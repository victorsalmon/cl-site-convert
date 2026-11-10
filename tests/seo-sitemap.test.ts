import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildRobotsContract,
  buildSitemapCapture,
  buildSitemapContract,
  parseRobotsDirectives,
} from "../src/source/seo/sitemap.js";
import type { RobotsCapture } from "../src/source/seo/sitemap.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "seo");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const BASE = "https://upscalehavens.ca";
const toPath = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
};

const robotsBody = fixture("robots.txt");

function robotsCapture(): RobotsCapture {
  const directives = parseRobotsDirectives(robotsBody);
  return {
    url: "/robots.txt",
    status: 200,
    contentType: "text/plain; charset=utf-8",
    body: robotsBody,
    rules: { disallow: directives.disallow, allow: directives.allow },
    sitemaps: directives.sitemaps,
  };
}

describe("parseRobotsDirectives", () => {
  const directives = parseRobotsDirectives(robotsBody);

  it("reads the disallow, the override and the sitemap pointer", () => {
    expect(directives).toEqual({
      disallow: ["/wp-admin/"],
      allow: ["/wp-admin/admin-ajax.php"],
      sitemaps: ["https://upscalehavens.ca/wp-sitemap.xml"],
    });
  });

  it("ignores comments, blank lines and unknown fields", () => {
    const parsed = parseRobotsDirectives(
      ["# a comment", "", "User-agent: *", "Crawl-delay: 10", "Disallow: /private/"].join("\n"),
    );
    expect(parsed).toEqual({ disallow: ["/private/"], allow: [], sitemaps: [] });
  });

  it("treats an empty Disallow value as no rule, not as a rule for everything", () => {
    expect(parseRobotsDirectives("User-agent: *\nDisallow:\n").disallow).toEqual([]);
  });
});

describe("buildSitemapCapture", () => {
  const captured = ["/", "/care/", "/tmh/", "/resources/checklists/", "/tmh/apply/"];

  it("reads the index, its child urlset, and the 3 URLs that child advertises", () => {
    const capture = buildSitemapCapture({
      rootUrl: "/wp-sitemap.xml",
      root: { status: 200, body: fixture("sitemap.index.xml") },
      children: [
        {
          url: `${BASE}/wp-sitemap-posts-page-1.xml`,
          status: 200,
          body: fixture("sitemap.pages.xml"),
        },
      ],
      robotsSitemaps: [`${BASE}/wp-sitemap.xml`],
      capturedRoutes: captured,
      toPath,
    });

    expect(capture.kind).toBe("index");
    expect(capture.children).toHaveLength(1);
    expect(capture.children[0]).toMatchObject({ kind: "urlset", urls: 3, status: 200 });
    expect(capture.urlCount).toBe(3);
    expect(capture.declaredInRobots).toEqual([`${BASE}/wp-sitemap.xml`]);
  });

  it("names captured routes the sitemap does not advertise", () => {
    const capture = buildSitemapCapture({
      rootUrl: "/wp-sitemap.xml",
      root: { status: 200, body: fixture("sitemap.index.xml") },
      children: [
        {
          url: `${BASE}/wp-sitemap-posts-page-1.xml`,
          status: 200,
          body: fixture("sitemap.pages.xml"),
        },
      ],
      robotsSitemaps: [],
      capturedRoutes: captured,
      toPath,
    });
    expect(capture.notInSitemap).toEqual(["/", "/care/"]);
    expect(capture.notCaptured).toEqual([]);
  });

  it("names advertised URLs that are not captured routes", () => {
    const capture = buildSitemapCapture({
      rootUrl: "/wp-sitemap.xml",
      root: { status: 200, body: fixture("sitemap.index.xml") },
      children: [
        {
          url: `${BASE}/wp-sitemap-posts-page-1.xml`,
          status: 200,
          body: fixture("sitemap.pages.xml"),
        },
      ],
      robotsSitemaps: [],
      capturedRoutes: ["/tmh/"],
      toPath,
    });
    expect(capture.notCaptured).toEqual(["/resources/checklists/", "/tmh/apply/"]);
  });

  it("records a failed child with its status and contributes no URLs from it", () => {
    const capture = buildSitemapCapture({
      rootUrl: "/wp-sitemap.xml",
      root: { status: 200, body: fixture("sitemap.index.xml") },
      children: [{ url: `${BASE}/wp-sitemap-posts-page-1.xml`, status: 503, body: "" }],
      robotsSitemaps: [],
      capturedRoutes: captured,
      toPath,
    });
    expect(capture.children[0]?.status).toBe(503);
    expect(capture.urlCount).toBe(0);
    expect(capture.kind).toBe("index");
  });

  it("reports an unreadable root as kind unknown rather than an empty urlset", () => {
    const capture = buildSitemapCapture({
      rootUrl: "/wp-sitemap.xml",
      root: null,
      children: [],
      robotsSitemaps: [],
      capturedRoutes: captured,
      toPath,
    });
    expect(capture.kind).toBe("unknown");
    expect(capture.status).toBe(0);
    expect(capture.urlCount).toBe(0);
  });

  it("reads a root that is itself a urlset (no index)", () => {
    const capture = buildSitemapCapture({
      rootUrl: "/wp-sitemap-posts-page-1.xml",
      root: { status: 200, body: fixture("sitemap.pages.xml") },
      children: [],
      robotsSitemaps: [],
      capturedRoutes: captured,
      toPath,
    });
    expect(capture.kind).toBe("urlset");
    expect(capture.urlCount).toBe(3);
  });
});

