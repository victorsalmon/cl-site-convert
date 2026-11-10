/**
 * Plugin manifest conformance harness.
 *
 * The manifest schema (`schemas/plugin-manifest.schema.json`) says what a
 * manifest may *look* like. This module answers the questions a JSON Schema
 * cannot:
 *
 *  1. does every plugin directory under `plugins/` actually have a manifest, and
 *     does it validate in strict mode against the versioned schema?
 *  2. do the files the manifest points at exist on this checkout (entrypoint,
 *     runbook, config schema and config document, non-optional assets), and are
 *     the declared asset integrity numbers true?
 *  3. does the declared IR range — `producesIrRange` for a source,
 *     `acceptsIrRange` for an emitter/sink, or the v1.0 `irRange` — accept the
 *     Site IR version this repo actually speaks?
 *  4. does the config document satisfy the config schema it names, so a loader
 *     can resolve and trust it?
 *  5. (`checkHookExports` / `runPluginConformanceAsync`) does the module named by
 *     `entrypoint.module` export the object named by `hooksExport`, and is every
 *     hook the manifest declares a function on it?
 *
 * Fail-closed by construction: a plugin is `ok` only when it produced zero
 * findings, a directory that carries files but no manifest is a finding, and a
 * run that discovers no plugins at all is a finding. A schema or config schema
 * that cannot be loaded throws or reports a finding — it never degrades into
 * "nothing to check, therefore pass".
 *
 * The sync checks are separate from the async hook-export check on purpose: the
 * sync ones are pure filesystem/JSON work and run everywhere, while proving the
 * load surface means importing plugin code.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject, ErrorObject, ValidateFunction } from "ajv/dist/2020.js";

import { IR_VERSION } from "../schema/site-ir.js";

/** Directory name the pipeline loads a plugin from. */
export const MANIFEST_FILENAME = "plugin.json";

/** Export name assumed by the v1.0.0 string `entrypoint` form. */
export const DEFAULT_HOOKS_EXPORT = "hooks";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from this module in both `src/` and `dist/`. */
export const REPO_ROOT = resolve(HERE, "..", "..");

/** Where plugins live. */
export const PLUGINS_ROOT = join(REPO_ROOT, "plugins");

/** The frozen manifest contract. */
export const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "plugin-manifest.schema.json");

/** Which manifest contract a document is written against. */
export type ManifestVersion = "1.0.0" | "1.1.0";

/** The seam a plugin sits on. */
export type PluginRole = "source" | "emitter" | "sink" | "deployer";

/** v1.1 load surface: the module and the export holding the hook record. */
export interface HookEntrypoint {
  module: string;
  hooksExport: string;
}

/** One member of a bundle directory, with its own integrity numbers. */
export interface BundleFile {
  path: string;
  sha256: string;
  bytes: number;
  brotliBytes?: number;
}

/** A file or bundle directory the plugin ships. */
export interface PluginAsset {
  path: string;
  kind?: string;
  optional?: boolean;
  type?: "file" | "directory";
  sha256?: string;
  bytes?: number;
  brotliBytes?: number;
  files?: BundleFile[];
}

/** Where a loader finds the plugin's config, and its schema. */
export interface PluginConfigLocation {
  path?: string;
  inline?: Record<string, unknown>;
}

/** The part of `plugin.json` this harness reads. Mirrors the versioned schema. */
export interface PluginManifest {
  manifestVersion?: ManifestVersion;
  name: string;
  version: string;
  role?: PluginRole;
  /** v1.0.0 only; v1.1 splits it into the two directional fields. */
  irRange?: string;
  acceptsIrRange?: string;
  producesIrRange?: string;
  emits: string[];
  consumes?: string[];
  sinks?: string[];
  hooks: string[];
  entrypoint?: string | HookEntrypoint;
  assets: PluginAsset[];
  runbook: string;
  configSchema?: string;
  config?: PluginConfigLocation;
}

/** Why a plugin failed conformance. One code per distinct repair. */
export type PluginFindingCode =
  | "manifest-missing"
  | "manifest-unreadable"
  | "schema"
  | "required-file-missing"
  | "asset-type-mismatch"
  | "asset-integrity"
  | "config-invalid"
  | "entrypoint-unloadable"
  | "hook-export-missing"
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

// --- manifest version and load surface -------------------------------------

