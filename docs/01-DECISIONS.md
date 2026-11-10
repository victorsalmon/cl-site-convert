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

## 2026-11-11 — Capture results and the per-page cascade gap

B1.2 + B1.3 captured the real target. Numbers, because they are the project's
real perimeter:

| | |
| :--- | :--- |
| Pages | 19/19, 0 failed |
| Raw HTML | 2,320,052 B → 371,838 B `dom.html` (**83.9% was script/style/comment**) |
| Linked stylesheets | 7 (145,655 B), document order preserved |
| Inline `<style>` blocks | **116 total → 48 unique** (1,797,263 B → 923,437 B; 48.6% dedup) |
| Media / fonts | 230 files (182 image, 48 font) — 48,931,147 B |
| `capture/assets` total | **50,000,239 B** committed |

**Round-trip fidelity invariant is proven, not asserted:** for each of three real
pages, prune-as-a-tree must deep-equal the captured DOM on tag, attribute order,
every class value and every text node, plus serialize→parse. 36 tests, 100+ class
pairs per page, zero whitespace drift. A runtime guard refuses to emit when a
surviving element's class list is not an ordered subsequence of the capture.

### The blocking finding: the IR cannot express per-page cascade order

Measured: the 19 pages have **18 distinct style chains**, ranging 7 entries
(`/resources/`) to 17 (`/ush/privacy-policy/`). The IR's `styles[].order` is a
single site-level sequence, so it **cannot** represent per-page order. Projecting
the global chain would produce wrong cascade on most pages — a silent fidelity bug
that no current gate would catch until pixel-diff.

- Therefore `capture/site-ir.json` deliberately keeps **only the 7 linked styles**;
  inline blocks live in `capture/style-chain.json` with `order` + `pages[]`.
- Nothing was fabricated to make the IR look complete. Minted `P1.7`: add
  `pages[].styleOrder` (ordered sha256 refs) and make the emitter consume it.

### CSS byte-integrity, and the one place line endings nearly broke it

`capture/assets/** -text` was added to `.gitattributes`. Without it the repo-wide
`*.css eol=lf` rule would rewrite line endings on checkout and **silently
invalidate every CSS hash**. Proven green on a pristine detached worktree.
285/285 file hashes verified from disk; 19/19 pages cross-check against the B1.2
record on byte length *and* every inline element hash.

### LiteSpeed cache: the baseline is cache-served

19/19 pages returned `x-litespeed-cache: hit`. Bypass is **not** possible from the
client (`Cache-Control: no-cache` returned byte-identical HTML, still `hit`); a
purge or `LSCWP_CTRL` call would be a mutating request against production, so it
was not attempted. Freshness is instead **evidenced**: the embedded cache stamp is
compared with REST `modified`, and all 19 are cache-newer-than-content.
The Simply Static export (deliverable 2) becomes the independent cross-check.

## 2026-11-11 — PII in captured artefacts: keep as-is (operator decision)

The IR contains the published contact address `victorsalmon@hotmail.com`
(`/mlm/`, `/mlm/onboard-mlm/`), three business addresses and four `tel:` links.
**Operator approved keeping them**, because all are already public on the live
site and redaction would make the IR a less faithful baseline, adding parity-gate
allowlist entries. No nonces, secrets or API keys are present (scanned: 0).

## 2026-11-11 — Google Fonts: rewrite at emit, never at capture

Captured CSS is verbatim and therefore still points at `fonts.gstatic.com`
absolutely. Decision:

- **Capture stays byte-identical.** Do not rewrite during capture.
- **The emitter applies the recorded `asset-rewrite-map.json`**, which is a
  deterministic, diffable transform — so the emitted CSS byte-hash differs from the
  captured hash *only* by URL substitution, and the transform is proven by a test
  that diffs the two and asserts every change is a URL swap.
- Rationale: removes a third-party request (privacy **and** performance), which is
  the point of the project. "Verbatim" means the *capture* is verbatim, not that no
  emitter may localise a URL.

## 2026-11-11 — Two assets are broken on the live site