describe("buildRobotsContract", () => {
  const capture = buildSitemapCapture({
    rootUrl: "/wp-sitemap.xml",
    root: { status: 200, body: fixture("sitemap.index.xml") },
    children: [
      {
        url: `${BASE}/wp-sitemap-posts-page-1.xml`,
        status: 200,
        body: fixture("sitemap.pages.xml"),
      },
    ],
    robotsSitemaps: [`${BASE}/wp-sitemap.xml`],
    capturedRoutes: ["/", "/care/", "/tmh/", "/resources/checklists/", "/tmh/apply/"],
    toPath,
  });

  it("keeps the captured body verbatim", () => {
    const contract = buildRobotsContract(robotsCapture(), capture, {
      sitemapPath: "/wp-sitemap.xml",
    });
    expect(contract.body).toBe(robotsBody);
    expect(contract.path).toBe("/robots.txt");
  });

  it("states the obligations as instructions, including the inert admin rule", () => {
    const contract = buildRobotsContract(robotsCapture(), capture, {
      sitemapPath: "/wp-sitemap.xml",
    });
    expect(contract.mustEmit.some((line) => line.includes("byte-identical"))).toBe(true);
    expect(contract.mustEmit.some((line) => line.includes("inert rather than wrong"))).toBe(true);
    expect(contract.mustEmit.some((line) => line.includes("wp-sitemap.xml"))).toBe(true);
  });

  it("says so plainly when robots.txt was not captured", () => {
    const failed: RobotsCapture = { ...robotsCapture(), status: 503, body: "" };
    const contract = buildRobotsContract(failed, capture, { sitemapPath: "/wp-sitemap.xml" });
    expect(contract.mustEmit[0]).toContain("NOT captured");
  });
});

describe("buildSitemapContract", () => {
  const capture = buildSitemapCapture({
    rootUrl: "/wp-sitemap.xml",
    root: { status: 200, body: fixture("sitemap.index.xml") },
    children: [
      {
        url: `${BASE}/wp-sitemap-posts-page-1.xml`,
        status: 200,
        body: fixture("sitemap.pages.xml"),
      },
    ],
    robotsSitemaps: [],
    capturedRoutes: ["/tmh/", "/resources/checklists/", "/tmh/apply/"],
    toPath,
  });

  it("carries the captured URL set forward", () => {
    const contract = buildSitemapContract(capture, {
      sitemapPath: "/wp-sitemap.xml",
      xslPath: "/wp-sitemap.xsl",
    });
    expect(contract.urlCount).toBe(3);
    expect(contract.locs).toHaveLength(3);
    expect(contract.kind).toBe("urlset");
  });

  it("warns about a dangling xml-stylesheet when the XSL is not carried over", () => {
    const contract = buildSitemapContract(capture, {
      sitemapPath: "/wp-sitemap.xml",
      xslPath: "/wp-sitemap.xsl",
    });
    expect(contract.mustEmit.some((line) => line.includes("wp-sitemap.xsl"))).toBe(true);
    const withoutXsl = buildSitemapContract(capture, {
      sitemapPath: "/wp-sitemap.xml",
      xslPath: null,
    });
    expect(withoutXsl.mustEmit.some((line) => line.includes("xml-stylesheet"))).toBe(false);
  });

  it("requires absolute URLs on the new origin", () => {
    const contract = buildSitemapContract(capture, {
      sitemapPath: "/wp-sitemap.xml",
      xslPath: null,
    });
    expect(contract.mustEmit.some((line) => line.includes("new origin"))).toBe(true);
  });
});
