/**
 * Route-enumeration tests.
 *
 * Every input here is a **recorded fixture** in `tests/fixtures/wp-rest/`, taken
 * from the live site with the same polite fetcher the tool uses. Nothing in this
 * file touches the network: a suite that hits the site would be slow, flaky, and
 * rude, and would also fail to notice the day the site changed.
 *
 * What is pinned, and why:
 *  - the pure parsers (robots, sitemap, REST item, pagination) against real bytes,
 *    because "the parser works" is only meaningful against real shapes;
 *  - the union/reconciliation arithmetic, because a silent off-by-one there is the
 *    difference between "the site has 19 pages" and a lie;
 *  - the end-to-end count from the fixtures (19 REST pages, 19 sitemap URLs, 19 in
 *    both), which is the regression pin for this snapshot of upscalehavens.ca.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isPathAllowed, parseRobots } from "../src/source/wp-rest/http.js";
import {
  detectWpVersion,
  extractInternalLinks,
  mergeSources,
  normaliseRestItem,
  parsePaginationHeaders,
  parseRestCollection,
  parseRestRoot,
  parseSitemap,
  pathFromUrl,
  pluginNamespaces,
  routeKey,
  slugFromPath,
} from "../src/source/wp-rest/parse.js";
import type { RouteRecord } from "../src/source/wp-rest/parse.js";
import {
  formatReconciliation,
  ROUTE_MANIFEST_VERSION,
  routableCollections,
} from "../src/source/wp-rest/routes.js";
import type { RouteManifest } from "../src/source/wp-rest/routes.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wp-rest");
const BASE_URL = "https://upscalehavens.ca";

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const robotsTxt = fixture("robots.txt");
const sitemapIndexXml = fixture("sitemap-index.xml");
const sitemapPagesXml = fixture("sitemap-pages.xml");
const pagesJson = fixture("pages-page-1.json");
const restRootJson = fixture("rest-root.trimmed.json");

/** Every REST page record from the recorded fixture, normalised. */
function fixtureRoutes(): RouteRecord[] {
  const collection = parseRestCollection(pagesJson, 200);
  expect(collection.error).toBeNull();
  const parentPaths = new Map<number, string>();
  for (const item of collection.items) {
    const record = item as Record<string, unknown>;
    const id = record["id"];
    const link = record["link"];
    if (typeof id === "number" && typeof link === "string") {
      parentPaths.set(id, pathFromUrl(link, BASE_URL));
    }
  }
  return collection.items.flatMap((item) => {
    const route = normaliseRestItem(item, { baseUrl: BASE_URL, parentPaths });
    return route === null ? [] : [route];
  });
}

describe("robots.txt", () => {
  it("reads the recorded file and finds the sitemap it advertises", () => {
    const rules = parseRobots(robotsTxt);
    expect(rules.unreadable).toBe(false);
    expect(rules.disallow).toEqual(["/wp-admin/"]);
    expect(rules.allow).toEqual(["/wp-admin/admin-ajax.php"]);
    expect(rules.sitemaps).toEqual(["https://upscalehavens.ca/wp-sitemap.xml"]);
  });

  it("obeys the Allow override inside a broader Disallow", () => {
    const rules = parseRobots(robotsTxt);
    expect(isPathAllowed("/wp-admin/admin-ajax.php", rules)).toBe(true);
    expect(isPathAllowed("/wp-admin/setup-config.php", rules)).toBe(false);
    expect(isPathAllowed("/tmh/apply/", rules)).toBe(true);
    expect(isPathAllowed("/wp-json/wp/v2/pages", rules)).toBe(true);
  });

  it("honours an explicit wildcard group over an unrelated one", () => {
    const rules = parseRobots(
      "User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /private/\n",
    );
    expect(isPathAllowed("/private/x", rules)).toBe(false);
    expect(isPathAllowed("/public", rules)).toBe(true);
  });

  it("treats an unreadable robots.txt as no restriction, and says so", () => {
    const rules = { disallow: [], allow: [], sitemaps: [], unreadable: true, status: 403 };
    expect(isPathAllowed("/anything", rules)).toBe(true);
  });
});

describe("sitemaps", () => {
  it("parses the recorded index and finds its single child", () => {
    const index = parseSitemap(sitemapIndexXml);
    expect(index.kind).toBe("index");
    expect(index.children).toEqual(["https://upscalehavens.ca/wp-sitemap-posts-page-1.xml"]);
    expect(index.entries).toEqual([]);
  });

  it("parses the recorded urlset into 19 entries with lastmod", () => {
    const urls = parseSitemap(sitemapPagesXml);
    expect(urls.kind).toBe("urlset");
    expect(urls.entries).toHaveLength(19);
    expect(urls.entries[0]?.loc).toBe("https://upscalehavens.ca/tmh/");
    expect(urls.entries[0]?.lastmod).not.toBeNull();
    // Root URL must survive parsing rather than being trimmed to nothing.
    expect(urls.entries.map((entry) => entry.loc)).toContain("https://upscalehavens.ca/");
  });

  it("reports an unknown document instead of guessing", () => {
    expect(parseSitemap("<html><body>404</body></html>").kind).toBe("unknown");
  });
});

