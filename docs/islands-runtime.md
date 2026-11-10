# Islands runtime contract

Measured evidence and the executable contract for bead **B3.2**
(`cl-site-convert-fcx`): *one Wasm module per plugin crate, lazily loaded only
when its mount node exists, and no bootloader emitted on island-free pages.*

`docs/00-ARCHITECTURE.md` and `docs/wasm-build.md` are owned elsewhere and were
not edited by this bead. This file is the runtime half they point at.

## The problem this replaces

A single merged `site_wasm.wasm` loaded on every page ships every island to
every page. A one-line Divi brochure page pays for a form island, a search
island and a consent banner it will never mount. The fidelity win of
WordPress → static is measured in bytes and paint time; a monolithic Wasm
payload hands a chunk of it back.

## The strategy, in one line

```
crate  ==  bundle  ==  one component  ==  one data-component value
```

- An **island crate** is a workspace crate under `crates/` with
  `crate-type = ["cdylib", …]`.
- It declares the component it provides in its own `Cargo.toml`:

  ```toml
  [package.metadata.island]
  component = "FluentForm"
  ```

- `scripts/wasm-size.mjs` builds the crate, measures it, copies it to
  `dist/pkg/<crate-name>.wasm`, and writes `dist/pkg/manifest.json`.
- An **emitter** ships only the bundles the page mounts
  (`bundlesForHtml`), plus the loader, plus an inlined manifest.
- The **loader** loads, per page, exactly one bundle for each distinct
  `data-component` present — and nothing when none is present.

Nothing in this chain is a hand-maintained list. Adding an island crate needs no
edit to the gate, the emitter or the loader; it needs its own `component`
declaration.

## Mount slot shape

```html
<div
  id="island-fluent-form"
  data-component="FluentForm"
  data-props='{"formId":3,"source":"apply"}'
></div>
```

| Part | Rule |
| :--- | :--- |
| element | Any element. A `div` is the default; an island that replaces a block-level region does not need to re-author the captured skeleton. |
| `id` | `island-{kebab-component}`. Not read by the runtime — it exists so a human, a test and the visual diff can address the slot. |
| `data-component` | **Required.** `^[A-Z][A-Za-z0-9]*$`. This is the manifest key and the only thing that selects a bundle. |
| `data-props` | Optional. A JSON **object**. Absent means `{}`. |
| content | Empty. The island owns its subtree after mount; the static HTML baseline owns everything outside it. |

`--emit static` never writes these attributes, so a page is island-bearing only
because the emitter said so. `--emit islands` is the static baseline **plus**
these slots, which is what keeps Wasm additive and revertible per page
(`docs/01-DECISIONS.md`, 2026-11-10).

## Bundle naming

| Artifact | Name | Why |
| :--- | :--- | :--- |
| Cargo artifact | `target/wasm32-unknown-unknown/release/islands_core.wasm` | Cargo's own rule (hyphens become underscores). Never shipped. |
| Emitted bundle | `dist/pkg/islands-core.wasm` | The crate name, which is already kebab-case and URL-safe. One naming scheme, no second mapping. |
| Manifest | `dist/pkg/manifest.json` | Generated on every gate run; never hand-edited. |
| Loader | `dist/pkg/loader.js` | `tsc` output of `src/runtime/loader.ts`, copied verbatim. |

There is exactly one bundle file per island crate, and exactly one manifest key
per bundle. The gate fails if a crate declares no component, declares a name
that is not an identifier, or shares a component name with another crate.

## The manifest

```jsonc
{
  "manifestVersion": 1,
  "target": "wasm32-unknown-unknown",
  "budgetBrotliBytes": 256000,
  "components": {
    "IslandsCore": {
      "crate": "islands-core",
      "wasmPath": "islands-core.wasm",
      "rawBytes": 129,
      "brotliBytes": 100,
      "sha256": "35be3728…"
    }
  }
}
```

`componentName -> { wasmPath, brotliBytes, sha256 }` is the minimum a page needs.
`crate` and `rawBytes` are there so a deploy report and a size report can be
produced from the manifest alone.

