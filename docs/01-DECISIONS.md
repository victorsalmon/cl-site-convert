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

## 2026-11-11 — Toolchain: official only, pinned, no binary-downloading npm packages

- `rustup` from the official distribution; channel **1.99.1** pinned in
  `rust-toolchain.toml` with `wasm32-unknown-unknown`, `rustfmt`, `clippy`.
- Deliberately **not** used: npm packages that fetch executables at install time,
  `wasm-pack` and `trunk` for now. `wasm-pack`/`trunk` are convenience wrappers;
  when islands land (B3.1) the default path is `cargo build --target
  wasm32-unknown-unknown` plus a **pinned** `wasm-bindgen-cli` compiled from
  source with `cargo install --locked`. Fewer moving parts, nothing unverified
  pulling a binary.
- `wasm-opt` is **optional**: the size gate (B3.1) is the real enforcement. If
  adopted, it comes from an official binaryen release with a checksum, never a
  wrapper package.
- The cargo waiver is **gone**. The gate now runs `check-toolchain` and
  `cargo test --workspace` as hard steps. A missing toolchain fails with
  remediation rather than skipping (ADR 0012).

## 2026-11-11 — Gate defect fixed: line endings

- A fresh worktree failed `prettier --check` because committed LF blobs checked
  out as CRLF under `core.autocrlf=true`. That is a gate that cannot pass on a
  clean checkout — a defect, not a baseline.
- Fixed with `.gitattributes` (`* text=auto eol=lf`, CRLF only for `.ps1`/`.bat`).
  **Proven** by creating a pristine worktree, installing, and running lint green.

## 2026-11-11 — currentsbk.ca is NOT WordPress

- `currentsbk.ca` is an Eleventy **static** site (deploy clone at
  `currents-bookkeeping/.sites/currentsbk.ca` contains only `_site`, `.cpanel.yml`,
  `site-info.md`; **no `wp-content`, no PHP**).
- Therefore it **cannot be the first conversion target** — a WordPress converter
  has nothing to convert there.
- It is retained as the **emitter round-trip fixture**: static HTML → Site IR →
  static HTML with pixel-diff ≈ 0. That is the cheapest possible proof of the
  emitter and the parity harness, and it needs no WordPress at all.
- First **real** conversion target remains `upscalehavens.ca`.

## 2026-11-11 — Webhook chain, final

- Chain: `Form → WP Webhooks → Pabbly → webhook → Google Sheets`.
- **WP Webhooks is pure glue** and is eliminated: Pabbly accepts inbound webhooks,
  so the new form island posts straight to Pabbly.
- **Pabbly is pure glue** and is preserved untouched: it receives our POST and
  forwards to the Sheets integration. Nothing to migrate.
- **Historical Fluent Forms submissions are not required.** Sheets is the system
  of record going forward; no `wp_fluentform_submissions` migration.
- Open ambiguity: the form plugin has been referred to as both *Fluent Forms* and
  *WP Forms*. The extractor (B4.1a) must **detect which plugin is present** rather
  than assume, and the capability detector (B1.5) must report it.

## 2026-11-11 — Open operator questions (blocking specific beads)

1. **The exact Pabbly payload** — from Pabbly's "Webhook by Pabbly" request history
   or the WP Webhooks log. Needed as the golden fixture for B4.1e.
2. **Does any form have a file-upload field?** Sheets cannot store files; the flow
   would need object storage (R2/S3) plus a link.
3. **WPForms or Fluent Forms?** Both names have been used. The extractor detects
   rather than assumes, but confirming the plugin settles the fixture.

Resolved and no longer open: history migration (not needed), WP Webhooks scope
(pure glue, eliminated), Pabbly scope (pure glue, preserved).
