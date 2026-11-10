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

## 2026-11-11 — Target recon: upscalehavens.ca is a 19-page Divi brochure, not a content site

Measured by B1.1 (48 polite serialised requests, 600 ms apart, robots-aware).
Manifest: `capture/routes.manifest.json`.

| Fact | Value | Consequence |
| :--- | :--- | :--- |
| Pages | **19** | Tiny. The whole conversion is small; effort estimate drops sharply |
| Posts | **0** | No blog. **Markdown prose projection is unnecessary** — drops work from B1.2 |
| Stack | **WordPress 7.1.4, Divi 4.27.7** | Divi shortcodes render to deep div nesting. Confirms *preserve captured DOM verbatim* is the only viable fidelity strategy; template clustering must group Divi section patterns |
| Plugins | Fluent Forms, FluentCRM, FluentSMTP, LiteSpeed Cache, **Redirection**, Divi | See below |
| Sections | `/tmh/`, `/mlm/`, **`/care/`**, **`/ush/`**, **`/resources/`** | Five sections, not the two originally briefed |
| Sources | REST 19, sitemap 19, union 19 | Zero divergence between machine-readable sources |

Specific traps now recorded:

1. **The form plugin is Fluent Forms** — confirmed by `fluentform/v1` and
   `/?fluent-form=3`. This resolves the Fluent Forms vs WPForms ambiguity. Not
   WPForms.
2. **A form is reachable only by query string** (`/apply` → `/?fluent-form=3`).
   Route enumeration and the forms extractor must handle query-string routes.
3. **`slug` is not the route.** The front page's WP slug is `ush`; path must come
   from `link`.
4. **Asymmetric naming.** `/mlm/applym/` is Mill Lake Manor's form, while
   `/mlm/apply/` redirects to *TMH's* form. Never infer a form from a path pattern.
5. **Redirection plugin is installed** → the 301 map can be **exported from the
   plugin** rather than reconstructed by crawling. B1.6 should prefer that source.
6. **LiteSpeed Cache is installed** → capture must not read a stale cached layer,
   or the golden baseline is poisoned. Prime or bypass deliberately.
7. **`template` is exposed** (`page-template-blank.php` on the apply/thanks
   pages) — a real input to island/template decisions.
8. **REST is unusually open**: `/wp-json/` public, `/wp/v2/users` open (1 user,
   no names or emails recorded — count only), and 8 non-core namespaces leak the
   plugin list. Treat the open user endpoint as a **live security finding**, not
   just a capture convenience.
9. A `project` CPT exists but is empty. Enumeration derives public `wp/v2` bases
   from `/types` so a populated CPT cannot be silently missed.

**Live-site bugs found (not conversion problems), filed as `cl-site-convert-sfs`:**
`/tmh/onboard` 301s to `/mlm/onboard-mlm/` (wrong property); `/mlm/apply` 301s to
TMH's form though `/mlm/applym/` exists; three pages carry a scheme-less
`href="chatgpt.com"` producing 404s.

## 2026-11-11 — Open operator questions (blocking specific beads)

1. **The exact Pabbly payload** — from Pabbly's "Webhook by Pabbly" request history
   or the WP Webhooks log. Needed as the golden fixture for B4.1e.
2. **Does any form have a file-upload field?** Sheets cannot store files; the flow
   would need object storage (R2/S3) plus a link.
3. **WPForms or Fluent Forms?** Both names have been used. The extractor detects
   rather than assumes, but confirming the plugin settles the fixture.

Resolved and no longer open: history migration (not needed), WP Webhooks scope
(pure glue, eliminated), Pabbly scope (pure glue, preserved).

## 2026-11-11 — B1.2 capture: normalisation only deletes; inline Divi CSS is a blocking gap

Measured by building the Site IR for all 19 pages (`capture/site-ir.json`,
`capture/site-ir.capture-report.json`).

- **2,320,052 B** of rendered HTML became **371,838 B** of `dom.html` — 83.9% of the
  served bytes were script, style and comment payloads, not markup.
- **Normalisation is string surgery, never parse-and-re-serialise.** A tree
  round-trip rewrites attribute quoting, entity spelling and void-element syntax,
  and any of those is visual drift. Only whole nodes are cut out (`script`, `style`,
  HTML comments, `#wpadminbar`, telemetry pixels/hints/frames), plus CRLF→LF. Every
  other byte stays where the server put it.
- **The fidelity invariant is a test, not a claim:** parse5 parses the raw page,
  prunes the removable nodes as a *tree*, and must deep-equal the parse of
  `dom.html` — tag, attribute order, every class value and every text node — and a
  serialize→parse round-trip must be stable. A surviving element's class attribute
  must stay an ordered subsequence of the capture; the adapter refuses to emit if not.
- **`styles[]` and `assets[]` stay empty in this pass.** A style entry requires the
  `sha256` of shipped bytes, and inventing one would be a lie. Stylesheet capture is
  B1.3; the `<link rel="stylesheet">` tags remain inside every `dom.html`.
