// ixmaps static checker — lints ixmaps builder code (HTML pages, JS files,
// project JSON) against grammar/grammar.json.
//
// What it checks:
//   ixmaps.Map(div, opts)   Map() option keys
//   .options({...})         .options() keys
//   .layer(...).<m>()       layer-builder method names
//   .type("A|B|C")          every flag token
//   .style({...})           style keys
//   .meta({...})            meta keys (flat merges meta into style, so any
//                           style key is valid too)
//   .binding({...})         binding aliases (flat silently drops unknown ones)
//   .data({...}) / .data(url, type)   data keys + data type
//   ixmaps.<fn>(...)        runtime API names (incl. ixmaps.data.<fn>)
//   <map>.<fn>(...)         map-instance methods on a captured map handle
// and, per target engine, which of the used keywords that engine does not
// support (--engine gl) or which are gl-only extensions flat ignores
// (--engine flat).
//
// Only literal arguments can be checked; anything computed is reported as
// `info: not-static` so a clean result never overstates what was verified.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import Ajv from 'ajv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadGrammar(file = path.join(ROOT, 'grammar', 'grammar.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ------------------------------------------------------------ vocabulary

class Vocabulary {
  constructor(grammar, engine) {
    this.g = grammar;
    this.engine = engine;
    this.ext = grammar.glExtensions || {};
    this.internal = grammar.glInternal || {};
    this.flagPatterns = Object.keys(grammar.flagPatterns || {}).map(p => {
      try { return new RegExp(`^(?:${p})$`); } catch { return null; }
    }).filter(Boolean);
  }
  // → { known: bool, entry, glExtension: bool }
  lookup(section, key) {
    const entry = this.g[section]?.[key];
    if (entry) return { known: true, entry };
    if (this.ext[section]?.[key]) return { known: true, glExtension: true, note: this.ext[section][key] };
    // ixmaps.setOptions matches some option keys case-insensitively as
    // substrings (i.match(/panHidden/i)) — mirror that exactly
    if (section === 'optionsKeys') {
      const lk = key.toLowerCase();
      for (const [k, e] of Object.entries(this.g.optionsKeys || {})) {
        if (e.match === 'ci-substring' && lk.includes(k.toLowerCase())) return { known: true, entry: e, via: k };
        if (e.match === 'ci-word' && new RegExp(`\\b${k}\\b`, 'i').test(key)) return { known: true, entry: e, via: k };
      }
    }
    return { known: false };
  }
  // longest substring-matched flag contained in an unknown token (SYMBOLS → SYMBOL)
  substringFlag(tok) {
    let best = null;
    for (const [k, e] of Object.entries(this.g.flags || {})) {
      if (e.substringMatched && k.length >= 3 && tok !== k && tok.includes(k) && (!best || k.length > best.length)) best = k;
    }
    return best;
  }
  keys(section) {
    return [...Object.keys(this.g[section] || {}), ...Object.keys(this.ext[section] || {}).filter(k => !k.startsWith('$'))];
  }
}

// Case-insensitive exact match first (fillOpacity → fillopacity), then
// edit distance ≤ 2.
function suggest(word, candidates) {
  const lw = word.toLowerCase();
  const ci = candidates.find(c => c.toLowerCase() === lw);
  if (ci) return ci;
  let best = null, bestD = 3;
  for (const c of candidates) {
    if (Math.abs(c.length - word.length) >= bestD) continue;
    const d = levenshtein(lw, c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

// ------------------------------------------------------------ AST helpers

function walk(node, fn, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && walk(c, fn, node));
    else if (v && typeof v.type === 'string') walk(v, fn, node);
  }
}

function memberPath(n) {
  if (!n) return null;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'MemberExpression' && !n.computed) {
    const o = memberPath(n.object);
    return o ? `${o}.${n.property.name}` : null;
  }
  return null;
}

function staticString(n) {
  if (!n) return undefined;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked;
  // "A|" + "B" — both sides static
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const l = staticString(n.left), r = staticString(n.right);
    if (l !== undefined && r !== undefined) return l + r;
  }
  return undefined;
}

function propKey(p) {
  if (p.type !== 'Property' || p.computed) return undefined;
  if (p.key.type === 'Identifier') return p.key.name;
  if (p.key.type === 'Literal') return String(p.key.value);
  return undefined;
}

