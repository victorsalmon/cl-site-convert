/**
 * Content-capture tests: page identity, metadata extraction and Site IR assembly.
 *
 * Every input is a recorded fixture — three rendered pages and one `/wp/v2/pages`
 * response — so this suite never touches the network. The final test validates the
 * assembled IR against the **frozen v1 schema** with ajv, which is the acceptance
 * criterion for this bead stated as code: an IR that does not validate is not an IR.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020Import from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  assembleSiteIr,
  buildPageRecord,
  buildCapabilities,
  capturePages,
  extractPageSignals,
  normaliseRestPage,
  parseRestPages,
} from "../src/source/wp-rest/content.js";
import type { CapturedPage } from "../src/source/wp-rest/content.js";
import { normaliseDocument } from "../src/source/wp-rest/dom.js";
import { PoliteFetcher } from "../src/source/wp-rest/http.js";
import type { HttpResponse } from "../src/source/wp-rest/http.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "wp-rest");
const PAGES = join(FIXTURES, "pages");

/** ajv ships as CJS; this is the minimal constructor shape this suite uses. */
type ValidateFn = ((data: unknown) => boolean) & {
  errors?: { instancePath?: string; message?: string }[] | null;
};
const Ajv2020 = Ajv2020Import as unknown as new (options?: Record<string, unknown>) => {
  compile: (schema: object) => ValidateFn;
};

const BASE_URL = "https://upscalehavens.ca";

const text = (...parts: string[]): string => readFileSync(join(...parts), "utf8");

const HOME_HTML = text(PAGES, "home.html");
const APPLY_HTML = text(PAGES, "tmh-apply.html");
const CARE_HTML = text(PAGES, "care.html");
const REST_PAGES = text(FIXTURES, "pages-content-page-1.json");
const REST_ROOT = text(FIXTURES, "rest-root.trimmed.json");

const restPages = parseRestPages(REST_PAGES, 200);
const restByPath = new Map(restPages.map((page) => [page.link ?? "", page]));

/** Assemble a `CapturedPage` from a fixture, exactly as the live capture would. */
function captured(url: string, raw: string, restLink: string): CapturedPage {
  const rest = restByPath.get(restLink) ?? null;
  if (rest === null) throw new Error(`no REST fixture for ${restLink}`);
  return {
    url,
    requestedUrl: `${BASE_URL}${url}`,
    status: 200,
    raw,
    normalised: normaliseDocument(raw),
    signals: extractPageSignals(raw),
    headers: { "x-litespeed-cache": "hit", "cache-control": "no-cache", etag: '"x-1;br"' },
    rest,
  };
}

const capturedPages = [
  captured("/", HOME_HTML, `${BASE_URL}/`),
  captured("/tmh/apply/", APPLY_HTML, `${BASE_URL}/tmh/apply/`),
  captured("/care/", CARE_HTML, `${BASE_URL}/care/`),
];

describe("REST page identity", () => {
  it("normalises all 19 recorded pages", () => {
    expect(restPages).toHaveLength(19);
    expect(restPages.every((page) => page.status === "publish")).toBe(true);
  });

  it("keeps the front page's slug ('ush') distinct from its route ('/')", () => {
    const home = restByPath.get(`${BASE_URL}/`);
    expect(home?.slug).toBe("ush");
    expect(home?.id).toBe(539);
  });

  it("decodes a rendered title and maps an empty template to null", () => {
    const home = restByPath.get(`${BASE_URL}/`);
    expect(home?.title).toBe("Upscale Havens");
    expect(home?.template).toBeNull();
    const apply = restByPath.get(`${BASE_URL}/tmh/apply/`);
    expect(apply?.title).toBe("Apply at Turtle Mountain Home");
    expect(apply?.template).toBe("page-template-blank.php");
  });

  it("returns null for an item that cannot identify a page", () => {
    expect(normaliseRestPage({ id: 1, slug: "x" })).toBeNull();
    expect(normaliseRestPage("nope")).toBeNull();
  });
});

