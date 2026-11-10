/**
 * Conformance harness tests.
 *
 * The real repository must conform (`plugins/_template` is the worked example).
 * Every synthetic root below exists to prove the harness fails closed: an
 * invalid manifest, a missing referenced file, a false asset hash, an unsatisfied
 * IR range, an unusable config, or a hook the entrypoint does not export must
 * produce a failing report, never a silent pass.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  MANIFEST_FILENAME,
  PLUGINS_ROOT,
  REPO_ROOT,
  checkPlugin,
  entrypointModule,
  isSemverRangeSatisfied,
  manifestVersionOf,
  runPluginConformance,
  runPluginConformanceAsync,
  validatePluginManifest,
} from "../src/conformance/plugin-manifest.js";
import type { PluginManifest } from "../src/conformance/plugin-manifest.js";
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

/** The frozen v1.0.0 shape, unchanged: it must stay valid forever. */
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

/** The same plugin written against the v1.1.0 contract. */
const validManifestV11: PluginManifest = {
  manifestVersion: "1.1.0",
  name: "probe",
  version: "0.1.0",
  role: "source",
  consumes: [],
  producesIrRange: "^1.1.0",
  emits: ["site-ir"],
  hooks: ["capture:start"],
  entrypoint: { module: "index.mjs", hooksExport: "hooks" },
  assets: [],
  runbook: "runbook.md",
};

/** An emitter: it reads Site IR and produces a site artifact. */
const emitterManifestV11: PluginManifest = {
  manifestVersion: "1.1.0",
  name: "emitter-probe",
  version: "0.1.0",
  role: "emitter",
  consumes: ["site-ir"],
  acceptsIrRange: "^1.1.0",
  emits: ["islands-wasm"],
  hooks: ["emit:page"],
  entrypoint: { module: "index.mjs", hooksExport: "hooks" },
  assets: [],
  runbook: "runbook.md",
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

/** The files a minimal conformant v1.1 plugin needs: one real exported handler. */
const validFilesV11: Record<string, string> = {
  "index.mjs": 'export const hooks = { "capture:start": () => ({}) };\n',
  "runbook.md": "# runbook\n",
};

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const brotliBytes = (text: string): number =>
  brotliCompressSync(Buffer.from(text, "utf8"), {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: Buffer.byteLength(text),
    },
  }).length;

/** Load a committed manifest fixture, so the fixtures are exercised here too. */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "tests", "fixtures", "plugin-manifest", name), "utf8"),
  );
}

function errorText(errors: string[]): string {
  return errors.join("\n");
}

describe("plugins/_template", () => {
  it("is discovered and conforms with zero findings, including the hook load surface", async () => {
    const report = await runPluginConformanceAsync();

    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);

    const template = report.results.find((result) => result.id === "_template");
    expect(template).toBeDefined();
    expect(template?.ok).toBe(true);
    expect(template?.findings).toEqual([]);
    expect(template?.manifest?.name).toBe("plugin-template");
  });

  it("declares the v1.1 manifest contract the pipeline loads through", () => {
    const template = runPluginConformance().results.find((result) => result.id === "_template");
    const manifest = template?.manifest;

    expect(manifest?.manifestVersion).toBe("1.1.0");
    expect(manifestVersionOf(manifest ?? validManifestV11)).toBe("1.1.0");
    expect(manifest?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest?.role).toBe("source");
    expect(manifest?.consumes).toEqual([]);
    expect(isSemverRangeSatisfied(manifest?.producesIrRange ?? "", IR_VERSION)).toBe(true);
    expect(manifest?.acceptsIrRange).toBeUndefined();
    expect(manifest?.emits.length).toBeGreaterThan(0);
    expect(manifest?.entrypoint).toEqual({ module: "index.mjs", hooksExport: "hooks" });
    expect(entrypointModule(manifest ?? validManifestV11)).toBe("index.mjs");
    expect(manifest?.runbook).toBe("runbook.md");
    expect(manifest?.configSchema).toBe("config.schema.json");
    expect(manifest?.config).toEqual({ path: "config.example.json" });
    // A hook the manifest declares must be loadable, so every hook is phase:name.
    for (const hook of manifest?.hooks ?? []) {
      expect(hook).toMatch(/^(capture|emit|deploy|sink):[a-z][a-z0-9-]*$/);
    }
  });

  it("ships an entrypoint that exports a handler for every declared hook and emits valid IR", async () => {
    const manifest = runPluginConformance().results.find(
      (result) => result.id === "_template",
    )?.manifest;
    const entrypoint = join(
      PLUGINS_ROOT,
      "_template",
      entrypointModule(manifest ?? validManifestV11) ?? "index.mjs",
    );

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
    expect(ir.irVersion).toBe(IR_VERSION);
    expect(isSemverRangeSatisfied(manifest?.producesIrRange ?? "", ir.irVersion)).toBe(true);

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
    expect(errorText(validation.errors)).toContain("irRange");
    expect(errorText(validation.errors)).toContain("assets/0/path");
  });
});

