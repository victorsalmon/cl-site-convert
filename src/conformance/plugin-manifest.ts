/**
 * Plugin manifest conformance harness.
 *
 * The manifest schema (`schemas/plugin-manifest.schema.json`) says what a
 * manifest may *look* like. This module answers the questions a JSON Schema
 * cannot:
 *
 *  1. does every plugin directory under `plugins/` actually have a manifest, and
 *     does it validate in strict mode against the frozen schema?
 *  2. do the files the manifest points at exist on this checkout (entrypoint,
 *     runbook, config schema, non-optional assets)?
 *  3. does `irRange` accept the Site IR version this repo actually speaks, so a
 *     plugin cannot claim compatibility it does not have?
 *
 * Fail-closed by construction: a plugin is `ok` only when it produced zero
 * findings, a directory that carries files but no manifest is a finding, and a
 * run that discovers no plugins at all is a finding. A schema that cannot be
 * loaded throws — it never degrades into "nothing to check, therefore pass".
 *
 * Not checked here: whether the entrypoint really exports a handler per declared
 * hook. That needs to execute plugin code, so it lives in
 * `tests/plugin-conformance.test.ts`, which loads `plugins/_template`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv/dist/2020.js";

import { IR_VERSION } from "../schema/site-ir.js";

/** Directory name the pipeline loads a plugin from. */
export const MANIFEST_FILENAME = "plugin.json";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from this module in both `src/` and `dist/`. */
export const REPO_ROOT = resolve(HERE, "..", "..");

/** Where plugins live. */
export const PLUGINS_ROOT = join(REPO_ROOT, "plugins");

/** The frozen manifest contract. */
export const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "plugin-manifest.schema.json");

/** The part of `plugin.json` this harness reads. Mirrors the frozen schema. */
export interface PluginManifest {
  name: string;
  version: string;
  irRange: string;
  emits: string[];
  sinks?: string[];
  hooks: string[];
  assets: Array<{ path: string; kind?: string; optional?: boolean }>;
  runbook: string;
  configSchema?: string;
  entrypoint?: string;
}

/** Why a plugin failed conformance. One code per distinct repair. */
export type PluginFindingCode =
  | "manifest-missing"
  | "manifest-unreadable"
  | "schema"
  | "required-file-missing"
  | "ir-range-unsatisfied"
  | "duplicate-name"
  | "plugins-root-missing"
  | "no-plugins";

export interface PluginFinding {
  code: PluginFindingCode;
  /** The offending path, relative to the plugin directory ("." for the plugin itself). */
  path: string;
  message: string;
}

export interface PluginConformanceResult {
  /** Directory name under `plugins/`, e.g. `_template`. */
  id: string;
  /** Absolute plugin directory. */
  dir: string;
  /** Absolute path to the manifest, whether or not it exists. */
  manifestPath: string;
  /** Present only when the manifest parsed as JSON. */
  manifest?: PluginManifest;
  findings: PluginFinding[];
  ok: boolean;
}

/** A directory that is not (yet) a plugin, named so the omission stays visible. */
export interface SkippedPluginDirectory {
  id: string;
  dir: string;
  reason: string;
}

export interface PluginConformanceReport {
  pluginsRoot: string;
  results: PluginConformanceResult[];
  skipped: SkippedPluginDirectory[];
  /** Findings that belong to the root rather than to one plugin. */
  findings: PluginFinding[];
  ok: boolean;
}

export interface ConformanceOptions {
  /** Override the plugins directory (tests use a temp root). */
  pluginsRoot?: string;
  /** Override the manifest schema path (tests use a broken schema). */
  schemaPath?: string;
}

// --- semver ----------------------------------------------------------------

interface Version {
  major: number;
  minor: number;
  patch: number;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const COMPARATOR_SOURCE = "(>=|<=|>|<|\\^|~|=)?\\s*(\\d+)\\.(\\d+)\\.(\\d+)";

function parseVersion(text: string): Version | undefined {
  const match = VERSION_PATTERN.exec(text.trim());
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function compare(left: Version, right: Version): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

/** First version above `version` that a caret range rejects. */
function caretUpper(version: Version): Version {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 };
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0 };
  return { major: 0, minor: 0, patch: version.patch + 1 };
}

/** First version above `version` that a tilde range rejects. */
function tildeUpper(version: Version): Version {
  return { major: version.major, minor: version.minor + 1, patch: 0 };
}

function satisfiesComparator(operator: string, bound: Version, version: Version): boolean {
  switch (operator) {
    case "=":
      return compare(version, bound) === 0;
    case ">":
      return compare(version, bound) > 0;
    case ">=":
      return compare(version, bound) >= 0;
    case "<":
      return compare(version, bound) < 0;
    case "<=":
      return compare(version, bound) <= 0;
    case "^":
      return compare(version, bound) >= 0 && compare(version, caretUpper(bound)) < 0;
    case "~":
      return compare(version, bound) >= 0 && compare(version, tildeUpper(bound)) < 0;
    default:
      return false;
  }
}

