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

## 2026-11-11 — Open operator questions (blocking specific beads)

1. Is WP Webhooks used **only** for the form → Pabbly hop, or other triggers too?
2. Are historical Fluent Forms submissions needed, or is Google Sheets the system
   of record?
3. Capture the **exact payload** Pabbly receives (Pabbly request history or WP
   Webhooks log) → golden fixture.
4. Does any form have a **file upload** field? Sheets cannot store files; the
   flow would need object storage (R2/S3) plus a link.