`real-estate-09-1024x648-1-400x284.jpg` and `real-estate-09-1024x648-1.jpg` both
404. Classified as `brokenReferences` + a non-blocking `broken-asset-reference`
capability rather than capture failures — the live page is broken identically, so
parity is unaffected. Appended to defect bead `cl-site-convert-sfs`.

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

## 2026-11-11 — One bundle per island crate, lazily loaded, none on island-free pages

B3.2 makes the bundle strategy mechanical. Contract and evidence:
`docs/islands-runtime.md`.

- **The mapping is declared, not guessed.** An island crate states its mount
  identity in its own manifest: `[package.metadata.island] component = "…"`. A
  `cdylib` crate without it, a name that is not a `data-component` identifier, or
  two crates claiming one component are all `cannot-evaluate` in the gate. No
  hand-maintained bundle list exists anywhere, so nothing can silently fall out
  of step with the crates.
- **`dist/pkg/manifest.json` is generated and then verified, never trusted.**
  `scripts/wasm-size.mjs` already built and measured the crates; it now also
  emits one `<crate>.wasm` per crate, sweeps orphans, writes the manifest, and
  **re-reads it from disk and re-hashes every emitted file** before passing. A
  written file is a claim; a re-read and re-hash is evidence. This is what makes
  "the manifest cannot go stale relative to the crates" true rather than
  aspirational.
- **The loader is a plain ES module with zero runtime imports.** No bundler, no
  framework, no glue to keep in step. A test asserts that property on the source,
  so a later edit cannot quietly add a module graph to the browser contract.
- **The zero-island guarantee is structural, not a policy.** `startIslands`
  collects mount nodes and returns `status: "no-islands"` *above* the manifest
  resolution and above every network-reaching `await`. An island-free page cannot
  make a request through the loader even if a bootloader were mis-emitted onto
  it; and the emitter's `bundlesForHtml` returns `[]` for such a page, so there
  is nothing to emit. Both halves are tested independently.
- **Props are parsed before bytes are spent.** A node with malformed
  `data-props` is a loud error and does not mount, and its bundle is not fetched.
  `data-props` must be a JSON **object**: an array or a scalar is a build bug, not
  a value to coerce.
- **Absent bundle is loud.** A page that mounts a component the manifest does not
  describe produces a `console.error` naming the component and the known ones,
  plus `data-island-state="bundle-missing"`. Skipping quietly is indistinguishable
  from an island that was never meant to be interactive.
- **`loaded` is an honest state.** Until `wasm-bindgen` lands, a `cdylib` cannot
  touch the DOM, so a bundle that instantiates and passes the ABI probe but
  exports no `mount` is marked `loaded`, not faked into `mounted`. The manifest
  already carries the `modulePath` field the glue will use, so the switch is a
  data change, not a contract change.
- **Real-browser verification is deferred to the emitter bead that produces a
  deployable two-page artifact**, with a written checklist (0 wasm requests and 0
  `/pkg/` requests on the island-free page; exactly the mounted components'
  bundles on the other). It is recorded as a checklist rather than claimed,
  because there is nothing to open in a browser until an emitter exists.


## 2026-11-12 — B1.6 SEO surface, redirect map and the `/?s=` contract

Measured by `capture/seo-and-redirects.json` (29 polite serialised requests, >=600 ms
apart) and re-derivable offline from `capture/site-ir.json` + `capture/routes.manifest.json`.

**The SEO surface is thin, and that is now a recorded fact rather than a suspicion.**
Confirmed site-wide `absent` on all 19 pages: meta description, OpenGraph, Twitter
cards, JSON-LD, hreflang. Present on all 19: `<title>`, `<link rel="canonical">`
(absolute, matching its route exactly), `<meta name="robots" content="max-image-preview:large">`.
Nothing was defaulted or inherited — a page with no description reports `null`, and
the site-level list is the intersection, not a vote.

- **The sidecar is a sidecar.** `capture/site-ir.json` is owned by another lane and was
  not modified; folding `pages[].seo` plus `redirects[]` into the IR is a later bead.
  `pnpm validate:seo` re-derives every per-page claim from the IR and every redirect
  claim from the manifest, so a hand-edited artifact fails the gate.
