# Plugin template

The smallest plugin that conforms to `schemas/plugin-manifest.schema.json` and
actually runs. Copy this directory to `plugins/<vendor>/`, rename `name`, and
replace the bodies of `index.mjs`. If `pnpm run validate:plugins` passes, the
pipeline can load it.

This template is the canonical **v1.1.0** example. The full contract, the rules
per role and the v1.0.0 → v1.1.0 migration are in `docs/plugin-manifest.md`.

## Manifest fields (`plugin.json`)

| Field | One line |
| :--- | :--- |
| `manifestVersion` | `"1.1.0"`. Declares which contract this manifest is written against; absent means the frozen v1.0.0 contract. |
| `name` | Plugin id, kebab-case and unique in this repo; it is how the pipeline and its logs refer to you. |
| `version` | Semver of this plugin's own behaviour, independent of the IR version it speaks. |
| `role` | The seam you sit on: `source`, `emitter`, `sink` or `deployer`. It decides which IR direction and artifact kinds are required. |
| `producesIrRange` | Source only: the Site IR range you emit; it must accept `IR_VERSION` from `src/schema/site-ir.ts`. |
| `acceptsIrRange` | Emitter and sink: the Site IR range you read; it must accept `IR_VERSION`. |
| `emits` | Artifact kinds you produce. A source emits `site-ir`, an emitter `static-html`/`islands-wasm`, a sink `api-functions`, a deployer `deployment`. |
| `consumes` | Artifact kinds you read — `[]` for a source, `["site-ir"]` for an emitter, `["form-submission"]` for a sink. |
| `sinks` | Submission targets (`webhook`, `pabbly`, `email-ses`, `sheets-direct`). Required for a sink, rejected for every other role. |
| `hooks` | The `phase:name` lifecycle handlers the pipeline will call, in `capture\|emit\|deploy\|sink` phases. |
| `entrypoint` | `{ "module": …, "hooksExport": … }`: the module and the export holding your hook record. Both are checked. |
| `assets` | Files or bundle directories you ship, with optional `sha256`/`bytes`/`brotliBytes`; a bundle uses `"type": "directory"` plus `files[]`. |
| `runbook` | Plugin-relative path to your operator runbook (markdown). |
| `configSchema` | Plugin-relative path to the JSON Schema for your config block. |
| `config` | Where the config actually is, so a loader can resolve it: `{ "path": "config.example.json" }` or `{ "inline": { … } }`. |

## Load contract

`index.mjs` publishes one record keyed by the manifest's hook names, and the
manifest names that record:

```json
"entrypoint": { "module": "index.mjs", "hooksExport": "hooks" }
```

```js
export const hooks = {
  "capture:start": captureStart,
  "capture:page": capturePage,
  "capture:end": captureEnd,
};
```

Every hook the manifest declares must be a function in that record — the
conformance harness imports the module and checks it, so a declared-but-missing
handler fails the gate instead of the first pipeline call. The handlers share one
mutable context (`captureStart` creates it, `capturePage` fills it, `captureEnd`
returns the assembled Site IR), and they reject input they cannot handle instead
of emitting a degraded result.

## Files

| File | Why |
| :--- | :--- |
| `plugin.json` | The manifest the conformance harness validates. |
| `index.mjs` | The entrypoint and `hooks` record. |
| `config.schema.json` | Configuration schema referenced by `configSchema`. |
| `config.example.json` | A working config, declared as `config.path` and shipped with its `sha256`/`bytes`. |
| `fixtures/golden-page.json` | Input fixture for `capturePage`, shipped as an asset with its `sha256`/`bytes`. |
| `runbook.md` | Stub; the full authoring runbook is bead B4.4. |

`fixtures/golden-form.json` is declared in `assets` with `"optional": true` and is
deliberately absent: it shows that an optional asset is allowed to be missing
while a required one is not.

## Checking your plugin

```powershell
pnpm run validate:plugins   # schema + files + asset hashes + config + hooks + IR range
pnpm test                   # includes tests/plugin-conformance.test.ts
```

If you edit `config.example.json` or `fixtures/golden-page.json`, the asset
integrity check will fail until you update the matching `sha256`/`bytes` entries.
That is the check working: a written hash is a claim, and the harness re-measures.
