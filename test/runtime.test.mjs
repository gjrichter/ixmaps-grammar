// The browser runtime (dist/) must give exactly the verdicts of the full
// grammar — it only drops evidence. Run `npm run build` after `npm run extract`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile, loadGrammar } from '../src/check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const full = loadGrammar();
const runtime = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'grammar.runtime.json'), 'utf8'));
const { createValidator, GRAMMAR, version } = await import('../dist/validate.mjs');

const SECTIONS = ['flags', 'styleKeys', 'bindingKeys', 'metaKeys', 'dataKeys', 'dataTypes', 'mapOptions',
  'optionsKeys', 'mapBuilderMethods', 'layerMethods', 'mapInstanceMethods', 'runtimeApi'];

test('dist is built from the current grammar.json and package version', () => {
  assert.equal(version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  for (const s of SECTIONS) assert.deepEqual(Object.keys(runtime[s]), Object.keys(full[s]), `${s} out of date — npm run build`);
  assert.deepEqual(GRAMMAR, runtime, 'validate.mjs and grammar.runtime.json differ — npm run build');
});

// the fixtures plus, when present on this machine, every real page
function corpus() {
  const files = fs.readdirSync(path.join(ROOT, 'test', 'fixtures')).map(f => path.join(ROOT, 'test', 'fixtures', f));
  const work = `${process.env.HOME}/Work/Claude Code`;
  for (const d of [work, `${work}/deckgl-accidents/api`, `${work}/deckgl-accidents/api/examples`]) {
    if (fs.existsSync(d)) files.push(...fs.readdirSync(d).filter(f => /\.(html?|json)$/.test(f)).map(f => path.join(d, f)));
  }
  return files;
}

test('runtime grammar gives identical findings to the full grammar (both engines)', () => {
  const files = corpus();
  for (const engine of ['flat', 'gl']) {
    for (const f of files) {
      const a = checkFile(f, { engine, grammar: full });
      const b = checkFile(f, { engine, grammar: runtime });
      assert.deepEqual(b.findings, a.findings, `${engine} ${f}`);
    }
  }
  assert.ok(files.length >= 5);
});

test('createValidator validates plain values and passes ctx through', () => {
  const found = [];
  const v = createValidator({ engine: 'gl', onFinding: (f, ctx) => found.push({ ...f, layer: ctx.layer }) });
  v.theme({
    type: 'CHART|PIE|CATEGORICL',
    style: { fillOpacity: 0.5, scale: 1 },
    binding: { geo: 'lat|lon', positon: 'x' },
    meta: { title: 'T' },
    data: { url: 'a.csv', type: 'csv' },
  }, { layer: 'plants' });
  v.options({ panhidden: true, zoomcontrol: 1 }, { layer: null });
  v.runtimeCall('setMapTool', { layer: null });
  const by = k => found.find(f => f.keyword === k);
  assert.equal(by('PIE').code, 'gl-unsupported');
  assert.equal(by('CATEGORICL').suggestion, 'CATEGORICAL');
  assert.equal(by('fillOpacity').suggestion, 'fillopacity');
  assert.equal(by('positon').code, 'unknown-binding-key');
  assert.equal(by('zoomcontrol').code, 'unknown-options-key');
  assert.equal(by('setMapTool').code, 'gl-unsupported');
  assert.equal(by('PIE').layer, 'plants');
  // panhidden is a valid flat option (ci-substring panHidden) that gl lacks
  assert.equal(by('panhidden').code, 'gl-unsupported');
  assert.ok(!by('scale') && !by('title') && !by('csv'));
});
