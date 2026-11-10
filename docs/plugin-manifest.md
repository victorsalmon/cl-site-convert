# Plugin manifest v1.1

The contract a plugin declares so the pipeline can load it without knowing its
internals. Canonical shape: `schemas/plugin-manifest.schema.json`. Conformance:
`src/conformance/plugin-manifest.ts`, run as `pnpm validate:plugins` and in
`tests/plugin-conformance.test.ts`. Worked example: `plugins/_template`.

A manifest is **self-describing and role-bearing**. `emits` alone could not tell
a source adapter from an emitter, `sinks` was a comment with no consequence, and
`hooks` named a handler the pipeline had no declared way to reach. v1.1 makes
those machine-checkable and leaves every v1.0.0 document valid.

## Two contract versions, chosen explicitly

| `manifestVersion` | Contract |
| :--- | :--- |
| absent or `"1.0.0"` | The frozen v1.0.0 contract: `irRange`, `entrypoint` as a path, `sinks` descriptive. `role`, `consumes`, `acceptsIrRange` and `producesIrRange` are **rejected** — a v1.0.0 manifest cannot half-upgrade. |
| `"1.1.0"` | `role` is required and decides which IR direction and artifact kinds the manifest must declare; the hook load surface is explicit. `irRange` is rejected: the direction must be stated. |

The additive fields (`entrypoint` object form, asset integrity and bundles,
`config`) are accepted by **both** versions, so no v1.0.0 manifest has to change
to keep working. See the migration note at the end.

## Fields

| Field | Required | Meaning |
| :--- | :--- | :--- |
| `manifestVersion` | v1.1 | `"1.1.0"` opts into the v1.1 rules. Absent means v1.0.0. |
| `name` | yes | Plugin id, kebab-case, unique per repository. |
| `version` | yes | Semver of the plugin's own behaviour, independent of the IR it speaks. |
| `role` | v1.1 | `source` \| `emitter` \| `sink` \| `deployer`. Decides the rules below. |
| `acceptsIrRange` | emitter, sink | Semver range of Site IR versions the plugin can **read**. Must accept `IR_VERSION` from `src/schema/site-ir.ts`. |
| `producesIrRange` | source | Semver range of Site IR versions the plugin **emits**. Must accept `IR_VERSION`. |
| `irRange` | v1.0 only | v1.0.0's one-direction-less range. Rejected in v1.1 so the conflation cannot survive. |
| `emits` | yes | Artifact kinds produced: `site-ir`, `static-html`, `islands-wasm`, `api-functions`, `deployment`, `capability-report`. |
| `consumes` | v1.1 | Artifact kinds read. Also `form-submission`, which is a sink's real input. |
| `sinks` | sink | Submission targets: `webhook`, `pabbly`, `email-ses`, `sheets-direct`. |
| `hooks` | yes | `phase:name` hooks (`capture\|emit\|deploy\|sink`). Each must be a function on the declared hooks export. |
| `entrypoint` | v1.1 object | `{ module, hooksExport }`. The v1.0 string form (a module path, export assumed `hooks`) is still accepted, but v1.1 requires the object. |
| `assets` | yes | Files or bundle directories, with optional integrity (below). |
| `runbook` | yes | Plugin-relative markdown runbook. |
| `configSchema` | no | Plugin-relative JSON Schema for the plugin's config. |
| `config` | with `configSchema` | Exactly one of `path` (a `.json` document) or `inline` (the document). |

## Rules by role

`role` is not a label; it is the switch that makes the rest checkable. All of the
following are schema rules, so a violation fails `pnpm validate:ir` as well as
`pnpm validate:plugins`.

| Role | `consumes` must contain | `emits` must contain | IR range | `sinks` |
| :--- | :--- | :--- | :--- | :--- |
| `source` | nothing (must be `[]`) | `site-ir` | `producesIrRange` required, `acceptsIrRange` forbidden | forbidden |
| `emitter` | `site-ir` | `static-html` or `islands-wasm` | `acceptsIrRange` required, `producesIrRange` forbidden | forbidden |
| `sink` | `form-submission` | `api-functions` | `acceptsIrRange` required, `producesIrRange` forbidden | at least one, required |
| `deployer` | one of `static-html`, `islands-wasm`, `api-functions` | `deployment` | neither field (a deployer speaks no IR) | forbidden |

Two consequences worth stating:

- **A sink needs a server function.** A form island posts to a Pages Function;
  there is no path from a static page to Pabbly without one. A sink that does not
  emit `api-functions` is a manifest error, not a later surprise.
- **`sinks` is not a comment.** Declaring a submission target makes the plugin a
  sink, and a sink must declare its target. The two halves are checked together.

## Hook load surface

`hooks` names what the pipeline calls; `entrypoint` now says where to find it:

```json
"entrypoint": { "module": "index.mjs", "hooksExport": "hooks" }
```

The async harness (`runPluginConformanceAsync`, which `pnpm validate:plugins`
runs) imports the module and proves:

1. the module loads at all (`entrypoint-unloadable` when it throws);
2. the named export is an object (`hook-export-missing` when it is absent);
3. every declared hook is a function on that object
   (`hook-export-missing`, path `index.mjs#hooks`).

A hook declared but not exported used to fail at the first pipeline call, long
after the gate went green. It now fails the gate.

