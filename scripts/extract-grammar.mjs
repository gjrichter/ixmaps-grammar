#!/usr/bin/env node
// Extracts the ixmaps grammar + API surface from the real engine sources
// into grammar/grammar.generated.json, then merges grammar/grammar.overlay.json
// (hand-curated: family, description, appliesTo, per-engine overrides) on top
// into grammar/grammar.json.
//
// Every generated entry carries file:line evidence, so any registry claim can
// be checked against the source it came from. Nothing is inferred beyond what
// the source literally contains — combination rules (appliesTo, conflicts)
// live only in the overlay.
//
// Usage: node scripts/extract-grammar.mjs [--flat <ixmaps-flat repo>] [--gl <ixmaps-gl.js>]
//        [--schema <v1.2.json>] [--datajs <data.js>]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HOME;

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
}
const SRC = {
  flat: arg('flat', `${HOME}/Repositories/GitHub/ixmaps-flat`),
  gl: arg('gl', `${HOME}/Repositories/GitHub/ixmaps-gl/ixmaps-gl.js`),
  // schema/ and data.js are not part of the ixmaps-flat deploy repo — they
  // live only in the dev tree.
  schema: arg('schema', `${HOME}/Sites/ixmaps/dev/flat_multi/ixmaps/schema/ixmaps/v1.2.json`),
  datajs: arg('datajs', `${HOME}/Sites/ixmaps/dev/flat_multi/data.js/data.js`),
};
const FLAT_FILES = {
  maptheme: 'maps/svg/js/maptheme.js',
  mapscript: 'maps/svg/js/mapscript.js',
  mapscript2: 'maps/svg/js/mapscript2.js',
  htmlgui: 'ui/js/htmlgui.js',
  htmlguiFlat: 'ui/js/htmlgui_flat.js',
  ixmaps: 'ixmaps.js',
};
const MAX_EVIDENCE = 3;

// ---------------------------------------------------------------- helpers

function readLines(file) {
  // some flat sources (htmlgui.js) use CRLF — `.` doesn't match \r in JS
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function gitRev(file) {
  try {
    const dir = fs.statSync(file).isDirectory() ? file : path.dirname(file);
    return execFileSync('git', ['-C', dir, 'log', '-1', '--format=%h %ad', '--date=short', '--', file],
      { encoding: 'utf8' }).trim() || null;
  } catch { return null; }
}

// registry section: key -> { evidence:[], refs, ...extra }
function addRef(section, key, where, extra = {}) {
  const e = section[key] || (section[key] = { refs: 0, evidence: [] });
  e.refs++;
  if (e.evidence.length < MAX_EVIDENCE && !e.evidence.includes(where)) e.evidence.push(where);
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) e[k] = [...new Set([...(e[k] || []), ...v])];
    else if (e[k] === undefined) e[k] = v;
  }
  return e;
}

function sortObj(o) {
  return Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
}

// ------------------------------------------------------------ flat: flags

// Theme type flags are tested with String.match on the theme's flag string.
// Only variables that hold the theme TYPE string are scanned (szFlag and
// its copies); merkFlag/testFlag/oldFlag are temporaries of the same value
// and add no tokens of their own.
const FLAG_CALL = /\b(?:szFlag|szOrigFlag|szThemeFlag|szChartFlag)\.match\(\s*(\/(?:\\\/|[^\/\n])+\/[a-z]*|"[^"]*"|'[^']*')/g;

function tokenizeFlagPattern(lit) {
  let body, quoted = false;
  if (lit[0] === '/') body = lit.slice(1, lit.lastIndexOf('/'));
  else { body = lit.slice(1, -1); quoted = true; }
  const wordBounded = /\\b/.test(body);
  const cleaned = body.replace(/\\b/g, '').replace(/^\^/, '').replace(/\$$/, '');
  // strip ONE level of wrapping parens: (VECTOR|BEZIER)
  const alts = cleaned.replace(/^\((.*)\)$/, '$1').split('|');
  const tokens = [], patterns = [];
  for (const raw of alts) {
    const t = raw.replace(/^\(|\)$/g, '').trim();
    if (!t) continue;
    if (/^[A-Z0-9_]+$/.test(t) && /[A-Z]/.test(t)) tokens.push(t);
    else if (/[A-Z]/.test(t) && !/^[a-z]/.test(t)) patterns.push(t);
    // lowercase tokens (tiled, add, remove, ...) are engine-internal
  }
  return { tokens, patterns, wordBounded, quoted };
}

// Every hand-written engine JS file (the legend tools parse flags too —
// NOLEGEND/SIMPLELEGEND live only in ui/js/tools/legend.js). Minified
// builds and js-source/ (a pre-compile duplicate of maps/svg/js) are skipped.
function flatJsFiles() {
  const out = [];
  const rec = dir => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // ui/libs = vendored third-party code (jQuery, ...), not ixmaps API
        if (!['node_modules', 'js-source', '.git', 'examples', 'app', 'plugins', 'libs'].includes(ent.name)) rec(p);
      } else if (ent.name.endsWith('.js') && !ent.name.endsWith('.min.js')) out.push(p);
    }
  };
  rec(SRC.flat);
  return out.sort();
}