describe("signals read from the rendered page", () => {
  it("reads the WordPress core SEO tags the site actually emits", () => {
    const signals = extractPageSignals(HOME_HTML);
    expect(signals.lang).toBe("en-US");
    expect(signals.canonical).toBe(`${BASE_URL}/`);
    expect(signals.robots).toBe("max-image-preview:large");
    // No SEO plugin is installed: there are no OG tags and no JSON-LD to invent.
    expect(signals.description).toBeNull();
    expect(signals.ogTitle).toBeNull();
    expect(signals.jsonLd).toEqual([]);
    expect(signals.jsonLdInvalid).toBe(0);
  });

  it("reads the stylesheet chain in document order, for B1.3 to capture", () => {
    const signals = extractPageSignals(APPLY_HTML);
    expect(signals.stylesheets.length).toBeGreaterThanOrEqual(5);
    expect(signals.stylesheets[0]?.href).toContain("fonts.googleapis.com");
    expect(signals.stylesheets.some((sheet) => sheet.href.includes("fluentform"))).toBe(true);
    expect(signals.stylesheets.every((sheet) => sheet.media === "all")).toBe(true);
  });

  it("detects Fluent Forms only on the page that carries it", () => {
    expect(extractPageSignals(APPLY_HTML).fluentForm).toBe(true);
    expect(extractPageSignals(HOME_HTML).fluentForm).toBe(false);
    expect(extractPageSignals(CARE_HTML).fluentForm).toBe(false);
  });

  it("records LiteSpeed's cache stamp so freshness is evidence, not faith", () => {
    const signals = extractPageSignals(HOME_HTML);
    expect(signals.cacheStamp?.version).toBe("7.9.3");
    expect(signals.cacheStamp?.renderedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("keeps Divi's body classes, which drive the theme's layout rules", () => {
    const signals = extractPageSignals(HOME_HTML);
    expect(signals.bodyClasses).toContain("et_pb_pagebuilder_layout");
    expect(signals.bodyClasses).toContain("et_divi_theme");
  });
});

describe("page records", () => {
  it("takes url from link and slug from REST — never one from the other", () => {
    const home = capturedPages[0];
    if (home === undefined) throw new Error("missing home fixture");
    const page = buildPageRecord(home);
    expect(page.url).toBe("/");
    expect(page.slug).toBe("ush");
    expect(page.status).toBe("publish");
    expect(page.template).toBe("");
    expect(page.title).toBe("Upscale Havens");
  });

  it("carries the captured template id and WordPress identity into meta", () => {
    const apply = capturedPages[1];
    if (apply === undefined) throw new Error("missing apply fixture");
    const page = buildPageRecord(apply);
    expect(page.url).toBe("/tmh/apply/");
    expect(page.slug).toBe("apply");
    expect(page.template).toBe("page-template-blank.php");
    expect(page.meta?.wpId).toBe(160);
    expect(page.meta?.publishedAt).toBe("2024-12-21T04:11:25");
    expect(page.meta?.updatedAt).toBe("2025-10-14T16:49:58");
    expect(page.seo?.canonical).toBe(`${BASE_URL}/tmh/apply/`);
  });

  it("keeps the Divi skeleton intact in dom.html and lifts the doctype out", () => {
    const home = capturedPages[0];
    if (home === undefined) throw new Error("missing home fixture");
    const page = buildPageRecord(home);
    expect(page.dom.doctype).toBe("<!DOCTYPE html>");
    expect(page.dom.html.startsWith("<html")).toBe(true);
    expect(page.dom.html).not.toMatch(/<script\b/i);
    // Deep Divi nesting survives: sections inside rows inside columns.
    expect(page.dom.html).toContain("et_pb_section");
    expect(page.dom.html).toContain("et_pb_row");
    expect(page.dom.html).toContain("et_pb_column");
    expect((page.dom.html.match(/et_pb_/g) ?? []).length).toBeGreaterThan(50);
  });
});

describe("capabilities", () => {
  it("fails loudly about inline CSS, forms and the PHP runtime", () => {
    const pages = capturedPages.map(buildPageRecord);
    const capabilities = buildCapabilities(pages, capturedPages);
    const byKey = new Map(capabilities.unsupported.map((entry) => [entry.capability, entry]));

    const inline = byKey.get("inline-style-blocks");
    expect(inline?.blocking).toBe(true);
    expect(inline?.where).toHaveLength(3);
    expect(inline?.detail).toContain("styles[]");

    const forms = byKey.get("fluent-forms");
    expect(forms?.blocking).toBe(true);
    expect(forms?.where).toEqual(["/tmh/apply/"]);

    expect(byKey.get("php-runtime")?.blocking).toBe(true);
    expect(byKey.get("litespeed-cache")?.blocking).toBe(false);
    expect(capabilities.supported).toContain("divi-page-builder");
  });
});

describe("Site IR assembly", () => {
  const identity = {
    title: "Upscale Havens Leasing and Tenant Coordination",
    description: "Intentional homes for friendly roommates who like nice things",
    homeUrl: BASE_URL,
    siteUrl: BASE_URL,
  };
  const { ir, report } = assembleSiteIr(BASE_URL, capturedPages, identity, {
    toolVersion: "0.1.0",
    minIntervalMs: 600,
    requests: 7,
  });

  it("validates against the frozen v1 schema", () => {
    const schema = JSON.parse(
      readFileSync(join(HERE, "..", "schemas", "site-ir.schema.json"), "utf8"),
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    const ok = validate(ir);
    if (!ok) {
      throw new Error(
        `IR did not validate: ${JSON.stringify(
          (validate.errors ?? []).map(
            (error) => `${error.instancePath ?? ""} ${error.message ?? ""}`,
          ),
          null,
          2,
        )}`,
      );
    }
    expect(ok).toBe(true);
  });

  it("declares the site identity from the REST root, not from a page title", () => {
    expect(ir.site.title).toBe(identity.title);
    expect(ir.site.description).toBe(identity.description);
    // WP locale is not in /wp-json/; the document lang is the evidence we have.
    expect(ir.site.locale).toBe("en_US");
    expect(ir.site.permalinks.structure).toBe("/%postname%/");
  });

  it("emits one page per captured route, with styles and assets deliberately empty", () => {
    expect(ir.pages.map((page) => page.url)).toEqual(["/", "/tmh/apply/", "/care/"]);
    expect(ir.styles).toEqual([]);
    expect(ir.assets).toEqual([]);
    expect(ir.capture?.sourceAdapter).toBe("wp-rest");
    expect(ir.capture?.notes).toContain("B1.3");
  });

  it("reports what was stripped and how the cache behaved", () => {
    expect(report.totals.pages).toBe(3);
    expect(report.totals.strippedBytes).toBeGreaterThan(0);
    expect(report.cache.hits).toBe(3);
    expect(report.cache.bypassNote).toContain("did not bypass LiteSpeed");
    expect(report.pages.every((page) => page.cache.litespeed === "hit")).toBe(true);
    expect(report.stylesheets.length).toBeGreaterThan(0);
  });

  it("records cache freshness against the REST modified timestamp", () => {
    const home = report.pages.find((page) => page.url === "/");
    // Cache stamp 2026-11-04 vs content modified 2025-11-27.
    expect(home?.cache.freshness).toBe("cache-newer-than-content");
    expect(home?.restModified).toBe("2025-11-27T02:07:02");
  });
});

describe("capture orchestration", () => {
  /** A fetcher stub: no sockets, deterministic answers, one request per path. */
  class StubFetcher extends PoliteFetcher {
    readonly requested: string[] = [];
    readonly #routes: Map<string, HttpResponse>;

    constructor(routes: Map<string, HttpResponse>) {
      super({ baseUrl: BASE_URL, minIntervalMs: 0 });
      this.#routes = routes;
    }

    override async fetch(pathOrUrl: string): Promise<HttpResponse> {
      const path = this.pathOf(pathOrUrl);
      this.requested.push(path);
      const response = this.#routes.get(path);
      if (response !== undefined) return response;
      return {
        url: this.absolute(pathOrUrl),
        status: 404,
        headers: {},
        body: "",
        location: null,
        error: null,
        attempts: 1,
      };
    }
  }

  const ok = (url: string, body: string, headers: Record<string, string> = {}): HttpResponse => ({
    url,
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8", ...headers },
    body,
    location: null,
    error: null,
    attempts: 1,
  });

  it("captures every routable route without touching the network", async () => {
    const manifestPath = join(FIXTURES, "manifest.test.json");
    const routes = new Map<string, HttpResponse>([
      [
        "/robots.txt",
        ok(`${BASE_URL}/robots.txt`, text(FIXTURES, "robots.txt"), {
          "content-type": "text/plain",
        }),
      ],
      ["/wp-json/", ok(`${BASE_URL}/wp-json/`, REST_ROOT, { "content-type": "application/json" })],
      [
        "/wp-json/wp/v2/pages?per_page=100&_fields=id,slug,link,status,type,parent,modified,date,title,template",
        ok(`${BASE_URL}/wp-json/wp/v2/pages`, REST_PAGES, { "content-type": "application/json" }),
      ],
      ["/", ok(`${BASE_URL}/`, HOME_HTML)],
      ["/tmh/apply/", ok(`${BASE_URL}/tmh/apply/`, APPLY_HTML)],
    ]);
    const stub = new StubFetcher(routes);

    const result = await capturePages({
      baseUrl: BASE_URL,
      manifestPath,
      fetcher: stub,
    });

    expect(result.failures).toEqual([]);
    expect(result.captured.map((page) => page.url)).toEqual(["/", "/tmh/apply/"]);
    expect(result.identity.title).toBe("Upscale Havens Leasing and Tenant Coordination");
    // robots.txt is read first: politeness is not optional.
    expect(stub.requested[0]).toBe("/robots.txt");
    expect(stub.requested).toContain(
      "/wp-json/wp/v2/pages?per_page=100&_fields=id,slug,link,status,type,parent,modified,date,title,template",
    );
  });

  it("refuses a manifest captured for a different site", async () => {
    await expect(
      capturePages({
        baseUrl: "https://example.com",
        manifestPath: join(FIXTURES, "manifest.test.json"),
        fetcher: new StubFetcher(new Map()),
      }),
    ).rejects.toThrow(/refusing to mix captures/);
  });
});
