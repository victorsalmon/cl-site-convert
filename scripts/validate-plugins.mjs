#!/usr/bin/env node
/**
 * Plugin manifest conformance check.
 *
 *   node scripts/validate-plugins.mjs            # every plugin under plugins/
 *   node scripts/validate-plugins.mjs --verbose  # print each plugin's facts
 *
 * What it proves, per plugin: the manifest validates in strict mode against
 * `schemas/plugin-manifest.schema.json` at its declared version (v1.0.0 or
 * v1.1.0), every file or bundle member the manifest references exists, every
 * declared asset `sha256`/`bytes`/`brotliBytes` matches the bytes on disk, the
 * config document satisfies its config schema, the declared IR range accepts
 * `IR_VERSION` from `src/schema/site-ir.ts`, and — because this script awaits the
 * async harness — the entrypoint exports a function for every declared hook.
 *
 * Exit codes: 0 every plugin conforms, 1 a plugin failed, 2 cannot evaluate
 * (the compiled harness is missing). Never a false pass: zero plugins is a
 * failure, not an empty success.
 *
 * The checks live in `src/conformance/plugin-manifest.ts` so this script and
 * `tests/plugin-conformance.test.ts` cannot drift apart. Node cannot import the
 * TypeScript module directly, so the script reads the compiled module; the
 * `validate:plugins` package script builds first.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const HARNESS = join(REPO_ROOT, "dist", "conformance", "plugin-manifest.js");
const verbose = process.argv.includes("--verbose");

if (!existsSync(HARNESS)) {
  console.error(
    `cannot-evaluate: ${HARNESS} is missing. Run \`pnpm run build\` first ` +
      "(`pnpm run validate:plugins` builds for you).",
  );
  process.exit(2);
}

let report;
try {
  const harness = await import(pathToFileURL(HARNESS).href);
  report = await harness.runPluginConformanceAsync();
} catch (error) {
  console.error(`cannot-evaluate: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const { results, skipped, findings, pluginsRoot } = report;

console.log(`plugins root: ${pluginsRoot}`);

const labelWidth = Math.max(
  4,
  ...results.map((result) => result.id.length),
  ...skipped.map((entry) => entry.id.length),
);

/** One line naming the seam and the IR direction this manifest declares. */
function factsOf(manifest) {
  const version = manifest.manifestVersion ?? "1.0.0";
  const role = manifest.role ?? "unroled";
  const range =
    manifest.acceptsIrRange !== undefined
      ? `acceptsIrRange=${manifest.acceptsIrRange}`
      : manifest.producesIrRange !== undefined
        ? `producesIrRange=${manifest.producesIrRange}`
        : `irRange=${manifest.irRange}`;
  return `  v${version} role=${role} ${range} name=${manifest.name}`;
}

for (const result of results) {
  const label = result.id.padEnd(labelWidth);
  const status = result.ok ? "PASS" : "FAIL";
  const facts = result.manifest === undefined ? "" : factsOf(result.manifest);
  console.log(`${status}  ${label}${facts}`);

  for (const finding of result.findings) {
    console.log(`        ${finding.code}: ${finding.path}: ${finding.message}`);
  }
  if (result.ok && verbose && result.manifest !== undefined) {
    console.log(`        hooks: ${result.manifest.hooks.join(", ") || "(none)"}`);
    console.log(
      `        assets: ${result.manifest.assets.map((asset) => asset.path).join(", ") || "(none)"}`,
    );
  }
}

for (const entry of skipped) {
  console.log(`SKIP  ${entry.id.padEnd(labelWidth)}  ${entry.reason}`);
}

for (const finding of findings) {
  console.log(`FAIL  ${"(root)".padEnd(labelWidth)}  ${finding.code}: ${finding.message}`);
}

const passed = results.filter((result) => result.ok).length;
console.log("");
console.log(`${passed}/${results.length} plugin(s) conform to the manifest contract`);

if (!report.ok) {
  console.error("plugin conformance failed");
  process.exit(1);
}
