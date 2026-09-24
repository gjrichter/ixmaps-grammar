import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadGrammar } from '../src/check.mjs';

const g = loadGrammar();
const HOME = process.env.HOME;
const flatRoot = g.sources.flat.path.replace(/^~/, HOME);
const glFile = g.sources.gl.path.replace(/^~/, HOME);
const datajs = g.sources.datajs.path.replace(/^~/, HOME);
const sourcesPresent = fs.existsSync(flatRoot) && fs.existsSync(glFile);
const cache = new Map();
const lineOf = (file, n) => {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(file, 'utf8').split(/\r?\n/));
  return cache.get(file)[n - 1];
};
function resolve(ev) {
  const m = ev.match(/^(.+?):(\d+)$/);
  if (!m) return null; // schema / overlay evidence has no line
  const [, f, ln] = m;
  if (f === 'ixmaps-gl.js') return [glFile, +ln];
  if (f === 'data.js') return [datajs, +ln];
  return [path.join(flatRoot, f), +ln];
}

test('registry has the expected size and key entries', () => {
  assert.ok(Object.keys(g.flags).length > 250);
  assert.ok(Object.keys(g.styleKeys).length > 150);
  for (const f of ['CHOROPLETH', 'CHART', 'FEATURE', 'BUBBLE', 'PIE', 'CATEGORICAL', 'AGGREGATE', 'NOLEGEND']) assert.ok(g.flags[f], f);
  for (const k of ['colorscheme', 'fillopacity', 'normalsizevalue', 'rangecentervalue']) assert.ok(g.styleKeys[k], k);
  assert.equal(g.bindingKeys.geo.target, 'style.lookupfield');
  assert.equal(g.bindingKeys.value.target, 'theme.field');
  assert.deepEqual(Object.keys(g.metaKeys).sort(), ['description', 'name', 'snippet', 'title', 'tooltip']);
});

test('every flat/gl evidence reference points at a source line containing the keyword', { skip: !sourcesPresent && 'engine sources not on this machine' }, () => {
  const bad = [];
  let checked = 0;
  for (const sec of ['flags', 'styleKeys', 'bindingKeys', 'metaKeys', 'layerMethods', 'mapInstanceMethods', 'runtimeApi', 'mapOptions', 'dataKeys']) {
    for (const [key, e] of Object.entries(g[sec])) {
      const leaf = key.split('.').pop();
      for (const ev of [...(e.evidence || []), ...(e.gl?.evidence || [])]) {
        const r = resolve(ev);
        if (!r) continue;
        const line = lineOf(...r);
        checked++;
        if (line === undefined || !line.includes(leaf)) bad.push(`${sec}.${key} @ ${ev}: ${String(line).trim().slice(0, 80)}`);
      }
    }
  }
  assert.ok(checked > 1000, `only ${checked} evidence refs checked`);
  assert.deepEqual(bad, []);
});

test('gl status is one of the known values', () => {
  for (const sec of ['flags', 'styleKeys', 'bindingKeys', 'runtimeApi'])
    for (const [k, e] of Object.entries(g[sec])) assert.ok(['impl', 'implicit', 'inert', 'missing'].includes(e.gl?.status), `${sec}.${k}`);
});