describe("manifest v1.0.0 is unchanged and every v1.1 rule is schema-enforced", () => {
  it("keeps the frozen v1.0.0 fixture valid, unmodified", () => {
    const validation = validatePluginManifest(fixture("wordpress.valid.json"));

    expect(validation).toEqual({ ok: true, errors: [] });
  });

  it("accepts a v1.1 source that declares role, consumes and producesIrRange", () => {
    expect(validatePluginManifest(fixture("wordpress-v1.1.valid.json"))).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("accepts an emitter bundle and a sink that declares its server function", () => {
    expect(validatePluginManifest(fixture("emitter.valid.json")).ok).toBe(true);
    expect(validatePluginManifest(fixture("sink.valid.json")).ok).toBe(true);
    expect(validatePluginManifest(fixture("deployer.valid.json")).ok).toBe(true);
  });

  it("requires `role` in v1.1", () => {
    const validation = validatePluginManifest(fixture("invalid-v11-missing-role.json"));

    expect(validation.ok).toBe(false);
    expect(errorText(validation.errors)).toContain("'role'");
  });

  it("requires acceptsIrRange for an emitter and producesIrRange for a source", () => {
    const emitter = validatePluginManifest(
      fixture("invalid-emitter-without-accepts-ir-range.json"),
    );
    const source = validatePluginManifest(fixture("invalid-source-without-produces-ir-range.json"));

    expect(emitter.ok).toBe(false);
    expect(errorText(emitter.errors)).toContain("acceptsIrRange");
    expect(source.ok).toBe(false);
    expect(errorText(source.errors)).toContain("producesIrRange");
  });

  it("ties a sink to the server function it needs", () => {
    const validation = validatePluginManifest(fixture("invalid-sink-missing-api-functions.json"));

    expect(validation.ok).toBe(false);
    expect(errorText(validation.errors)).toContain("/emits");
  });

  it("ties `sinks` to the sink role in both directions", () => {
    const missing = validatePluginManifest(fixture("invalid-sink-without-sinks.json"));
    const extra = validatePluginManifest(fixture("invalid-non-sink-declares-sinks.json"));

    expect(missing.ok).toBe(false);
    expect(errorText(missing.errors)).toContain("'sinks'");
    expect(extra.ok).toBe(false);
    expect(errorText(extra.errors)).toContain("role");
  });

  it("ties `consumes` to the role instead of leaving it as a comment", () => {
    const validation = validatePluginManifest(fixture("invalid-emitter-consumes-nothing.json"));

    expect(validation.ok).toBe(false);
    expect(errorText(validation.errors)).toContain("consumes");
  });

  it("requires the object entrypoint form in v1.1 so the load surface is declared", () => {
    const validation = validatePluginManifest(fixture("invalid-v11-string-entrypoint.json"));

    expect(validation.ok).toBe(false);
    expect(errorText(validation.errors)).toContain("entrypoint");
  });

  it("expresses a bundle directory and asset integrity, and rejects a bundle without it", () => {
    const emitter = fixture("emitter.valid.json") as { assets: Array<{ type?: string }> };
    expect(emitter.assets.some((asset) => asset.type === "directory")).toBe(true);

    const bundle = validatePluginManifest(fixture("invalid-bundle-without-files.json"));
    const wasm = validatePluginManifest(fixture("invalid-wasm-asset-without-integrity.json"));

    expect(bundle.ok).toBe(false);
    expect(errorText(bundle.errors)).toContain("'files'");
    expect(wasm.ok).toBe(false);
    expect(errorText(wasm.errors)).toContain("sha256");
    expect(errorText(wasm.errors)).toContain("brotliBytes");
  });

  it("requires exactly one config location, and a config whenever a schema is named", () => {
    const ambiguous = validatePluginManifest(fixture("invalid-config-path-and-inline.json"));
    const orphan = validatePluginManifest(fixture("invalid-config-schema-without-config.json"));

    expect(ambiguous.ok).toBe(false);
    expect(errorText(ambiguous.errors)).toContain("config");
    expect(orphan.ok).toBe(false);
    expect(errorText(orphan.errors)).toContain("config");
  });

  it("rejects v1.1 fields on a v1.0.0 manifest, and irRange on a v1.1 manifest", () => {
    const v10 = validatePluginManifest(fixture("invalid-v10-declares-role.json"));
    const v11 = validatePluginManifest(fixture("invalid-v11-keeps-ir-range.json"));

    expect(v10.ok).toBe(false);
    expect(errorText(v10.errors)).toContain("role");
    expect(v11.ok).toBe(false);
    expect(errorText(v11.errors)).toContain("irRange");
  });

  it("rejects an IR range on a deployer, which speaks no Site IR", () => {
    const validation = validatePluginManifest(fixture("invalid-deployer-with-ir-range.json"));

    expect(validation.ok).toBe(false);
    expect(errorText(validation.errors)).toContain("acceptsIrRange");
  });
});

describe("asset integrity and bundles", () => {
  it("passes when a declared hash, size and brotli size match the bytes on disk", () => {
    const root = tempDir();
    const payload = "console.log('bundle');\n";
    writePlugin(
      root,
      "wasm-ok",
      {
        ...emitterManifestV11,
        name: "wasm-ok",
        assets: [
          {
            path: "pkg/island.wasm",
            kind: "wasm",
            sha256: sha256(payload),
            bytes: Buffer.byteLength(payload),
            brotliBytes: brotliBytes(payload),
          },
        ],
      },
      { ...validFilesV11, "pkg/island.wasm": payload },
    );

    const report = runPluginConformance({ pluginsRoot: root });
    expect(report.results[0]?.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails a declared sha256 or byte count that does not match the file", () => {
    const root = tempDir();
    writePlugin(
      root,
      "bad-hash",
      {
        ...validManifestV11,
        name: "bad-hash",
        assets: [
          {
            path: "fixtures/golden.json",
            kind: "fixture",
            sha256: sha256("some other content"),
            bytes: 999,
          },
        ],
      },
      { ...validFilesV11, "fixtures/golden.json": '{"page":1}' },
    );

    const report = runPluginConformance({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];
    const messages = findings.map((finding) => finding.message).join("\n");

    expect(report.ok).toBe(false);
    expect(findings.map((finding) => finding.code)).toEqual(["asset-integrity", "asset-integrity"]);
    expect(messages).toContain("sha256");
    expect(messages).toContain("bytes");
  });

  it("fails a brotli size claim that the bytes do not reproduce", () => {
    const root = tempDir();
    const payload = "x".repeat(4096);
    writePlugin(
      root,
      "bad-brotli",
      {
        ...emitterManifestV11,
        name: "bad-brotli",
        assets: [
          {
            path: "pkg/island.wasm",
            kind: "wasm",
            sha256: sha256(payload),
            bytes: Buffer.byteLength(payload),
            brotliBytes: brotliBytes(payload) + 1,
          },
        ],
      },
      { ...validFilesV11, "pkg/island.wasm": payload },
    );

    const report = runPluginConformance({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];

    expect(report.ok).toBe(false);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("asset-integrity");
    expect(findings[0]?.message).toContain("brotliBytes");
  });

  it("resolves a bundle's members inside the bundle and verifies each one", () => {
    const root = tempDir();
    const page = "<main>page</main>\n";
    const header = "<header>header</header>\n";
    const manifest = {
      ...emitterManifestV11,
      name: "bundle-ok",
      emits: ["static-html"],
      assets: [
        {
          path: "templates",
          kind: "template",
          type: "directory",
          files: [
            { path: "page.html", sha256: sha256(page), bytes: Buffer.byteLength(page) },
            {
              path: "partials/header.html",
              sha256: sha256(header),
              bytes: Buffer.byteLength(header),
            },
          ],
        },
      ],
    };

    writePlugin(root, "bundle-ok", manifest, {
      ...validFilesV11,
      "templates/page.html": page,
      "templates/partials/header.html": header,
    });
    const okReport = runPluginConformance({ pluginsRoot: root });
    expect(okReport.results[0]?.findings).toEqual([]);

    // A member that is not inside the bundle is a finding, not a pass.
    writePlugin(root, "bundle-missing", {
      ...manifest,
      name: "bundle-missing",
      assets: [
        {
          path: "templates",
          kind: "template",
          type: "directory",
          files: [{ path: "partials/absent.html", sha256: sha256(page), bytes: 10 }],
        },
      ],
    });
    const missingReport = runPluginConformance({ pluginsRoot: root });
    const missing = missingReport.results.find((result) => result.id === "bundle-missing");
    expect(missing?.findings.map((finding) => finding.code)).toContain("asset-type-mismatch");
  });

  it("fails a directory asset whose path is a file", () => {
    const root = tempDir();
    writePlugin(
      root,
      "bundle-is-file",
      {
        ...validManifestV11,
        name: "bundle-is-file",
        assets: [
          {
            path: "templates/page.html",
            kind: "template",
            type: "directory",
            files: [{ path: "page.html", sha256: sha256("x"), bytes: 1 }],
          },
        ],
      },
      { ...validFilesV11, "templates/page.html": "x" },
    );

    const report = runPluginConformance({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];

    expect(report.ok).toBe(false);
    expect(findings[0]?.code).toBe("asset-type-mismatch");
  });
});

describe("config resolution", () => {
  const configSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "probe config",
    type: "object",
    additionalProperties: false,
    required: ["timeoutMs"],
    properties: { timeoutMs: { type: "integer", minimum: 1000 } },
  };

  it("resolves config.path and validates it against configSchema", () => {
    const root = tempDir();
    writePlugin(
      root,
      "config-ok",
      {
        ...validManifestV11,
        name: "config-ok",
        configSchema: "config.schema.json",
        config: { path: "config.json" },
      },
      {
        ...validFilesV11,
        "config.schema.json": JSON.stringify(configSchema),
        "config.json": JSON.stringify({ timeoutMs: 5000 }),
      },
    );

    const report = runPluginConformance({ pluginsRoot: root });
    expect(report.results[0]?.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails a config document that violates its schema", () => {
    const root = tempDir();
    writePlugin(
      root,
      "config-invalid",
      {
        ...validManifestV11,
        name: "config-invalid",
        configSchema: "config.schema.json",
        config: { path: "config.json" },
      },
      {
        ...validFilesV11,
        "config.schema.json": JSON.stringify(configSchema),
        "config.json": JSON.stringify({ timeoutMs: 10 }),
      },
    );

    const report = runPluginConformance({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];

    expect(report.ok).toBe(false);
    expect(findings.map((finding) => finding.code)).toEqual(["config-invalid"]);
    expect(findings[0]?.path).toBe("config.json");
  });

  it("fails an inline config that violates its schema", () => {
    const root = tempDir();
    writePlugin(
      root,
      "config-inline",
      {
        ...validManifestV11,
        name: "config-inline",
        configSchema: "config.schema.json",
        config: { inline: { timeoutMs: "soon" } },
      },
      { ...validFilesV11, "config.schema.json": JSON.stringify(configSchema) },
    );

    const report = runPluginConformance({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];

    expect(report.ok).toBe(false);
    expect(findings.map((finding) => finding.code)).toEqual(["config-invalid"]);
    expect(findings[0]?.path).toBe("config.inline");
  });

  it("fails a config.path that does not exist", () => {
    const root = tempDir();
    writePlugin(
      root,
      "config-missing",
      {
        ...validManifestV11,
        name: "config-missing",
        configSchema: "config.schema.json",
        config: { path: "config.json" },
      },
      { ...validFilesV11, "config.schema.json": JSON.stringify(configSchema) },
    );

    const report = runPluginConformance({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];

    expect(report.ok).toBe(false);
    expect(findings.map((finding) => finding.code)).toContain("required-file-missing");
    expect(findings.map((finding) => finding.path)).toContain("config.json");
  });
});

describe("hook load surface", () => {
  it("passes when every declared hook is a function on the declared export", async () => {
    const root = tempDir();
    writePlugin(
      root,
      "hooks-ok",
      { ...validManifestV11, name: "hooks-ok", hooks: ["capture:start", "capture:page"] },
      {
        ...validFilesV11,
        "index.mjs":
          'export const hooks = { "capture:start": () => ({}), "capture:page": () => ({}) };\n',
      },
    );

    const report = await runPluginConformanceAsync({ pluginsRoot: root });
    expect(report.results[0]?.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails a hook the manifest declares but the export omits", async () => {
    const root = tempDir();
    writePlugin(
      root,
      "hooks-missing",
      {
        ...validManifestV11,
        name: "hooks-missing",
        hooks: ["capture:start", "capture:end"],
      },
      {
        ...validFilesV11,
        "index.mjs": 'export const hooks = { "capture:start": () => ({}) };\n',
      },
    );

    const report = await runPluginConformanceAsync({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];

    expect(report.ok).toBe(false);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("hook-export-missing");
    expect(findings[0]?.message).toContain("capture:end");
    expect(findings[0]?.path).toBe("index.mjs#hooks");
  });

  it("fails an entrypoint that does not export the declared hooks export", async () => {
    const root = tempDir();
    writePlugin(
      root,
      "hooks-export-absent",
      {
        ...validManifestV11,
        name: "hooks-export-absent",
        entrypoint: { module: "index.mjs", hooksExport: "handlers" },
      },
      { ...validFilesV11, "index.mjs": 'export const hooks = { "capture:start": () => ({}) };\n' },
    );

    const report = await runPluginConformanceAsync({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];

    expect(report.ok).toBe(false);
    expect(findings.map((finding) => finding.code)).toEqual(["hook-export-missing"]);
    expect(findings[0]?.message).toContain('"handlers"');
  });

  it("fails an entrypoint module that cannot be imported", async () => {
    const root = tempDir();
    writePlugin(
      root,
      "hooks-throw",
      { ...validManifestV11, name: "hooks-throw" },
      {
        ...validFilesV11,
        "index.mjs": 'throw new Error("plugin exploded at load");\n',
      },
    );

    const report = await runPluginConformanceAsync({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];

    expect(report.ok).toBe(false);
    expect(findings.map((finding) => finding.code)).toEqual(["entrypoint-unloadable"]);
    expect(findings[0]?.message).toContain("plugin exploded at load");
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

  it("fails a source whose producesIrRange cannot accept the repository IR version", () => {
    const root = tempDir();
    writePlugin(
      root,
      "future-produce",
      { ...validManifestV11, name: "future-produce", producesIrRange: "^2.0.0" },
      validFilesV11,
    );

    const report = runPluginConformance({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];

    expect(report.ok).toBe(false);
    expect(findings.map((finding) => finding.code)).toEqual(["ir-range-unsatisfied"]);
    expect(findings[0]?.message).toContain("producesIrRange");
  });

  it("fails an emitter whose acceptsIrRange cannot accept the repository IR version", () => {
    const root = tempDir();
    writePlugin(
      root,
      "future-accept",
      {
        ...emitterManifestV11,
        name: "future-accept",
        acceptsIrRange: "^0.9.0",
        emits: ["static-html"],
        hooks: [],
      },
      validFilesV11,
    );

    const report = runPluginConformance({ pluginsRoot: root });
    const findings = report.results[0]?.findings ?? [];

    expect(report.ok).toBe(false);
    expect(findings.map((finding) => finding.code)).toEqual(["ir-range-unsatisfied"]);
    expect(findings[0]?.message).toContain("acceptsIrRange");
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
