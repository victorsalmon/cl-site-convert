import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { captureSeo, parseSearchProbe } from "../src/source/seo/capture.js";
import { PoliteFetcher } from "../src/source/wp-rest/http.js";
import type { HttpResponse } from "../src/source/wp-rest/http.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "seo");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const BASE = "https://fixture.test";
const ROOT_SITEMAP = "/wp-sitemap.xml";
/**
 * The child sitemap lives wherever the index says it does. The recorded fixture is
 * the real site's index, so its `<loc>` names upscalehavens.ca — the script keys the
 * child there rather than pretending the fixture site hosts it.
 */
const CHILD_SITEMAP =
  /<loc>\s*([^<\s]+)\s*<\/loc>/i.exec(fixture("sitemap.index.xml"))?.[1] ??
  (() => {
    throw new Error("sitemap.index.xml has no <loc>");
  })();

function response(
  url: string,
  status: number,
  body = "",
  location: string | null = null,
): HttpResponse {
  return {
    url,
    status,
    headers: { "content-type": "text/html; charset=UTF-8" },
    body,
    location,
    error: null,
    attempts: 1,
  };
}

/**
 * A fetcher that answers from a script instead of the network.
 *
 * This is what keeps the whole capture testable: the pass makes 5 kinds of live
 * request (robots, sitemap tree, search probes, redirect arrivals, shape probes) and
 * every one of them is a recorded response here. A missing key fails loudly rather
 * than silently returning a 404, so an untested request path cannot slip through as
 * an unexplained result.
 */
class ScriptedFetcher extends PoliteFetcher {
  readonly #responses: Map<string, HttpResponse>;

  constructor(responses: Map<string, HttpResponse>) {
    super({ baseUrl: BASE, minIntervalMs: 1 });
    this.#responses = responses;
  }

  override async fetch(pathOrUrl: string): Promise<HttpResponse> {
    const found = this.#responses.get(pathOrUrl);
    if (found !== undefined) return { ...found, url: pathOrUrl };
    throw new Error(`ScriptedFetcher: no response scripted for ${pathOrUrl}`);
  }
}

function scriptedSite(
  options: { routeStatus?: Record<string, number> } = {},
): Map<string, HttpResponse> {
  const routes = [
    { url: `${BASE}/`, path: "/", canonical: `${BASE}/` },
    { url: `${BASE}/care/`, path: "/care/", canonical: `${BASE}/care/` },
  ];
  const responses = new Map<string, HttpResponse>();
  responses.set("/robots.txt", response("/robots.txt", 200, fixture("robots.txt")));
  // The root sitemap is requested by its site-relative path; the children come back
  // as absolute URLs from its own <loc> elements, so they are keyed absolutely.
  responses.set(ROOT_SITEMAP, response(ROOT_SITEMAP, 200, fixture("sitemap.index.xml")));
  responses.set(CHILD_SITEMAP, response(CHILD_SITEMAP, 200, fixture("sitemap.pages.xml")));
  responses.set("/?s=test", response("/?s=test", 200, fixture("search.no-results.html")));
  responses.set("/?s=room", response("/?s=room", 200, fixture("search.matches.html")));
  responses.set("/from-old", response("/from-old", 301, "", `${BASE}/care/`));
  responses.set("/care/", response("/care/", 200, "<html><head></head><body></body></html>"));
  responses.set("/index.html", response("/index.html", 404, "not found"));
  responses.set("/care", response("/care", 301, "", `${BASE}/care/`));
  for (const route of routes) {
    // The capture reads the page HTML from the IR fixture, not the wire; the only
    // live page request is the alias probe above.
    if (options.routeStatus === undefined) continue;
    const status = options.routeStatus[route.path];
    if (status !== undefined) responses.set(route.path, response(route.path, status));
  }
  return responses;
}

