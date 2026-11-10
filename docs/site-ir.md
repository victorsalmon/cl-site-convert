# Site IR v1

The intermediate representation every source adapter produces and every emitter
consumes. Canonical shape: `schemas/site-ir.schema.json` (JSON Schema draft
2020-12). TypeScript: `src/schema/site-ir.ts`. Rust: `crates/site-ir`.

`irVersion` is `1.x.y`. A breaking change means a new schema file, not a widened
one — this document describes v1 and nothing else.

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

## Fields

| Field | Required | Meaning |
| :--- | :--- | :--- |
| `irVersion` | yes | Semver of the IR shape; only `1.x.y` is accepted here. |
| `site` | yes | `baseUrl`, `title`, `locale` (WP locale, e.g. `en_CA`), `permalinks.structure` (`/%postname%/`). Optional `subsites[]` for multi-site captures (`{id, path, title}`), `description`. |
| `pages[]` | yes | One entry per routable document. `url` (site-relative, leading `/`), `slug`, `status`, `template` (captured template id, `""` if none), `dom`. Optional `subsite` (references `site.subsites[].id`), `title`, `meta`, `seo`, `islands`, `proseMarkdown`. |
| `assets[]` | yes | Downloaded blobs. `sourceUrl`, `localPath`, `sha256`, `kind` (`image`/`font`/`script`/`document`/`media`/`other`). Optional `bytes`, `contentType`, `referencedBy`. CSS is **not** here. |
| `styles[]` | yes | The ordered CSS chain. `href` (as captured), `localPath`, `sha256` (hash of the shipped bytes), `order` (0-based, unique). Optional `media`, `subsite`. Emitters link these in ascending `order`, byte-identical. |
| `menus[]` | no | `id`, `name`, `items[]`; items nest via `children[]`. |
| `taxonomies[]` | no | `name` (WP key: `category`, `post_tag`), `terms[]` (`slug`, `name`, optional `parent`). |
| `authors[]` | no | `id`, `slug`, `name`, optional `bio`, `avatarPath`. |
| `forms[]` | no | `id`, `source` (captured plugin), `fields[]`, `submitContract`. A field keeps its submitted `name` exactly — the sink envelope depends on it. `submitContract` = `{sink, endpointRef, honeypot?, turnstile?}` and points at the wire contract that must survive; it never references PHP. |
| `behaviors[]` | no | Captured interactions that static HTML cannot express: `page`, `selector` (present in that page's `dom`), `kind`, optional `endpointRef`, `islandId`, `options`. |
| `apiContracts[]` | no | `id`, `method`, `url`, optional `requestShape`/`responseShape` (free-form JSON, see Deferred), `headers`, `notes`. |
| `capabilities` | yes | `supported[]` and `unsupported[]`. Each unsupported entry is `{capability, detail?, blocking?, where?[]}`. This is how an adapter **fails loudly**: `blocking: true` means the conversion cannot be faithful until it is resolved. Never silently degrade. |
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

### Referential rules (validator-enforced, schema cannot)

- `page.subsite` ∈ `site.subsites[].id`
- `page.url` unique; `page.islands[].id` unique per page
- `style.order` unique
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

## Deferred to v1.1

Deliberately absent. Leave them out rather than half-encoding them:

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
