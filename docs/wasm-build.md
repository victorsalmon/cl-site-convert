# Wasm build and the size budget

Measured evidence for bead **B3.1** (`cl-site-convert-cv9`). This file records
what the Wasm path actually does on this repo today, how the size gate measures
it, and the risk left open when real islands land.

`docs/00-ARCHITECTURE.md` is owned elsewhere and is deliberately **not** edited
by this bead.

## Decision recap (do not re-litigate)

- **Plain `cargo build --target wasm32-unknown-unknown`.** No `wasm-pack`, no
  `trunk`.
- **No `wasm-opt`.** Not installed, not a dependency. If it ever becomes
  necessary it comes from an official `binaryen` release with a checksum — never
  an npm wrapper that downloads an executable.
- Toolchain is pinned by `rust-toolchain.toml` (channel `1.99.1`, component
  `rustfmt`/`clippy`, target `wasm32-unknown-unknown`), verified by
  `scripts/check-toolchain.ps1` as a hard gate step.

## Release profile guarantees

`[profile.release]` in the workspace `Cargo.toml` is tuned for shipped Wasm size
and is complete — nothing needed to be added by this bead:

| Setting | Value | What it buys |
| :--- | :--- | :--- |
| `opt-level` | `"z"` | Optimize for size, not speed. Correct default for lazily loaded islands. |
| `lto` | `true` | Full cross-crate LTO: drops unreachable monomorphized code, which is where most naive Wasm bloat lives. |
| `codegen-units` | `1` | Lets LTO see the whole crate graph; slightly slower compile, smaller output. |
| `panic` | `"abort"` | Removes the unwinding machinery. Required for a small `cdylib`; also correct for Wasm, where unwinding is not the host's model. |
| `strip` | `true` | Removes debug info from the shipped `.wasm`. |

Consequence: the measured numbers below are **already** the tuned output. There
is no "release build still has debug symbols" caveat hiding in them.

## The crate

`crates/islands-core` is a `cdylib` + `rlib`:

- `cdylib` → the `.wasm` bundle a page loads.
- `rlib` → the same crate is a normal library, so `cargo test --workspace` tests
  it natively. **A `cdylib` alone is not testable**; both crate types are
  required for the gate to mean anything.

Exports (C ABI, no `wasm-bindgen`):

| Symbol | Signature | Purpose |
| :--- | :--- | :--- |
| `islands_core_abi_version` | `() -> u16` | Probe the bundle's mount-slot ABI before handing it control. |
| `islands_core_accepts_host_abi` | `(u32) -> u32` | `1` when the host ABI matches, `0` otherwise. |

`u32` instead of `bool` because a `cdylib` boundary without `wasm-bindgen` only
carries C scalars. Tests cover the version, exact-match compatibility and the
exported wrapper.

### Is a `cdylib` without `wasm-bindgen` sufficient at this stage?

**Yes, for proving the pipeline and the gate — and only for that.** It gives a
real Wasm module, a real artefact path, real measured bytes and a real budget
check, with zero extra tooling and nothing that downloads a binary.

What it cannot do, and what `wasm-bindgen` adds when islands actually land:

1. **Strings and structs across the boundary.** Today only scalars cross. Props
   (`{ formId, endpoint }`), field names and success/error messages are all
   strings; without bindgen they have to be marshalled by hand through linear
   memory (pointer + length) and decoded on the JS side.
2. **The generated JS glue.** `wasm-bindgen` emits the `.js` shim that
   instantiates the module, passes typed values and wires exports. Writing that
   by hand is exactly the kind of unverified surface this repo avoids.
3. **DOM and event integration.** `web-sys` / `js-sys` bindings are
   `wasm-bindgen`-generated. A Leptos form island is unrealistic without them.
4. **ABI/version coupling.** `wasm-bindgen` requires the CLI version to match the
   `wasm-bindgen` crate version, so it must be pinned: `cargo install --locked
   wasm-bindgen-cli --version <same as Cargo.toml>`.

When that lands, the size gate must grow: the shipped payload becomes
`.wasm` **+** the glue `.js`, and `esbuild`-minified glue is not free. This gate
currently measures the `.wasm` only.

## Measured result (2026-11-11)

`cargo 1.99.1`, target `wasm32-unknown-unknown`, release profile above.
`cargo build -p islands-core --release --target wasm32-unknown-unknown`.

| Crate | Raw `.wasm` | Brotli (q11) | Budget | Verdict |
| :--- | ---: | ---: | ---: | :--- |
| `islands-core` | **129 B** | **100 B** | < 250 KB (`256000 B`) | PASS |