// Unwind `a.b(x).c(y).d(z)` from its outermost call into
// { root, calls:[{name, node, args}] } in source order.
function unwindChain(call) {
  const calls = [];
  let n = call;
  while (n) {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed) {
      calls.push({ name: n.callee.property.name, node: n, args: n.arguments });
      n = n.callee.object;
    } else if (n.type === 'NewExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed) {
      // new ixmaps.Map(...)
      calls.push({ name: n.callee.property.name, node: n, args: n.arguments });
      n = n.callee.object;
    } else break;
  }
  return { root: n, calls: calls.reverse() };
}

const FN_TYPES = new Set(['FunctionExpression', 'ArrowFunctionExpression']);
const firstParamName = fn => (fn && FN_TYPES.has(fn.type) && fn.params[0]?.type === 'Identifier') ? fn.params[0].name : null;

// ------------------------------------------------------------ checker

class Checker {
  constructor(vocab, file) {
    this.v = vocab;
    this.file = file;
    this.findings = [];
    this.lineOffset = 0;
    this.usage = []; // {section, key, line} for the engine report
  }

  report(severity, code, node, message, extra = {}) {
    const loc = node?.loc?.start || { line: 0, column: 0 };
    this.findings.push({ severity, code, file: this.file, line: loc.line + this.lineOffset, col: loc.column + 1, message, ...extra });
  }

  // one keyword occurrence: known? engine-supported?
  use(section, key, node, label) {
    const r = this.v.lookup(section, key);
    if (!r.known) return false;
    this.usage.push({ section, key, line: (node?.loc?.start.line || 0) + this.lineOffset });
    if (this.v.engine === 'gl') {
      if (r.glExtension) return true;
      const st = r.entry.gl?.status || 'missing';
      if (st === 'missing') this.report('warning', 'gl-unsupported', node, `${label} "${key}" is not implemented by ixmaps-gl`, { section, keyword: key });
      else if (st === 'inert') this.report('info', 'gl-inert', node, `${label} "${key}" is recognized by ixmaps-gl but has no rendering effect`, { section, keyword: key });
      else if (st === 'implicit') this.report('info', 'gl-implicit', node, `${label} "${key}": ${r.entry.gl.note}`, { section, keyword: key });
    } else if (r.glExtension) {
      this.report('warning', 'gl-only', node, `${label} "${key}" is an ixmaps-gl extension; ixmaps-flat ignores it (${r.note})`, { section, keyword: key });
    }
    return true;
  }

  unknown(section, key, node, label, why = '') {
    const s = suggest(key, this.v.keys(section));
    this.report('error', `unknown-${label.replace(/\s+/g, '-')}`, node,
      `unknown ${label} "${key}"${s ? ` — did you mean "${s}"?` : ''}${why}`, { section, keyword: key, suggestion: s || undefined });
  }

  notStatic(node, what) {
    this.report('info', 'not-static', node, `${what} is not a literal — not checked`);
  }

  checkObjectKeys(obj, section, label, { alsoValid, unknownSeverity = 'error', why = '' } = {}) {
    if (!obj) return;
    if (obj.type !== 'ObjectExpression') { this.notStatic(obj, `${label} argument`); return; }
    for (const p of obj.properties) {
      if (p.type === 'SpreadElement') { this.notStatic(p, `${label} spread`); continue; }
      const k = propKey(p);
      if (k === undefined) { this.notStatic(p, `${label} computed key`); continue; }
      if (this.use(section, k, p.key, label)) continue;
      if (alsoValid && alsoValid(k, p.key)) continue;
      if (unknownSeverity === 'error') this.unknown(section, k, p.key, label, why);
      else {
        const s = suggest(k, this.v.keys(section));
        this.report(unknownSeverity, `unknown-${label.replace(/\s+/g, '-')}`, p.key,
          `unknown ${label} "${k}"${s ? ` — did you mean "${s}"?` : ''}${why}`, { section, keyword: k, suggestion: s || undefined });
      }
    }
  }

  checkTypeString(str, node) {
    for (const raw of str.split('|')) {
      const tok = raw.trim();
      if (!tok) continue;
      if (this.use('flags', tok, node, 'type flag')) continue;
      if (this.v.flagPatterns.some(re => re.test(tok))) continue;
      const sub = this.v.substringFlag(tok);
      if (sub) {
        this.report('warning', 'flag-substring', node, `"${tok}" is not a flag; it only has an effect because ixmaps-flat also matches "${sub}" as a substring — write "${sub}"`, { section: 'flags', keyword: tok, suggestion: sub });
        continue;
      }
      if (this.v.lookup('flags', tok.toUpperCase()).known) {
        this.report('error', 'flag-case', node, `type flag "${tok}" must be uppercase ("${tok.toUpperCase()}") — flags are matched case-sensitively`, { section: 'flags', keyword: tok, suggestion: tok.toUpperCase() });
        continue;
      }
      this.unknown('flags', tok, node, 'type flag');
    }
  }

