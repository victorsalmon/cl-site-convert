/**
 * Conformance harness tests.
 *
 * The real repository must conform (`plugins/_template` is the worked example).
 * Every synthetic root below exists to prove the harness fails closed: an
 * invalid manifest, a missing referenced file, or an unsatisfiable `irRange`
 * must produce a failing report, never a silent pass.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  MANIFEST_FILENAME,
  PLUGINS_ROOT,
  REPO_ROOT,
  checkPlugin,
  isSemverRangeSatisfied,
  runPluginConformance,
  validatePluginManifest,
} from "../src/conformance/plugin-manifest.js";
import { IR_VERSION } from "../src/schema/site-ir.js";

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cl-site-convert-plugins-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const validManifest = {
  name: "probe",
  version: "0.1.0",
  irRange: "^1.0.0",
  emits: ["site-ir"],
  hooks: ["capture:start"],
  assets: [],
  runbook: "runbook.md",
  entrypoint: "index.mjs",
};

/** Write one plugin directory; `manifest` may be a raw string to test bad JSON. */
function writePlugin(
  root: string,
  id: string,
  manifest: unknown,
  files: Record<string, string> = {},
): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const body = typeof manifest === "string" ? manifest : JSON.stringify(manifest, null, 2);
  writeFileSync(join(dir, MANIFEST_FILENAME), body, "utf8");
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(dir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }
  return dir;
}

/** The files a minimal conformant plugin needs behind `validManifest`. */
const validFiles: Record<string, string> = {
  "index.mjs": "export const hooks = {};\n",
  "runbook.md": "# runbook\n",
};

describe("plugins/_template", () => {
  it("is discovered and conforms with zero findings", () => {
    const report = runPluginConformance();

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);

    const template = report.results.find((result) => result.id === "_template");
    expect(template).toBeDefined();
    expect(template?.ok).toBe(true);
    expect(template?.findings).toEqual([]);
    expect(template?.manifest?.name).toBe("plugin-template");
  });

  it("declares the manifest contract the pipeline loads through", () => {
    const template = runPluginConformance().results.find((result) => result.id === "_template");
    const manifest = template?.manifest;

    expect(manifest?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(isSemverRangeSatisfied(manifest?.irRange ?? "", IR_VERSION)).toBe(true);
    expect(manifest?.emits.length).toBeGreaterThan(0);
    expect(manifest?.entrypoint).toBe("index.mjs");
    expect(manifest?.runbook).toBe("runbook.md");
    expect(manifest?.configSchema).toBe("config.schema.json");
    // A hook the manifest declares must be loadable, so every hook is phase:name.
    for (const hook of manifest?.hooks ?? []) {
      expect(hook).toMatch(/^(capture|emit|deploy|sink):[a-z][a-z0-9-]*$/);
    }
  });

  it("ships an entrypoint that exports a handler for every declared hook and emits valid IR", async () => {
    const manifest = runPluginConformance().results.find(
      (result) => result.id === "_template",
    )?.manifest;
    const entrypoint = join(PLUGINS_ROOT, "_template", manifest?.entrypoint ?? "index.mjs");

    const module = (await import(pathToFileURL(entrypoint).href)) as {
      hooks?: Record<string, unknown>;
    };
    const handlers = module.hooks;

    expect(handlers).toBeDefined();
    for (const hook of manifest?.hooks ?? []) {
      expect(typeof handlers?.[hook]).toBe("function");
    }

    // The template is real, not a TODO: it produces a Site IR document.
    const captureStart = handlers?.["capture:start"] as (input: unknown) => unknown;
    const capturePage = handlers?.["capture:page"] as (context: unknown, page: unknown) => unknown;
    const captureEnd = handlers?.["capture:end"] as (context: unknown) => {
      irVersion: string;
      pages: unknown[];
    };

    const context = captureStart({ baseUrl: "https://example.test", title: "Example" });
    capturePage(context, { url: "/", slug: "home", html: '<h1 class="hero">Home</h1>' });
    const ir = captureEnd(context);

    expect(ir.pages).toHaveLength(1);
    expect(ir.irVersion).toMatch(/^1\.\d+\.\d+$/);
    expect(isSemverRangeSatisfied(manifest?.irRange ?? "", ir.irVersion)).toBe(true);

    // The emitted document must satisfy the frozen Site IR schema, not just look
    // IR-shaped: the template is the worked example other plugins are copied from.
    const siteIrSchema = JSON.parse(
      readFileSync(join(REPO_ROOT, "schemas", "site-ir.schema.json"), "utf8"),
    ) as AnySchemaObject;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(siteIrSchema);
    const valid = validate(ir);
    expect(valid, JSON.stringify(validate.errors)).toBe(true);
  });

  it("keeps the declared optional asset absent without failing", () => {
    const template = runPluginConformance().results.find((result) => result.id === "_template");
    const optionalAssets = (template?.manifest?.assets ?? []).filter(
      (asset) => asset.optional === true,
    );

    expect(optionalAssets.length).toBeGreaterThan(0);
    for (const asset of optionalAssets) {
      // The file really is absent: the pass above is the optional rule working,
      // not a check that silently skipped a missing path.
      expect(existsSync(join(PLUGINS_ROOT, "_template", asset.path))).toBe(false);
    }
    expect(template?.findings).toEqual([]);
  });
});