async function seedInputs(options: {
  canonical?: Record<string, string | null>;
  routeStatus?: Record<string, number>;
}): Promise<{ dir: string; manifestPath: string; irPath: string; outPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "seo-capture-"));
  const manifestPath = join(dir, "routes.manifest.json");
  const irPath = join(dir, "site-ir.json");
  const outPath = join(dir, "seo-and-redirects.json");

  const canonicalFor = (path: string): string | null =>
    options.canonical !== undefined && path in options.canonical
      ? (options.canonical[path] ?? null)
      : `${BASE}${path}`;

  const routes = [
    { url: `${BASE}/`, path: "/" },
    { url: `${BASE}/care/`, path: "/care/" },
  ];

  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        manifestVersion: "1",
        baseUrl: BASE,
        discovery: {
          redirects: [{ from: "/from-old", to: `${BASE}/care/`, code: 301 }],
          linkHarvest: {
            probes: [{ path: "/care/chatgpt.com", status: 404, location: null }],
          },
        },
        routes: routes.map((route) => ({
          url: route.url,
          path: route.path,
          slug: route.path === "/" ? "home" : "care",
          status: "publish",
          type: "page",
          http: { status: options.routeStatus?.[route.path] ?? 200 },
        })),
        notes: ["broken link: /care/chatgpt.com 404s (linked from the site, in no source)"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const pages = routes.map((route) => {
    const canonical = canonicalFor(route.path);
    const canonicalTag = canonical === null ? "" : `<link rel="canonical" href="${canonical}" />`;
    return {
      url: route.path,
      slug: "page",
      status: "publish",
      template: "",
      dom: {
        html: [
          '<html lang="en-US"><head><title>Fixture page</title>',
          `<meta name='robots' content='max-image-preview:large' />`,
          canonicalTag,
          "</head><body>",
          '<a href="chatgpt.com">chatgpt.com</a>',
          "</body></html>",
        ].join(""),
      },
      seo: canonical === null ? {} : { canonical },
    };
  });

  await writeFile(irPath, JSON.stringify({ irVersion: "1.0.0", pages }, null, 2), "utf8");
  return { dir, manifestPath, irPath, outPath };
}

describe("parseSearchProbe", () => {
  it("recognises a no-results page from its body class and marker", () => {
    const probe = parseSearchProbe("/?s=test", 200, "text/html", fixture("search.no-results.html"));
    expect(probe.noResults).toBe(true);
    expect(probe.resultMarkers).toBe(0);
    expect(probe.documentTitle).toContain('Search results for "test"');
    expect(probe.robots).toBe("max-image-preview:large");
    expect(probe.bodyClasses).toContain("search-no-results");
  });

  it("recognises a matching page and counts its result wrappers", () => {
    const probe = parseSearchProbe("/?s=room", 200, "text/html", fixture("search.matches.html"));
    expect(probe.noResults).toBe(false);
    expect(probe.resultMarkers).toBe(5);
    expect(probe.bodyClasses).toContain("search-results");
  });
});

