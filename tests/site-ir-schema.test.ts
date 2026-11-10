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

describe("backward compatibility (v1.0, and a v1.1 page without a cascade)", () => {
  const capture = JSON.parse(readFileSync(CAPTURE_PATH, "utf8")) as Record<string, unknown>;

  it("validates the committed v1.0.0 fixture with no edits", () => {
    // `wordpress-two-subsites.valid.json` is a v1.0 document: no `style.origin`,
    // no `page.styleOrder`, no evidence, no security findings.
    const v10 = readFixture("wordpress-two-subsites.valid.json");
    expect((v10 as Record<string, unknown>)["irVersion"]).toBe("1.0.0");
    expect(validate(v10), errorsOf(validate).join("\n")).toBe(true);
  });

  it("declares v1.1 now that it carries inline styles and per-page order", () => {
    // The artifact was v1.0.0 when B1.2 captured only `dom`; B1.3 wrote the CSS and
    // P1.7 projected the complete chain, so `origin: "inline"` (a v1.1 field) is
    // present and the document has to say so.
    expect(capture["irVersion"]).toBe("1.1.0");
    expect(validate(capture), errorsOf(validate).join("\n")).toBe(true);
  });

  it("still validates the artifact with every `styleOrder` removed", () => {
    // Additive means a consumer that predates the field can read the same
    // document: deleting the cascade cannot invalidate it.
    const stripped = structuredClone(capture) as { pages: Record<string, unknown>[] };
    for (const page of stripped.pages) delete page["styleOrder"];
    expect(stripped.pages.every((page) => page["styleOrder"] === undefined)).toBe(true);
    expect(validate(stripped), errorsOf(validate).join("\n")).toBe(true);
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

describe("page style order (v1.1)", () => {
  const SHA_A = "a".repeat(64);
  const SHA_B = "b".repeat(64);

  /** A minimal document carrying two inline styles and one page. */
  function documentWithCascade(styleOrder: unknown): Record<string, unknown> {
    const document = readFixture("minimal.valid.json") as Record<string, unknown>;
    document["irVersion"] = "1.1.0";
    document["styles"] = [
      { origin: "inline", localPath: "styles/0000-a.css", sha256: SHA_A, order: 0 },
      { origin: "inline", localPath: "styles/0001-b.css", sha256: SHA_B, order: 1 },
    ];
    const page = (document["pages"] as Record<string, unknown>[])[0];
    if (page === undefined) throw new Error("minimal fixture lost its page");
    if (styleOrder === undefined) delete page["styleOrder"];
    else page["styleOrder"] = styleOrder;
    return document;
  }

  it("accepts a per-page cascade whose order is the page's, not the site chain's", () => {
    // `styles[].order` ascends 0, 1; this page loads B before A.
    const document = documentWithCascade([SHA_B, SHA_A]);
    expect(validate(document), errorsOf(validate).join("\n")).toBe(true);
  });

  it("accepts a page with no styleOrder at all", () => {
    // Optional: a v1.0 document, and any v1.1 page whose cascade was not captured.
    expect(validate(documentWithCascade(undefined))).toBe(true);
    expect(validate(readFixture("minimal.valid.json"))).toBe(true);
  });

  it("accepts an explicitly empty cascade", () => {
    expect(validate(documentWithCascade([]))).toBe(true);
  });

  it("rejects an entry that is not a sha256", () => {
    expect(validate(documentWithCascade(["not-a-hash"]))).toBe(false);
    expect(errorsOf(validate).join(" ")).toContain("pattern");
  });

  it("rejects a non-string entry", () => {
    expect(validate(documentWithCascade([42]))).toBe(false);
    expect(errorsOf(validate).join(" ")).toContain("string");
  });

  it("cannot police the reference itself: a well-formed unknown hash passes the schema", () => {
    // Deliberate: JSON Schema has no cross-reference. `scripts/validate-ir.mjs` and
    // `SiteIr::validate()` reject this, and the committed fixture
    // `invalid-style-order-unknown-sha256.json` proves it on every gate run.
    expect(validate(documentWithCascade(["c".repeat(64)]))).toBe(true);
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