  checkDataType(t, node) {
    const lt = t.toLowerCase();
    if (!this.use('dataTypes', lt, node, 'data type')) {
      const s = suggest(lt, this.v.keys('dataTypes'));
      this.report('warning', 'unknown-data-type', node, `unknown data type "${t}"${s ? ` — did you mean "${s}"?` : ''}`, { section: 'dataTypes', keyword: t, suggestion: s || undefined });
    }
  }

  checkLayerCall(c) {
    const { name, args, node } = c;
    const mnode = node.callee?.property || node;
    if (!this.use('layerMethods', name, mnode, 'layer method')) {
      this.unknown('layerMethods', name, mnode, 'layer method');
      return;
    }
    const a0 = args[0];
    switch (name) {
      case 'type': {
        const s = staticString(a0);
        if (s === undefined) this.notStatic(a0, '.type() argument');
        else this.checkTypeString(s, a0);
        break;
      }
      case 'style':
        this.checkObjectKeys(a0, 'styleKeys', 'style key');
        // a style object may itself carry `type`
        if (a0?.type === 'ObjectExpression') {
          const tp = a0.properties.find(p => propKey(p) === 'type');
          const s = tp && staticString(tp.value);
          if (s !== undefined) this.checkTypeString(s, tp.value);
        }
        break;
      case 'meta':
        this.checkObjectKeys(a0, 'metaKeys', 'meta key', {
          // htmlgui.js newTheme merges meta into style
          alsoValid: (k, n) => this.use('styleKeys', k, n, 'meta key'),
        });
        break;
      case 'binding':
      case 'encoding':
        this.checkObjectKeys(a0, 'bindingKeys', 'binding key', { why: ' (ixmaps-flat silently ignores unknown binding keys)' });
        break;
      case 'data': {
        if (!a0) break;
        if (a0.type === 'ObjectExpression') {
          this.checkObjectKeys(a0, 'dataKeys', 'data key', { unknownSeverity: 'warning' });
          const tp = a0.properties.find(p => propKey(p) === 'type');
          const s = tp && staticString(tp.value);
          if (s !== undefined) this.checkDataType(s, tp.value);
        } else if (args[1]) {
          const s = staticString(args[1]);
          if (s !== undefined) this.checkDataType(s, args[1]);
        }
        break;
      }
    }
  }

  checkMapCall(c, { instance }) {
    const { name, args, node } = c;
    const mnode = node.callee?.property || node;
    const known = this.use('mapBuilderMethods', name, mnode, 'map method')
      || this.use('mapInstanceMethods', name, mnode, 'map method');
    if (!known) {
      if (this.v.internal.mapInstanceMethods?.includes(name) || this.v.internal.mapBuilderMethods?.includes(name)) return;
      const cands = [...this.v.keys('mapBuilderMethods'), ...this.v.keys('mapInstanceMethods')];
      const s = suggest(name, cands);
      // on a captured handle the method could be a page's own property —
      // only a near-miss is worth an error there
      if (instance && !s) return;
      this.report('error', 'unknown-map-method', mnode, `unknown map method "${name}"${s ? ` — did you mean "${s}"?` : ''}`, { section: 'mapInstanceMethods', keyword: name, suggestion: s || undefined });
      return;
    }
    if (name === 'options') this.checkObjectKeys(args[0], 'optionsKeys', 'options key');
  }

  // Map(div, opts, cb) itself
  checkMapCtor(c) {
    this.use('runtimeApi', c.name, c.node.callee?.property || c.node, 'ixmaps function');
    if (c.args[1]) this.checkObjectKeys(c.args[1], 'mapOptions', 'Map option');
  }

