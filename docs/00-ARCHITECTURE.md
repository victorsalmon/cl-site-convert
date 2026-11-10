# Architecture

## Purpose

Convert a live WordPress site into a fast, static-first site that renders the
same and behaves the same, with interactive behaviour rebuilt as Rust/Wasm
islands. Output target is a choice, not a fork.

## Pipeline

```
                    ┌──────────────────────────────────────────┐
  live WP  ────────►│ source/  (wp-rest | wxr | playwright)    │
  WXR      ────────►│   route manifest                         │
  scrape   ────────►│   content + DOM skeleton                 │
                    │   assets (CSS verbatim) + URL map        │
                    │   telemetry (corroboration only)         │
                    │   capability report (fail loudly)        │
                    │   SEO surface + 301 map                  │
                    └───────────────────┬──────────────────────┘
                                        ▼
                            ┌───────────────────────┐
                            │      SITE IR v1       │  schemas/site-ir.schema.json
                            │  (frozen, versioned)  │
                            └───────┬───────────┬───┘
                                    │           │
                    ┌───────────────▼──┐   ┌────▼─────────────────┐
                    │ emit/static-html │   │ emit/islands-wasm    │
                    │  (baseline)      │   │  baseline + slots    │
                    │                  │   │  + lazy wasm bundles │
                    └────────┬─────────┘   └────┬─────────────────┘
                             │                  │
                             └────────┬─────────┘
                                      ▼
                            ┌───────────────────┐
                            │  deploy/ (artifact-push) │
                            │  cf-pages | dotcanda | s3 │
                            └───────────────────┘
```

Form submissions leave through `src/sinks/`, not through the emitter.

## Site IR — the crown jewel

Frozen at v1 before any plugin agent starts. Shape (indicative):

```jsonc
{
  "irVersion": "1.0.0",
  "site":   { "baseUrl", "title", "locale", "permalinks" },
  "pages":  [{ "url", "slug", "status", "template", "dom", "meta", "seo", "islands" }],
  "assets": [{ "sourceUrl", "localPath", "sha256", "kind" }],
  "styles": [{ "href", "localPath", "order" }],      // VERBATIM, ordered
  "menus":  [...], "taxonomies": [...], "authors": [...],
  "forms":  [{ "id", "source", "fields", "validation", "submitContract" }],
  "behaviors": [{ "page", "selector", "kind", "endpointRef" }],
  "apiContracts": [{ "method", "url", "requestShape", "responseShape" }],
  "capabilities": { "supported": [], "unsupported": [] },
  "redirects": [{ "from", "to", "code" }]
}
```

`dom` is a normalized HTML skeleton with **class names preserved**. It is the
fidelity carrier. Markdown exists only as an optional prose projection.

## Islands

- One Wasm module per plugin crate.
- Bootloader emitted **only** on pages that contain at least one island mount.
- Loader lazy-`import()`s the module for each `data-component` present.
- Mount slot: `<div id="island-{name}" data-component="{Component}" data-props="…">`.
- Size budget is a **measured gate**, not a target: < 250 KB brotli per bundle.

## Deployers

Interface: `deploy(artifactDir, config) → { url, verified }`

| Target | Trigger | Static | Functions | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `cf-pages` | `pnpm dlx wrangler pages deploy` | ✅ | ✅ Pages Functions | **MVP target** |
| `dotcanda` | `git push` to deploy remote | ✅ | ❌ | existing fleet pattern |
| `s3-cloudfront` | `aws s3 sync` + invalidation | ✅ | ❌ (Lambda@Edge) | later |

`dist/` (static) and `api/` (functions) are **separate deployables**. Nothing in
`dist/` may know which host receives it.

## Verification gates (block cutover)

1. **Visual parity** — Playwright pixel-diff, old vs new, across a viewport ×
   interaction-state matrix. Needs a reproducible old baseline (`wp-env`).
2. **Performance** — Lighthouse CI vs the *captured* baseline; block on regression.
3. **Structure** — `html-validate` + `linkinator` + `pa11y-ci` parity.
4. **SEO** — URL-set equality, status codes, meta equality, redirect resolution.
5. **Forms** — golden-payload fixture + end-to-end assertion that a test row
   reaches the Google Sheet, then deleted.