describe("REST root", () => {
  it("reads identity and namespaces, and names the plugin namespaces", () => {
    const root = parseRestRoot(restRootJson);
    expect(root.name).toBe("Upscale Havens Leasing and Tenant Coordination");
    expect(root.showOnFront).toBe("page");
    expect(root.pageOnFront).toBe(539);
    expect(root.gmtOffset).toBe(-8);
    expect(pluginNamespaces(root.namespaces)).toEqual([
      "fluent-smtp",
      "fluentform/v1",
      "litespeed/v1",
      "litespeed/v3",
      "redirection/v1",
      "fluent-crm/v1",
      "fluent-crm/v2",
      "divi/v1",
    ]);
  });

  it("does not report a plugin leak when only core namespaces exist", () => {
    expect(pluginNamespaces(["wp/v2", "oembed/1.0"])).toEqual([]);
  });

  it("detects the version from the generator meta only", () => {
    expect(detectWpVersion('<meta name="generator" content="WordPress 7.1.4" />')).toBe("7.1.4");
    expect(detectWpVersion("<html><head></head></html>")).toBeNull();
  });
});

describe("REST items", () => {
  it("normalises 19 recorded pages with no losses", () => {
    const routes = fixtureRoutes();
    expect(routes).toHaveLength(19);
    expect(routes.every((route) => route.source === "wp-rest")).toBe(true);
    expect(routes.every((route) => route.status === "publish")).toBe(true);
    expect(routes.every((route) => route.type === "page")).toBe(true);
  });

  it("maps an empty REST template to null and keeps a real one", () => {
    const routes = fixtureRoutes();
    const apply = routes.find((route) => route.path === "/tmh/apply/");
    expect(apply?.template).toBe("page-template-blank.php");
    const home = routes.find((route) => route.path === "/");
    expect(home?.template).toBeNull();
    // The front page's WP slug is its own thing ("ush"), not its path.
    expect(home?.slug).toBe("ush");
    expect(home?.url).toBe(`${BASE_URL}/`);
  });

  it("resolves the numeric parent id to the parent's route path", () => {
    const routes = fixtureRoutes();
    expect(routes.find((route) => route.path === "/tmh/")?.parent).toBeNull();
    expect(routes.find((route) => route.path === "/tmh/apply/")?.parent).toBe("/tmh/");
    expect(routes.find((route) => route.path === "/mlm/onboard-mlm/")?.parent).toBe("/mlm/");
    expect(routes.find((route) => route.path === "/tmh/apply/")?.parentId).toBe(72);
  });

  it("drops an item that lacks the fields a route needs, rather than inventing them", () => {
    expect(normaliseRestItem({ id: 1, slug: "x" }, { baseUrl: BASE_URL })).toBeNull();
    expect(normaliseRestItem("not an object", { baseUrl: BASE_URL })).toBeNull();
  });

  it("reports an unparseable collection in-band instead of throwing", () => {
    expect(parseRestCollection("<html>", 200).error).not.toBeNull();
    expect(parseRestCollection("{}", 200).error).not.toBeNull();
    const forbidden = parseRestCollection("", 401);
    expect(forbidden.error).toBe("HTTP 401");
    expect(forbidden.items).toEqual([]);
  });

  it("reads X-WP-Total headers, and reports unknown when absent", () => {
    expect(parsePaginationHeaders({ "x-wp-total": "19", "x-wp-totalpages": "1" })).toEqual({
      total: 19,
      totalPages: 1,
    });
    expect(parsePaginationHeaders({})).toEqual({ total: null, totalPages: null });
    expect(parsePaginationHeaders({ "x-wp-total": "many" })).toEqual({
      total: null,
      totalPages: null,
    });
  });
});

describe("path keys", () => {
  it("treats trailing-slash variants as one route", () => {
    expect(routeKey("/tmh/apply/")).toBe("/tmh/apply");
    expect(routeKey("/tmh/apply")).toBe("/tmh/apply");
    expect(routeKey("/")).toBe("/");
    expect(routeKey("")).toBe("/");
  });

  it("takes the last segment as the slug, and nothing for the root", () => {
    expect(slugFromPath("/tmh/apply/")).toBe("apply");
    expect(slugFromPath("/mlm/onboard-mlm/")).toBe("onboard-mlm");
    expect(slugFromPath("/")).toBe("");
  });

  it("keeps query strings, because they can be distinct routes", () => {
    expect(pathFromUrl("https://upscalehavens.ca/?fluent-form=3", BASE_URL)).toBe(
      "/?fluent-form=3",
    );
  });
});