## Assets: files, bundles and integrity

```jsonc
// A file asset may declare its integrity.
{ "path": "fixtures/golden-page.json", "kind": "fixture",
  "sha256": "8ebe96…", "bytes": 186 }

// A bundle is a directory; each member carries its own integrity and path
// (relative to the bundle, so the bundle can move).
{ "path": "templates", "kind": "template", "type": "directory",
  "files": [
    { "path": "page.html", "sha256": "bbbb…", "bytes": 1024 },
    { "path": "partials/header.html", "sha256": "cccc…", "bytes": 256 }
  ] }

// A Wasm bundle member must also declare its compressed size.
{ "path": "pkg", "kind": "wasm", "type": "directory",
  "files": [{ "path": "island.wasm", "sha256": "dddd…", "bytes": 204800,
              "brotliBytes": 96000 }] }
```

Schema rules: `type: "directory"` requires `files`; a file asset forbids it; a
`kind: "wasm"` asset must declare `sha256`, `bytes` and `brotliBytes` (per member
for a bundle); `brotliBytes`/`sha256` require `bytes`.

Harness rules (a declared number is a claim, re-measuring is the evidence):

- `sha256` and `bytes` are recomputed from the bytes on disk;
- `brotliBytes` is recomputed with brotli **quality 11** — the same measurement
  `scripts/wasm-size.mjs` uses for the **< 250 KB per-bundle budget**, so the
  manifest can carry the number the size gate decides on;
- a declared `directory` that is a file, and a bundle member outside the bundle,
  are both `asset-type-mismatch`.

Integrity is optional for a plain file and for an `optional` asset (which may be
absent on a fresh checkout); it is mandatory for Wasm.

## Config

`configSchema` used to name a schema and never the document. v1.1 requires the
document too, and the harness validates it:

```json
"configSchema": "config.schema.json",
"config": { "path": "config.example.json" }   // or { "inline": { … } }
```

- Exactly one of `path` / `inline` (`config-invalid` / schema rejection otherwise).
- `configSchema` present ⇒ `config` required, and `config` present ⇒
  `configSchema` required. A loader can always resolve **and** validate.
- A `path` document is read and validated against `configSchema`; an unreadable
  file, unparsable JSON, uncompilable schema, or a document that violates the
  schema is `config-invalid`.

## What is enforced where

| Check | Schema (`validate:ir`) | Sync harness (`validate:plugins`) | Async harness |
| :--- | :---: | :---: | :---: |
| role / consumes / emits / range / sinks linkage | ✅ | | |
| reachable `IR_VERSION` for the declared direction | | ✅ | |
| referenced files and bundle members exist | | ✅ | |
| asset `sha256` / `bytes` / `brotliBytes` are true | | ✅ | |
| config resolves and validates | | ✅ | |
| entrypoint loads, hooks export exists, every hook is callable | | | ✅ |

## Migration: v1.0.0 → v1.1.0

Optional for an existing plugin, required for a new one. `plugins/_template` has
migrated; `tests/fixtures/plugin-manifest/wordpress.valid.json` is deliberately
left **untouched** so the additive claim stays proven on every run.

1. Add `"manifestVersion": "1.1.0"`.
2. Add `"role"`. Pick the seam honestly — it changes which fields are required.
3. Replace `irRange` with the direction the role requires:
   `acceptsIrRange` (emitter/sink) or `producesIrRange` (source). A source that
   produces `1.1.0` writes `"^1.1.0"`; an emitter that reads any v1 writes
   `"^1.0.0"`.
4. Add `consumes` — `[]` for a source, `["site-ir"]` for an emitter,
   `["form-submission"]` for a sink, the built artifacts for a deployer.
5. Replace `"entrypoint": "index.mjs"` with
   `"entrypoint": { "module": "index.mjs", "hooksExport": "hooks" }`, and make
   sure that export really holds a function per declared hook.
6. If `configSchema` is declared, add `config` (`path` or `inline`).
7. Optionally add `sha256`/`bytes` (and `brotliBytes` for Wasm) to assets, or
   turn a template directory into a `type: "directory"` bundle.

Nothing else in v1.0.0 is invalidated: `name`, `version`, `emits`, `hooks`,
`assets`, `runbook`, `configSchema` and the v1.0 string `entrypoint` all keep
their meaning, and the schema still accepts a v1.0.0 manifest exactly as written.

## Deliberately deferred

- **A plugin-level `permissions` / capability grant** (filesystem, network,
  secrets). Nothing runs untrusted plugin code yet, so the shape would be a guess.
- **Per-hook argument and return schemas.** The hook names and their load surface
  are checkable today; the payload contract lives in the pipeline's TypeScript
  types until there is a second implementation to agree with.
- **Signed assets / a trust chain** beyond content hashes. Hashes prove the bytes
  did not change; they do not prove who produced them.
- **Rust-side manifest types.** The pipeline loads manifests from TypeScript only;
  `crates/` carries the Site IR, not plugin contracts.
- **Automatic migration of an existing v1.0.0 manifest.** The migration is written
  down and tested, not automated: deciding a `role` is a judgement call about
  which seam a plugin occupies, and guessing it would be the same class of error
  as inferring a form from a path pattern.