/**
 * Does `range` accept `version`?
 *
 * The manifest schema admits exactly these shapes: `1.0.0`, `=1.0.0`, `^1.0.0`,
 * `~1.0.0`, `>1.0.0`, `>=1.0.0`, `<1.0.0`, `<=1.0.0`, and space-separated
 * comparator lists such as `1.0.0 <2.0.0`. Anything the tiny parser cannot read
 * is `false`: an unreadable range is an unsatisfied range, never a pass.
 */
export function isSemverRangeSatisfied(range: string, version: string): boolean {
  const parsedVersion = parseVersion(version);
  if (parsedVersion === undefined) return false;

  const comparatorPattern = new RegExp(COMPARATOR_SOURCE, "g");
  const comparators: Array<{ operator: string; bound: Version }> = [];

  for (const match of range.matchAll(comparatorPattern)) {
    const [, operator, major, minor, patch] = match;
    if (major === undefined || minor === undefined || patch === undefined) return false;
    const bound = parseVersion(`${major}.${minor}.${patch}`);
    if (bound === undefined) return false;
    comparators.push({ operator: operator ?? "=", bound });
  }

  if (comparators.length === 0) return false;

  // Fail closed on residue the tokenizer did not consume, e.g. `latest` or `^1.0`.
  const residue = range.replace(new RegExp(COMPARATOR_SOURCE, "g"), "").trim();
  if (residue.length > 0) return false;

  return comparators.every(({ operator, bound }) =>
    satisfiesComparator(operator, bound, parsedVersion),
  );
}

// --- manifest validation ---------------------------------------------------

const validators = new Map<string, ValidateFunction>();

function manifestValidator(schemaPath: string): ValidateFunction {
  const cached = validators.get(schemaPath);
  if (cached !== undefined) return cached;

  // A schema that cannot be read or compiled is a cannot-evaluate. Throwing here
  // is deliberate: silently reporting "no findings" would be a false pass.
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as AnySchemaObject;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  validators.set(schemaPath, validate);
  return validate;
}

function formatAjvErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => {
    const params: Record<string, unknown> = error.params;
    const extra =
      typeof params["additionalProperty"] === "string" ? ` [${params["additionalProperty"]}]` : "";
    return `${error.instancePath || "(root)"}: ${error.message ?? "invalid"}${extra}`;
  });
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

/** Validate a parsed manifest against the frozen schema, without touching disk. */
export function validatePluginManifest(
  manifest: unknown,
  schemaPath: string = MANIFEST_SCHEMA_PATH,
): ManifestValidation {
  const validate = manifestValidator(schemaPath);
  if (validate(manifest)) return { ok: true, errors: [] };
  return { ok: false, errors: formatAjvErrors(validate.errors) };
}

// --- referenced files ------------------------------------------------------