  checkProgram(ast) {
    // pass 1: names bound to map handles / layer builders
    const mapVars = new Set(), layerVars = new Set();
    const isMapRoot = ch => memberPath(ch.root)?.replace(/^window\./, '') === 'ixmaps' && ['Map', 'embed'].includes(ch.calls[0]?.name);
    const isLayerRoot = ch => memberPath(ch.root)?.replace(/^window\./, '') === 'ixmaps' && ['layer', 'Layer', 'theme'].includes(ch.calls[0]?.name);
    const chainOf = n => (n && (n.type === 'CallExpression' || n.type === 'NewExpression')) ? unwindChain(n) : null;
    walk(ast, n => {
      let id, init;
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') { id = n.id.name; init = n.init; }
      if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') { id = n.left.name; init = n.right; }
      if (init?.type === 'AwaitExpression') init = init.argument;
      const ch = chainOf(init);
      if (id && ch) {
        if (isMapRoot(ch)) mapVars.add(id);
        else if (isLayerRoot(ch) || (mapVars.has(memberPath(ch.root)) && ch.calls[0]?.name === 'layer')) layerVars.add(id);
      }
      if (n.type === 'CallExpression') {
        const c2 = unwindChain(n);
        const rootName = memberPath(c2.root);
        const fromMap = isMapRoot(c2) || mapVars.has(rootName);
        // ixmaps.Map(div, opts, function (map) {...}) and .then(map => ...)
        if (isMapRoot(c2)) { const p = firstParamName(c2.calls[0].args[2]); if (p) mapVars.add(p); }
        if (fromMap) for (const c of c2.calls) if (c.name === 'then') { const p = firstParamName(c.args[0]); if (p) mapVars.add(p); }
        // ixmaps.layer(name, function (layer) {...})
        if (isLayerRoot(c2)) { const p = firstParamName(c2.calls[0].args[1]); if (p) layerVars.add(p); }
      }
    });

    // pass 2: check every outermost chain
    walk(ast, (n, parent) => {
      if (n.type !== 'CallExpression' && n.type !== 'NewExpression') return;
      if (parent && parent.type === 'MemberExpression' && parent.object === n) return; // not outermost
      const ch = unwindChain(n);
      if (!ch.calls.length) return;
      const rootPath = memberPath(ch.root)?.replace(/^window\./, '');
      let state = null, calls = ch.calls, instance = false;
      if (rootPath === 'ixmaps') {
        const first = calls[0];
        if (['Map', 'embed'].includes(first.name)) { this.checkMapCtor(first); state = 'map'; calls = calls.slice(1); }
        else if (['layer', 'Layer', 'theme'].includes(first.name)) { this.use('runtimeApi', first.name, first.node.callee.property, 'ixmaps function'); state = 'layer'; calls = calls.slice(1); }
        else { this.checkRuntimeCall(first.name, first.node); return; }
      } else if (rootPath?.startsWith('ixmaps.')) {
        const ns = rootPath.slice(7);
        // ixmaps.data.facetsFilterA.push(...) — a method of a known
        // property's VALUE (an array, a string), not an ixmaps API call
        const e = this.v.g.runtimeApi?.[ns];
        if (e && e.kind === 'property') return;
        // only one namespace level is registered (ixmaps.data.showFacets);
        // deeper paths (ixmaps.data.facetsFilterA.filter) are page-side values
        if (ns.includes('.')) return;
        this.checkRuntimeCall(`${ns}.${calls[0].name}`, calls[0].node);
        return;
      } else if (mapVars.has(rootPath)) { state = 'map'; instance = true; }
      else if (layerVars.has(rootPath)) state = 'layer';
      else return;

      for (const c of calls) {
        if (state === 'map') {
          this.checkMapCall(c, { instance });
          // map.layer(name) returns a layer builder; map.layer(builder) —
          // an ixmaps.layer(...) call or a variable holding one — stays on the map
          if (c.name === 'layer' && c.args[0] && !this.isLayerBuilderExpr(c.args[0], layerVars)) state = 'layer';
        } else {
          if (['then', 'catch'].includes(c.name)) break; // chain left the builder
          this.checkLayerCall(c);
        }
      }
    });
  }

  isLayerBuilderExpr(n, layerVars) {
    if (n.type === 'CallExpression' || n.type === 'NewExpression') return true;
    if (n.type === 'Identifier') return layerVars.has(n.name);
    return false;
  }

  checkRuntimeCall(name, node) {
    const mnode = node.callee?.property || node;
    if (this.use('runtimeApi', name, mnode, 'ixmaps function')) return;
    this.unknown('runtimeApi', name, mnode, 'ixmaps function');
  }

