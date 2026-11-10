#!/usr/bin/env node
/**
 * Measured Wasm bundle gate **and** bundle emitter.
 *
 *   node scripts/wasm-size.mjs        # or: pnpm validate:wasm-size
 *
 * What it proves:
 *
 *  1. every island crate that produces a `cdylib` builds for
 *     `wasm32-unknown-unknown` in release mode;
 *  2. the resulting file is a real Wasm module (magic `\0asm`, not 0 bytes);
 *  3. its **brotli** size is under the per-bundle budget;
 *  4. `dist/pkg/` contains exactly one bundle per island crate, no more and no
 *     less, and `dist/pkg/manifest.json` is a faithful description of those
 *     bytes.
 *
 * Point 4 is the anti-staleness guarantee. The manifest is never read as input
 * and never hand-edited: it is **regenerated** from the crates on every run,
 * orphaned bundles are swept, and the manifest that was just written is re-read
 * and re-hashed from disk before the gate is allowed to pass. A written file is
 * a claim; re-reading it from disk is evidence.
 *
 * The gate builds the artifacts itself. It never trusts a pre-existing `.wasm`
 * in `target/`, because a stale artifact is a false green.
 *
 * Exit codes: 0 every bundle is under budget and the manifest is consistent,
 * 1 a bundle exceeded the budget, 2 cannot evaluate (no cargo, no island crate,
 * a `cdylib` crate with no declared component, a duplicate component name, or a
 * missing/empty/not-Wasm artifact). Exit 2 is a failure, not a pass: a gate that
 * cannot measure must never report success (cl-common ADR 0012).
 *
 * Contract and measured numbers: `docs/wasm-build.md` and
 * `docs/islands-runtime.md`.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

/** Where the emitted bundles and their manifest land. */
const BUNDLE_DIR = join(REPO_ROOT, "dist", "pkg");
const MANIFEST_PATH = join(BUNDLE_DIR, "manifest.json");
const MANIFEST_VERSION = 1;

/** Wasm modules start with `\0asm` followed by the version dword 1. */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/** Component names are `data-component` values, so they are identifiers. */
const COMPONENT_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

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

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Minimal `Cargo.toml` reader. Deliberately not a TOML parser: this repo has no
 * TOML dependency and only three keys matter here.
 */
function readManifest(crateDir) {
  const text = readFileSync(join(crateDir, "Cargo.toml"), "utf8");
  const name = /^name\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  const crateTypeList = /^crate-type\s*=\s*\[([^\]]*)\]/m.exec(text)?.[1] ?? "";
  const crateTypes = [...crateTypeList.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  const islandSection = /^\[package\.metadata\.island\][^\n]*\n([\s\S]*?)(?=\n\[|$)/m.exec(
    text,
  )?.[1];
  const component = /^\s*component\s*=\s*"([^"]*)"\s*$/m.exec(islandSection ?? "")?.[1];

  return { name, crateTypes, component };
}

// --- Discover island crates -------------------------------------------------
// An *island* crate is any workspace crate that builds a `cdylib`: those are the
// bundles a page loads. Adding an island crate needs no edit to this script — it
// needs its own `[package.metadata.island] component = "…"`.
if (!existsSync(CRATES_DIR)) {
  cannotEvaluate(`crates/ directory not found at ${CRATES_DIR}`);
}

