/**
 * Capability-detector tests.
 *
 * Every input is a recorded or shape-accurate **fixture** under
 * `tests/fixtures/capabilities/`; nothing here touches the network. The point of
 * the suite is not "the regexes match" but "the gate's decision is right":
 *
 *  - a Divi brochure site converts,
 *  - a Fluent Forms site is convertible but its forms are named as needing a
 *    sink,
 *  - WooCommerce and WPML halt the conversion,
 *  - an unrecognised namespace halts it too — including one that looks friendly —
 *    because "not in the catalog" means "nobody proved this is stateless",
 *  - and no evidence at all is `cannot-evaluate`, never a pass.
 *
 * The emitted report is also validated against the frozen Site IR schema, so a
 * future field rename cannot quietly produce a file the emitter rejects.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CATALOG } from "../src/source/capabilities/catalog.js";
import {
  assertConvertible,
  CANNOT_EVALUATE_KEY,
  ConversionRefusedError,
  detectCapabilities,
  exitCodeFor,
  factsFromManifest,
  formatReport,
  pagesFromBundle,
  runCapabilityCli,
} from "../src/source/capabilities/detect.js";
import type {
  CapabilityEvidenceInput,
  CapabilityReport,
  SiteCapabilities,
} from "../src/source/capabilities/detect.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const FIXTURES = join(HERE, "fixtures", "capabilities");

/** Read a scenario fixture directory into detector input. */
function scenario(name: string): CapabilityEvidenceInput {
  const input: CapabilityEvidenceInput = {};
  const restRootPath = join(FIXTURES, name, "rest-root.json");
  const pagesPath = join(FIXTURES, name, "pages.json");
  if (existsSync(restRootPath)) input.restRoot = readFileSync(restRootPath, "utf8");
  if (existsSync(pagesPath)) {
    input.pages = pagesFromBundle(readFileSync(pagesPath, "utf8"), []);
  }
  return input;
}

/** The target site's recorded REST facts (B1.1 recon), as a route manifest. */
function targetFacts(): {
  namespaces: string[];
  usersEndpointOpen: boolean;
  userCount: number | null;
} {
  const body = readFileSync(join(FIXTURES, "upscalehavens", "manifest.json"), "utf8");
  const facts = factsFromManifest(body);
  if (facts === null) throw new Error("upscalehavens manifest fixture carries no rest facts");
  return facts;
}

function unsupportedKeys(report: CapabilityReport): string[] {
  return report.capabilities.unsupported.map((entry) => entry.capability);
}

// ---- schema conformance -----------------------------------------------------

const siteIrSchema = JSON.parse(
  readFileSync(join(REPO_ROOT, "schemas", "site-ir.schema.json"), "utf8"),
) as Record<string, unknown>;

/**
 * ajv is loaded through a dynamic import and a narrow structural type.
 *
 * `ajv/dist/2020.js` is CommonJS with `export =`, which TypeScript models as a
 * module namespace here rather than a constructor. A three-method interface is
 * all this suite needs, and it keeps the test's typings independent of ajv's
 * internal declaration shape.
 */
interface AjvValidator {
  (data: unknown): boolean;
  errors?: { instancePath: string; message?: string }[] | null;
}

interface AjvInstance {
  addSchema(schema: object): unknown;
  compile(schema: object): AjvValidator;
}

type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

const ajvModule = (await import("ajv/dist/2020.js")) as unknown as {
  default?: AjvConstructor;
} & Partial<AjvConstructor>;

const Ajv2020 = (ajvModule.default ?? ajvModule) as AjvConstructor;
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(siteIrSchema);
const validateSiteIr = ajv.compile(siteIrSchema);
const validateCapabilities = ajv.compile({
  $ref: `${String(siteIrSchema["$id"])}#/$defs/capabilities`,
});

/** Put a report's capabilities into a valid IR document and validate the whole thing. */
function irProblems(capabilities: SiteCapabilities): string[] {
  const base = JSON.parse(
    readFileSync(join(HERE, "fixtures", "site-ir", "minimal.valid.json"), "utf8"),
  ) as Record<string, unknown>;
  base["capabilities"] = capabilities;
  if (validateSiteIr(base)) return [];
  return (validateSiteIr.errors ?? []).map(
    (error) => `${error.instancePath || "(root)"}: ${error.message ?? "invalid"}`,
  );
}

