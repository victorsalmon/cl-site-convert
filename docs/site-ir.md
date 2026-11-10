# Site IR v1.1

The intermediate representation every source adapter produces and every emitter
consumes. Canonical shape: `schemas/site-ir.schema.json` (JSON Schema draft
2020-12). TypeScript: `src/schema/site-ir.ts`. Rust: `crates/site-ir`.

`irVersion` is `1.x.y`. A breaking change means a new schema file, not a widened
one — this document describes v1 and nothing else.

**v1.1 is additive.** It adds three optional things — `style.origin`,
`capabilities.unsupported[].evidence[]` and the top-level `securityFindings[]` —
and grandfathers the one field it has to relax (`style.href`, now required only
for linked styles). **Every v1.0 document remains valid, unchanged**, which the
committed `capture/site-ir.json` proves on every `pnpm validate:ir` run and in
`tests/site-ir-schema.test.ts`. A v2 shape still means a new schema file.

## The two rules that must never be broken

1. **`dom` is the fidelity carrier.** `dom.html` is a normalized HTML skeleton,
   and **class names are preserved byte-for-byte**. Emitters render it; they do
   not re-author it into a component tree, rename classes, or "tidy" markup.
   Only an island's own subtree may be replaced by a mount slot.
2. **Markdown is only an optional prose projection, never the IR.** It appears
   solely as `page.proseMarkdown`, for search or editing. No emitter may read it,
   and no adapter may treat it as the page body: Markdown cannot carry nested
   grid layout, page-builder wrappers, or class names.

A third rule follows from the first: **`styles` is ordered and verbatim.** There
is no pruning field and no "cleaned" variant — the schema forbids unknown
properties, so `pruned` or `cleaned` is a validation error, not a preference.
That holds for inline CSS exactly as it does for a linked file: it is shipped
byte-identical, never rewritten or merged.

## Fields