`modulePath` is the extension point for `wasm-bindgen`: when a bundle ships JS
glue, the emitted manifest records it, and the loader `import()`s that module
instead of fetching the `.wasm`. The manifest shape does not change.

### Anti-staleness

`dist/` is generated output, so "stale" can only mean "the build did not
regenerate it". `pnpm gate` runs `validate:wasm-size` on every invocation, and
that step:

1. rebuilds every island crate (never trusts `target/`);
2. measures raw and brotli bytes and hashes the exact bytes;
3. sweeps any `.wasm` in `dist/pkg/` that no crate produces;
4. writes the bundle copies and `manifest.json`;
5. **re-reads `manifest.json` from disk and re-hashes every emitted file**,
   failing as `cannot-evaluate` if any size, path or sha256 disagrees.

Step 5 is the difference between "we wrote a file" and "the shipped bytes match
the contract". A written file is a claim; a re-read and re-hash is evidence.

## Loader behaviour

`src/runtime/loader.ts` → `dist/pkg/loader.js`. Plain ES module, **zero runtime
imports** (only `import type`, which `tsc` erases), no bundler assumptions. A test
asserts that property on the source so a future edit cannot quietly add a module
graph to the browser contract.

```ts
import { startIslands } from "/pkg/loader.js";

await startIslands(document, { manifest: window.__ISLANDS_MANIFEST__ });
// or, when the emitter does not inline the manifest:
await startIslands(document, { manifestUrl: "/pkg/manifest.json" });
```

### Order of operations

1. **Collect** `[data-component]` nodes.
2. **Zero-network exit** — if there are none, return `status: "no-islands"`
   immediately. This is above the manifest fetch and above every `await` that
   could reach the network, so it cannot be bypassed by an option.
3. **Resolve the manifest** — the inlined object if given, otherwise one fetch of
   `manifestUrl`. A failure here is reported and no bundle is loaded.
4. **Parse props** for every node. A node with unparseable props is rejected
   *before any bundle is fetched*, so a component whose mounts are all broken
   costs zero bytes.
5. **Look up** one entry per distinct component. A present component with no
   manifest entry is a loud `console.error` plus
   `data-island-state="bundle-missing"` — never a skip.
6. **Load** one bundle per distinct present component, in document order.
7. **Check the ABI** — a bundle exporting `islands_core_abi_version` with a
   version other than `LOADER_ABI_VERSION` is refused.
8. **Mount** each node: `mount(node, props)` when the bundle (or its glue
   module) exports one; otherwise mark the node `loaded`.

### `data-island-state`

Every mount node ends in exactly one state, so a page's behaviour is inspectable
without reading the console:

| State | Meaning |
| :--- | :--- |
| `mounted` | The bundle exported and ran `mount(node, props)`. |
| `loaded` | The bundle loaded and passed the ABI check but exports no `mount` — the honest pre-`wasm-bindgen` state. |
| `component-invalid` | `data-component` is not an identifier. Reported, not coerced. |
| `props-invalid` | `data-props` is empty, not JSON, or not a JSON object. Reported; bundle not fetched. |
| `bundle-missing` | The page mounts it; the manifest has no entry. Reported loudly. |
| `load-failed` | Fetch/instantiate/import threw. Other components still mount. |
| `abi-mismatch` | Host and bundle disagree on the mount-slot ABI. Refused. |
| `mount-failed` | `mount()` threw. Reported, not swallowed. |

## The "no islands ⇒ no wasm bytes" guarantee

Two independent mechanisms, because a guarantee with one proof is a wish:

1. **Emitter side (data).** `bundlesForHtml(html, manifest)` returns `[]` for
   HTML with no mount slots. The emitter ships loader, manifest and bootloader
   only when that array is non-empty. An empty page therefore has nothing to
   emit.
2. **Runtime side (network).** `startIslands` returns `status: "no-islands"`
   before resolving the manifest. Even if a bootloader were somehow emitted onto
   an island-free page, it would issue zero requests.

`tests/islands-loader.test.ts` asserts the runtime half with a recording fake
`fetch`:

