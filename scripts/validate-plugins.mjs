#!/usr/bin/env node
/**
 * Plugin manifest conformance check.
 *
 *   node scripts/validate-plugins.mjs            # every plugin under plugins/
 *   node scripts/validate-plugins.mjs --verbose  # print each plugin's facts
 *
 * What it proves, per plugin: the manifest validates in strict mode against
 * `schemas/plugin-manifest.schema.json`, every file the manifest references
 * exists, and `irRange` accepts `IR_VERSION` from `src/schema/site-ir.ts`.
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
  report = harness.runPluginConformance();
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

for (const result of results) {
  const label = result.id.padEnd(labelWidth);
  const status = result.ok ? "PASS" : "FAIL";
  const facts =
    result.manifest === undefined
      ? ""
      : `  name=${result.manifest.name} irRange=${result.manifest.irRange}`;
  console.log(`${status}  ${label}${facts}`);

  for (const finding of result.findings) {
    console.log(`        ${finding.code}: ${finding.path}: ${finding.message}`);
  }
  if (result.ok && verbose && result.manifest !== undefined) {
    console.log(`        hooks: ${result.manifest.hooks.join(", ")}`);
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
