# Plugin template

The smallest plugin that conforms to `schemas/plugin-manifest.schema.json` and
actually runs. Copy this directory to `plugins/<vendor>/`, rename `name`, and
replace the bodies of `index.mjs`. If `pnpm run validate:plugins` passes, the
pipeline can load it.

## Manifest fields (`plugin.json`)

| Field | One line |
| :--- | :--- |
| `name` | Plugin id, kebab-case and unique in this repo; it is how the pipeline and its logs refer to you. |
| `version` | Semver of this plugin's own behaviour, independent of the IR version it speaks. |
| `irRange` | Semver range of Site IR versions you accept or produce; it must accept `IR_VERSION` from `src/schema/site-ir.ts`. |
| `emits` | Which artifact kinds you produce (`site-ir`, `static-html`, `islands-wasm`, `api-functions`, `deployment`, `capability-report`). |
| `sinks` | Submission targets you emit or consume (`webhook`, `pabbly`, `email-ses`, `sheets-direct`); omit unless you are a form sink. |
| `hooks` | The `phase:name` lifecycle handlers the pipeline will call, in `capture|emit|deploy|sink` phases. |
| `assets` | Files you ship beside your code; `optional: true` means the file may be absent on a fresh checkout. |
| `runbook` | Plugin-relative path to your operator runbook (markdown). |
| `configSchema` | Plugin-relative path to the JSON Schema for your config block. |
| `entrypoint` | Plugin-relative path to the module the pipeline imports to reach your `hooks` record. |

## Load contract

`index.mjs` publishes one record keyed by the manifest's hook names:

```js
export const hooks = {
  "capture:start": captureStart,
  "capture:page": capturePage,
  "capture:end": captureEnd,
};
```

Every hook the manifest declares must appear in that record. The handlers share
one mutable context (`captureStart` creates it, `capturePage` fills it,
`captureEnd` returns the assembled Site IR), and they reject input they cannot
handle instead of emitting a degraded result.

## Files

| File | Why |
| :--- | :--- |
| `plugin.json` | The manifest the conformance harness validates. |
| `index.mjs` | The entrypoint and `hooks` record. |
| `config.schema.json` | Configuration schema referenced by `configSchema`. |
| `config.example.json` | A working config, shipped as an `assets` entry. |
| `fixtures/golden-page.json` | Input fixture for `capturePage`, shipped as an `assets` entry. |
| `runbook.md` | Stub; the full authoring runbook is bead B4.4. |

`fixtures/golden-form.json` is declared in `assets` with `"optional": true` and is
deliberately absent: it shows that an optional asset is allowed to be missing
while a required one is not.

## Checking your plugin

```powershell
pnpm run validate:plugins   # manifest schema + referenced files + irRange
pnpm test                   # includes tests/plugin-conformance.test.ts
```