describe("manifest schema enforcement", () => {
  it("accepts the template manifest", () => {
    const template = runPluginConformance().results.find((result) => result.id === "_template");
    const validation = validatePluginManifest(template?.manifest);

    expect(validation).toEqual({ ok: true, errors: [] });
  });

  it("rejects an unusable irRange and an escaping asset path", () => {
    const validation = validatePluginManifest({
      ...validManifest,
      irRange: "latest",
      assets: [{ path: "../escape.html", kind: "template" }],
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("\n")).toContain("irRange");
    expect(validation.errors.join("\n")).toContain("assets/0/path");
  });
});

describe("fail-closed behaviour", () => {
  it("fails a plugin whose manifest is not valid JSON", () => {
    const root = tempDir();
    writePlugin(root, "broken", "{ not json", validFiles);

    const report = runPluginConformance({ pluginsRoot: root });

    expect(report.ok).toBe(false);
    expect(report.results[0]?.findings.map((finding) => finding.code)).toContain(
      "manifest-unreadable",
    );
  });

  it("fails a plugin whose manifest violates the schema", () => {
    const root = tempDir();
    writePlugin(root, "bad-schema", { ...validManifest, irRange: "latest" }, validFiles);

    const report = runPluginConformance({ pluginsRoot: root });

    expect(report.ok).toBe(false);
    expect(report.results[0]?.ok).toBe(false);
    expect(report.results[0]?.findings.map((finding) => finding.code)).toContain("schema");
  });

  it("fails a plugin whose entrypoint or runbook is missing", () => {
    const root = tempDir();
    writePlugin(root, "missing-files", validManifest, { "runbook.md": "# runbook\n" });

    const report = runPluginConformance({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];

    expect(report.ok).toBe(false);
    expect(findings.map((finding) => finding.code)).toEqual(["required-file-missing"]);
    expect(findings[0]?.path).toBe("index.mjs");
  });

  it("fails a plugin whose required asset is missing", () => {
    const root = tempDir();
    writePlugin(
      root,
      "missing-asset",
      { ...validManifest, assets: [{ path: "fixtures/golden.json", kind: "fixture" }] },
      validFiles,
    );

    const report = runPluginConformance({ pluginsRoot: root });

    expect(report.ok).toBe(false);
    expect(report.results[0]?.findings[0]?.path).toBe("fixtures/golden.json");
  });

  it("fails a plugin whose irRange cannot accept the repository IR version", () => {
    const root = tempDir();
    writePlugin(root, "future-ir", { ...validManifest, irRange: "^2.0.0" }, validFiles);

    const report = runPluginConformance({ pluginsRoot: root });

    expect(report.ok).toBe(false);
    expect(report.results[0]?.findings.map((finding) => finding.code)).toContain(
      "ir-range-unsatisfied",
    );
  });

  it("fails a directory that holds files but no manifest", () => {
    const root = tempDir();
    mkdirSync(join(root, "half-built"), { recursive: true });
    writeFileSync(join(root, "half-built", "index.mjs"), "export {};\n", "utf8");

    const report = runPluginConformance({ pluginsRoot: root });

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain("manifest-missing");
  });

  it("names an empty directory as skipped, not as a plugin", () => {
    const root = tempDir();
    mkdirSync(join(root, "empty-scaffold"), { recursive: true });
    writePlugin(root, "probe", validManifest, validFiles);

    const report = runPluginConformance({ pluginsRoot: root });

    expect(report.ok).toBe(true);
    expect(report.skipped.map((entry) => entry.id)).toEqual(["empty-scaffold"]);
  });

  it("fails a plugins root with no plugins at all", () => {
    const report = runPluginConformance({ pluginsRoot: tempDir() });

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toEqual(["no-plugins"]);
  });

  it("fails two plugins that claim the same name", () => {
    const root = tempDir();
    writePlugin(root, "first", validManifest, validFiles);
    writePlugin(root, "second", validManifest, validFiles);

    const report = runPluginConformance({ pluginsRoot: root });

    expect(report.ok).toBe(false);
    expect(report.results[1]?.findings.map((finding) => finding.code)).toContain("duplicate-name");
  });

  it("refuses to report a missing manifest as conformant when checked directly", () => {
    const root = tempDir();
    mkdirSync(join(root, "nothing"), { recursive: true });

    const result = checkPlugin(join(root, "nothing"));

    expect(result.ok).toBe(false);
    expect(result.findings[0]?.code).toBe("manifest-missing");
  });
});

describe("isSemverRangeSatisfied", () => {
  it("understands the ranges the manifest schema admits", () => {
    expect(isSemverRangeSatisfied("1.0.0", "1.0.0")).toBe(true);
    expect(isSemverRangeSatisfied("1.0.0", "1.0.1")).toBe(false);
    expect(isSemverRangeSatisfied("=1.0.0", "1.0.0")).toBe(true);
    expect(isSemverRangeSatisfied("^1.0.0", "1.0.0")).toBe(true);
    expect(isSemverRangeSatisfied("^1.0.0", "1.9.9")).toBe(true);
    expect(isSemverRangeSatisfied("^1.0.0", "2.0.0")).toBe(false);
    expect(isSemverRangeSatisfied("~1.2.0", "1.2.9")).toBe(true);
    expect(isSemverRangeSatisfied("~1.2.0", "1.3.0")).toBe(false);
    expect(isSemverRangeSatisfied(">=1.2.0", "1.2.0")).toBe(true);
    expect(isSemverRangeSatisfied(">1.2.0", "1.2.0")).toBe(false);
    expect(isSemverRangeSatisfied("<2.0.0", "1.9.9")).toBe(true);
    expect(isSemverRangeSatisfied("1.0.0 <2.0.0", "1.0.0")).toBe(true);
    expect(isSemverRangeSatisfied("1.0.0 <2.0.0", "1.5.0")).toBe(false);
    expect(isSemverRangeSatisfied(">=1.0.0 <2.0.0", "1.5.0")).toBe(true);
    expect(isSemverRangeSatisfied("^0.1.0", "0.1.9")).toBe(true);
    expect(isSemverRangeSatisfied("^0.1.0", "0.2.0")).toBe(false);
    expect(isSemverRangeSatisfied("^0.0.1", "0.0.1")).toBe(true);
    expect(isSemverRangeSatisfied("^0.0.1", "0.0.2")).toBe(false);
  });

  it("fails closed on anything it cannot parse", () => {
    expect(isSemverRangeSatisfied("latest", "1.0.0")).toBe(false);
    expect(isSemverRangeSatisfied("^1.0", "1.0.0")).toBe(false);
    expect(isSemverRangeSatisfied("^1.0.0 || ^2.0.0", "1.0.0")).toBe(false);
    expect(isSemverRangeSatisfied("^1.0.0", "1.0")).toBe(false);
    expect(isSemverRangeSatisfied("^1.0.0", "1.0.0-beta.1")).toBe(false);
  });
});