- **Blocking finding — inline critical CSS has no representation in v1.** Divi
  4.27.7 inlines 5–14 `<style>` blocks per page (80–117 KB per page, ~1.77 MB in
  total, including the whole Divi theme, `et-critical-inline-css`, global styles and
  an `ETmodules` `@font-face`). `styles[]` requires an `href`, so inline CSS cannot
  be expressed. The capture drops those blocks and records each one's `sha256` and
  byte length in the capture report, which makes recovery provable. **B1.3 must
  materialise them as ordered stylesheet files (synthesised `localPath`, capture
  order preserved), or v1.1 needs an inline-CSS field.** Until then, emitted pages
  render without their critical CSS and visual parity is not achievable.
- **LiteSpeed cannot be bypassed from the client.** All 19 pages returned
  `x-litespeed-cache: hit`, and `Cache-Control: no-cache` returned byte-identical
  HTML (still a hit). Freshness is therefore evidenced per page by comparing
  LiteSpeed's embedded cache stamp with REST `modified` — on this capture all 19 are
  cache-newer-than-content, so the golden baseline is not stale.
- **Divi's closing comments are gone.** `<!-- #main-header -->`, `<!-- .container -->`
  and friends are comments and are stripped by rule. Template clustering (B1.3)
  must derive section boundaries from `et_pb_section`/`et_pb_row`/`et_pb_column`
  classes instead of the marker comments.
- **Public contact data is captured as public page content:** three business email
  addresses and four `tel:` links appear in the DOM. They are published on the live
  site; the capture report lists them so a human can confirm before the IR is used.

## 2026-11-11 - Capability gate: unknown is blocking, and "not evaluated" is not "clean"

B1.5 detects capability from two evidence sources — `/wp-json/` namespaces and
rendered DOM markers — and reports **which evidence proved each finding** (the
literal namespace token, or the matched marker plus the route it was found on).

- **Three classes, two IR fields.** `supported` and `unsupported[]` are all the
  frozen schema has, so `needs-handling` is `unsupported[]` with
  `blocking: false` and `unsupported-blocking` is `blocking: true`. No new field
  was needed and `schemas/` is untouched.
- **Unclassified is blocking.** Any non-core REST namespace not in
  `src/source/capabilities/catalog.ts` blocks the conversion, whether or not it
  *looks* stateful; the report names the suspicion separately. Clearing it means
  adding the plugin to the catalog **with a reason**, never a wildcard.
- **Cannot-evaluate is not a pass.** With no namespaces and no pages the report is
  `cannot-evaluate`, the CLI exits 2, and the report carries a blocking
  `cannot-evaluate` entry so a consumer holding only the JSON still refuses.
  `capture/capabilities.json` is therefore never empty-and-silent.
- **The open users endpoint** is recorded as `rest-users-public`
  (`blocking: false`): a live security finding about the source install, not a
  conversion blocker. There is no `securityFindings[]` in v1 and inventing one is
  a schema change, so it rides in `unsupported[]` with a detail that says what it
  is. **Schema ask for v1.1:** `capabilities.unsupported[].evidence[]`
  (`kind`/`value`/`source`) and a top-level `securityFindings[]`; today the
  evidence is carried in prose inside `detail` and on stdout.
- **Offline by construction.** The CLI reads recorded evidence
  (`capture/routes.manifest.json`, an optional `/wp-json/` body, an optional
  `capture/dom.pages.json` bundle) and never the network, so the gate result is a
  function of the capture and can be re-run and diffed.
- `capture:capabilities` exits 0 (convertible), 1 (blocking, each printed with
  its reason) or 2 (cannot evaluate). `assertConvertible(report)` is the
  emit-time guard B2.1 calls; it refuses both blocking findings and the
  `cannot-evaluate` sentinel.

Target result: **convertible**, 2 supported (`divi`, `redirection`), 5 needing
handling (`fluent-forms`, `fluent-crm`, `fluent-smtp`, `litespeed-cache`,
`rest-users-public`), 0 blocking.

## 2026-11-11 — Gate defect fixed: rustup's install dir was not on PATH

- `pnpm gate` failed at the Rust step on this machine with "cargo is not on PATH"
  while `cargo 1.99.1` was installed at `%USERPROFILE%\.cargo\bin` — the directory
  simply was not in the User or Machine `PATH`. That is a gate that cannot pass on
  a provisioned machine: a defect, not a baseline (ADR 0012).
- Fix: `scripts/gate.ps1` looks for `cargo.exe` in rustup's standard install
  location **only when `cargo` is not already on PATH**, prepends it, and prints a
  loud `note:`. `check-toolchain.ps1` inherits the corrected `PATH` and still
  verifies the pinned channel and `wasm32-unknown-unknown`. A genuinely missing
  toolchain still fails, with the same remediation text.
- Machine-level follow-up (not repo-owned): add `%USERPROFILE%\.cargo\bin` to the
  User `PATH` so new shells find the toolchain without the note.
- Proven by running `pnpm gate` green in a fresh worktree.
