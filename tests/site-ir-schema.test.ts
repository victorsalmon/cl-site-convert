/**
 * Site IR schema conformance — the contract every adapter and emitter depends on.
 *
 * The load-bearing test here is **backward compatibility**: `capture/site-ir.json`
 * is a committed v1.0.0 artifact produced by B1.2. It must validate, unchanged,
 * against the current schema. If that test fails the schema broke a v1.0
 * document, and the fix is the schema — never the capture.
 *
 * The rest pins the v1.1 additions: `style.origin`, `unsupported.evidence[]` and
 * `securityFindings[]`, including the conditional `href` rule (`href` is required
 * for a linked style and only for a linked style).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { IR_VERSION, isSupportedIrVersion } from "../src/schema/site-ir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SCHEMA_PATH = join(REPO_ROOT, "schemas", "site-ir.schema.json");
const FIXTURES = join(HERE, "fixtures", "site-ir");
const CAPTURE_PATH = join(REPO_ROOT, "capture", "site-ir.json");

/**
 * ajv is loaded through a dynamic import and a narrow structural type, as in
 * `capabilities.test.ts`: `ajv/dist/2020.js` is CommonJS with `export =`, so
 * TypeScript models the module as a namespace rather than a constructor.
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

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;

/**
 * A fresh ajv per compile: the instance that compiled the root schema has already
 * registered its `$id`, and re-registering it is a duplicate-id error.
 */