describe("reconciliation", () => {
  const restRoutes = fixtureRoutes();
  const sitemapEntries = parseSitemap(sitemapPagesXml).entries;

  it("unions the recorded sources into 19 routes, all present in both", () => {
    const merged = mergeSources(restRoutes, sitemapEntries, BASE_URL);
    expect(merged.reconciliation).toEqual({
      wpRest: 19,
      sitemap: 19,
      union: 19,
      both: 19,
      restOnly: [],
      sitemapOnly: [],
    });
    expect(merged.routes.every((route) => route.source === "both")).toBe(true);
  });

  it("names a REST-only route instead of folding it away", () => {
    const draft: RouteRecord = {
      url: `${BASE_URL}/care/showings-draft/`,
      path: "/care/showings-draft/",
      slug: "showings-draft",
      status: "draft",
      type: "page",
      parent: "/care/",
      parentId: 557,
      modified: null,
      template: null,
      source: "wp-rest",
    };
    const merged = mergeSources([draft, ...restRoutes], sitemapEntries, BASE_URL);
    expect(merged.reconciliation.restOnly).toEqual(["/care/showings-draft"]);
    expect(merged.reconciliation.wpRest).toBe(20);
    expect(merged.routes.find((route) => route.path === "/care/showings-draft/")?.source).toBe(
      "wp-rest",
    );
  });

  it("names a sitemap-only URL and gives it no invented status", () => {
    const extra = { loc: `${BASE_URL}/legacy/`, lastmod: "2025-01-01T00:00:00-08:00" };
    const merged = mergeSources(restRoutes, [...sitemapEntries, extra], BASE_URL);
    expect(merged.reconciliation.sitemapOnly).toEqual(["/legacy"]);
    const route = merged.routes.find((candidate) => candidate.path === "/legacy/");
    expect(route?.status).toBe("unknown");
    expect(route?.type).toBe("other");
    expect(route?.modified).toBe("2025-01-01T00:00:00-08:00");
  });

  it("matches a sitemap URL to a REST route despite a trailing-slash difference", () => {
    const entries = [{ loc: `${BASE_URL}/tmh/apply`, lastmod: null }];
    const merged = mergeSources(restRoutes, entries, BASE_URL);
    expect(merged.reconciliation.both).toBe(1);
    expect(merged.reconciliation.sitemapOnly).toEqual([]);
    expect(merged.routes.find((route) => route.path === "/tmh/apply/")?.source).toBe("both");
  });

  it("prefers the REST page over a sitemap 'other' at the same path", () => {
    const entries = [{ loc: `${BASE_URL}/tmh/`, lastmod: "2020-01-01T00:00:00-08:00" }];
    const merged = mergeSources(restRoutes, entries, BASE_URL);
    const tmh = merged.routes.find((route) => route.path === "/tmh/");
    expect(tmh?.type).toBe("page");
    expect(tmh?.slug).toBe("tmh");
    // REST already knew `modified`; the sitemap's lastmod never overrides it.
    expect(tmh?.modified).toBe("2025-08-20T12:06:57");
  });

  it("fills modified from the sitemap only when REST had none", () => {
    const route: RouteRecord = {
      url: `${BASE_URL}/no-modified/`,
      path: "/no-modified/",
      slug: "no-modified",
      status: "publish",
      type: "page",
      parent: null,
      parentId: 0,
      modified: null,
      template: null,
      source: "wp-rest",
    };
    const merged = mergeSources(
      [route],
      [{ loc: `${BASE_URL}/no-modified/`, lastmod: "2025-02-02T00:00:00-08:00" }],
      BASE_URL,
    );
    expect(merged.routes[0]?.modified).toBe("2025-02-02T00:00:00-08:00");
    expect(merged.routes[0]?.source).toBe("both");
  });
});