describe("captureSeo — offline, from recorded fixtures", () => {
  it("writes the sidecar and reports no failures for a conforming site", async () => {
    const inputs = await seedInputs({});
    const result = await captureSeo({
      baseUrl: BASE,
      manifestPath: inputs.manifestPath,
      irPath: inputs.irPath,
      assetsReportPath: join(inputs.dir, "absent.json"),
      out: inputs.outPath,
      fetcher: new ScriptedFetcher(scriptedSite()),
    });

    expect(result.cannotEvaluate).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.report).not.toBeNull();

    const written = JSON.parse(await readFile(inputs.outPath, "utf8")) as {
      seoVersion: string;
      summary: { pages: number; seoAbsentSiteWide: string[]; canonicalMismatches: number };
      redirects: { count: number; verified: number };
      pages: { url: string }[];
    };
    expect(written.seoVersion).toBe("1");
    expect(written.summary.pages).toBe(2);
    expect(written.summary.canonicalMismatches).toBe(0);
    expect(written.summary.seoAbsentSiteWide).toContain("description");
    expect(written.redirects).toMatchObject({ count: 1, verified: 1 });
  });

  it("fails when a canonical does not equal its route", async () => {
    const inputs = await seedInputs({ canonical: { "/care/": `${BASE}/care` } });
    const result = await captureSeo({
      baseUrl: BASE,
      manifestPath: inputs.manifestPath,
      irPath: inputs.irPath,
      assetsReportPath: join(inputs.dir, "absent.json"),
      out: inputs.outPath,
      fetcher: new ScriptedFetcher(scriptedSite()),
    });
    expect(result.failures.some((failure) => failure.includes("canonical"))).toBe(true);
    expect(result.report?.summary.canonicalMismatches).toBe(1);
  });

  it("fails when a canonical is absent entirely", async () => {
    const inputs = await seedInputs({ canonical: { "/care/": null } });
    const result = await captureSeo({
      baseUrl: BASE,
      manifestPath: inputs.manifestPath,
      irPath: inputs.irPath,
      assetsReportPath: join(inputs.dir, "absent.json"),
      out: inputs.outPath,
      fetcher: new ScriptedFetcher(scriptedSite()),
    });
    expect(result.failures.some((failure) => failure.includes("(absent)"))).toBe(true);
  });

  it("fails when a page is unreachable, naming the recorded status", async () => {
    const inputs = await seedInputs({ routeStatus: { "/care/": 500 } });
    const result = await captureSeo({
      baseUrl: BASE,
      manifestPath: inputs.manifestPath,
      irPath: inputs.irPath,
      assetsReportPath: join(inputs.dir, "absent.json"),
      out: inputs.outPath,
      fetcher: new ScriptedFetcher(scriptedSite()),
    });
    expect(result.failures.some((failure) => failure.includes("unreachable"))).toBe(true);
    expect(result.failures.some((failure) => failure.includes("500"))).toBe(true);
  });

  it("cannot evaluate, rather than passing, when the manifest is missing", async () => {
    const inputs = await seedInputs({});
    const result = await captureSeo({
      baseUrl: BASE,
      manifestPath: join(inputs.dir, "nope.json"),
      irPath: inputs.irPath,
      out: inputs.outPath,
      fetcher: new ScriptedFetcher(scriptedSite()),
    });
    expect(result.report).toBeNull();
    expect(result.cannotEvaluate).toHaveLength(1);
  });

  it("cannot evaluate when --base-url disagrees with the manifest", async () => {
    const inputs = await seedInputs({});
    const result = await captureSeo({
      baseUrl: "https://other.test",
      manifestPath: inputs.manifestPath,
      irPath: inputs.irPath,
      out: inputs.outPath,
      fetcher: new ScriptedFetcher(scriptedSite()),
    });
    expect(result.report).toBeNull();
    expect(result.cannotEvaluate[0]).toContain("refusing to mix captures");
  });

  it("reconciles a broken reference found in the captured DOM against a recorded probe", async () => {
    const inputs = await seedInputs({});
    const result = await captureSeo({
      baseUrl: BASE,
      manifestPath: inputs.manifestPath,
      irPath: inputs.irPath,
      assetsReportPath: join(inputs.dir, "absent.json"),
      out: inputs.outPath,
      fetcher: new ScriptedFetcher(scriptedSite()),
    });
    const broken = result.report?.brokenReferences ?? [];
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({
      severity: "high",
      status: 404,
      statusSource: "live-probe",
      pages: ["/care/"],
    });
  });
});

describe("the committed sidecar", () => {
  it("conforms to scripts/validate-seo.mjs, so the artifact cannot drift from the gate", () => {
    const repoRoot = join(import.meta.dirname, "..");
    const run = spawnSync(process.execPath, [join(repoRoot, "scripts", "validate-seo.mjs")], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  });
});