function compileRoot(): AjvValidator {
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

/** Compile a `$defs` entry by reference, the way `capabilities.test.ts` does. */
function compileDef(name: string): AjvValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(schema);
  return ajv.compile({ $ref: `${String(schema["$id"])}#/$defs/${name}` });
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function errorsOf(validate: AjvValidator): string[] {
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath || "(root)"}: ${error.message ?? "invalid"}`,
  );
}

const validate = compileRoot();

describe("irVersion", () => {
  it("accepts the 1.x family the schema accepts", () => {
    expect(isSupportedIrVersion("1.0.0")).toBe(true);
    expect(isSupportedIrVersion("1.1.0")).toBe(true);
  });

  it("rejects a 2.x version, which is a different schema", () => {
    expect(isSupportedIrVersion("2.0.0")).toBe(false);
    expect(isSupportedIrVersion("1.0")).toBe(false);
  });

  it("declares the version the schema was last widened to", () => {
    expect(IR_VERSION).toBe("1.1.0");
  });

  it("the schema pattern accepts both 1.0.0 and 1.1.0 documents", () => {
    const { pattern } = (schema["properties"] as Record<string, { pattern: string }>)["irVersion"]!;
    const accepts = (version: string) => new RegExp(pattern).test(version);
    expect(accepts("1.0.0")).toBe(true);
    expect(accepts("1.1.0")).toBe(true);
    expect(accepts("2.0.0")).toBe(false);
  });
});

describe("backward compatibility with the committed v1.0 capture", () => {
  const capture = JSON.parse(readFileSync(CAPTURE_PATH, "utf8")) as Record<string, unknown>;

  it("is still the v1.0.0 document B1.2 committed", () => {
    expect(capture["irVersion"]).toBe("1.0.0");
  });

  it("validates against the v1.1 schema with no edits", () => {
    expect(validate(capture), errorsOf(validate).join("\n")).toBe(true);
  });

  it("still requires `href` on a style entry that omits `origin`", () => {
    const v10 = readFixture("minimal.valid.json") as Record<string, unknown>;
    v10["styles"] = [
      {
        localPath: "styles/0000-divi-style.css",
        sha256: "0".repeat(64),
        order: 0,
      },
    ];
    expect(validate(v10)).toBe(false);
    expect(errorsOf(validate).join(" ")).toContain("href");
  });
});

describe("style origin (v1.1)", () => {
  it("accepts a linked entry with an href", () => {
    const document = readFixture("minimal.valid.json") as Record<string, unknown>;
    document["styles"] = [
      {
        origin: "linked",
        href: "https://example.ca/wp-content/themes/Divi/style.css",
        localPath: "styles/0000-divi-style.css",
        sha256: "0".repeat(64),
        order: 0,
      },
    ];
    expect(validate(document), errorsOf(validate).join("\n")).toBe(true);
  });

  it("accepts an inline entry with no href, still carrying sha256 and localPath", () => {
    const document = readFixture("minimal.valid.json") as Record<string, unknown>;
    document["styles"] = [
      {
        origin: "inline",
        localPath: "styles/0000-et-critical-inline-css.css",
        sha256: "0".repeat(64),
        order: 0,
      },
    ];
    expect(validate(document), errorsOf(validate).join("\n")).toBe(true);
  });

  it("rejects an inline entry that omits sha256", () => {
    const document = readFixture("minimal.valid.json") as Record<string, unknown>;
    document["styles"] = [{ origin: "inline", localPath: "styles/0000-inline.css", order: 0 }];
    expect(validate(document)).toBe(false);
    expect(errorsOf(validate).join(" ")).toContain("sha256");
  });

  it("rejects an inline entry that omits localPath", () => {
    const document = readFixture("minimal.valid.json") as Record<string, unknown>;
    document["styles"] = [{ origin: "inline", sha256: "0".repeat(64), order: 0 }];
    expect(validate(document)).toBe(false);
    expect(errorsOf(validate).join(" ")).toContain("localPath");
  });

  it("rejects an unknown origin value", () => {
    const document = readFixture("minimal.valid.json") as Record<string, unknown>;
    document["styles"] = [
      {
        origin: "embedded",
        href: "https://example.ca/style.css",
        localPath: "styles/0000-style.css",
        sha256: "0".repeat(64),
        order: 0,
      },
    ];
    expect(validate(document)).toBe(false);
  });

  it("accepts the committed v1.1 fixture (inline style plus evidence and findings)", () => {
    expect(validate(readFixture("inline-styles.valid.json")), errorsOf(validate).join("\n")).toBe(
      true,
    );
  });
});

describe("capability evidence (v1.1)", () => {
  const evidenceSchema = compileDef("capabilityEvidence");

  it("accepts each documented evidence kind", () => {
    for (const kind of ["rest-namespace", "dom-marker", "rest-endpoint"]) {
      const evidence = { kind, value: "/wp/v2/users", source: "/wp-json/" };
      expect(evidenceSchema(evidence), `${kind}: ${errorsOf(evidenceSchema).join(" ")}`).toBe(true);
    }
  });

  it("rejects an unknown evidence kind", () => {
    expect(evidenceSchema({ kind: "guess", value: "/wp-json/", source: "/wp-json/" })).toBe(false);
  });

  it("rejects evidence with no source", () => {
    expect(evidenceSchema({ kind: "rest-namespace", value: "fluentform/v1" })).toBe(false);
  });
});

describe("security findings (v1.1)", () => {
  const findingSchema = compileDef("securityFinding");

  it("accepts the open-users finding", () => {
    const finding = {
      id: "public-user-endpoint",
      kind: "public-user-enumeration",
      detail: "`/wp-json/wp/v2/users` is publicly readable.",
      blocking: false,
    };
    expect(findingSchema(finding), errorsOf(findingSchema).join(" ")).toBe(true);
  });

  it("accepts an optional `where` list of routes", () => {
    expect(
      findingSchema({
        id: "verbose-error",
        kind: "verbose-error",
        detail: "A stack trace leaked on an error page.",
        blocking: true,
        where: ["/care/"],
      }),
    ).toBe(true);
  });

  it("rejects a finding with no detail", () => {
    expect(findingSchema({ id: "x", kind: "verbose-error", blocking: false })).toBe(false);
  });

  it("rejects a finding with no blocking flag", () => {
    expect(findingSchema({ id: "x", kind: "verbose-error", detail: "d" })).toBe(false);
  });
});
