import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile, checkJs } from '../src/check.mjs';

const fx = f => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', f);
const codes = r => r.findings.map(f => `${f.code}:${f.keyword ?? ''}`);
const errors = r => r.findings.filter(f => f.severity === 'error');

test('a correct flat page has no errors or warnings for engine=flat', () => {
  const r = checkFile(fx('good.html'));
  assert.deepEqual(r.findings.filter(f => f.severity !== 'info'), []);
  // every chain section was actually reached
  const sections = new Set(r.usage.map(u => u.section));
  for (const s of ['mapOptions', 'optionsKeys', 'layerMethods', 'flags', 'styleKeys', 'bindingKeys', 'metaKeys', 'dataKeys', 'dataTypes', 'runtimeApi', 'mapInstanceMethods'])
    assert.ok(sections.has(s), `section ${s} not exercised`);
});

test('typos are reported with the right code and suggestion', () => {
  const r = checkFile(fx('typos.html'));
  const got = new Map(errors(r).map(f => [f.keyword, f]));
  const expect = {
    mapTyp: ['unknown-Map-option', 'mapType'],
    objectscalling: ['unknown-options-key', 'objectscaling'],
    positon: ['unknown-binding-key', 'position'],
    categoricl: ['unknown-type-flag', 'CATEGORICAL'],
    CATEGORICL: ['unknown-type-flag', 'CATEGORICAL'],
    fillOpacity: ['unknown-style-key', 'fillopacity'],
    bogusmeta: ['unknown-meta-key', undefined],
    styl: ['unknown-layer-method', 'style'],
    setMapToo: ['unknown-ixmaps-function', 'setMapTool'],
    'data.showFacetz': ['unknown-ixmaps-function', 'data.showFacets'],
  };
  for (const [kw, [code, sug]] of Object.entries(expect)) {
    const f = got.get(kw);
    assert.ok(f, `no error for ${kw}; got ${codes(r).join(', ')}`);
    assert.equal(f.code, code, kw);
    assert.equal(f.suggestion, sug, kw);
  }
  // unknown data type is a warning (flat passes it to data.js unchecked)
  assert.ok(r.findings.some(f => f.code === 'unknown-data-type' && f.suggestion === 'geojson'));
  assert.equal(errors(r).length, Object.keys(expect).length, codes(r).join(', '));
});

test('line numbers point into the HTML file', () => {
  const r = checkFile(fx('typos.html'));
  assert.equal(r.findings.find(f => f.keyword === 'setMapToo').line, 13);
});

test('engine=flat flags gl-only extensions; engine=gl flags what gl lacks', () => {
  const flat = checkFile(fx('gl_only.html'));
  assert.deepEqual(flat.findings.filter(f => f.code === 'gl-only').map(f => f.keyword).sort(), ['SPLINE', 'legendtheme']);
  assert.equal(errors(flat).length, 0);
  const gl = checkFile(fx('gl_only.html'), { engine: 'gl' });
  assert.ok(gl.findings.some(f => f.code === 'gl-unsupported' && f.keyword === 'PIE'));
  assert.ok(!gl.findings.some(f => f.code === 'gl-only'));
  assert.ok(!gl.findings.some(f => ['CHART', 'PLOT', 'GRIDSIZE', 'VALUES', 'scale'].includes(f.keyword) && f.code === 'gl-unsupported'));
});

test('computed arguments are reported as not-static, never as clean', () => {
  const r = checkFile(fx('not_static.html'));
  assert.equal(r.findings.filter(f => f.code === 'not-static').length, 2);
  assert.equal(errors(r).length, 0);
});

test('project JSON: theme type flags and style keys are checked', () => {
  const r = checkFile(fx('project.json'));
  const kws = errors(r).map(f => f.keyword);
  assert.ok(kws.includes('QUANTLE'));
  assert.ok(kws.includes('fillopacty'));
});

test('callback-style ixmaps.layer(name, fn) and Map(div, opts, fn) handles are tracked', () => {
  const r = checkJs(`
    ixmaps.layer("a", function (l) { l.type("CHART|BUBBL"); });
    ixmaps.Map("m", {}, function (map) { map.changeThemeStyl("a", "x"); });`);
  assert.deepEqual(errors(r).map(f => f.keyword).sort(), ['BUBBL', 'changeThemeStyl']);
});

test('unrelated .data()/.type() chains (jQuery etc.) are ignored', () => {
  const r = checkJs(`$("#x").data("k").type("foo"); something.style({ bogus: 1 });`);
  assert.deepEqual(r.findings, []);
});

test('options keys follow ixmaps.setOptions case-insensitive substring matching', () => {
  const r = checkJs(`ixmaps.Map("m",{}).options({ panhidden: true, worksilent: true, featurescaling: "dynamic", zoomcontrol: 1 });`);
  assert.deepEqual(errors(r).map(f => f.keyword), ['zoomcontrol']);
});

test('substring-only flags are a warning pointing at the real flag', () => {
  const r = checkJs(`ixmaps.layer("a").type("CHART|SYMBOLS|SIZE");`);
  const f = r.findings.find(x => x.keyword === 'SYMBOLS');
  assert.equal(f.code, 'flag-substring');
  assert.equal(f.suggestion, 'SYMBOL');
  assert.equal(errors(r).length, 0);
});

test('map.layer(nonLiteralName) switches the chain to the layer builder', () => {
  const r = checkJs(`const m = ixmaps.Map("m", {}); m.layer(cfg.id).type("WMS|IMAGE").meta({ name: cfg.name }).define();`);
  assert.deepEqual(errors(r), []);
});

test('methods of ixmaps.* property values are not API calls', () => {
  const r = checkJs(`ixmaps.data.facetsFilterA.push("x"); ixmaps.data.showFacets("a","b");`);
  assert.deepEqual(errors(r), []);
});

test('"<script>" inside an HTML comment does not open a script block', async () => {
  const { checkHtml } = await import('../src/check.mjs');
  const r = checkHtml(`<!-- loaded as plain <script> tags -->\n<script src="a.js"></script>\n<script>\nixmaps.setMapToo("x");\n</script>`);
  assert.ok(!r.findings.some(f => f.code === 'parse-error'));
  assert.equal(r.findings.find(f => f.keyword === 'setMapToo').line, 4);
});

test('map handles stored on an object (window._map = ixmaps.Map(...)) are tracked', () => {
  const r = checkJs(`
    window._map = ixmaps.Map("m", {});
    window._map.layer("a").type("CHART|BUBBL").style({ fillOpacity: 1 });
    _map.then(map => map.changeThemeStyl("a", "x"));`);
  assert.deepEqual(errors(r).map(f => f.keyword).sort(), ['BUBBL', 'changeThemeStyl', 'fillOpacity']);
});