- **Canonical = route: 19/19.** No mismatch. A trailing-slash difference counts as a
  mismatch by design (`/care` and `/care/` are two URLs), and that is why the check is
  path-exact rather than normalised.
- **Trailing-slash policy: `always`** (18 of 18 non-root routes), and the live site
  enforces it: `/care` 301s to `/care/`. `/index.html` answers **404**, so no
  `index.html`-style URL exists to break.
- **The 301 map is proven, not exported.** The `Redirection` plugin's store was NOT
  read: its data sits behind an admin/export surface, and reading it would mean
  authenticated or mutating requests against production. All **11/11** recorded 301s
  were re-verified live: arrival `Location` matches the map, **hops = 1**, destination
  **2xx** (five internal, six off-site to Drive/Signal/YouTube). **0 chains, 0 loops.**
  The verified set is emitted as `_redirects` lines in `newSiteContract.redirects`.
- **`/?s=` is a live feature, not a stub.** `/?s=test` answers 200 with a
  `search search-no-results` page; `/?s=room` returns real results. Both carry
  `noindex, follow, max-image-preview:large` and **no canonical** — the one place the
  current site already handles duplicate content correctly, so the replacement must
  reproduce it rather than "improve" it. Contract: 302 `/?s=<q>` → `/search/?q=<q>`,
  served by a build-time index of the 19 pages (bead P4.2).
- **Sitemap + robots captured verbatim.** `/wp-sitemap.xml` is an index over one urlset
  of 19 URLs, all 19 in the capture, declaring `/wp-sitemap.xml` from
  `robots.txt`; `robots.txt` is stored byte-for-byte with its `Disallow: /wp-admin/`
  (now inert — the path will not exist on the static host) and its
  `Allow: /wp-admin/admin-ajax.php` override. The replacement must also serve
  `/wp-sitemap.xsl` or drop the `xml-stylesheet` reference, or every sitemap fetch
  carries a 404.
- **Broken references reconciled into one list (5).** The three scheme-less
  `href="chatgpt.com"` links resolve *relative to the page* — `/mlm/applym/chatgpt.com`
  etc., all 404 — and the two 404 images on `/mlm/applym/` are **one** gallery item: the
  full-size file is reachable as a clickable `<a href>` as well as a `srcset`
  candidate, which the asset pass recorded only as `img:srcset`. Merging them makes the
  fix one repair, not three, and the severity ordering (4 high, 1 medium) says what to
  fix first. Nothing is auto-repaired: `chatgpt.com` → `https://chatgpt.com` changes
  what the page links to, which is a content decision.
- **Exit contract.** `capture:seo` exits 1 on any unreachable page, canonical/route
  mismatch, redirect chain, redirect loop, arrival mismatch or 404 destination; 2 when
  it cannot evaluate (missing inputs, or `--base-url` disagreeing with the manifest).
## 2026-11-11 - Template clustering: 19 pages are 15 shapes, and WP `template` is a shell key not a layout key

B2.2 measures page-builder structure instead of guessing effort. Contract and
evidence: `docs/template-clustering.md`, `src/analysis/cluster.ts`,
`capture/template-registry.json`.

- **The signature is section/row/column shape, and site chrome is excluded.** A
  Divi Theme Builder footer is a real `et_pb_section` on 16 of the 19 pages;
  counting it would make every page resemble every other page and collapse the
  measurement to "1 template". Sections marked `_tb_footer`/`_tb_header` are
  recorded as `siteChrome` and not compared. The marker is corroborated by the
  capture: the only three pages without it are exactly the three
  `page-template-blank.php` pages (19/19).
- **Content cannot enter the signature.** Text, `src`/`href`, module type and
  instance class numbers (`et_pb_heading_12`, `page-id-557`, `wp-image-662`) are
  stripped. `et_pb_column_1_3` survives: two trailing integers are a column
  fraction, one is an instance index.
- **Measured 19 pages -> 15 templates.** Four shapes are shared by two pages each
  (sweepy/ttlock, `/mlm/`+`/tmh/`, the two onboard pages, the two chrome-only
  `/ush/` pages); eleven pages have their own shape. Divi here is hand-built page
  by page, so per-template work is 15 units, not 2.