describe("catalog", () => {
  it("uses only schema-safe, unique capability keys", () => {
    const keys = CATALOG.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("explains every classification", () => {
    for (const entry of CATALOG) {
      expect(entry.rationale.length).toBeGreaterThan(20);
      expect(entry.namespaces.length + entry.markers.length).toBeGreaterThan(0);
    }
  });

  it("has no stateful regex markers that could fire twice", () => {
    for (const entry of CATALOG) {
      for (const marker of entry.markers) expect(marker.pattern.global).toBe(false);
    }
  });
});

describe("Divi brochure site", () => {
  const report = detectCapabilities(scenario("divi-only"));

  it("converts, with Divi and Redirection reported as supported", () => {
    expect(report.status).toBe("convertible");
    expect(report.capabilities.supported).toEqual(["divi", "redirection"]);
    expect(report.capabilities.unsupported).toEqual([]);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("names both pieces of evidence that proved Divi", () => {
    const divi = report.findings.find((finding) => finding.key === "divi");
    expect(divi).toBeDefined();
    expect(divi?.classification).toBe("supported");
    expect(divi?.evidence.some((item) => item.kind === "rest-namespace")).toBe(true);
    expect(divi?.evidence.some((item) => item.kind === "dom-marker")).toBe(true);
    expect(divi?.where).toEqual(["/", "/tmh/"]);
  });

  it("records which evidence sources were actually consulted", () => {
    expect(report.evidence.kinds).toEqual(["rest-namespace", "dom-marker"]);
    expect(report.evidence.domPages).toEqual(["/", "/tmh/"]);
    expect(report.evidence.restNamespaces).toContain("divi/v1");
  });
});

describe("Fluent Forms site", () => {
  const report = detectCapabilities(scenario("fluent-forms"));

  it("is convertible but names the forms stack as needing handling", () => {
    expect(report.status).toBe("convertible");
    expect(exitCodeFor(report)).toBe(0);
    const keys = unsupportedKeys(report);
    expect(keys).toContain("fluent-forms");
    expect(keys).toContain("fluent-smtp");
    expect(keys).toContain("fluent-crm");
  });

  it("never marks a needs-handling capability as blocking", () => {
    for (const entry of report.capabilities.unsupported) expect(entry.blocking).toBe(false);
  });

  it("states the namespace and the DOM marker that proved the form plugin", () => {
    const entry = report.capabilities.unsupported.find(
      (item) => item.capability === "fluent-forms",
    );
    expect(entry?.detail).toContain("fluentform/v1");
    expect(entry?.detail).toContain("fluentform");
    expect(entry?.where).toEqual(["/tmh/apply/"]);
  });

  it("does not fail the emit guard", () => {
    expect(() => assertConvertible(report)).not.toThrow();
  });
});

describe("WooCommerce site", () => {
  const report = detectCapabilities(scenario("woocommerce"));

  it("blocks on the commerce capability", () => {
    expect(report.status).toBe("blocked");
    expect(exitCodeFor(report)).toBe(1);
    const entry = report.capabilities.unsupported.find((item) => item.capability === "woocommerce");
    expect(entry?.blocking).toBe(true);
    expect(entry?.detail).toContain("Blocking: WooCommerce");
    expect(entry?.where).toEqual(["/cart/", "/shop/"]);
  });

  it("refuses to emit, listing the blocking capability", () => {
    expect(() => assertConvertible(report)).toThrow(ConversionRefusedError);
    try {
      assertConvertible(report);
    } catch (error) {
      expect(error).toBeInstanceOf(ConversionRefusedError);
      expect((error as ConversionRefusedError).reason).toBe("blocking");
      expect((error as ConversionRefusedError).blocking.map((e) => e.capability)).toContain(
        "woocommerce",
      );
      expect((error as Error).message).toContain("woocommerce");
    }
  });
});

describe("WPML site", () => {
  const report = detectCapabilities(scenario("wpml"));

  it("blocks on multilingual", () => {
    expect(report.status).toBe("blocked");
    const entry = report.capabilities.unsupported.find((item) => item.capability === "wpml");
    expect(entry?.blocking).toBe(true);
    expect(entry?.where).toEqual(["/"]);
  });

  it("refuses to emit", () => {
    expect(() => assertConvertible(report)).toThrow(/Refusing to convert/);
  });
});

describe("unclassified capabilities block", () => {
  it("blocks an unrecognised namespace that looks like commerce", () => {
    const report = detectCapabilities(scenario("unknown-commerce"));
    expect(report.status).toBe("blocked");
    const entry = report.capabilities.unsupported.find(
      (item) => item.capability === "unclassified-namespace",
    );
    expect(entry?.blocking).toBe(true);
    expect(entry?.detail).toContain("shopengine/v2");
    expect(entry?.detail).toContain("tickets/v1");
    expect(entry?.detail).toContain("server-side state");
    expect(() => assertConvertible(report)).toThrow(ConversionRefusedError);
  });

  it("blocks an unrecognised namespace even when it looks harmless", () => {
    const report = detectCapabilities(scenario("unknown-benign"));
    expect(report.status).toBe("blocked");
    expect(unsupportedKeys(report)).toEqual(["unclassified-namespace"]);
    expect(report.findings[0]?.rationale).not.toContain("server-side state");
    expect(() => assertConvertible(report)).toThrow(/Refusing to convert/);
  });

  it("does not mistake core WordPress namespaces for plugins", () => {
    const report = detectCapabilities({
      namespaces: ["oembed/1.0", "wp/v2", "wp-site-health/v1", "wp-block-editor/v1"],
    });
    expect(report.status).toBe("convertible");
    expect(report.capabilities.unsupported).toEqual([]);
    expect(report.evidence.reasons.join(" ")).toContain("no rendered pages");
  });
});

describe("cannot evaluate", () => {
  it("never passes when the REST root advertised nothing and no page was captured", () => {
    const report = detectCapabilities(scenario("empty"));
    expect(report.status).toBe("cannot-evaluate");
    expect(exitCodeFor(report)).toBe(2);
    expect(report.capabilities.supported).toEqual([]);
    expect(report.capabilities.unsupported).toEqual([
      expect.objectContaining({ capability: CANNOT_EVALUATE_KEY, blocking: true }),
    ]);
  });

  it("never passes with no evidence at all", () => {
    const report = detectCapabilities({});
    expect(report.status).toBe("cannot-evaluate");
    expect(report.capabilities.unsupported[0]?.capability).toBe(CANNOT_EVALUATE_KEY);
  });

  it("treats an unparseable /wp-json/ body as no evidence", () => {
    const report = detectCapabilities({ restRoot: "<html>503 Service Unavailable</html>" });
    expect(report.status).toBe("cannot-evaluate");
    expect(report.evidence.reasons.join(" ")).toMatch(/not valid JSON/);
  });

  it("refuses to emit when only the report JSON is available", () => {
    const report = detectCapabilities({});
    expect(() => assertConvertible(report.capabilities)).toThrow(/Refusing to convert/);
    try {
      assertConvertible(report.capabilities);
    } catch (error) {
      expect((error as ConversionRefusedError).reason).toBe("cannot-evaluate");
    }
  });
});

describe("report shape", () => {
  const scenarios = [
    "divi-only",
    "fluent-forms",
    "woocommerce",
    "wpml",
    "unknown-commerce",
    "unknown-benign",
  ] as const;

  it.each(scenarios)("emits a capabilities object the frozen IR schema accepts (%s)", (name) => {
    const report = detectCapabilities(scenario(name));
    expect(validateCapabilities(report.capabilities)).toBe(true);
    expect(irProblems(report.capabilities)).toEqual([]);
  });

  it("accepts the cannot-evaluate report too", () => {
    const report = detectCapabilities({});
    expect(validateCapabilities(report.capabilities)).toBe(true);
    expect(irProblems(report.capabilities)).toEqual([]);
  });

  it("renders a table naming the evidence for each finding", () => {
    const text = formatReport(detectCapabilities(scenario("woocommerce")));
    expect(text).toContain("BLOCKING");
    expect(text).toContain("woocommerce");
    expect(text).toContain("REST namespace `woocommerce/v3`");
    expect(text).toContain("RESULT: BLOCKED");
  });
});

describe("the real target (upscalehavens.ca, B1.1 recon)", () => {
  const facts = targetFacts();
  const report = detectCapabilities({
    namespaces: facts.namespaces,
    usersEndpointOpen: facts.usersEndpointOpen,
    userCount: facts.userCount,
  });

  it("classifies the Divi brochure stack as convertible", () => {
    expect(report.status).toBe("convertible");
    expect(report.capabilities.supported).toEqual(["divi", "redirection"]);
  });

  it("names every plugin-dependent capability as needing handling", () => {
    expect(unsupportedKeys(report)).toEqual([
      "fluent-crm",
      "fluent-forms",
      "fluent-smtp",
      "litespeed-cache",
      "rest-users-public",
    ]);
    for (const entry of report.capabilities.unsupported) expect(entry.blocking).toBe(false);
  });

  it("records the open users endpoint as a security finding that does not block", () => {
    const entry = report.capabilities.unsupported.find(
      (item) => item.capability === "rest-users-public",
    );
    expect(entry?.blocking).toBe(false);
    expect(entry?.detail).toContain("/wp-json/wp/v2/users");
    expect(entry?.detail).toContain("1 user");
    expect(entry?.detail).toContain("security finding");
  });

  it("matches the committed capture/capabilities.json", () => {
    const committed = JSON.parse(
      readFileSync(join(REPO_ROOT, "capture", "capabilities.json"), "utf8"),
    ) as SiteCapabilities;
    expect(committed).toEqual(report.capabilities);
    expect(validateCapabilities(committed)).toBe(true);
  });
});

describe("capture:capabilities CLI", () => {
  const run = async (
    argv: readonly string[],
  ): Promise<{ code: number; stdout: string; outPath: string; dir: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "capabilities-cli-"));
    const outPath = join(dir, "capabilities.json");
    const lines: string[] = [];
    const code = await runCapabilityCli([...argv, "--out", outPath], {
      io: { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) },
    });
    return { code, stdout: lines.join("\n"), outPath, dir };
  };

  it("exits 0 and writes the report for a convertible site", async () => {
    const { code, stdout, outPath, dir } = await run([
      "--no-manifest",
      "--rest-root",
      join(FIXTURES, "divi-only", "rest-root.json"),
      "--dom-bundle",
      join(FIXTURES, "divi-only", "pages.json"),
    ]);
    try {
      expect(code).toBe(0);
      expect(stdout).toContain("RESULT: CONVERTIBLE");
      const written = JSON.parse(await readFile(outPath, "utf8")) as SiteCapabilities;
      expect(written.supported).toEqual(["divi", "redirection"]);
      expect(validateCapabilities(written)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 and prints why, for a blocking site", async () => {
    const { code, stdout, outPath, dir } = await run([
      "--no-manifest",
      "--rest-root",
      join(FIXTURES, "woocommerce", "rest-root.json"),
      "--dom-bundle",
      join(FIXTURES, "woocommerce", "pages.json"),
    ]);
    try {
      expect(code).toBe(1);
      expect(stdout).toContain("RESULT: BLOCKED");
      expect(stdout).toContain("woocommerce");
      expect(stdout).toContain("where: /cart/, /shop/");
      // The evidence still lands on disk: a blocked run is a finding, not a failure to write.
      const written = JSON.parse(await readFile(outPath, "utf8")) as SiteCapabilities;
      expect(written.unsupported.some((entry) => entry.blocking === true)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 when there is no evidence to evaluate", async () => {
    const { code, stdout, dir } = await run([
      "--no-manifest",
      "--rest-root",
      join(FIXTURES, "empty", "rest-root.json"),
      "--dom-bundle",
      join(FIXTURES, "empty", "pages.json"),
    ]);
    try {
      expect(code).toBe(2);
      expect(stdout).toContain("RESULT: CANNOT EVALUATE");
      expect(stdout).toContain("must not proceed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exits 2 when every input path is missing, rather than passing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capabilities-cli-"));
    const lines: string[] = [];
    try {
      const code = await runCapabilityCli(
        ["--no-manifest", "--dom-bundle", join(dir, "absent.json")],
        {
          io: { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) },
          cwd: dir,
        },
      );
      expect(code).toBe(2);
      expect(lines.join("\n")).toContain("CANNOT EVALUATE");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads the route manifest shape the pipeline actually writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capabilities-cli-"));
    const outPath = join(dir, "capabilities.json");
    const lines: string[] = [];
    try {
      const code = await runCapabilityCli(
        ["--manifest", join(FIXTURES, "upscalehavens", "manifest.json"), "--out", outPath],
        { io: { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) } },
      );
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("input           : manifest:");
      const written = JSON.parse(await readFile(outPath, "utf8")) as SiteCapabilities;
      expect(written.supported).toEqual(["divi", "redirection"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