  // project JSON theme (schema v1.2 shape: {layer, field, style:{type,...}, binding, meta, data})
  checkProjectTheme(theme, where) {
    const node = { loc: { start: { line: 0, column: 0 } } };
    const self = this;
    const keysOf = (obj, section, label, opts = {}) => {
      for (const k of Object.keys(obj || {})) {
        if (self.use(section, k, node, label)) continue;
        if (opts.alsoValid?.(k)) continue;
        const s = suggest(k, self.v.keys(section));
        self.report(opts.severity || 'error', `unknown-${label.replace(/\s+/g, '-')}`, node,
          `${where}: unknown ${label} "${k}"${s ? ` — did you mean "${s}"?` : ''}`, { section, keyword: k, suggestion: s || undefined });
      }
    };
    keysOf(theme.style, 'styleKeys', 'style key');
    if (typeof theme.style?.type === 'string') this.checkTypeString(theme.style.type, node);
    keysOf(theme.binding, 'bindingKeys', 'binding key');
    keysOf(theme.meta, 'metaKeys', 'meta key', { alsoValid: k => this.v.lookup('styleKeys', k).known });
    keysOf(theme.data, 'dataKeys', 'data key', { severity: 'warning' });
    if (typeof theme.data?.type === 'string') this.checkDataType(theme.data.type, node);
  }
}

// ------------------------------------------------------------ entry points

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const JS_TYPES = /^\s*$|type\s*=\s*["']?(?:text\/javascript|application\/javascript|module)["']?/i;

function parseJs(code) {
  const opts = { ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowHashBang: true };
  try { return acorn.parse(code, { ...opts, sourceType: 'module' }); }
  catch { return acorn.parse(code, { ...opts, sourceType: 'script' }); }
}

export function checkJs(code, { file = '<js>', engine = 'flat', grammar = loadGrammar(), lineOffset = 0 } = {}) {
  const ck = new Checker(new Vocabulary(grammar, engine), file);
  ck.lineOffset = lineOffset;
  try { ck.checkProgram(parseJs(code)); }
  catch (e) {
    ck.findings.push({ severity: 'warning', code: 'parse-error', file, line: (e.loc?.line || 0) + lineOffset, col: (e.loc?.column || 0) + 1, message: `could not parse script: ${e.message}` });
  }
  return { findings: ck.findings, usage: ck.usage };
}

export function checkHtml(html, { file = '<html>', engine = 'flat', grammar = loadGrammar() } = {}) {
  const findings = [], usage = [];
  // blank out <!-- comments --> (keeping newlines, so line numbers hold):
  // a comment mentioning "<script>" must not open a script block
  html = html.replace(/<!--[\s\S]*?-->/g, c => c.replace(/[^\n]/g, ' '));
  for (const m of html.matchAll(SCRIPT_RE)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs) || !(JS_TYPES.test(attrs) || !/type\s*=/i.test(attrs))) continue;
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    const lineOffset = html.slice(0, bodyStart).split('\n').length - 1;
    const r = checkJs(m[2], { file, engine, grammar, lineOffset });
    findings.push(...r.findings);
    usage.push(...r.usage);
  }
  return { findings, usage };
}

let _ajvValidate = null;
export function checkProject(json, { file = '<project>', engine = 'flat', grammar = loadGrammar() } = {}) {
  const ck = new Checker(new Vocabulary(grammar, engine), file);
  const schemaFile = path.join(ROOT, 'grammar', 'schema', 'v1.2.json');
  if (fs.existsSync(schemaFile)) {
    if (!_ajvValidate) {
      const ajv = new (Ajv.default || Ajv)({ allErrors: true, strict: false });
      _ajvValidate = ajv.compile(JSON.parse(fs.readFileSync(schemaFile, 'utf8')));
    }
    if (!_ajvValidate(json)) {
      for (const e of _ajvValidate.errors) {
        ck.findings.push({ severity: 'error', code: 'schema', file, line: 0, col: 0, message: `schema v1.2: ${e.instancePath || '/'} ${e.message}` });
      }
    }
  }
  (json.themes || []).forEach((t, i) => ck.checkProjectTheme(t, `themes[${i}]`));
  return { findings: ck.findings, usage: ck.usage };
}

export function checkFile(file, opts = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const o = { ...opts, file };
  if (/\.html?$/i.test(file)) return checkHtml(text, o);
  if (/\.json$/i.test(file)) {
    let json;
    try { json = JSON.parse(text); }
    catch (e) { return { findings: [{ severity: 'error', code: 'json', file, line: 0, col: 0, message: e.message }], usage: [] }; }
    return checkProject(json, o);
  }
  return checkJs(text, o);
}