| Field | Required | Meaning |
| :--- | :--- | :--- |
| `irVersion` | yes | Semver of the IR shape; only `1.x.y` is accepted here. |
| `site` | yes | `baseUrl`, `title`, `locale` (WP locale, e.g. `en_CA`), `permalinks.structure` (`/%postname%/`). Optional `subsites[]` for multi-site captures (`{id, path, title}`), `description`. |
| `pages[]` | yes | One entry per routable document. `url` (site-relative, leading `/`), `slug`, `status`, `template` (captured template id, `""` if none), `dom`. Optional `subsite` (references `site.subsites[].id`), `title`, `meta`, `seo`, `islands`, `proseMarkdown`. |
| `assets[]` | yes | Downloaded blobs. `sourceUrl`, `localPath`, `sha256`, `kind` (`image`/`font`/`script`/`document`/`media`/`other`). Optional `bytes`, `contentType`, `referencedBy`. CSS is **not** here. |
| `styles[]` | yes | The ordered CSS chain: linked stylesheets **and** inline `<style>` blocks in one sequence. `localPath`, `sha256` (hash of the shipped bytes), `order` (0-based). Optional `origin` (`linked`/`inline`, absent ⇒ `linked`), `media`, `subsite`. `href` is required **unless** `origin` is `inline`. Emitters emit in ascending `order`, byte-identical. |
| `menus[]` | no | `id`, `name`, `items[]`; items nest via `children[]`. |
| `taxonomies[]` | no | `name` (WP key: `category`, `post_tag`), `terms[]` (`slug`, `name`, optional `parent`). |
| `authors[]` | no | `id`, `slug`, `name`, optional `bio`, `avatarPath`. |
| `forms[]` | no | `id`, `source` (captured plugin), `fields[]`, `submitContract`. A field keeps its submitted `name` exactly — the sink envelope depends on it. `submitContract` = `{sink, endpointRef, honeypot?, turnstile?}` and points at the wire contract that must survive; it never references PHP. |
| `behaviors[]` | no | Captured interactions that static HTML cannot express: `page`, `selector` (present in that page's `dom`), `kind`, optional `endpointRef`, `islandId`, `options`. |
| `apiContracts[]` | no | `id`, `method`, `url`, optional `requestShape`/`responseShape` (free-form JSON, see Deferred), `headers`, `notes`. |
| `capabilities` | yes | `supported[]` and `unsupported[]`. Each unsupported entry is `{capability, detail?, blocking?, where?[], evidence?[]}`. This is how an adapter **fails loudly**: `blocking: true` means the conversion cannot be faithful until it is resolved. Never silently degrade. |
| `securityFindings[]` | no | Security observations about the **source** site: `id`, `kind`, `detail`, `blocking`, optional `where?[]`. Not a conversion blocker unless `blocking: true`, and never a place to hide a capability gap. |
| `redirects[]` | no | `from` (site-relative), `to` (path or absolute URL), `code` ∈ `301, 302, 307, 308`. |
| `capture` | no | Provenance: `sourceAdapter`, `capturedAt`, optional `toolVersion`, `notes`. Recommended so two captures can be diffed. |

### Islands

`page.islands[]` holds mount records only: `{id, component, props}`. `id` is the
mount slot id (`island-...`). `component` is a PascalCase name the Wasm bundle
resolves at runtime. `props` is opaque JSON.

The IR **never** encodes Rust component internals — no module paths, no field
names, no hydration strategy. `--emit islands` must be `--emit static` plus mount
slots and lazily loaded bundles; if the IR carried component internals, static
output could not be an honest baseline.

### Styles: linked and inline (v1.1)

`styles[]` is one ordered chain, not a list of files. Each entry says where its
CSS came from:

| `origin` | `href` | Meaning |
| :--- | :--- | :--- |
| absent (v1.0 shape) | **required** | A linked stylesheet. Absent is read as `linked`. |
| `"linked"` | **required** | Same entry, written explicitly. |
| `"inline"` | **must be omitted** | A `<style>` block from the captured document. It has no url. |

`order` is **document position across both kinds** — a page that ships
`<link>`, `<style>`, `<link>` produces `order` 0, 1, 2 in that sequence. An
emitter must not emit all links first and then all inline blocks, or the cascade
changes and the page drifts.

`sha256` and `localPath` are required for inline entries too. The CSS must still
be materialised as bytes with a recorded hash, so "verbatim hand-off" stays
provable; `origin` only removes the *url* requirement. Divi 4.27.7 emits 5–14
inline blocks per page (~1.77 MB across 19 pages), so this is the difference
between a page with its critical CSS and one without.

### Capability evidence (v1.1)

`capabilities.unsupported[].evidence[]` holds the machine-checkable proof for a
finding, so the proof does not live in prose inside `detail`:

```json
{ "kind": "rest-namespace", "value": "litespeed/v1", "source": "/wp-json/" }
{ "kind": "dom-marker", "value": "et_pb_section", "source": "/care/" }
{ "kind": "rest-endpoint", "value": "/wp-json/wp/v2/users", "source": "/wp-json/" }
```

`kind` ∈ `rest-namespace`, `dom-marker`, `rest-endpoint`. `value` is the literal
token — never a paraphrase. `source` is where it was observed. `detail` still
carries the human explanation; `evidence` carries the citation.

### Security findings (v1.1)

`securityFindings[]` describes the **source** site, not the conversion:
`{id, kind, detail, blocking, where?[]}`.

- `id` — stable slug, e.g. `public-user-endpoint`.
- `kind` — finding class, e.g. `public-user-enumeration`, `exposed-debug`.
- `detail` — what is exposed, in plain words.
- `blocking` — `true` only when the emitted site must not be published from this
  IR until it is resolved. A finding about the *old* host is usually `false`.
- `where` — affected routes, omitted for site-wide findings.

The upsalehavens capture's open `/wp-json/wp/v2/users` endpoint is the founding
example: it is a live security finding about the WordPress install, not a
capability the converter lacks, so it belongs here rather than in
`capabilities.unsupported[]`.

### Referential rules (validator-enforced, schema cannot)

- `page.subsite` ∈ `site.subsites[].id`
- `page.url` unique; `page.islands[].id` unique per page
- `style.order` unique, counted across linked **and** inline entries
- `form.submitContract.endpointRef` and `behavior.endpointRef` ∈
  `apiContracts[].id`
- `behavior.page` and `behavior.islandId` resolve on the same page

## Conformance

```powershell
node scripts/validate-ir.mjs
```

Fixtures live in `tests/fixtures/site-ir/` and `tests/fixtures/plugin-manifest/`.
A file containing `.valid.` must validate; every other fixture must be rejected.
The script exits `1` on a mismatch and `2` when it cannot evaluate (ajv missing),
never a false pass.

## Deferred beyond v1.1

v1.1 added only the additive fields above (`style.origin`, `evidence[]`,
`securityFindings[]`). The rest is still deliberately absent. Leave them out
rather than half-encoding them:

- **Page ↔ term assignment** (`page.terms[]`) and generated term-archive routes.
  v1 captures concrete pages only.
- **Page hierarchy** (`parentUrl`, menu order) — menus carry the shape for now.
- **Formal wire-shape language** for `apiContracts.requestShape/responseShape`;
  v1 stores free-form JSON Schema-shaped objects.
- **Per-page stylesheet overrides** and critical-CSS/order hints.
- **Asset rewriting** (`srcset`, responsive variants) — assets are captured files.
- **Hydration/timing hints** for islands (`idle`/`visible`/`load`), and behavior
  timing.
- **i18n/hreflang** and per-locale page variants.
- **File-upload storage** for forms (object storage + link).
- **Redirect priority/regex matching**; v1 is exact-path only.
- **Cache/header policy** — belongs to the deployer, not the IR.
- **Consent/cookie script inventory.**
