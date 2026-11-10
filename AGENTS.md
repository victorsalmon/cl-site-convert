# AGENTS.md — cl-site-convert

Cross-repo **conversion engine**: takes a live WordPress site and emits either
**static HTML** or **static HTML + Rust/Wasm islands**, then deploys it.

First target: `upscalehavens.ca` → `site.upscalehavens.ca` (dev) → apex (operator-gated).

Fleet orientation: `$env:CL_REPOS_ROOT\cl-common\AGENTS.md`. Machine rules:
`$env:CL_REPOS_ROOT\cl-common\saas-modules\AGENTS.md`. Those bind here.

## The one rule that governs this repo

**Fidelity beats cleverness.** The goal is a site that *looks and behaves like the
original*. That means:

1. **Preserve the captured DOM skeleton and class names.** Do not re-author pages
   into a component tree — that is where visual drift comes from.
2. **Ship captured CSS byte-identical.** Never prune, never "clean up". Pruning may
   only exist as an opt-in, measured, off-by-default pass.
3. **Markdown is not an intermediate representation.** It cannot carry nested grid
   layout, page-builder wrappers, or class names. Blog *prose* may additionally
   project to Markdown; the IR of record is structured HTML + metadata.
4. **Only islands are componentized.** Everything else stays static HTML.

If a change trades fidelity for tidiness, it is the wrong change.

## Architecture — four orthogonal seams

```
source adapters  →  Site IR  →  emitters  →  deployers
                                 ↑
                            sinks (submission targets)
```

| Seam | Responsibility | Must not know about |
| :--- | :--- | :--- |
| `src/source/` | live WP REST / WXR / Playwright scrape → Site IR | emitters, deployment |
| `schemas/` | the frozen **Site IR** (crown jewel) | anything |
| `src/emit/` | Site IR → `static-html` \| `islands-wasm` | the host it lands on |
| `src/sinks/` | where form submissions go (`webhook`, `pabbly`, `email-ses`, later `sheets-direct`) | the form UI |
| `src/deploy/` | artifact dir + target config → deployed URL | what generated the artifact |

`--emit islands` MUST equal `--emit static` **plus** mount slots and lazily
loaded Wasm bundles. Same HTML baseline, so static ships first and Wasm is
additive and revertible per page.

**Deployers are artifact-push, never git-integration** (Cloudflare Pages cannot
integrate `worktree.ca`, and dotCanada/S3 have no host-side build).

## Scope discipline

- **No WooCommerce / e-commerce.** Out of scope by decision.
- **Unsupported WordPress capability fails loudly.** WPML, membership, booking,
  e-commerce: emit a capability report and stop — never silently degrade.
- **Nothing here runs PHP.** Fluent Forms and WP Webhooks are *extracted from* and
  *replaced*, never adapted. What must survive is the wire contract between them.

## Non-negotiables

- **Gates, not assertions.** "Looks similar" is unprovable without the visual
  parity harness. A green gate is the only acceptable evidence.
- **Gate integrity** (`cl-common` ADR 0012/0013): a gate that cannot pass is a
  defect, never a baseline. No known-red, no silencing, no lowered threshold
  without a measured justification.
- **Secrets never reach the client bundle.** The Pabbly webhook URL is a
  credential; it lives in a Pages Function secret.
- **One writer per worktree.** Isolate lanes in `.worktrees/<name>` (gitignored).

## Build & test

```powershell
pnpm install
pnpm lint; pnpm test            # TS side
cargo test                      # Rust side
cargo build --target wasm32-unknown-unknown -p islands-core
```

Rust toolchain is **not yet provisioned** on this machine — see bead B0.6.

## Where to look

| You need | Read |
| :--- | :--- |
| Why things are shaped this way | `docs/01-DECISIONS.md` |
| System design | `docs/00-ARCHITECTURE.md` |
| Live backlog | `bd ready` / `bd list` in this repo |
| Plugin authoring contract | `plugins/_template` + `docs/runbooks/CREATING_NEW_PLUGINS.md` |
