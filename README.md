# ixmaps-grammar

A machine-readable registry of the ixmaps theme grammar and API, **extracted
from the engine sources** (not hand-written), plus `ixmaps-check`, a static
checker for ixmaps pages that also reports which features a page uses that
[ixmaps-gl](https://github.com/gjrichter/ixmaps-gl) does not support.

It is the shared front end of the plan to keep ixmaps-flat and ixmaps-gl in
sync: one vocabulary, per-engine support status, coverage as a number.

## Layout

| Path | What |
|---|---|
| `scripts/extract-grammar.mjs` | scans the engine sources → `grammar/grammar.generated.json` |
| `grammar/grammar.overlay.json` | hand-curated additions (notes, gl extensions, overrides) — **edit this** |
| `grammar/grammar.json` | generated + overlay, what the checker reads — do not edit |
| `grammar/schema/v1.2.json` | vendored ixmaps project JSON schema |
| `src/core.mjs` | the keyword rules (`Validator`) — shared by the checker and the browser runtime |
| `src/check.mjs` | static checker: AST traversal (`checkFile`, `checkHtml`, `checkJs`, `checkProject`) |
| `scripts/build-runtime.mjs` | builds `dist/validate.mjs` + `dist/grammar.runtime.json` (browser runtime) |
| `bin/ixmaps-check.mjs` | CLI |

## Checking pages

```bash
npx ixmaps-check page.html                 # lint against the ixmaps-flat grammar
npx ixmaps-check --engine gl page.html     # + what ixmaps-gl lacks for this page
npx ixmaps-check --quiet --json dir/       # all .html/.js/.json in dir, JSON output
```

Exit code 1 on errors (`--strict`: also on warnings).

| Severity | Code | Meaning |
|---|---|---|
| error | `unknown-type-flag`, `unknown-style-key`, `unknown-binding-key`, `unknown-meta-key`, `unknown-layer-method`, `unknown-map-method`, `unknown-Map-option`, `unknown-options-key`, `unknown-ixmaps-function` | not in the grammar — a typo or a feature that doesn't exist (with a did-you-mean when one is close) |
| error | `flag-case` | flags are matched case-sensitively |
| warning | `flag-substring` | not a flag, only works because flat matches a shorter flag as substring (`SYMBOLS` → `SYMBOL`) |
| warning | `unknown-data-key`, `unknown-data-type` | flat copies unknown `.data()` keys through unchecked |
| warning | `gl-only` | (engine flat) an ixmaps-gl extension flat silently ignores |
| warning | `gl-unsupported` | (engine gl) used keyword ixmaps-gl does not implement |
| info | `gl-inert` | (engine gl) recognized by gl, no rendering effect |
| info | `gl-implicit` | (engine gl) gl applies the behavior without testing the keyword — read the note |
| info | `not-static` | a computed argument — **not checked**; a clean run never covers it |

What is checked: `ixmaps.Map(div, opts)` option keys, `.options()`, layer
builder methods, `.type()` flags, `.style()`, `.meta()`, `.binding()`,
`.data()` keys and type, `ixmaps.<fn>()` / `ixmaps.data.<fn>()` calls, and
methods called on a captured map handle (`const m = ixmaps.Map(...)`,
`Map(..., function (map) {...})`, `.then(map => ...)`). Project JSON files
are validated against schema v1.2 and their themes checked the same way.

Not checked (v1): style **values** (colorscheme shapes, numeric ranges),
flag combinations (which flags apply to which base type), inline `onclick`
handlers, and `ixmaps.a.b.c()` paths deeper than one namespace.

## Browser runtime (used by ixmaps-gl)

```bash
npm run build     # after npm run extract
```

writes `dist/validate.mjs` — one self-contained ES module (`src/core.mjs` plus the grammar
without evidence, ~83 KB, ~13 KB gzipped) — and `dist/grammar.runtime.json`. ixmaps-gl
`import()`s the module only when validation is turned on (`.options({validate:true})`,
see the ixmaps-gl README):

```js
const { createValidator } = await import('.../dist/validate.mjs');
const v = createValidator({ engine: 'gl', onFinding: (finding, ctx) => console.warn(finding.message) });
v.theme({ type, style, meta, binding, data }, { layer: 'name' });
v.options({...}); v.mapOptions({...}); v.style({...}); v.runtimeCall('setMapTool');
```

The keyword rules live once, in `src/core.mjs`: the static checker (`src/check.mjs`) only
walks the AST and hands values to the same `Validator`. `npm test` checks that `dist/` is
built from the current grammar and gives the same findings as the full grammar.

## Regenerating the grammar

```bash
npm run extract   # defaults below; override with --flat --gl --schema --datajs
npm test
```

| Source | Default path | Extracted |
|---|---|---|
| ixmaps-flat deploy repo | `~/Repositories/GitHub/ixmaps-flat` | flags (`szFlag.match` in every engine JS file, incl. legend tools), style keys (`styleObj.*`, `themeStyleTranslateA`), binding aliases (`htmlgui.js` normalization block), meta keys, builder / map-instance / themeApi methods, `ixmaps.*` runtime API, Map() options, `.options()` keys (`ixmaps.setOptions` + `ixMap.setFeatures`) |
| ixmaps-gl | `~/Repositories/GitHub/ixmaps-gl/ixmaps-gl.js` | per-keyword gl status: `flags.has()`, `KNOWN_INERT_FLAGS`, style/binding/meta/option reads, `LayerBuilder`/`MapBuilder` methods, the exported `ixmaps` object, `engineApi` |
| schema | dev tree `ixmaps/schema/ixmaps/v1.2.json` | style/data/options keys; vendored |
| data.js | dev tree `data.js/data.js` | data types |

Every generated entry carries `file:line` evidence; `npm test` verifies that
each evidence line actually contains its keyword.

### How flat matches, and what the registry records

- Flags are tested with `String.match` on the whole type string, mostly
  **without word boundaries** — `/SIZE/` also fires for `SIZELOG`. Entries
  with `substringMatched: true` behave that way.
- `.options()` keys `silent`, `loadsilent`, `panHidden`, `hideOnPan`, … are
  matched case-insensitively as substrings (`match: "ci-substring"`); the
  rest go to `setFeatures`, an exact `switch`.
- `.meta()` is merged into `style` by `htmlgui.js`, so any style key is valid
  in meta.
- Unknown binding keys and unknown flags are silently ignored by flat — the
  reason this checker exists.

### gl status

`impl` (gl reads it), `inert` (in `KNOWN_INERT_FLAGS`), `implicit` (gl
behaves that way without testing the keyword — overlay note says how),
`missing`. The status is derived from what gl's source *reads*, not from
rendering equivalence: `impl` means "handled", not "pixel-identical to flat".
`glOnly` in the generated file lists gl reads flat doesn't know — review
them into `glExtensions` (real extensions) or `glInternal` (noise) in the
overlay.
