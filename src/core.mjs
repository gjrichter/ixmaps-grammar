// ixmaps grammar validation core — the keyword rules, shared by the static
// checker (src/check.mjs, Node + AST) and the runtime validator
// (dist/validate.mjs, browser, loaded by ixmaps-gl). No Node or AST
// dependencies: it validates plain values.
//
// Every finding carries an opaque `ctx` supplied by the caller (an AST node
// for the static checker, { layer } for the runtime validator); the caller's
// onFinding hook turns it into a location.

// ------------------------------------------------------------ vocabulary

export class Vocabulary {
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
  isInternal(section, key) {
    return !!this.internal[section]?.includes(key);
  }
}

// Case-insensitive exact match first (fillOpacity → fillopacity), then
// edit distance ≤ 2.
export function suggest(word, candidates) {
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

export function levenshtein(a, b) {
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

const codeOf = label => `unknown-${label.replace(/\s+/g, '-')}`;

// ------------------------------------------------------------ validator

export class Validator {
  // onFinding(finding, ctx) / onUse({section, key}, ctx) — both optional;
  // by default findings collect in this.findings with their ctx attached.
  constructor(grammar, { engine = 'flat', onFinding, onUse } = {}) {
    this.v = new Vocabulary(grammar, engine);
    this.findings = [];
    this.onFinding = onFinding || ((f, ctx) => this.findings.push({ ...f, ctx }));
    this.onUse = onUse || (() => {});
  }

  report(severity, code, ctx, message, extra = {}) {
    this.onFinding({ severity, code, message, ...extra }, ctx);
  }

  // one keyword occurrence: known? engine-supported? → known
  keyword(section, key, ctx, label) {
    const r = this.v.lookup(section, key);
    if (!r.known) return false;
    this.onUse({ section, key }, ctx);
    if (this.v.engine === 'gl') {
      if (r.glExtension) return true;
      const st = r.entry.gl?.status || 'missing';
      if (st === 'missing') this.report('warning', 'gl-unsupported', ctx, `${label} "${key}" is not implemented by ixmaps-gl`, { section, keyword: key });
      else if (st === 'inert') this.report('info', 'gl-inert', ctx, `${label} "${key}" is recognized by ixmaps-gl but has no rendering effect`, { section, keyword: key });
      else if (st === 'implicit') this.report('info', 'gl-implicit', ctx, `${label} "${key}": ${r.entry.gl.note}`, { section, keyword: key });
    } else if (r.glExtension) {
      this.report('warning', 'gl-only', ctx, `${label} "${key}" is an ixmaps-gl extension; ixmaps-flat ignores it (${r.note})`, { section, keyword: key });
    }
    return true;
  }

  unknown(section, key, ctx, label, { severity = 'error', why = '', candidates } = {}) {
    const s = suggest(key, candidates || this.v.keys(section));
    this.report(severity, codeOf(label), ctx,
      `unknown ${label} "${key}"${s ? ` — did you mean "${s}"?` : ''}${why}`, { section, keyword: key, suggestion: s || undefined });
  }

  // one object key: known in `section`, or `alsoValid`, else unknown
  objectKey(key, ctx, section, label, { alsoValid, severity = 'error', why = '' } = {}) {
    if (this.keyword(section, key, ctx, label)) return;
    if (alsoValid && alsoValid(key, ctx)) return;
    this.unknown(section, key, ctx, label, { severity, why });
  }

  typeString(str, ctx) {
    for (const raw of String(str).split('|')) {
      const tok = raw.trim();
      if (!tok) continue;
      if (this.keyword('flags', tok, ctx, 'type flag')) continue;
      if (this.v.flagPatterns.some(re => re.test(tok))) continue;
      const sub = this.v.substringFlag(tok);
      if (sub) {
        this.report('warning', 'flag-substring', ctx, `"${tok}" is not a flag; it only has an effect because ixmaps-flat also matches "${sub}" as a substring — write "${sub}"`, { section: 'flags', keyword: tok, suggestion: sub });
        continue;
      }
      if (this.v.lookup('flags', tok.toUpperCase()).known) {
        this.report('error', 'flag-case', ctx, `type flag "${tok}" must be uppercase ("${tok.toUpperCase()}") — flags are matched case-sensitively`, { section: 'flags', keyword: tok, suggestion: tok.toUpperCase() });
        continue;
      }
      this.unknown('flags', tok, ctx, 'type flag');
    }
  }

  dataType(t, ctx) {
    const lt = String(t).toLowerCase();
    if (this.keyword('dataTypes', lt, ctx, 'data type')) return;
    const s = suggest(lt, this.v.keys('dataTypes'));
    this.report('warning', 'unknown-data-type', ctx, `unknown data type "${t}"${s ? ` — did you mean "${s}"?` : ''}`, { section: 'dataTypes', keyword: t, suggestion: s || undefined });
  }

  // --- per-argument rules (key → ctx pairs, so both callers can locate keys)

  styleKey(k, ctx) { this.objectKey(k, ctx, 'styleKeys', 'style key'); }
  metaKey(k, ctx) {
    // htmlgui.js newTheme merges meta into style
    this.objectKey(k, ctx, 'metaKeys', 'meta key', { alsoValid: (kk, c) => this.keyword('styleKeys', kk, c, 'meta key') });
  }
  bindingKey(k, ctx) { this.objectKey(k, ctx, 'bindingKeys', 'binding key', { why: ' (ixmaps-flat silently ignores unknown binding keys)' }); }
  dataKey(k, ctx) { this.objectKey(k, ctx, 'dataKeys', 'data key', { severity: 'warning' }); }
  optionsKey(k, ctx) { this.objectKey(k, ctx, 'optionsKeys', 'options key'); }
  mapOptionKey(k, ctx) { this.objectKey(k, ctx, 'mapOptions', 'Map option'); }

  layerMethod(name, ctx) {
    if (this.keyword('layerMethods', name, ctx, 'layer method')) return true;
    this.unknown('layerMethods', name, ctx, 'layer method');
    return false;
  }

  // instance: called on a captured map handle, where an unknown name may be
  // a page's own property — only a near-miss is reported there
  mapMethod(name, ctx, { instance = false } = {}) {
    if (this.keyword('mapBuilderMethods', name, ctx, 'map method') || this.keyword('mapInstanceMethods', name, ctx, 'map method')) return true;
    if (this.v.isInternal('mapInstanceMethods', name) || this.v.isInternal('mapBuilderMethods', name)) return true;
    const cands = [...this.v.keys('mapBuilderMethods'), ...this.v.keys('mapInstanceMethods')];
    const s = suggest(name, cands);
    if (instance && !s) return true;
    this.report('error', 'unknown-map-method', ctx, `unknown map method "${name}"${s ? ` — did you mean "${s}"?` : ''}`, { section: 'mapInstanceMethods', keyword: name, suggestion: s || undefined });
    return false;
  }

  runtimeCall(name, ctx) {
    if (this.keyword('runtimeApi', name, ctx, 'ixmaps function')) return;
    this.unknown('runtimeApi', name, ctx, 'ixmaps function');
  }

  // --- plain-value validators (runtime: values already evaluated)

  keysOf(obj, fn, ctx) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) for (const k of Object.keys(obj)) fn.call(this, k, ctx);
  }

  // a theme definition as plain values: { type, style, meta, binding, data }
  // (the same shape for a project-JSON theme, where type sits in style.type)
  theme(def, ctx) {
    if (!def) return;
    // the type first — wherever it sits (flat's definition shape keeps it in
    // style.type) — so its findings lead the report, then the style keys
    if (typeof def.type === 'string') this.typeString(def.type, ctx);
    if (typeof def.style?.type === 'string') this.typeString(def.style.type, ctx);
    this.keysOf(def.style, this.styleKey, ctx);
    this.keysOf(def.meta, this.metaKey, ctx);
    this.keysOf(def.binding, this.bindingKey, ctx);
    if (def.data && typeof def.data === 'object') {
      this.keysOf(def.data, this.dataKey, ctx);
      if (typeof def.data.type === 'string') this.dataType(def.data.type, ctx);
    }
  }

  style(obj, ctx) {
    this.keysOf(obj, this.styleKey, ctx);
    if (typeof obj?.type === 'string') this.typeString(obj.type, ctx);
  }
  options(obj, ctx) { this.keysOf(obj, this.optionsKey, ctx); }
  mapOptions(obj, ctx) { this.keysOf(obj, this.mapOptionKey, ctx); }
}