const islands = readdirSync(CRATES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(CRATES_DIR, entry.name, "Cargo.toml")))
  .map((entry) => {
    const { name, crateTypes, component } = readManifest(join(CRATES_DIR, entry.name));
    if (name === undefined) {
      cannotEvaluate(`crates/${entry.name}/Cargo.toml has no package name`);
    }
    return {
      crate: name,
      dir: `crates/${entry.name}`,
      /** Cargo's artifact name inside `target/`. */
      artifact: `${name.replace(/-/g, "_")}.wasm`,
      /** Emitted, URL-safe bundle name: the crate name is already kebab-case. */
      bundleFile: `${name}.wasm`,
      component,
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

// A bundle nothing can mount is dead weight; a component the emitter cannot name
// is a component it cannot place. Both are build errors.
const componentOwners = new Map();
for (const island of islands) {
  if (island.component === undefined || island.component.length === 0) {
    cannotEvaluate(
      `${island.dir}/Cargo.toml is a cdylib but declares no ` +
        '`[package.metadata.island] component = "ComponentName"`. Without it the ' +
        "emitted manifest cannot map a data-component value to this bundle.",
    );
  }
  if (!COMPONENT_PATTERN.test(island.component)) {
    cannotEvaluate(
      `${island.dir}: component "${island.component}" is not a valid component name ` +
        "(expected /^[A-Z][A-Za-z0-9]*$/ — it becomes a data-component value)",
    );
  }
  const owner = componentOwners.get(island.component);
  if (owner !== undefined) {
    cannotEvaluate(
      `component "${island.component}" is declared by both ${owner} and ${island.dir}. ` +
        "Two bundles cannot answer to one mount slot.",
    );
  }
  componentOwners.set(island.component, island.dir);
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
  rows.push({ ...island, source: path, bytes, raw, brotli, sha256: sha256Of(bytes), verdict });
}

// --- Emit one bundle per crate ---------------------------------------------
// `dist/` is generated output, so sweeping an orphan here is correct rather than
// destructive: after this block the directory is exactly the crate-derived set,
// which is what makes "the manifest cannot go stale" true.
try {
  mkdirSync(BUNDLE_DIR, { recursive: true });
} catch (error) {
  cannotEvaluate(`cannot create ${BUNDLE_DIR}: ${error.message}`);
}

const expectedBundles = new Set(rows.map((row) => row.bundleFile));
for (const name of readdirSync(BUNDLE_DIR)) {
  if (!name.endsWith(".wasm")) continue;
  if (expectedBundles.has(name)) continue;
  try {
    unlinkSync(join(BUNDLE_DIR, name));
  } catch (error) {
    cannotEvaluate(`cannot remove stale bundle ${name}: ${error.message}`);
  }
  console.log(`  removed stale bundle ${name} (no island crate produces it)`);
}

for (const row of rows) {
  try {
    copyFileSync(row.source, join(BUNDLE_DIR, row.bundleFile));
  } catch (error) {
    cannotEvaluate(`cannot write ${row.bundleFile}: ${error.message}`);
  }
}

const components = {};
for (const row of rows) {
  components[row.component] = {
    crate: row.crate,
    wasmPath: row.bundleFile,
    rawBytes: row.raw,
    brotliBytes: row.brotli,
    sha256: row.sha256,
  };
}

const manifest = {
  manifestVersion: MANIFEST_VERSION,
  target: TARGET,
  budgetBrotliBytes: BUDGET_BROTLI_BYTES,
  components,
};

try {
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
} catch (error) {
  cannotEvaluate(`cannot write ${MANIFEST_PATH}: ${error.message}`);
}

// --- Verify the manifest against the bytes on disk --------------------------
// The manifest was just written from memory. Re-read it and re-hash the files it
// names: that is the difference between "we wrote a file" and "the shipped bytes
// match the contract".
let emitted;
try {
  emitted = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch (error) {
  cannotEvaluate(`${MANIFEST_PATH} cannot be read back as JSON: ${error.message}`);
}

const emittedComponents = Object.keys(emitted?.components ?? {});
const declaredComponents = rows.map((row) => row.component);

if (emitted?.manifestVersion !== MANIFEST_VERSION) {
  cannotEvaluate(
    `${MANIFEST_PATH} reports manifestVersion ${emitted?.manifestVersion}, expected ${MANIFEST_VERSION}`,
  );
}
if (
  emittedComponents.length !== declaredComponents.length ||
  declaredComponents.some((component) => !emittedComponents.includes(component))
) {
  cannotEvaluate(
    `${MANIFEST_PATH} does not describe exactly the island crates: ` +
      `manifest=[${emittedComponents.join(", ")}] crates=[${declaredComponents.join(", ")}]`,
  );
}

for (const row of rows) {
  const entry = emitted.components?.[row.component];
  if (entry === undefined) {
    cannotEvaluate(`${MANIFEST_PATH} is missing component ${row.component}`);
  }
  if (entry.wasmPath !== row.bundleFile) {
    cannotEvaluate(
      `${row.component}: manifest wasmPath "${entry.wasmPath}" does not match emitted "${row.bundleFile}"`,
    );
  }
  if (entry.brotliBytes !== row.brotli) {
    cannotEvaluate(
      `${row.component}: manifest brotliBytes ${entry.brotliBytes} does not match measured ${row.brotli}`,
    );
  }

  const emittedPath = join(BUNDLE_DIR, entry.wasmPath);
  if (!existsSync(emittedPath)) {
    cannotEvaluate(`${row.component}: emitted bundle ${emittedPath} is missing`);
  }
  const emittedBytes = readFileSync(emittedPath);
  const emittedSha = sha256Of(emittedBytes);
  if (emittedBytes.length !== row.raw) {
    cannotEvaluate(
      `${row.component}: emitted bundle is ${emittedBytes.length} B but the build produced ${row.raw} B`,
    );
  }
  if (emittedSha !== entry.sha256) {
    cannotEvaluate(
      `${row.component}: emitted bundle sha256 ${emittedSha.slice(0, 12)}… does not match ` +
        `manifest ${String(entry.sha256).slice(0, 12)}…`,
    );
  }
}

// --- Report ----------------------------------------------------------------
const crateWidth = Math.max(5, ...rows.map((row) => row.crate.length));
const componentWidth = Math.max(9, ...rows.map((row) => row.component.length));

console.log("");
console.log(
  `${"component".padEnd(componentWidth)}  ${"crate".padEnd(crateWidth)}  ` +
    `${"raw".padStart(12)}  ${"brotli".padStart(12)}  ${"budget".padStart(12)}  ` +
    `${"sha256".padEnd(12)}  verdict`,
);
console.log("-".repeat(componentWidth + crateWidth + 12 + 12 + 12 + 12 + 10 + 10));

for (const row of rows) {
  const budgetCell = `< ${formatBytes(BUDGET_BROTLI_BYTES)}`;
  const verdictCell =
    row.verdict === "PASS"
      ? `PASS  (${((1 - row.brotli / BUDGET_BROTLI_BYTES) * 100).toFixed(1)}% headroom)`
      : `FAIL  over by ${formatBytes(row.brotli - BUDGET_BROTLI_BYTES)}`;
  console.log(
    `${row.component.padEnd(componentWidth)}  ${row.crate.padEnd(crateWidth)}  ` +
      `${`${row.raw} B`.padStart(12)}  ${`${row.brotli} B`.padStart(12)}  ` +
      `${budgetCell.padStart(12)}  ${row.sha256.slice(0, 12)}…  ${verdictCell}`,
  );
}

console.log("");
console.log(
  `${rows.length - overBudget}/${rows.length} bundle(s) under the ${formatBytes(
    BUDGET_BROTLI_BYTES,
  )} brotli budget (brotli quality 11)`,
);
console.log(
  `manifest: ${MANIFEST_PATH} — ${emittedComponents.length} component(s), verified ` +
    `against the emitted bytes on disk`,
);
console.log(
  `island-free pages load 0 of these bundles: the loader returns before resolving ` +
    `the manifest when a document has no [data-component] mount node`,
);

if (overBudget > 0) {
  console.error(
    "wasm size gate failed: a bundle exceeded the budget. Reduce the bundle, " +
      "not the budget — a lowered threshold needs a measured justification.",
  );
  process.exit(1);
}