- **Complete-link, threshold 0.85, chosen from the data.** Similarity is a
  weighted LCS over sections with LCS-ratio row matching. Measured pairs: 3 at
  `1.000`, 1 at `0.875` (one row's column count differs), 2 at `0.800` (a shared
  prefix, genuinely different blocks), 12 at `0.667`. `0.800` is a false positive
  and `0.875` the cheapest real match, so every threshold in `(0.800, 0.875]`
  yields the same partition; 0.85 is its midpoint. Tests re-cluster across the
  whole band and assert 14 below and 16 above, so the number cannot drift into
  arbitrariness.
- **The WP `template` field is reported, not folded in.** Folding
  `page-template-*` into the similarity would make the cross-check circular.
  Measured: `template` predicts the shell 19/19 but not the layout - 16 default
  pages span 12 clusters, and the 3 blank-template pages are 3 different shapes
  (10, 7 and 2 sections; pairwise similarity 0.333-0.569). Consequence for the
  emitter: key per-template fixtures, QA matrices and parity baselines on the
  cluster id, key shell/chrome decisions on `template`, and take form islands
  from the extracted form records rather than from either.
- **Two pages are chrome and nothing else.** `/ush/owner/` and
  `/ush/privacy-policy/` have an empty `div.entry-content` and no page-builder
  section; they are reported as `chromeOnlyRoutes` rather than measuring as an
  anonymous "0 sections".
- **An empty capture is `cannot-evaluate`, never "0 templates".** The CLI exits 2
  and the registry carries a reason (ADR 0012). A test asserts the committed
  registry is reproduced byte-for-byte from `capture/site-ir.json`, so the
  artifact cannot go stale silently.
## 2026-11-10 — Static emitter: cascade from `styleOrder`, one contiguous style block, relative assets

B2.1 produces the first real artifact: 19 pages, 7 linked stylesheets, 116 inline
blocks, 230 media files, 2.16 MB of HTML. Contract and proofs:
`docs/static-emitter.md`.

- **`page.styleOrder` is the only cascade authority.** The captured `<link>`
  tags are removed from the head and the whole chain is re-emitted in
  `styleOrder` order. Emitting the tags as captured would ship *none* of the
  inline CSS (the capture deleted those nodes), and ordering by `styles[].order`
  would ship CSS a page never had. A sequence that does not match `styleOrder`
  exactly — count, order, origin — fails the build.
- **One contiguous block, at the first stylesheet link.** The capture removed the
  inline `<style>` nodes but recorded no positions for them, so reconstructing
  the interleaving between non-CSS head elements would be invention. Cascade
  depends on the CSS order, which is preserved exactly; every non-stylesheet head
  element keeps its bytes and its order relative to the other non-stylesheet
  elements. Recorded rather than improvised.
- **Relative references, one depth prefix.** `capture/asset-rewrite-map.json`
  values already mirror the site's absolute paths, so a rewritten reference is
  `"../".repeat(depth) + path`: page depth for HTML and inline CSS, the
  stylesheet's own directory depth for a linked file. Nothing in `dist/site/`
  knows a host, a root, or a subpath — the same tree serves from Pages, from a
  preview subpath, or from disk.
- **Two derived lookups on top of the map, both recorded.** Divi points
  `@font-face` at `//host/…`, which the map recorded absolutely, so the scheme
  comes from `site.baseUrl`; `?query`/`#fragment` tails are looked up without the
  tail and re-attached verbatim. 62 of 65 distinct CSS `url()` values rewrite;
  the 3 left alone are relative references that already resolve against the
  stylesheet's emitted (mirrored) path.
- **A missing `.css` extension is appended in the same directory.** Three
  captured Google Fonts sheets have no extension, and a static host that sniffs
  nothing serves those as `application/octet-stream`, which browsers refuse to
  apply as CSS. The directory does not move, so relative `url(...)` references
  still resolve.
- **Deferred CSS is a named gap, not a silent loss.** Divi's
  `<link rel="preload" as="style" onload="…">` tags are not stylesheet links:
  they are preserved as captured and still point at the source host, because
  B1.3 never captured their CSS. Fixing that is a capture change, not an emitter
  change.
