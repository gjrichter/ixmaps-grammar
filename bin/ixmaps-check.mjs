#!/usr/bin/env node
// ixmaps-check [--engine flat|gl] [--json] [--quiet] [--strict] <file|dir>...
//   --engine  target engine for the support report (default: flat)
//   --json    machine-readable output
//   --quiet   hide info-level findings
//   --strict  exit 1 on warnings too (default: errors only)
// Directories are scanned (non-recursively) for .html/.js/.json files.

import fs from 'node:fs';
import path from 'node:path';
import { checkFile, loadGrammar } from '../src/check.mjs';

const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf(n); if (i >= 0) { argv.splice(i, 1); return true; } return false; };
const opt = n => { const i = argv.indexOf(n); if (i >= 0) { const v = argv[i + 1]; argv.splice(i, 2); return v; } return undefined; };
const engine = opt('--engine') || 'flat';
const asJson = flag('--json'), quiet = flag('--quiet'), strict = flag('--strict');
if (!['flat', 'gl'].includes(engine) || !argv.length) {
  console.error('usage: ixmaps-check [--engine flat|gl] [--json] [--quiet] [--strict] <file|dir>...');
  process.exit(2);
}

const files = argv.flatMap(p => fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter(f => /\.(html?|js|json)$/i.test(f)).sort().map(f => path.join(p, f))
  : [p]);

const grammar = loadGrammar();
const results = files.map(f => ({ file: f, ...checkFile(f, { engine, grammar }) }));

if (asJson) {
  console.log(JSON.stringify({ engine, grammar: grammar.sources, results }, null, 2));
} else {
  for (const r of results) {
    const shown = r.findings.filter(f => !(quiet && f.severity === 'info'));
    if (!shown.length) continue;
    console.log(`\n${r.file}`);
    for (const f of shown) console.log(`  ${String(f.line).padStart(5)}:${String(f.col).padEnd(3)} ${f.severity.padEnd(7)} ${f.code.padEnd(22)} ${f.message}`);
    if (engine === 'gl') {
      const miss = [...new Set(r.findings.filter(f => f.code === 'gl-unsupported').map(f => `${f.keyword} (${f.section})`))];
      if (miss.length) console.log(`  → ixmaps-gl lacks ${miss.length}: ${miss.join(', ')}`);
    }
  }
  const count = sev => results.reduce((n, r) => n + r.findings.filter(f => f.severity === sev).length, 0);
  console.log(`\n${files.length} file(s), engine=${engine}: ${count('error')} error(s), ${count('warning')} warning(s), ${count('info')} info`);
}
const bad = results.some(r => r.findings.some(f => f.severity === 'error' || (strict && f.severity === 'warning')));
process.exit(bad ? 1 : 0);
