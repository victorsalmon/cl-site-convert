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

### Prerequisites

| Tool | Why | Install |
| :--- | :--- | :--- |
| Node 20+ / pnpm 11 | TypeScript pipeline | `pnpm install` |
| **rustup** | Rust + Wasm toolchain | https://rustup.rs |

`rust-toolchain.toml` pins the exact channel, components and the
`wasm32-unknown-unknown` target; **rustup installs both automatically**, so no
manual `rustup target add` is needed. The gate verifies this via
`scripts/check-toolchain.ps1` and fails with remediation if it is missing.

Security posture: **official distribution only.** No npm package that downloads a
binary at install time, no third-party wrapper around a toolchain. Tooling is
pinned so a build is reproducible and a compromise is visible.

### Commands

```powershell
pnpm install
pnpm gate                                     # the whole gate, fail-closed
pnpm lint; pnpm typecheck; pnpm test          # TS steps individually
pnpm validate:ir; pnpm validate:plugins       # contract conformance
cargo test --workspace                        # Rust
```

`pnpm gate` is the single source of truth. It must be green before any merge —
per-lane green does not imply merged green, as the first two lanes proved.

## Where to look

| You need | Read |
| :--- | :--- |
| Why things are shaped this way | `docs/01-DECISIONS.md` |
| System design | `docs/00-ARCHITECTURE.md` |
| Live backlog | `bd ready` / `bd list` in this repo |
| Plugin authoring contract | `plugins/_template` + `docs/runbooks/CREATING_NEW_PLUGINS.md` |

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