- **Zero scripts is a consequence, not a promise.** `bundlesForHtml` runs on the
  emitted HTML with a no-bundles manifest: it returns `[]` for every page in this
  IR, and a page that mounts anything is refused with a pointer to
  `--emit islands`. The emitted tree has 0 `<script>` tags by construction.
- **The parity test is structural, not textual.** For all 19 pages the test
  re-parses emitted and captured HTML and compares tag names, attribute **order**
  and class lists, allowing value changes only on `img[src]`, `img[srcset]`,
  `source[srcset]` and `link[href]`, each of which must resolve to a real file in
  the tree. Two mutation probes were run against it: an injected `<script>` is
  refused by the emitter's own guard, and emitting the chain at the end of the
  head instead of the first link's position fails three tests.

## 2026-11-10 — Plugin manifest v1.1: role, direction, load surface, integrity, config

B0.4 reported six concrete manifest gaps that would bite the real feature
plugins. Contract and evidence: `docs/plugin-manifest.md`,
`schemas/plugin-manifest.schema.json`, `src/conformance/plugin-manifest.ts`,
`plugins/_template` (migrated), `tests/plugin-conformance.test.ts`.

- **Version selection is explicit, and v1.0.0 is untouched.** A manifest without
  `manifestVersion` keeps the frozen v1.0.0 contract exactly (`irRange` only; the
  string `entrypoint`). `manifestVersion: "1.1.0"` opts into `role`,
  directional IR ranges and the object entrypoint; a v1.0.0 manifest that
  declares a v1.1 field is rejected rather than half-honoured. The committed
  `tests/fixtures/plugin-manifest/wordpress.valid.json` was deliberately **not**
  edited, so the additive claim is re-proven on every `pnpm validate:ir` run.
- **`role` is the switch, not a label.** `source` requires `producesIrRange` and
  an empty `consumes`; `emitter`/`sink` require `acceptsIrRange`, and a
  `producesIrRange` on them is an error; `deployer` may declare neither. `emits`
  is role-checked (`site-ir`, a site artifact, `api-functions`, `deployment`),
  and a **sink must emit `api-functions`**: every form island reaches Pabbly
  through a Pages Function, so a static-only sink is a contract error.
- **`sinks` is now consequential in both directions.** Declaring a submission
  target makes the plugin a sink; a sink must declare at least one.
- **The hook load surface is declared and proven.** `entrypoint: { module,
  hooksExport }` in v1.1; `pnpm validate:plugins` imports the module and fails on
  an unloadable entrypoint, a missing hooks export, or a hook the manifest
  declares that is not a function on it. This is the async half of the harness —
  the sync half stays filesystem/JSON only.
- **Assets can be bundles and can carry integrity.** `type: "directory"` +
  `files[]` (member paths relative to the bundle) expresses a template or Wasm
  bundle; `sha256`/`bytes`/`brotliBytes` are accepted and **re-measured** — a
  declared hash or size that the bytes do not reproduce fails the gate. A
  `kind: "wasm"` asset must declare all three, with `brotliBytes` measured at
  quality 11 exactly as the **< 250 KB** size gate measures, so the manifest can
  carry the number that gate decides on. The 250 KB ceiling itself stays owned by
  `validate:wasm-size`; duplicating the threshold here would be two sources of
  truth for one budget.
- **The config is resolvable, not just described.** `config` is exactly one of
  `path` (a `.json` document) or `inline`, and in v1.1 `configSchema` ⇔ `config`.
  The harness validates the document against the schema, so a loader receives a
  config it can trust rather than a schema it must interpret.
- **Deliberately deferred, and said so in the doc:** a plugin permission/grant
  shape, per-hook payload schemas, signed assets beyond content hashes, and
  Rust-side manifest types (`crates/` carries the Site IR, not plugin contracts —
  and it is out of scope for this bead). Automating the migration is also
  declined: choosing a `role` is a judgement about which seam a plugin occupies,
  and guessing it is the same error class as inferring a form from a path.

