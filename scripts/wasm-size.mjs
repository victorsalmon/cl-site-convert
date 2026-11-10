#!/usr/bin/env node
/**
 * Measured Wasm bundle size gate.
 *
 *   node scripts/wasm-size.mjs
 *
 * What it proves: every island crate that produces a `cdylib` actually builds
 * for `wasm32-unknown-unknown` in release mode, the resulting file is a real
 * Wasm module, and its **brotli** size is under the per-bundle budget.
 *
 * The gate builds the artifacts itself. It never trusts a pre-existing `.wasm`
 * in `target/`, because a stale artifact is a false green.
 *
 * Exit codes: 0 every bundle is under budget, 1 a bundle exceeded the budget,
 * 2 cannot evaluate (no cargo, no island crate, a missing/empty/not-Wasm
 * artifact). Exit 2 is a failure, not a pass: a gate that cannot measure must
 * never report success (cl-common ADR 0012).
 *
 * Budget rationale and the measured numbers live in `docs/wasm-build.md`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CRATES_DIR = join(REPO_ROOT, "crates");

const TARGET = "wasm32-unknown-unknown";
const PROFILE = "release";

/** Per-bundle ceiling, in brotli bytes. 250 KB = 250 * 1024. */
const BUDGET_BROTLI_BYTES = 250 * 1024;

/** Wasm modules start with `\0asm` followed by the version dword 1. */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

function cannotEvaluate(message) {
  console.error(`cannot-evaluate: ${message}`);
  process.exit(2);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Brotli-compress exactly as a CDN would, at maximum quality. */
function brotliSize(buffer) {
  return brotliCompressSync(buffer, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
    },
  }).length;
}

/**
 * Minimal `Cargo.toml` reader. Deliberately not a TOML parser: this repo has no
 * TOML dependency and only two keys matter here.
 */
function readManifest(crateDir) {
  const text = readFileSync(join(crateDir, "Cargo.toml"), "utf8");
  const name = /^name\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  const crateTypeList = /^crate-type\s*=\s*\[([^\]]*)\]/m.exec(text)?.[1] ?? "";
  const crateTypes = [...crateTypeList.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  return { name, crateTypes };
}

// --- Discover island crates -------------------------------------------------
// An *island* crate is any workspace crate that builds a `cdylib`: those are the
// bundles a page loads. Adding an island crate needs no edit to this script.
if (!existsSync(CRATES_DIR)) {
  cannotEvaluate(`crates/ directory not found at ${CRATES_DIR}`);
}

const islands = readdirSync(CRATES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(CRATES_DIR, entry.name, "Cargo.toml")))
  .map((entry) => {
    const { name, crateTypes } = readManifest(join(CRATES_DIR, entry.name));
    if (name === undefined) {
      cannotEvaluate(`crates/${entry.name}/Cargo.toml has no package name`);
    }
    return {
      crate: name,
      artifact: `${name.replace(/-/g, "_")}.wasm`,
      isIsland: crateTypes.includes("cdylib"),
    };
  })
  .filter((entry) => entry.isIsland);

if (islands.length === 0) {
  cannotEvaluate(
    'no crate under crates/ declares `crate-type = ["cdylib", …]`; ' +
      "there is nothing to measure, so the size gate cannot pass.",
  );
}

// --- Build -----------------------------------------------------------------
// One cargo invocation for every island crate: the release profile (lto,
// codegen-units=1) is per-invocation, and this keeps the build a single unit.
console.log(
  `building ${islands.map((island) => island.crate).join(", ")} for ${TARGET} (${PROFILE})`,
);

const cargoVersion = spawnSync("cargo", ["--version"], { encoding: "utf8" });
if (cargoVersion.error !== undefined || cargoVersion.status !== 0) {
  cannotEvaluate(
    "cargo is not runnable. Install rustup from https://rustup.rs then re-open the " +
      "shell (rust-toolchain.toml installs the pinned channel and the wasm32 target).",
  );
}
console.log(`  ${cargoVersion.stdout.trim()}  target=${TARGET}`);

const buildArgs = ["build", "--target", TARGET, "--profile", PROFILE];
for (const island of islands) {
  buildArgs.push("-p", island.crate);
}

const build = spawnSync("cargo", buildArgs, { cwd: REPO_ROOT, stdio: "inherit" });
if (build.error !== undefined) {
  cannotEvaluate(`cargo build failed to start: ${build.error.message}`);
}
if (build.status !== 0) {
  console.error(`cannot-evaluate: cargo build exited ${build.status}`);
  process.exit(2);
}

// --- Measure ---------------------------------------------------------------
const rows = [];
let overBudget = 0;

for (const island of islands) {
  const path = join(REPO_ROOT, "target", TARGET, PROFILE, island.artifact);
  if (!existsSync(path)) {
    cannotEvaluate(
      `expected artifact ${path} is missing after a successful build. ` +
        "The crate must be a `cdylib` to produce a .wasm bundle.",
    );
  }

  const bytes = readFileSync(path);
  if (bytes.length === 0) {
    cannotEvaluate(`${path} is 0 bytes; an empty module proves nothing.`);
  }
  if (!bytes.subarray(0, 4).equals(WASM_MAGIC)) {
    cannotEvaluate(`${path} is not a WebAssembly module (bad magic bytes).`);
  }

  const raw = statSync(path).size;
  const brotli = brotliSize(bytes);
  const verdict = brotli < BUDGET_BROTLI_BYTES ? "PASS" : "FAIL";
  if (verdict === "FAIL") {
    overBudget += 1;
  }
  rows.push({ ...island, raw, brotli, verdict });
}

// --- Report ----------------------------------------------------------------
const crateWidth = Math.max(5, ...rows.map((row) => row.crate.length));

console.log("");
console.log(
  `${"crate".padEnd(crateWidth)}  ${"raw".padStart(12)}  ${"brotli".padStart(12)}  ` +
    `${"budget".padStart(12)}  verdict`,
);
console.log("-".repeat(crateWidth + 12 + 12 + 12 + 10 + 6));

for (const row of rows) {
  const budgetCell = `< ${formatBytes(BUDGET_BROTLI_BYTES)}`;
  const verdictCell =
    row.verdict === "PASS"
      ? `PASS  (${((1 - row.brotli / BUDGET_BROTLI_BYTES) * 100).toFixed(1)}% headroom)`
      : `FAIL  over by ${formatBytes(row.brotli - BUDGET_BROTLI_BYTES)}`;
  console.log(
    `${row.crate.padEnd(crateWidth)}  ${`${row.raw} B`.padStart(12)}  ` +
      `${`${row.brotli} B`.padStart(12)}  ${budgetCell.padStart(12)}  ${verdictCell}`,
  );
}

console.log("");
console.log(
  `${rows.length - overBudget}/${rows.length} bundle(s) under the ${formatBytes(
    BUDGET_BROTLI_BYTES,
  )} brotli budget (brotli quality 11)`,
);

if (overBudget > 0) {
  console.error(
    "wasm size gate failed: a bundle exceeded the budget. Reduce the bundle, " +
      "not the budget — a lowered threshold needs a measured justification.",
  );
  process.exit(1);
}
