# Decisions

Append-only. Date-stamped. Each entry states the decision and why, so a later
agent does not re-litigate it.

## 2026-11-10 — Repository and namespace

- Repo: `cl-site-convert`, at `E:\repos\cl-site-convert`.
- Plugin namespace: `plugins/wordpress/` (WordPress is one converter, not *the*
  converter).
- Rejected: `cl-site2` (implies a predecessor that never existed; reads like a
  deploy target next to `cl-common/Sites/`) and `cl-convert` (less specific).

## 2026-11-10 — Target and deployment

- Target site: **`upscalehavens.ca`** — confirmed live WordPress, two property
  sub-sites (`/tmh/`, `/mlm/`) and form routes (`/tmh/apply/`, `/tmh/onboard-tmh/`,
  `/tmh/offboard/`).
- Dev preview: **`*.pages.dev`**, not a custom subdomain.
- `site.upscalehavens.ca` is a **gated** step: apex currently resolves to a
  traditional host (`38.111.114.25`), not Cloudflare. Binding a CF Pages custom
  domain generally requires the zone on Cloudflare, which risks the live apex.
  Do not touch apex DNS until the operator approves.
- Apex cutover from `upscalehavens.ca` → new site is **operator-gated** on
  functional approval.
- Deploy target for MVP: **Cloudflare Pages only**. Other targets are adapter beads.

## 2026-11-10 — Output is a flag, not a fork

- `--emit static` and `--emit islands` share one HTML baseline; `islands` adds
  mount slots + lazy Wasm bundles. This makes Wasm additive and revertible and
  lets static ship first.

## 2026-11-10 — Deployers are artifact-push

- Never git-integration. Cloudflare Pages cannot integrate `worktree.ca`
  (GitHub/GitLab only), and dotCanada/S3 have no host-side build.
- Static payload ports across all targets; **functions do not**. Therefore
  `dist/` and `api/` are separate deployables.

## 2026-11-10 — Forms: extracted and replaced, never adapted

- Fluent Forms and WP Webhooks are PHP; Cloudflare serves no PHP. Neither plugin
  survives. The **wire contract** survives.
- WP Webhooks is **eliminable**: Pabbly accepts inbound webhooks natively, so the
  chain collapses to *form island → Function → POST → Pabbly → Google Sheets*.
  Pabbly and Sheets are unchanged by this migration.
- Forms are **event emitters, not email senders** → `sinks/` is a first-class
  seam: `webhook`, `pabbly`, `email-ses`, later `sheets-direct`.
- Payload fidelity is the risk: replicate WP Webhooks' **envelope**, verified by a
  committed golden-payload fixture.
- Accepted losses vs WP Webhooks, each with a replacement: retry (3× backoff,
  always 200 to visitor), delivery log (structured log + correlation id), spam
  protection (honeypot + Turnstile) — the latter is a genuine regression risk.

## 2026-11-10 — Fidelity rules

- Preserve captured DOM skeleton and class names; ship CSS verbatim; do not
  re-author pages into components; only islands are componentized.
- Markdown is not the IR. It cannot carry layout, wrappers, or class names.
- The fidelity win was already banked by WordPress → static. Client-side Wasm is
  a *regression* for content pages unless it is SSR+islands, and even then only
  for interactive subtrees.

## 2026-11-10 — No OSS converter exists

- Nothing converts WordPress PHP/Wasm to Rust. WordPress Playground runs WP *as*
  Wasm (PHP-WASM + SQLite) for demos/testing — not a converter, not Rust, and
  slower than static for production. FrankenWasm runs Wasm plugins *inside* PHP.
  The only mature automated path is WP → static HTML, which this repo extends.

## 2026-11-10 — Scope: WordPress only

- This tool converts **WordPress** sites. It is not a general static-site
  converter. No generic `source/scrape` adapter as a primary path.
- Consequence: `source/` is WordPress-specific; Playwright is reserved for
  **telemetry** (B1.4) and **verification** (B5.1), not primary capture.

## 2026-11-10 — Static-export plugins: adopt Simply Static as an adapter, reject WP2Static

Research findings (docs.simplystatic.com; `elementor/wp2static` + Wayback):

| | Simply Static | WP2Static |
| :--- | :--- | :--- |
| Maintenance | **Active** — 3.8.24 (Nov 2026), live docs, 30k+ installs | **Abandoned** — last release 7.2 (Jan 2023), last commit Feb 2024, delisted from wp.org since 2020 |
| Free artifact | ZIP (Activity Log) or a **Local Directory** path you set | Fixed path `wp-content/uploads/wp2static-processed-site` |
| Scriptable CLI | **WP-CLI is Pro-only ($99/yr)** | **WP-CLI in free core** (`detect`/`crawl`/`post_process`/`deploy`) |
| Structured metadata (IR) | **No** — flat HTML + assets | **No** — flat HTML + assets |
| Cloudflare-native output | `_redirects` + `_headers` | none |
| Forms | Pro: webhook `/wp-json/simplystatic/v1/entries`, supports **Fluent Forms** | none |

**Decision.** Neither plugin emits a Site IR, so neither can be the architecture —
their export is flat HTML and loses template identity, taxonomies and form
definitions. But Simply Static is genuinely useful as **one adapter plus a
free fidelity baseline**:

1. `source/simply-static` — consume its Local Directory export for the **HTML
   mirror, assets and CSS verbatim** (B1.3), plus its `_redirects`/`_headers`
   for the `cf-pages` deployer.
2. **Golden visual baseline** — its mirror is a pixel-accurate reference our own
   emitter is diffed against (B5.1) from day one, before any Rust exists.
3. **Feasibility probe** — if the site cannot static-export cleanly, dynamic
   blockers surface immediately.

Structured metadata comes from **`source/wp-rest`**, not from the export.

**Use the free tier, triggered manually, reading the Local Directory.** The
$99/yr Pro tier buys WP-CLI automation we do not need for a one-site migration.
Simply Static Pro's forms webhook is noted as a *reference implementation* only —
our sink must replicate the WP Webhooks→Pabbly envelope, which is a different
contract.

**WP2Static is rejected.** Its only advantage (free WP-CLI) does not justify
depending on a project that is delisted, Elementor-owned and untouched since
early 2024.

## 2026-11-11 — Open operator questions (blocking specific beads)

1. Is WP Webhooks used **only** for the form → Pabbly hop, or other triggers too?
2. Are historical Fluent Forms submissions needed, or is Google Sheets the system
   of record?
3. Capture the **exact payload** Pabbly receives (Pabbly request history or WP
   Webhooks log) → golden fixture.
4. Does any form have a **file upload** field? Sheets cannot store files; the
   flow would need object storage (R2/S3) plus a link.
