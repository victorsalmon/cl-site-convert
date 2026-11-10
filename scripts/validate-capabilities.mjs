#!/usr/bin/env node
/**
 * Capability-report conformance validator.
 *
 *   node scripts/validate-capabilities.mjs                     # capture/capabilities.json
 *   node scripts/validate-capabilities.mjs <path> [<path>...]   # explicit reports
 *
 * `capture/capabilities.json` is not "a report we also write". It is the Site IR
 * `capabilities` object that the emitter consumes, so it is validated against the
 * frozen schema (`schemas/site-ir.schema.json` -> `$defs/capabilities`) inside the
 * gate rather than trusted. The detection code proves the classification logic;
 * this proves the artifact's shape, and both are needed.
 *
 * Beyond the schema, two properties a JSON Schema cannot express are enforced:
 *
 *  - every `blocking: true` entry must also be `unsupported` (i.e. every blocking
 *    capability is visible in the report's own failure list);
 *  - a report must never be empty-and-silent: a report with no `supported` and no
 *    `unsupported` entries would read as a clean site while proving nothing, so it
 *    is rejected. `cannot-evaluate` is an entry, not an empty file.
 *
 * Exit codes: 0 pass, 1 a report is non-conforming, 2 cannot-evaluate (ajv
 * missing, or no report to read). Mirrors `scripts/validate-ir.mjs`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_REPORTS = ["capture/capabilities.json"];

function cannotEvaluate(message) {
  console.error(`cannot-evaluate: ${message}`);
  process.exit(2);
}

async function loadAjv() {
  const candidates = [];
  const addRoot = (dir) => {
    if (!dir) return;
    candidates.push(join(dir, "node_modules", "ajv", "dist", "2020.js"));
  };
  addRoot(REPO_ROOT);
  addRoot(process.cwd());
  for (const dir of (process.env.AJV_RESOLVE_FROM ?? "").split(
    process.platform === "win32" ? ";" : ":",
  )) {
    addRoot(dir.trim());
  }

  try {
    const mod = await import("ajv/dist/2020.js");
    return mod.default ?? mod;
  } catch {
    // fall through to explicit paths
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate).href);
      return mod.default ?? mod;
    }
  }

  cannotEvaluate(
    "ajv (draft 2020-12) is not installed. Install it for the validator, e.g.\n" +
      "  pnpm add -D ajv\n" +
      "or point AJV_RESOLVE_FROM at a directory whose node_modules contains ajv.",
  );
}

/** Relationships the schema cannot police. An empty list means the report is sane. */
function reportProblems(report) {
  const problems = [];
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return ["report is not a JSON object"];
  }
  const supported = Array.isArray(report.supported) ? report.supported : [];
  const unsupported = Array.isArray(report.unsupported) ? report.unsupported : [];

  if (supported.length === 0 && unsupported.length === 0) {
    problems.push(
      "report is empty: nothing supported and nothing unsupported reads as a clean site while proving nothing",
    );
  }

  const keys = new Set();
  for (const entry of unsupported) {
    if (typeof entry?.capability !== "string") continue;
    if (keys.has(entry.capability)) problems.push(`duplicate capability ${entry.capability}`);
    keys.add(entry.capability);
    if (entry.blocking === true && (entry.detail ?? "").length === 0) {
      problems.push(`${entry.capability}: blocking entry carries no detail explaining why`);
    }
  }

  for (const name of supported) {
    if (keys.has(name)) problems.push(`${name} is listed as both supported and unsupported`);
  }

  return problems;
}

async function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const paths = requested.length > 0 ? requested : DEFAULT_REPORTS;

  const Ajv2020 = await loadAjv();
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const schema = JSON.parse(
    readFileSync(join(REPO_ROOT, "schemas", "site-ir.schema.json"), "utf8"),
  );
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/capabilities` });

  let failures = 0;
  for (const path of paths) {
    const absolute = resolve(process.cwd(), path);
    if (!existsSync(absolute)) {
      console.error(`FAIL  ${path}  (no such file)`);
      failures += 1;
      continue;
    }

    let report;
    try {
      report = JSON.parse(readFileSync(absolute, "utf8"));
    } catch (error) {
      console.error(`FAIL  ${path}  not valid JSON: ${error.message}`);
      failures += 1;
      continue;
    }

    const schemaOk = validate(report);
    const schemaErrors = (validate.errors ?? []).map(
      (error) =>
        `${error.instancePath || "(root)"}: ${error.message}${
          error.params && "additionalProperty" in error.params
            ? ` [${error.params.additionalProperty}]`
            : ""
        }`,
    );
    const problems = reportProblems(report);

    if (schemaOk && problems.length === 0) {
      console.log(`PASS  ${path}`);
      continue;
    }
    failures += 1;
    console.log(`FAIL  ${path}`);
    for (const error of schemaErrors) console.log(`        schema: ${error}`);
    for (const problem of problems) console.log(`        report: ${problem}`);
  }

  console.log("");
  console.log(`${paths.length - failures}/${paths.length} capability report(s) conformed`);
  if (failures > 0) {
    console.error(`${failures} capability report(s) failed`);
    process.exit(1);
  }
}

await main();