describe("link harvest", () => {
  const html = `
    <a href="/tmh/apply/">Apply</a>
    <a href="/tmh/apply/">Apply again</a>
    <a href="https://upscalehavens.ca/mlm/">MLM</a>
    <a href="https://example.com/elsewhere">Elsewhere</a>
    <a href="mailto:hi@upscalehavens.ca">Mail</a>
    <a href="#section">Anchor</a>
    <a href="/wp-json/wp/v2/pages">REST</a>
    <a href="/feed/">Feed</a>
    <a href="/wp-content/uploads/2025/12/x.pdf">PDF</a>
    <a href="/?fluent-form=3">Form</a>
    <a href="apply">Relative</a>
  `;

  it("keeps on-site paths, deduplicates, and drops machines, assets and other hosts", () => {
    expect(extractInternalLinks(html, BASE_URL, "/tmh/")).toEqual([
      "/?fluent-form=3",
      "/mlm/",
      "/tmh/apply",
      "/tmh/apply/",
    ]);
  });

  it("resolves a bare relative href against the page, not the site root", () => {
    expect(extractInternalLinks('<a href="apply">a</a>', BASE_URL, "/tmh/onboard-tmh/")).toEqual([
      "/tmh/onboard-tmh/apply",
    ]);
    expect(extractInternalLinks('<a href="apply">a</a>', BASE_URL)).toEqual(["/apply"]);
  });

  it("returns nothing for a base URL that will not parse", () => {
    expect(extractInternalLinks('<a href="/x">x</a>', "not a url")).toEqual([]);
  });
});

describe("routable collections", () => {
  it("always includes pages and posts, and adds custom post types", () => {
    expect(routableCollections([])).toEqual(["pages", "posts"]);
    expect(
      routableCollections([
        { restBase: "pages", restNamespace: "wp/v2" },
        { restBase: "project", restNamespace: "wp/v2" },
        { restBase: "fcrm-dummy", restNamespace: "wp/v2" },
      ]),
    ).toEqual(["pages", "posts", "project", "fcrm-dummy"]);
  });

  it("skips builder machinery, templated bases, foreign namespaces and junk", () => {
    expect(
      routableCollections([
        { restBase: "media", restNamespace: "wp/v2" },
        { restBase: "menu-items", restNamespace: "wp/v2" },
        { restBase: "template-parts", restNamespace: "wp/v2" },
        { restBase: "font-families/(?P<font_family_id>[\\d]+)/font-faces", restNamespace: "wp/v2" },
        { restBase: "orders", restNamespace: "wc/v3" },
        { restBase: null, restNamespace: "wp/v2" },
      ]),
    ).toEqual(["pages", "posts"]);
  });

  it("does not duplicate pages or posts when /types reports them", () => {
    expect(
      routableCollections([
        { restBase: "pages", restNamespace: "wp/v2" },
        { restBase: "posts", restNamespace: "wp/v2" },
      ]),
    ).toEqual(["pages", "posts"]);
  });
});

describe("report", () => {
  it("prints the divergence sections even when they are empty", () => {
    const merged = mergeSources(fixtureRoutes(), parseSitemap(sitemapPagesXml).entries, BASE_URL);
    const manifest: RouteManifest = {
      manifestVersion: ROUTE_MANIFEST_VERSION,
      generatedAt: "2026-11-10T00:00:00.000Z",
      baseUrl: BASE_URL,
      tool: {
        name: "cl-site-convert",
        version: "0.1.0",
        userAgent: "test",
        minIntervalMs: 600,
        requests: 0,
      },
      rest: {
        available: true,
        rootStatus: 200,
        siteName: "Upscale Havens",
        description: null,
        namespaces: [],
        pluginNamespaces: [],
        leaksPluginList: false,
        wpVersion: "7.1.4",
        wpVersionSource: "generator-meta",
        showOnFront: "page",
        pageOnFront: 539,
        pluginsEndpointStatus: 401,
        usersEndpointOpen: true,
        userCount: 1,
        collections: [],
        reasons: [],
      },
      sitemap: {
        attempts: [],
        documents: [],
        robotsDeclared: [],
        urlCount: 19,
        reasons: [],
      },
      taxonomies: { categories: { count: 0, terms: [] }, tags: { count: 0, terms: [] }, types: [] },
      reconciliation: merged.reconciliation,
      counts: {
        total: 19,
        byType: { page: 19, post: 0, other: 0 },
        bySource: { "wp-rest": 0, sitemap: 0, both: 19 },
        byStatus: { publish: 19 },
      },
      discovery: {
        robots: { status: 200, unreadable: false, disallow: ["/wp-admin/"], allow: [] },
        linkHarvest: { pagesScanned: 19, distinctInternalPaths: 22, notInManifest: [], probes: [] },
        redirects: [],
        skipped: [],
      },
      routes: merged.routes,
      notes: [],
    };

    const report = formatReconciliation(manifest);
    expect(report).toContain("wp-rest routes : 19");
    expect(report).toContain("sitemap urls   : 19");
    expect(report).toContain("union          : 19");
    expect(report).toContain("rest only (0):");
    expect(report).toContain("(none — the two sources agree)");
  });
});