```
islands bundle load proof (fixture manifest: 4 components)
  page             mounts  bundle fetches  which
  island-free           0               0  (none)
  two-mount             2               2  fluent-form.wasm, search-box.wasm
  repeated-mount        2               1  fluent-form.wasm
```

The fixture manifest deliberately has **four** components so "only these, not the
others" is a real assertion rather than a tautology: `consent-banner.wasm` and
`islands-core.wasm` are asserted absent, and the manifest URL is asserted never
fetched.

`tests/islands-mounts.test.ts` asserts the emitter half against Divi-shaped HTML
(deep nesting, inline CSS, a `data-component` string inside a `<script>`), which
must yield `[]`.

## What the gate prints today

```
building islands-core for wasm32-unknown-unknown (release)
  cargo 1.99.1  target=wasm32-unknown-unknown

component    crate                  raw        brotli        budget  sha256        verdict
-------------------------------------------------------------------------------------------
IslandsCore  islands-core         129 B         100 B    < 250.0 KB  35be3728bda3…  PASS  (100.0% headroom)

1/1 bundle(s) under the 250.0 KB brotli budget (brotli quality 11)
manifest: …/dist/pkg/manifest.json — 1 component(s), verified against the emitted bytes on disk
```

One crate exists so far (`crates/islands-core`), so the table has one row. The
mapping is crate-derived, not hardcoded: a temporary probe crate declaring
`component = "ProbeIsland"` was added during this bead's verification, and the
manifest gained a second entry with no change to the script; the probe was then
removed and the manifest returned to one entry.

## Browser verification (deferred, by design)

The proofs above are Node tests against a recording fake network, not a browser.
That is deliberate: the load **set** — exactly these two, never those three — is
only observable when every request is recorded, and a real browser makes that
assertion harder while proving nothing extra about the logic under test.

A real browser must still be used before this is called shipped, and the honest
checklist is one page of each shape:

1. **Deploy a two-page artifact** to `*.pages.dev`: one island-free page and one
   page with two mounts.
2. **Island-free page** — open DevTools → Network, filter `wasm`, reload. Expect
   **0** `wasm` requests **and 0 requests to `/pkg/manifest.json`**. Then
   `document.querySelectorAll("[data-island-state]")` must be empty, and
   `performance.getEntriesByType("resource")` must contain no `/pkg/` entry at
   all (the bootloader `<script>` must not be emitted either).
3. **Two-mount page** — reload with `wasm` filtered. Expect exactly two `.wasm`
   requests, matching the manifest entries for the two mounted components, and
   no request for the third component's bundle. Responses must be
   `content-type: application/wasm` so `instantiateStreaming` compiles rather
   than throwing.
4. **Break it on purpose** — mutate one `data-props` to `{"formId":` and confirm
   one console error naming the component, `data-island-state="props-invalid"`
   on that node, and no request for that component's bundle.
5. **Mount a component with no bundle** — confirm the loud console error names
   the component and lists the known ones.
6. **Record the evidence** — network HAR export and a screenshot per page
   attached to the bead. A claim of "zero wasm bytes" without a HAR is a claim,
   not evidence.

The steps are also the acceptance criteria for the emitter bead that first
produces a real two-page artifact, since until then there is nothing to open in
a browser.

## Open risk

The per-bundle ceiling is enforced per bundle, and splitting harder is the
escalation path when a real island approaches 250 KB brotli
(`docs/wasm-build.md`). What this bead does **not** do:

- **No code splitting inside a bundle.** One crate is one bundle; a crate that
  grows must be split into crates, which is a deliberate structural change.
- **No preload/prefetch hints.** A hint would be a request on an island-free
  page if emitted unconditionally, so any future hint must be generated from
  `bundlesForHtml` output and tested the same way.
- **No shared runtime chunk.** `crates/islands-core` is currently a stub; when
  several islands share real runtime code, the choice is between duplicating it
  per bundle (bytes) and extracting a shared bundle (one more request). That is
  a measured decision for the first real islands, not a default.