/** A manifest without `manifestVersion` is a v1.0.0 manifest. */
export function manifestVersionOf(manifest: PluginManifest): ManifestVersion {
  return manifest.manifestVersion === "1.1.0" ? "1.1.0" : "1.0.0";
}

/** Plugin-relative path of the loadable module, whichever entrypoint form was used. */
export function entrypointModule(manifest: PluginManifest): string | undefined {
  if (manifest.entrypoint === undefined) return undefined;
  if (typeof manifest.entrypoint === "string") return manifest.entrypoint;
  return manifest.entrypoint.module;
}

/** Export name holding the hook record; the string form assumes `hooks`. */
export function hooksExportName(manifest: PluginManifest): string {
  if (manifest.entrypoint === undefined) return DEFAULT_HOOKS_EXPORT;
  if (typeof manifest.entrypoint === "string") return DEFAULT_HOOKS_EXPORT;
  return manifest.entrypoint.hooksExport;
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

function isDirectory(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

/** True when `absolutePath` is `root` or lives beneath it. */
function isInside(root: string, absolutePath: string): boolean {
  return absolutePath === root || absolutePath.startsWith(root + sep);
}

/**
 * Every plugin-relative path in the manifest must resolve to a real file inside
 * the plugin directory. Optional assets may be absent; nothing may escape the
 * directory even if the schema is bypassed. A bundle asset must be a directory
 * and each of its members must exist inside it.
 */
export function checkManifestFiles(dir: string, manifest: PluginManifest): PluginFinding[] {
  const findings: PluginFinding[] = [];
  const pluginRoot = resolve(dir);

  const requireFile = (relativePath: string, field: string, optional: boolean): void => {
    const absolutePath = resolve(pluginRoot, relativePath);

    if (!isInside(pluginRoot, absolutePath)) {
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

  const modulePath = entrypointModule(manifest);
  if (modulePath !== undefined) {
    requireFile(modulePath, "entrypoint.module", false);
  }
  requireFile(manifest.runbook, "runbook", false);
  if (manifest.configSchema !== undefined) {
    requireFile(manifest.configSchema, "configSchema", false);
  }
  if (manifest.config?.path !== undefined) {
    requireFile(manifest.config.path, "config.path", false);
  }

  for (const asset of manifest.assets) {
    const label = `assets[].path (${asset.kind ?? "other"})`;
    const assetPath = resolve(pluginRoot, asset.path);

    if (!isInside(pluginRoot, assetPath)) {
      findings.push({
        code: "required-file-missing",
        path: asset.path,
        message: `${label} must stay inside the plugin directory`,
      });
      continue;
    }

    if (asset.type === "directory") {
      if (!isDirectory(assetPath)) {
        if (asset.optional === true) continue;
        findings.push({
          code: "asset-type-mismatch",
          path: asset.path,
          message: `${label} declares type "directory" but "${asset.path}" is not a directory`,
        });
        continue;
      }
      for (const member of asset.files ?? []) {
        const memberPath = resolve(assetPath, member.path);
        if (!isInside(assetPath, memberPath) || !isFile(memberPath)) {
          findings.push({
            code: "asset-type-mismatch",
            path: `${asset.path}/${member.path}`,
            message: `bundle member "${member.path}" does not exist inside the bundle "${asset.path}"`,
          });
        }
      }
      continue;
    }

    if (isFile(assetPath)) continue;
    if (asset.optional === true) continue;

    findings.push({
      code: "required-file-missing",
      path: asset.path,
      message: `${label} references "${asset.path}", which does not exist`,
    });
  }

  return findings;
}

// --- asset integrity --------------------------------------------------------

/** Hash the shipped bytes, exactly as the size gate does. */
function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Brotli-compress exactly as a CDN would, at maximum quality (mirrors scripts/wasm-size.mjs). */
function brotliBytesOf(buffer: Buffer): number {
  return brotliCompressSync(buffer, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
    },
  }).length;
}

/**
 * A declared hash or size is a claim; re-reading and re-hashing the file is the
 * evidence. Every declared `sha256`/`bytes`/`brotliBytes` must match the bytes
 * on disk, for a file asset and for each bundle member. Undeclared numbers are
 * simply not checked — `optional` assets often carry none.
 */
export function checkAssetIntegrity(dir: string, manifest: PluginManifest): PluginFinding[] {
  const findings: PluginFinding[] = [];
  const pluginRoot = resolve(dir);

  const verify = (
    relativePath: string,
    absolutePath: string,
    claimed: { sha256?: string; bytes?: number; brotliBytes?: number },
  ): void => {
    let buffer: Buffer;
    try {
      buffer = readFileSync(absolutePath);
    } catch {
      // Existence is checkManifestFiles' job; a missing file is not a second finding.
      return;
    }

    if (claimed.bytes !== undefined && buffer.length !== claimed.bytes) {
      findings.push({
        code: "asset-integrity",
        path: relativePath,
        message: `declared bytes ${claimed.bytes} but the file is ${buffer.length} B (${pluginRoot})`,
      });
    }
    if (claimed.sha256 !== undefined) {
      const actual = sha256Of(buffer);
      if (actual !== claimed.sha256) {
        findings.push({
          code: "asset-integrity",
          path: relativePath,
          message: `declared sha256 ${claimed.sha256.slice(0, 12)}… but the file hashes to ${actual.slice(0, 12)}…`,
        });
      }
    }
    if (claimed.brotliBytes !== undefined) {
      const actual = brotliBytesOf(buffer);
      if (actual !== claimed.brotliBytes) {
        findings.push({
          code: "asset-integrity",
          path: relativePath,
          message: `declared brotliBytes ${claimed.brotliBytes} but quality-11 brotli measures ${actual} B`,
        });
      }
    }
  };

  for (const asset of manifest.assets) {
    const assetPath = resolve(pluginRoot, asset.path);
    if (!isInside(pluginRoot, assetPath)) continue;

    if (asset.type === "directory") {
      if (!isDirectory(assetPath)) continue;
      for (const member of asset.files ?? []) {
        const memberPath = resolve(assetPath, member.path);
        if (!isInside(assetPath, memberPath) || !isFile(memberPath)) continue;
        const claimed = {
          sha256: member.sha256,
          bytes: member.bytes,
          ...(member.brotliBytes === undefined ? {} : { brotliBytes: member.brotliBytes }),
        };
        verify(`${asset.path}/${member.path}`, memberPath, claimed);
      }
      continue;
    }

    if (!isFile(assetPath)) continue;
    verify(asset.path, assetPath, {
      ...(asset.sha256 === undefined ? {} : { sha256: asset.sha256 }),
      ...(asset.bytes === undefined ? {} : { bytes: asset.bytes }),
      ...(asset.brotliBytes === undefined ? {} : { brotliBytes: asset.brotliBytes }),
    });
  }

  return findings;
}

// --- config -----------------------------------------------------------------

const configValidators = new Map<string, ValidateFunction>();

function configValidator(schemaPath: string): ValidateFunction {
  const cached = configValidators.get(schemaPath);
  if (cached !== undefined) return cached;

  // The config schema is plugin-authored. A fresh Ajv per path avoids the
  // duplicate-`$id` refusal when several plugins are checked in one process.
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as AnySchemaObject;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  configValidators.set(schemaPath, validate);
  return validate;
}

/**
 * Resolve the declared config document and validate it against `configSchema`.
 * A config that cannot be read, parsed or compiled against its schema is a
 * finding: a loader that forgot what it could not check would ship a broken
 * config silently.
 */
export function checkPluginConfig(dir: string, manifest: PluginManifest): PluginFinding[] {
  const location = manifest.config;
  if (location === undefined) return [];

  let document: unknown;
  let label: string;

  if (location.path !== undefined) {
    const absolutePath = resolve(resolve(dir), location.path);
    label = location.path;
    // Existence is checkManifestFiles' finding; do not report it twice.
    if (!isFile(absolutePath)) return [];
    try {
      document = JSON.parse(readFileSync(absolutePath, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return [
        {
          code: "config-invalid",
          path: location.path,
          message: `config.path cannot be read as JSON: ${detail}`,
        },
      ];
    }
  } else if (location.inline !== undefined) {
    document = location.inline;
    label = "config.inline";
  } else {
    return [];
  }

  if (manifest.configSchema === undefined) return [];

  let validate: ValidateFunction;
  try {
    validate = configValidator(resolve(resolve(dir), manifest.configSchema));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [
      {
        code: "config-invalid",
        path: manifest.configSchema,
        message: `configSchema cannot be compiled: ${detail}`,
      },
    ];
  }

  if (validate(document)) return [];
  return formatAjvErrors(validate.errors).map((error) => ({
    code: "config-invalid" as const,
    path: label,
    message: error,
  }));
}

// --- IR range ---------------------------------------------------------------

/**
 * The declared range must accept the Site IR version this repository speaks.
 * v1.1 is directional: an emitter/sink accepts IR, a source produces it. v1.0
 * keeps the single `irRange` meaning, so an existing manifest is unchanged.
 */
export function checkIrRanges(manifest: PluginManifest): PluginFinding[] {
  const findings: PluginFinding[] = [];

  const check = (field: string, range: string): void => {
    if (isSemverRangeSatisfied(range, IR_VERSION)) return;
    findings.push({
      code: "ir-range-unsatisfied",
      path: MANIFEST_FILENAME,
      message: `${field} "${range}" does not accept IR_VERSION "${IR_VERSION}" from src/schema/site-ir.ts`,
    });
  };

  if (manifestVersionOf(manifest) === "1.1.0") {
    if (manifest.acceptsIrRange !== undefined) check("acceptsIrRange", manifest.acceptsIrRange);
    if (manifest.producesIrRange !== undefined) check("producesIrRange", manifest.producesIrRange);
    return findings;
  }

  if (manifest.irRange !== undefined) check("irRange", manifest.irRange);
  return findings;
}

// --- hook exports -----------------------------------------------------------

/**
 * Import the entrypoint and prove the load surface: the export named by
 * `hooksExport` (or `hooks` for the string form) must be an object, and every
 * hook the manifest declares must be a function on it. A hook the manifest
 * declares but the module does not export would otherwise surface at the first
 * pipeline call, long after the gate said the plugin was fine.
 */
export async function checkHookExports(
  dir: string,
  manifest: PluginManifest,
): Promise<PluginFinding[]> {
  const modulePath = entrypointModule(manifest);
  if (modulePath === undefined) return [];

  const exportName = hooksExportName(manifest);
  const absolutePath = resolve(resolve(dir), modulePath);

  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [
      {
        code: "entrypoint-unloadable",
        path: modulePath,
        message: `entrypoint module cannot be imported: ${detail}`,
      },
    ];
  }

  const handlers = module[exportName];
  if (typeof handlers !== "object" || handlers === null) {
    return [
      {
        code: "hook-export-missing",
        path: modulePath,
        message: `entrypoint does not export an object named "${exportName}" holding the hook record`,
      },
    ];
  }

  const record = handlers as Record<string, unknown>;
  const findings: PluginFinding[] = [];
  for (const hook of manifest.hooks) {
    if (typeof record[hook] !== "function") {
      findings.push({
        code: "hook-export-missing",
        path: `${modulePath}#${exportName}`,
        message: `hook "${hook}" is declared but "${exportName}" has no function for it`,
      });
    }
  }
  return findings;
}

// --- per-plugin check ------------------------------------------------------

/** Check one plugin directory's static surface. Never throws for plugin-authored mistakes. */
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
  findings.push(...checkAssetIntegrity(dir, manifest));
  findings.push(...checkPluginConfig(dir, manifest));
  findings.push(...checkIrRanges(manifest));

  return finish(manifest);
}

// --- discovery -------------------------------------------------------------

export interface PluginDiscovery {
  dirs: string[];
  skipped: SkippedPluginDirectory[];
  findings: PluginFinding[];
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

/**
 * Check every plugin under `pluginsRoot` and cross-check the things one manifest
 * cannot see. Synchronous: schema, files, asset integrity, config and IR range.
 * Use `runPluginConformanceAsync` when the hook load surface must be proven too.
 */
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

/**
 * The full check the gate runs: every sync rule plus the hook load surface. The
 * async step imports each plugin's entrypoint, so it proves what the pipeline
 * will actually be able to call rather than what the manifest claims.
 */
export async function runPluginConformanceAsync(
  options: ConformanceOptions = {},
): Promise<PluginConformanceReport> {
  const report = runPluginConformance(options);

  for (const result of report.results) {
    if (result.manifest === undefined) continue;
    result.findings.push(...(await checkHookExports(result.dir, result.manifest)));
    result.ok = result.findings.length === 0;
  }

  report.ok = report.findings.length === 0 && report.results.every((result) => result.ok);
  return report;
}