function extractFlags(reg) {
  for (const file of flatJsFiles()) {
    const rel = path.relative(SRC.flat, file);
    readLines(file).forEach((line, i) => {
      for (const m of line.matchAll(FLAG_CALL)) {
        const { tokens, patterns, wordBounded } = tokenizeFlagPattern(m[1]);
        const where = `${rel}:${i + 1}`;
        for (const t of tokens) {
          const e = addRef(reg.flags, t, where);
          // flat's matching is substring-based unless the source uses \b —
          // e.g. /SIZE/ also fires for SIZELOG. Record whether ANY reference
          // is substring-matched, since that's the one that can surprise.
          if (!wordBounded) e.substringMatched = true;
        }
        for (const p of patterns) addRef(reg.flagPatterns, p, where);
      }
    });
  }
}

// ------------------------------------------------------- flat: style keys

function extractStyleKeys(reg) {
  const mt = path.join(SRC.flat, FLAT_FILES.maptheme);
  const lines = readLines(mt);
  const reDot = /\bstyleObj\.([A-Za-z_][A-Za-z0-9_]*)/g;
  const reBr = /\bstyleObj\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g;
  lines.forEach((line, i) => {
    for (const m of line.matchAll(reDot)) addRef(reg.styleKeys, m[1], `${FLAT_FILES.maptheme}:${i + 1}`, { sources: ['maptheme.read'] });
    for (const m of line.matchAll(reBr)) addRef(reg.styleKeys, m[1], `${FLAT_FILES.maptheme}:${i + 1}`, { sources: ['maptheme.read'] });
  });
  // themeStyleTranslateA: the style<->theme-object table used by
  // changeThemeStyle and theme serialization — the set of keys that can be
  // changed at runtime.
  const start = lines.findIndex(l => /var themeStyleTranslateA\s*=\s*\[/.test(l));
  if (start >= 0) {
    for (let i = start; i < lines.length; i++) {
      const m = lines[i].match(/\bstyle:\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/);
      if (m) addRef(reg.styleKeys, m[1], `${FLAT_FILES.maptheme}:${i + 1}`, { sources: ['maptheme.translate'], runtimeChangeable: true });
      if (/^\s*\];/.test(lines[i])) break;
    }
  }
  // htmlgui.js normalization writes theme.style["x"] (binding/data/meta targets)
  readLines(path.join(SRC.flat, FLAT_FILES.htmlgui)).forEach((line, i) => {
    for (const m of line.matchAll(/\btheme\.style\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g)) {
      addRef(reg.styleKeys, m[1], `${FLAT_FILES.htmlgui}:${i + 1}`, { sources: ['htmlgui.normalize'] });
    }
  });
}

// ------------------------------------------------------- flat: meta keys