function isFile(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Every plugin-relative path in the manifest must resolve to a real file inside
 * the plugin directory. Optional assets may be absent; nothing may escape the
 * directory even if the schema is bypassed.
 */
export function checkManifestFiles(dir: string, manifest: PluginManifest): PluginFinding[] {
  const findings: PluginFinding[] = [];
  const pluginRoot = resolve(dir);

  const requireFile = (relativePath: string, field: string, optional: boolean): void => {
    const absolutePath = resolve(pluginRoot, relativePath);
    const inside = absolutePath === pluginRoot || absolutePath.startsWith(pluginRoot + sep);

    if (!inside) {
      findings.push({
        code: "required-file-missing",
        path: relativePath,
        message: `${field} must stay inside the plugin directory`,
      });
      return;
    }

    if (isFile(absolutePath)) return;
    if (optional) return;

    findings.push({
      code: "required-file-missing",
      path: relativePath,
      message: `${field} references "${relativePath}", which does not exist`,
    });
  };

  if (manifest.entrypoint !== undefined) {
    requireFile(manifest.entrypoint, "entrypoint", false);
  }
  requireFile(manifest.runbook, "runbook", false);
  if (manifest.configSchema !== undefined) {
    requireFile(manifest.configSchema, "configSchema", false);
  }
  for (const asset of manifest.assets) {
    requireFile(asset.path, `assets[].path (${asset.kind ?? "other"})`, asset.optional === true);
  }

  return findings;
}

// --- per-plugin check ------------------------------------------------------

/** Check one plugin directory. Never throws for plugin-authored mistakes. */
export function checkPlugin(
  pluginDir: string,
  schemaPath: string = MANIFEST_SCHEMA_PATH,
): PluginConformanceResult {
  const dir = resolve(pluginDir);
  const id = basename(dir);
  const manifestPath = join(dir, MANIFEST_FILENAME);
  const findings: PluginFinding[] = [];

  const finish = (manifest?: PluginManifest): PluginConformanceResult => {
    const result: PluginConformanceResult = {
      id,
      dir,
      manifestPath,
      findings,
      ok: findings.length === 0,
    };
    if (manifest !== undefined) result.manifest = manifest;
    return result;
  };

  if (!isFile(manifestPath)) {
    findings.push({
      code: "manifest-missing",
      path: MANIFEST_FILENAME,
      message: `no ${MANIFEST_FILENAME}; a plugin without a manifest cannot be loaded`,
    });
    return finish();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    findings.push({
      code: "manifest-unreadable",
      path: MANIFEST_FILENAME,
      message: `${MANIFEST_FILENAME} is not valid JSON: ${detail}`,
    });
    return finish();
  }

  const validation = validatePluginManifest(parsed, schemaPath);
  if (!validation.ok) {
    for (const error of validation.errors) {
      findings.push({ code: "schema", path: MANIFEST_FILENAME, message: error });
    }
    // The shape is untrustworthy, so the file and range checks would only
    // produce noise. The schema finding above is the one to fix.
    return finish();
  }

  const manifest = parsed as PluginManifest;
  findings.push(...checkManifestFiles(dir, manifest));

  if (!isSemverRangeSatisfied(manifest.irRange, IR_VERSION)) {
    findings.push({
      code: "ir-range-unsatisfied",
      path: MANIFEST_FILENAME,
      message: `irRange "${manifest.irRange}" does not accept IR_VERSION "${IR_VERSION}" from src/schema/site-ir.ts`,
    });
  }

  return finish(manifest);
}

// --- discovery -------------------------------------------------------------

export interface PluginDiscovery {
  dirs: string[];
  skipped: SkippedPluginDirectory[];
  findings: PluginFinding[];
}

function isDirectory(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every direct child of `pluginsRoot` that looks like a plugin.
 *
 * - a child with `plugin.json` is a plugin to check;
 * - a child with files but no `plugin.json` is a finding (half-built plugins must
 *   not slip through the gate silently);
 * - an empty child is skipped by name — git cannot deliver an empty directory, so
 *   it is local debris, not a claim of a plugin.
 */
export function discoverPluginDirs(pluginsRoot: string = PLUGINS_ROOT): PluginDiscovery {
  const root = resolve(pluginsRoot);
  const dirs: string[] = [];
  const skipped: SkippedPluginDirectory[] = [];
  const findings: PluginFinding[] = [];

  if (!isDirectory(root)) {
    findings.push({
      code: "plugins-root-missing",
      path: ".",
      message: `plugins directory "${root}" does not exist`,
    });
    return { dirs, skipped, findings };
  }

  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const dir = join(root, entry.name);
    if (isFile(join(dir, MANIFEST_FILENAME))) {
      dirs.push(dir);
      continue;
    }

    if (readdirSync(dir).length === 0) {
      skipped.push({
        id: entry.name,
        dir,
        reason: `empty directory with no ${MANIFEST_FILENAME}`,
      });
      continue;
    }

    findings.push({
      code: "manifest-missing",
      path: entry.name,
      message: `plugins/${entry.name}/ has files but no ${MANIFEST_FILENAME}`,
    });
  }

  return { dirs, skipped, findings };
}

// --- whole-root check ------------------------------------------------------

/** Check every plugin under `pluginsRoot` and cross-check the things one manifest cannot see. */
export function runPluginConformance(options: ConformanceOptions = {}): PluginConformanceReport {
  const pluginsRoot = resolve(options.pluginsRoot ?? PLUGINS_ROOT);
  const schemaPath = options.schemaPath ?? MANIFEST_SCHEMA_PATH;
  const discovery = discoverPluginDirs(pluginsRoot);
  const findings: PluginFinding[] = [...discovery.findings];
  const results: PluginConformanceResult[] = [];

  const seenNames = new Map<string, string>();

  for (const dir of discovery.dirs) {
    const result = checkPlugin(dir, schemaPath);
    const name = result.manifest?.name;
    if (name !== undefined) {
      const firstDir = seenNames.get(name);
      if (firstDir !== undefined) {
        result.findings.push({
          code: "duplicate-name",
          path: MANIFEST_FILENAME,
          message: `name "${name}" is already used by ${firstDir}`,
        });
        result.ok = false;
      } else {
        seenNames.set(name, result.id);
      }
    }
    results.push(result);
  }

  if (results.length === 0) {
    findings.push({
      code: "no-plugins",
      path: ".",
      message: `no plugin with a ${MANIFEST_FILENAME} was found under "${pluginsRoot}"`,
    });
  }

  const ok = findings.length === 0 && results.every((result) => result.ok);
  return { pluginsRoot, results, skipped: discovery.skipped, findings, ok };
}