This is a stub: two tiny exported functions, no allocator, no DOM, no
dependencies beyond `core`. The 129 bytes confirm the **pipeline** works (a real
`\0asm` module with both exports and a `memory` section); they say **nothing**
about how much headroom 250 KB is once Leptos arrives. Do not read the
"100% headroom" line as evidence of anything except that the gate functions.

## The gate: `scripts/wasm-size.mjs`

```
pnpm validate:wasm-size      # or: node scripts/wasm-size.mjs
```

What it does, in order:

1. **Discovers** island crates by scanning `crates/*/Cargo.toml` for
   `crate-type = ["cdylib", …]`. Adding an island crate needs **no** edit to the
   script; a `rlib`-only crate such as `site-ir` is correctly skipped.
2. **Builds** them itself — one `cargo build --target wasm32-unknown-unknown
   --profile release -p <crate>…` — so a stale `target/` cannot produce a false
   green. Proven: deleting the `.wasm` and re-running the gate rebuilds it and
   still exits 0.
3. **Measures** raw bytes from disk and brotli bytes at **quality 11** (a CDN
   would not compress harder), with the size hint set.
4. **Checks** that the artefact is a real Wasm module (magic `\0asm`) and is not
   0 bytes — a shape that "passes" a size check without being a bundle is a
   false green.
5. **Enforces** the per-bundle budget of **< 250 KB brotli** (`250 * 1024`
   bytes) and prints a `crate / raw / brotli / budget / verdict` table.

Exit codes:

| Code | Meaning |
| ---: | :--- |
| 0 | Every island bundle is under budget. |
| 1 | A bundle exceeded 250 KB brotli. |
| 2 | **Cannot evaluate**: no `cargo`, no `cdylib` crate, or a missing/empty/non-Wasm artefact. **Not a pass** (cl-common ADR 0012). |

Both failure paths were exercised, not assumed: a probe with the budget lowered
to 50 B exited **1**, and a probe pointed at a nonexistent artefact exited **2**.

Wired into `scripts/gate.ps1` as the `validate:wasm-size` step, immediately
after `validate:ir` / `validate:plugins`. The gate therefore fails on an
oversized bundle and on an unmeasurable one.

### Gate defect found and fixed on the way

`Invoke-NativeStep` in `scripts/gate.ps1` piped each native command straight
into the function's own output stream, and every call site ended in
`| Out-Null`. That discarded **all** step output: this bead's size table, the
9/9 IR fixture table and the plugin table were produced and then thrown away. A
gate whose evidence is invisible cannot be reviewed, and the requirement here is
a *printed* table.

Fixed by streaming each step's output through `Write-Host` (`2>&1` keeps stdout
and stderr in order). Verified: stdout and stderr both appear, `$LASTEXITCODE`
is still captured, and a non-zero step still lands in the failure list.

### Proof that the whole gate fails, not just the script

Exercised end to end, not asserted:

1. Budget temporarily lowered to 50 B → `pnpm gate` exited **1**, printing
   `islands-core … FAIL over by 50 B`, `FAILED: validate:wasm-size (exit 1)`,
   `GATE: FAIL`. Budget then restored.
2. Artefact renamed → the script exited **2** (`cannot-evaluate`).
3. `.wasm` deleted with the budget intact → the gate **rebuilt** it and passed,
   proving it does not depend on a pre-existing artefact.

## Open risk: 250 KB brotli once Leptos lands

The budget is per **lazy bundle**, not per site, which is the only way it can
hold. Still, these are the cost centres that will push against it, in order:

1. **`web-sys` surface.** Bindings are generated per feature. Every DOM API an
   island touches adds code; use narrowly scoped `web-sys` features, never the
   full crate.
2. **`serde` + `serde_json`.** A form island that parses props or serialises a
   payload drags in a meaningful chunk of both. `serde-wasm-bindgen` is smaller
   than JSON round-tripping for props.
3. **Leptos reactive runtime.** Fine-grained reactivity is much smaller than a
   virtual DOM, but it is still the bulk of a hello-world island.

Honest position: a single Leptos + `web-sys` + `serde` form island landing under
250 KB brotli is **plausible but not safe by default**, and the first real island
(B4.1b) is where it gets measured. If it exceeds budget, the escalation order is:

1. Trim `web-sys` features and drop JSON round-trips (free — no new tooling).
2. Split per-island bundles harder (B3.2 is exactly this bead).
3. Only then consider `wasm-opt -Oz` from a checksummed official `binaryen`
   release — a deliberate, measured addition, never an npm wrapper.

Threshold changes require a measured justification recorded here, per ADR 0013.