// htmlgui.js merges theme.meta INTO theme.style (so any style key is valid in
// .meta()), and when serializing moves a fixed set of style keys back out to
// meta: `if (i == "title") { theme.meta[i] = theme.style[i]; ...`. That set
// is the canonical meta vocabulary.
function extractMetaKeys(reg) {
  const lines = readLines(path.join(SRC.flat, FLAT_FILES.htmlgui));
  lines.forEach((line, i) => {
    const m = line.match(/if\s*\(\s*i\s*==\s*["']([A-Za-z0-9_]+)["']\s*\)\s*\{?\s*$/);
    if (m && /theme\.meta\[i\]\s*=\s*theme\.style\[i\]/.test(lines[i + 1] || '')) {
      addRef(reg.metaKeys, m[1], `${FLAT_FILES.htmlgui}:${i + 1}`, { sources: ['htmlgui.serialize'] });
    }
  });
}

// ---------------------------------------------------- flat: binding keys

function extractBindingKeys(reg) {
  const rel = FLAT_FILES.htmlgui;
  const lines = readLines(path.join(SRC.flat, rel));
  const start = lines.findIndex(l => /if\s*\(\s*theme\.binding\s*\)/.test(l));
  if (start < 0) throw new Error('binding alias block not found in htmlgui.js');
  let pending = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(/\(\s*i\s*==\s*["']([A-Za-z0-9_]+)["']\s*\)/g)) pending.push([m[1], i + 1]);
    const t = line.match(/theme(?:\.style)?\[\s*["']([A-Za-z0-9_]+)["']\s*\]\s*=\s*theme\.binding\[i\]/);
    if (t) {
      const target = /theme\.style\[/.test(line) ? `style.${t[1]}` : `theme.${t[1]}`;
      for (const [alias, ln] of pending) addRef(reg.bindingKeys, alias, `${FLAT_FILES.htmlgui}:${ln}`, { target });
      pending = [];
    }
    if (/GR .*check and preset default values/.test(line)) break;
  }
}

// ------------------------------------------------ flat: builder methods

function extractObjectLiteralMethods(file, blockStartRe, section, label) {
  const lines = readLines(file);
  let inBlock = false, depth = 0;
  lines.forEach((line, i) => {
    if (!inBlock && blockStartRe.test(line)) { inBlock = true; depth = 0; }
    if (!inBlock) return;
    const m = line.match(/^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*function\b/);
    if (m && depth === 1) addRef(section, m[1], `${path.relative(SRC.flat, file)}:${i + 1}`, { sources: [label] });
    for (const ch of line.replace(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\/\/.*$/g, '')) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { inBlock = false; return; } }
    }
  });
}

function extractBuilderMethods(reg) {
  const ixf = path.join(SRC.flat, FLAT_FILES.ixmaps);
  const src = fs.readFileSync(ixf, 'utf8');
  const lineOf = idx => src.slice(0, idx).split('\n').length;
  for (const [name, section] of [['_CHAINABLE_METHODS', reg.mapBuilderMethods], ['_PROMISE_METHODS', reg.mapBuilderMethods]]) {
    const m = src.match(new RegExp(`var ${name}\\s*=\\s*\\[([^\\]]*)\\]`));
    if (!m) throw new Error(`${name} not found in ixmaps.js`);
    const ln = lineOf(m.index);
    for (const t of m[1].matchAll(/['"]([A-Za-z]+)['"]/g)) addRef(section, t[1], `${FLAT_FILES.ixmaps}:${ln}`, { sources: [name] });
  }
  // layer builder: ixmaps.themeConstruct.prototype in ixmaps.js (the
  // ixmaps.layer() path) and in htmlgui_flat.js (the map.layer() path)
  extractObjectLiteralMethods(ixf, /ixmaps\.themeConstruct\.prototype\s*=\s*\{/, reg.layerMethods, 'ixmaps.js themeConstruct');
  const hf = path.join(SRC.flat, FLAT_FILES.htmlguiFlat);
  extractObjectLiteralMethods(hf, /ixmaps\.themeConstruct\.prototype\s*=\s*\{/, reg.layerMethods, 'htmlgui_flat.js themeConstruct');
  extractObjectLiteralMethods(hf, /ixmaps\.mapApi\.prototype\s*=\s*\{/, reg.mapInstanceMethods, 'htmlgui_flat.js mapApi');
  extractObjectLiteralMethods(hf, /ixmaps\.themeApi\.prototype\s*=\s*\{/, reg.themeApiMethods, 'htmlgui_flat.js themeApi');
}

// ------------------------------------------------------ flat: runtime API

// ixmaps.<name> = ... across every flat JS file, including one level of
// nesting (ixmaps.data.showFacets, defined in ui/js/tools/filter.js).
// Engine-private ixmaps.__foo / ixmaps._foo helpers are skipped.
function extractRuntimeApi(reg) {
  const re = /^\s*(?:window\.)?ixmaps\.([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)?)\s*=(?!=)\s*(.*)$/;
  for (const file of flatJsFiles()) {
    if (/maps\/svg\/js\//.test(file)) continue; // SVG-window engine, no ixmaps.* namespace
    readLines(file).forEach((line, i) => {
      const m = line.match(re);
      if (!m) return;
      const kind = /^(?:function\b|\(?[\w\s,]*\)?\s*=>|ixmaps\.)/.test(m[2]) ? 'function' : 'property';
      addRef(reg.runtimeApi, m[1], `${path.relative(SRC.flat, file)}:${i + 1}`, { kind });
    });
  }
  // ixmaps.data = window.ixmaps.data || {} also registers the namespace itself
  if (reg.runtimeApi['data']) reg.runtimeApi['data'].kind = 'namespace';
}

// ------------------------------------------------ flat: map options

function extractMapOptions(reg) {
  const rel = FLAT_FILES.htmlguiFlat;
  readLines(path.join(SRC.flat, rel)).forEach((line, i) => {
    for (const m of line.matchAll(/\bopt\.([A-Za-z][A-Za-z0-9_]*)/g)) {
      addRef(reg.mapOptions, m[1], `${FLAT_FILES.htmlguiFlat}:${i + 1}`, { sources: ['htmlgui_flat opt'] });
    }
  });
}

// ------------------------------------------------ flat: .options() keys

// .options(o) → ixmaps.setOptions (htmlgui.js): a few keys are matched
// case-insensitively as SUBSTRINGS (i.match(/panHidden/i)); everything else
// is forwarded to map.Api.setMapFeatures → ixMap.prototype.setFeatures
// (mapscript.js), a switch over exact `case "key":` names.
function extractOptionsKeys(reg) {
  const hg = readLines(path.join(SRC.flat, FLAT_FILES.htmlgui));
  const so = hg.findIndex(l => /ixmaps\.setOptions\s*=\s*function/.test(l));
  if (so < 0) throw new Error('ixmaps.setOptions not found in htmlgui.js');
  for (let i = so + 1; i < hg.length; i++) {
    const m = hg[i].match(/\bi\.match\(\/(?:\\b)?([A-Za-z0-9]+)(?:\\b)?\/i\)/);
    if (m) addRef(reg.optionsKeys, m[1], `${FLAT_FILES.htmlgui}:${i + 1}`, { sources: ['ixmaps.setOptions'], match: /\\b/.test(hg[i]) ? 'ci-word' : 'ci-substring' });
    if (/setMapFeatures\(szFeatures\)/.test(hg[i])) break;
  }
  const ms = readLines(path.join(SRC.flat, FLAT_FILES.mapscript));
  const sf = ms.findIndex(l => /ixMap\.prototype\.setFeatures\s*=\s*function/.test(l));
  if (sf < 0) throw new Error('ixMap.prototype.setFeatures not found in mapscript.js');
  for (let i = sf + 1; i < ms.length; i++) {
    if (/^\s*ixMap\.prototype\.[A-Za-z]+\s*=/.test(ms[i])) break;
    for (const m of ms[i].matchAll(/\bcase\s+["']([A-Za-z0-9_]+)["']\s*:/g)) {
      addRef(reg.optionsKeys, m[1], `${FLAT_FILES.mapscript}:${i + 1}`, { sources: ['ixMap.setFeatures'] });
    }
  }
}

// ------------------------------------------------ schema v1.2

function extractSchema(reg) {
  if (!fs.existsSync(SRC.schema)) { console.warn(`schema not found: ${SRC.schema}`); return; }
  const s = JSON.parse(fs.readFileSync(SRC.schema, 'utf8'));
  const where = `schema/${path.basename(SRC.schema)}`;
  const theme = s.properties.themes.items.properties;
  for (const k of Object.keys(theme.style?.properties || {})) addRef(reg.styleKeys, k, where, { sources: ['schema'] });
  for (const k of Object.keys(theme.meta?.properties || {})) addRef(reg.metaKeys, k, where, { sources: ['schema'] });
  for (const k of Object.keys(theme.data?.properties || {})) addRef(reg.dataKeys, k, where, { sources: ['schema'] });
  for (const k of Object.keys(theme.binding?.properties || {})) {
    if (!reg.bindingKeys[k]) addRef(reg.bindingKeys, k, where, { sources: ['schema'] });
  }
  for (const k of Object.keys(s.properties.map.properties.options?.properties || {})) {
    addRef(reg.optionsKeys, k, where, { sources: ['schema'] });
  }
}

// ------------------------------------------------ flat: data keys/types

function extractData(reg) {
  // themeConstruct.data(): reads dataObj.<key>; unknown keys are copied
  // through unchecked (for (var i in dataObj) this.def.data[i] = ...).
  readLines(path.join(SRC.flat, FLAT_FILES.ixmaps)).forEach((line, i) => {
    for (const m of line.matchAll(/\bdataObj\.([A-Za-z][A-Za-z0-9_]*)/g)) {
      addRef(reg.dataKeys, m[1], `${FLAT_FILES.ixmaps}:${i + 1}`, { sources: ['themeConstruct.data'] });
    }
  });
  addRef(reg.dataTypes, 'ext', 'ixmaps.js themeConstruct.data', { sources: ['ixmaps.js'] });
  if (!fs.existsSync(SRC.datajs)) { console.warn(`data.js not found: ${SRC.datajs}`); return; }
  // data.js compares type strings in several spellings; the registry key is
  // lowercase and matching is case-insensitive (see checker).
  readLines(SRC.datajs).forEach((line, i) => {
    for (const m of line.matchAll(/\b(?:szType|type|format)\s*===?\s*["']([A-Za-z]+)["']/g)) {
      addRef(reg.dataTypes, m[1].toLowerCase(), `data.js:${i + 1}`, { sources: ['data.js'] });
    }
  });
}

// ------------------------------------------------ gl engine support

function extractGl(reg) {
  const src = fs.readFileSync(SRC.gl, 'utf8');
  const lines = src.split('\n');
  const gl = {
    flags: {}, inertFlags: {}, styleKeys: {}, bindingKeys: {}, metaKeys: {}, mapOptions: {},
    optionsKeys: {}, runtimeApi: {}, dataKeys: {}, dataTypes: {},
    // flat binding target → evidence, from gl's GL_BINDING_TARGETS table;
    // alias → its line in gl's generated FLAT_BINDING_ALIASES table
    bindingTargets: {}, aliasLines: {},
    // gl's generated FLAT_META_KEYS: meta keys gl also reads from style
    metaFromStyle: {}, mapInstanceMethods: {}, layerMethods: {}, mapBuilderMethods: {},
  };
  // `mapOptions` means two things in gl: inside class MapBuilder it is the
  // Map(div, opts) constructor object; everywhere else (LayerRuntime,
  // valueRadius, ...) it is the .options({...}) object passed down as
  // LayerRuntime's mapOptions. Classify reads by enclosing class.
  const ast = acorn.parse(src, { ecmaVersion: 'latest', locations: true });
  let mb = [0, -1];
  walk(ast, n => { if (n.type === 'ClassDeclaration' && n.id?.name === 'MapBuilder') mb = [n.loc.start.line, n.loc.end.line]; });
  // Scan CODE only: drop // comments and '...' / "..." strings first, so a
  // keyword that merely appears in a comment or in a string (e.g. the
  // generated alias table's "style.colorfield" values) isn't taken for a
  // read. Template strings are kept — real reads sit inside their ${...}.
  const codeOnly = line => line
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""')
    .replace(/\/\/.*$/, '');
  lines.forEach((rawLine, i) => {
    const line = codeOnly(rawLine);
    const where = `ixmaps-gl.js:${i + 1}`;
    const inMapBuilder = i + 1 >= mb[0] && i + 1 <= mb[1];
    // flags and data types are quoted in the code itself (flags.has('CHART'),
    // dataConfig.type === 'csv') — matched on the raw line
    for (const m of rawLine.matchAll(/flags\.has\(\s*'([A-Z0-9_]+)'\s*\)/g)) addRef(gl.flags, m[1], where);
    // style keys: only reads off the theme's style object (this.style /
    // rt.style / r.style / a bare `style` param) — never a DOM element's
    // .style (el.style, tooltipEl.style, ...)
    for (const m of line.matchAll(/(?:\b(?:this|rt|r)\.|(?<![\w.$]))style\.([a-z][a-zA-Z0-9]*)/g)) addRef(gl.styleKeys, m[1], where);
    for (const m of line.matchAll(/\bbinding\.([a-zA-Z][a-zA-Z0-9]*)/g)) addRef(gl.bindingKeys, m[1], where);
    for (const m of line.matchAll(/\bmeta\.([a-zA-Z][a-zA-Z0-9]*)/g)) addRef(gl.metaKeys, m[1], where);
    for (const m of line.matchAll(/\bmapOptions\.([a-zA-Z][a-zA-Z0-9]*)/g)) addRef(inMapBuilder ? gl.mapOptions : gl.optionsKeys, m[1], where);
    for (const m of line.matchAll(/\b(?:dataConfig|lb\._data)\.([a-zA-Z][a-zA-Z0-9]*)/g)) addRef(gl.dataKeys, m[1], where);
    for (const m of rawLine.matchAll(/\bdataConfig\.type\s*===\s*'([a-zA-Z]+)'/g)) addRef(gl.dataTypes, m[1].toLowerCase(), where);
    for (const m of line.matchAll(/\b_engineOptions\.([a-zA-Z][a-zA-Z0-9]*)/g)) addRef(gl.optionsKeys, m[1], where);
  });
  const inert = src.match(/const KNOWN_INERT_FLAGS\s*=\s*\[([^\]]*)\]/);
  if (inert) {
    const bodyStart = inert.index + inert[0].indexOf('[') + 1;
    for (const t of inert[1].matchAll(/'([A-Z0-9_]+)'/g)) {
      const ln = src.slice(0, bodyStart + t.index).split('\n').length; // array spans lines
      addRef(gl.inertFlags, t[1], `ixmaps-gl.js:${ln}`);
    }
  }

  // Structural API: read class methods + the exported object literals from
  // the AST rather than regexing a 6000-line file.
  walk(ast, node => {
    if (node.type === 'ClassDeclaration' && node.id) {
      const target = { LayerBuilder: gl.layerMethods, MapBuilder: gl.mapBuilderMethods }[node.id.name];
      if (!target) return;
      for (const m of node.body.body) {
        if (m.type === 'MethodDefinition' && m.key.type === 'Identifier' && m.kind === 'method' && !m.key.name.startsWith('_')) {
          addRef(target, m.key.name, `ixmaps-gl.js:${m.loc.start.line}`);
        }
      }
    }
    // global.ixmaps = { ... }
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression'
      && node.left.property.name === 'ixmaps' && node.right.type === 'ObjectExpression') {
      for (const p of node.right.properties) {
        const k = p.key && (p.key.name || p.key.value);
        if (k) addRef(gl.runtimeApi, k === 'Map' ? 'Map' : k, `ixmaps-gl.js:${p.loc.start.line}`);
      }
    }
    // const ixmapsData = { ... } — exported as ixmaps.data
    if (node.type === 'VariableDeclarator' && node.id.name === 'ixmapsData' && node.init?.type === 'ObjectExpression') {
      for (const p of node.init.properties) {
        const k = p.key && (p.key.name || p.key.value);
        if (k) addRef(gl.runtimeApi, `data.${k}`, `ixmaps-gl.js:${p.loc.start.line}`);
      }
    }
    // const GL_BINDING_TARGETS = { 'theme.field': [...], ... } — the flat
    // binding targets gl implements; every alias of such a target (resolved
    // through gl's generated FLAT_BINDING_ALIASES table) is implemented
    if (node.type === 'VariableDeclarator' && node.id.name === 'GL_BINDING_TARGETS' && node.init?.type === 'ObjectExpression') {
      for (const p of node.init.properties) {
        const k = p.key && (p.key.value || p.key.name);
        if (k) addRef(gl.bindingTargets, k, `ixmaps-gl.js:${p.loc.start.line}`);
      }
    }
    if (node.type === 'VariableDeclarator' && node.id.name === 'FLAT_META_KEYS' && node.init?.type === 'ArrayExpression') {
      for (const el of node.init.elements) if (el && typeof el.value === 'string') gl.metaFromStyle[el.value] = `ixmaps-gl.js:${el.loc.start.line}`;
    }
    if (node.type === 'VariableDeclarator' && node.id.name === 'FLAT_BINDING_ALIASES' && node.init?.type === 'ObjectExpression') {
      for (const p of node.init.properties) {
        const k = p.key && (p.key.value || p.key.name);
        if (k) gl.aliasLines[k] = `ixmaps-gl.js:${p.loc.start.line}`;
      }
    }
    // const engineApi = { ... }  — the map handle .then(map => ...) receives
    if (node.type === 'VariableDeclarator' && node.id.name === 'engineApi' && node.init?.type === 'ObjectExpression') {
      for (const p of node.init.properties) {
        const k = p.key && (p.key.name || p.key.value);
        if (k && !String(k).startsWith('_')) addRef(gl.mapInstanceMethods, k, `ixmaps-gl.js:${p.loc.start.line}`);
      }
    }
  });
  // the chain methods the builder Promise exposes (createMap's proxy/then)
  addRef(gl.mapBuilderMethods, 'then', 'ixmaps-gl.js createMap');
  addRef(gl.mapBuilderMethods, 'catch', 'ixmaps-gl.js createMap');
  return gl;
}

function walk(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(c => c && typeof c.type === 'string' && walk(c, fn));
    else if (v && typeof v.type === 'string' && k !== 'loc') walk(v, fn);
  }
}

// Attach gl support status to every flat entry. gl-only reads (keys gl
// reads that flat doesn't know) are listed separately for review — some
// are genuine gl extensions, others are regex noise (e.g. MapLibre style
// objects also called `style`); they are NOT added to the grammar.
function mergeGl(reg, gl) {
  const status = (section, glSection, key, inertSection) => {
    if (inertSection && inertSection[key]) return { status: 'inert', evidence: inertSection[key].evidence };
    if (glSection[key]) return { status: 'impl', evidence: glSection[key].evidence };
    return { status: 'missing' };
  };
  const pairs = [
    ['flags', 'flags', 'inertFlags'], ['styleKeys', 'styleKeys'], ['bindingKeys', 'bindingKeys'],
    ['metaKeys', 'metaKeys'], ['mapOptions', 'mapOptions'], ['optionsKeys', 'optionsKeys'],
    ['runtimeApi', 'runtimeApi'], ['dataKeys', 'dataKeys'], ['dataTypes', 'dataTypes'], ['mapInstanceMethods', 'mapInstanceMethods'],
    ['layerMethods', 'layerMethods'], ['mapBuilderMethods', 'mapBuilderMethods'],
  ];
  // aliases resolved through gl's target table: an alias (or the style key
  // flat writes it to) is implemented when gl implements its target
  for (const [alias, e] of Object.entries(reg.bindingKeys)) {
    const t = e.target && gl.bindingTargets[e.target];
    // evidence: the alias's own line in gl's alias table (it names the alias)
    if (t && !gl.bindingKeys[alias]) gl.bindingKeys[alias] = { refs: t.refs, evidence: [gl.aliasLines[alias] || t.evidence[0]] };
  }
  for (const target of Object.keys(gl.bindingTargets)) {
    const m = target.match(/^style\.(.+)$/);
    if (m && reg.styleKeys[m[1]] && !gl.styleKeys[m[1]]) gl.styleKeys[m[1]] = gl.bindingTargets[target];
  }

  // meta keys gl reads from style too (flat merges meta into style): the
  // style key counts as implemented when gl implements the meta key
  for (const [k, where] of Object.entries(gl.metaFromStyle)) {
    if (gl.metaKeys[k] && reg.styleKeys[k] && !gl.styleKeys[k]) gl.styleKeys[k] = { refs: 1, evidence: [where] };
  }

  reg.glOnly = {};
  for (const [sec, glSec, inertSec] of pairs) {
    for (const key of Object.keys(reg[sec])) reg[sec][key].gl = status(sec, gl[glSec], key, inertSec && gl[inertSec]);
    const extra = Object.keys(gl[glSec]).filter(k => !reg[sec][k]
      // meta keys are merged into style by flat (htmlgui.js newTheme), so a
      // gl meta read of a known style key isn't gl-only
      && !(sec === 'metaKeys' && reg.styleKeys[k]));
    if (extra.length) reg.glOnly[sec] = Object.fromEntries(extra.sort().map(k => [k, gl[glSec][k].evidence]));
  }
}

// ------------------------------------------------ overlay merge

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$')) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

// ------------------------------------------------ main

const SECTIONS = ['flags', 'flagPatterns', 'styleKeys', 'bindingKeys', 'metaKeys', 'dataKeys', 'dataTypes',
  'mapOptions', 'optionsKeys', 'mapBuilderMethods', 'layerMethods', 'mapInstanceMethods', 'themeApiMethods', 'runtimeApi'];

const reg = Object.fromEntries(SECTIONS.map(s => [s, {}]));
extractFlags(reg);
extractStyleKeys(reg);
extractBindingKeys(reg);
extractMetaKeys(reg);
extractBuilderMethods(reg);
extractRuntimeApi(reg);
extractMapOptions(reg);
extractOptionsKeys(reg);
extractSchema(reg);
extractData(reg);

// vendor the project schema so the checker is self-contained
if (fs.existsSync(SRC.schema)) {
  fs.mkdirSync(path.join(ROOT, 'grammar', 'schema'), { recursive: true });
  fs.copyFileSync(SRC.schema, path.join(ROOT, 'grammar', 'schema', path.basename(SRC.schema)));
}

const overlayPath = path.join(ROOT, 'grammar', 'grammar.overlay.json');
const overlay = fs.existsSync(overlayPath) ? JSON.parse(fs.readFileSync(overlayPath, 'utf8')) : {};
// Overlay may ADD flat entries the source scan can't see (documented-only
// keys, options read via indirect access). They get a gl status too.
for (const sec of SECTIONS) {
  for (const [k, v] of Object.entries(overlay[sec] || {})) {
    if (!reg[sec][k] && v && v.add) reg[sec][k] = { refs: 0, evidence: [v.add], sources: ['overlay'] };
  }
}

const gl = extractGl(reg);
mergeGl(reg, gl);

const flatVersion = (fs.readFileSync(path.join(SRC.flat, FLAT_FILES.ixmaps), 'utf8').match(/version:\s*"([^"]+)"/) || [])[1];
const generated = {
  $comment: 'GENERATED by scripts/extract-grammar.mjs — do not edit; curate grammar.overlay.json instead',
  sources: {
    flat: { path: SRC.flat.replace(HOME, '~'), version: flatVersion, commit: gitRev(SRC.flat) },
    gl: { path: SRC.gl.replace(HOME, '~'), commit: gitRev(SRC.gl) },
    schema: { path: SRC.schema.replace(HOME, '~') },
    datajs: { path: SRC.datajs.replace(HOME, '~') },
  },
  counts: Object.fromEntries(SECTIONS.map(s => [s, Object.keys(reg[s]).length])),
  ...Object.fromEntries(SECTIONS.map(s => [s, sortObj(reg[s])])),
  glOnly: reg.glOnly,
};
fs.writeFileSync(path.join(ROOT, 'grammar', 'grammar.generated.json'), JSON.stringify(generated, null, 2) + '\n');

const merged = deepMerge(JSON.parse(JSON.stringify(generated)), overlay);
merged.$comment = 'GENERATED = grammar.generated.json + grammar.overlay.json — do not edit';
fs.writeFileSync(path.join(ROOT, 'grammar', 'grammar.json'), JSON.stringify(merged, null, 2) + '\n');

// coverage summary
const cov = sec => {
  const vals = Object.values(merged[sec]);
  const c = { impl: 0, implicit: 0, inert: 0, missing: 0 };
  vals.forEach(v => { c[v.gl?.status || 'missing']++; });
  return `${sec.padEnd(20)} ${String(vals.length).padStart(4)}  gl impl ${String(c.impl).padStart(3)}  implicit ${c.implicit}  inert ${String(c.inert).padStart(2)}  missing ${String(c.missing).padStart(4)}`;
};
console.log(`flat ${flatVersion} (${generated.sources.flat.commit}) / gl (${generated.sources.gl.commit})`);
for (const s of ['flags', 'styleKeys', 'bindingKeys', 'metaKeys', 'dataKeys', 'dataTypes', 'mapOptions', 'optionsKeys',
  'mapBuilderMethods', 'layerMethods', 'mapInstanceMethods', 'themeApiMethods', 'runtimeApi']) {
  if (merged[s][Object.keys(merged[s])[0]]?.gl) console.log(cov(s));
  else console.log(`${s.padEnd(20)} ${String(Object.keys(merged[s]).length).padStart(4)}`);
}
console.log(`flagPatterns         ${Object.keys(merged.flagPatterns).length}`);
console.log('gl-only reads (review):', Object.fromEntries(Object.entries(reg.glOnly).map(([k, v]) => [k, Object.keys(v)])));
