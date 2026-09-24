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
import { Validator } from './core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadGrammar(file = path.join(ROOT, 'grammar', 'grammar.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

// AST traversal only — every keyword rule lives in core.mjs (Validator).
// The ctx passed to the validator is the AST node to locate the finding at.
class Checker {
  constructor(grammar, engine, file, lineOffset = 0) {
    this.file = file;
    this.lineOffset = lineOffset;
    this.findings = [];
    this.usage = []; // {section, key, line} for the engine report
    const lineOf = ctx => (ctx?.loc?.start.line || 0) + this.lineOffset;
    this.val = new Validator(grammar, {
      engine,
      onFinding: (f, ctx) => {
        const loc = ctx?.loc?.start || { line: 0, column: 0 };
        // project-JSON themes carry a { where } ctx instead of a node
        const message = ctx?.where ? `${ctx.where}: ${f.message}` : f.message;
        this.findings.push({ severity: f.severity, code: f.code, file, line: loc.line + this.lineOffset, col: loc.column + 1, ...f, message });
      },
      onUse: ({ section, key }, ctx) => this.usage.push({ section, key, line: lineOf(ctx) }),
    });
    this.v = this.val.v;
  }

  notStatic(node, what) {
    this.val.report('info', 'not-static', node, `${what} is not a literal — not checked`);
  }

  // each literal key of an object argument → keyFn(key, keyNode)
  objectArg(obj, label, keyFn) {
    if (!obj) return;
    if (obj.type !== 'ObjectExpression') { this.notStatic(obj, `${label} argument`); return; }
    for (const p of obj.properties) {
      if (p.type === 'SpreadElement') { this.notStatic(p, `${label} spread`); continue; }
      const k = propKey(p);
      if (k === undefined) { this.notStatic(p, `${label} computed key`); continue; }
      keyFn.call(this.val, k, p.key);
    }
  }

  // a `type` property inside an object literal (.style({type:...}), .data({type:...}))
  literalProp(obj, name) {
    if (obj?.type !== 'ObjectExpression') return undefined;
    const p = obj.properties.find(pp => propKey(pp) === name);
    const s = p && staticString(p.value);
    return s === undefined ? undefined : { value: s, node: p.value };
  }

  checkLayerCall(c) {
    const { name, args, node } = c;
    if (!this.val.layerMethod(name, node.callee?.property || node)) return;
    const a0 = args[0];
    switch (name) {
      case 'type': {
        const s = staticString(a0);
        if (s === undefined) this.notStatic(a0, '.type() argument');
        else this.val.typeString(s, a0);
        break;
      }
      case 'style': {
        this.objectArg(a0, 'style key', this.val.styleKey);
        const t = this.literalProp(a0, 'type');
        if (t) this.val.typeString(t.value, t.node);
        break;
      }
      case 'meta':
        this.objectArg(a0, 'meta key', this.val.metaKey);
        break;
      case 'binding':
      case 'encoding':
        this.objectArg(a0, 'binding key', this.val.bindingKey);
        break;
      case 'data': {
        if (!a0) break;
        if (a0.type === 'ObjectExpression') {
          this.objectArg(a0, 'data key', this.val.dataKey);
          const t = this.literalProp(a0, 'type');
          if (t) this.val.dataType(t.value, t.node);
        } else if (args[1]) {
          const s = staticString(args[1]);
          if (s !== undefined) this.val.dataType(s, args[1]);
        }
        break;
      }
    }
  }

  checkMapCall(c, { instance }) {
    const { name, args, node } = c;
    if (!this.val.mapMethod(name, node.callee?.property || node, { instance })) return;
    if (name === 'options') this.objectArg(args[0], 'options key', this.val.optionsKey);
  }

  // Map(div, opts, cb) itself
  checkMapCtor(c) {
    this.val.keyword('runtimeApi', c.name, c.node.callee?.property || c.node, 'ixmaps function');
    if (c.args[1]) this.objectArg(c.args[1], 'Map option', this.val.mapOptionKey);
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
      // window._map = ixmaps.Map(...) / app.map = ... — keyed the way chain
      // roots are looked up below (memberPath, window. stripped)
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression') {
        const mp = memberPath(n.left);
        if (mp) { id = mp.replace(/^window\./, ''); init = n.right; }
      }
      if (init?.type === 'AwaitExpression') init = init.argument;
      const ch = chainOf(init);
      if (id && ch) {
        if (isMapRoot(ch)) mapVars.add(id);
        else if (isLayerRoot(ch) || (mapVars.has(memberPath(ch.root)?.replace(/^window\./, '')) && ch.calls[0]?.name === 'layer')) layerVars.add(id);
      }
      if (n.type === 'CallExpression') {
        const c2 = unwindChain(n);
        const rootName = memberPath(c2.root)?.replace(/^window\./, '');
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
        else if (['layer', 'Layer', 'theme'].includes(first.name)) { this.val.keyword('runtimeApi', first.name, first.node.callee.property, 'ixmaps function'); state = 'layer'; calls = calls.slice(1); }
        else { this.val.runtimeCall(first.name, first.node.callee?.property || first.node); return; }
      } else if (rootPath?.startsWith('ixmaps.')) {
        const ns = rootPath.slice(7);
        // ixmaps.data.facetsFilterA.push(...) — a method of a known
        // property's VALUE (an array, a string), not an ixmaps API call
        const e = this.v.g.runtimeApi?.[ns];
        if (e && e.kind === 'property') return;
        // only one namespace level is registered (ixmaps.data.showFacets);
        // deeper paths (ixmaps.data.facetsFilterA.filter) are page-side values
        if (ns.includes('.')) return;
        this.val.runtimeCall(`${ns}.${calls[0].name}`, calls[0].node.callee?.property || calls[0].node);
        return;
      } else if (mapVars.has(rootPath)) { state = 'map'; instance = true; }
      else if (layerVars.has(rootPath)) state = 'layer';
      else return;

      for (const c of calls) {
        if (state === 'map') {
          this.checkMapCall(c, { instance });
          // map.layer(name) returns a layer builder; map.layer(builder) —
          // an ixmaps.layer(...) call or a variable holding one — stays on the map
          if (c.name === 'layer' && c.args[0] && !isLayerBuilderExpr(c.args[0], layerVars)) state = 'layer';
        } else {
          if (['then', 'catch'].includes(c.name)) break; // chain left the builder
          this.checkLayerCall(c);
        }
      }
    });
  }
}

function isLayerBuilderExpr(n, layerVars) {
  if (n.type === 'CallExpression' || n.type === 'NewExpression') return true;
  if (n.type === 'Identifier') return layerVars.has(n.name);
  return false;
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
  const ck = new Checker(grammar, engine, file, lineOffset);
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
  const ck = new Checker(grammar, engine, file);
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
  // project themes are plain values — schema v1.2 shape, type in style.type
  (json.themes || []).forEach((t, i) => ck.val.theme(t, { where: `themes[${i}]` }));
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
