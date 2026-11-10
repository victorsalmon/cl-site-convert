import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SEO_FIELDS,
  absentFields,
  extractSeoSurface,
  summariseSeo,
} from "../src/source/seo/surface.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "seo");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/**
 * `head.home.html` and `head.privacy.html` are verbatim `<head>` slices of the
 * recorded upscalehavens.ca capture. They are the *absence* evidence: B1.2 reported
 * that description, OpenGraph, Twitter, JSON-LD and hreflang do not exist on this
 * site. An extractor that guessed any of them would turn that finding into a fiction.
 */
describe("extractSeoSurface — the real captured head", () => {
  const home = extractSeoSurface(fixture("head.home.html"));

  it("reads the title with entities decoded", () => {
    expect(home.title).toBe(
      "Upscale Havens Leasing and Tenant Coordination | Intentional homes for friendly roommates who like nice things",
    );
  });

  it("reads the canonical exactly as declared (absolute, with its trailing slash)", () => {
    expect(home.canonical).toBe("https://upscalehavens.ca/");
  });

  it("reads the robots directive from a single-quoted attribute", () => {
    // WordPress emits name='robots' content='…' with single quotes; a regex that only
    // accepts double quotes reports this as absent, which is how a false "no robots
    // meta anywhere" finding gets written.
    expect(home.robots).toBe("max-image-preview:large");
  });

  it("reports description, hreflang, OpenGraph, Twitter and JSON-LD as absent — not empty", () => {
    expect(home.description).toBeNull();
    expect(home.openGraph).toEqual([]);
    expect(home.twitter).toEqual([]);
    expect(home.hreflang).toEqual([]);
    expect(home.jsonLd).toEqual({ count: 0, types: [], invalid: 0 });
    expect(home.absent).toEqual(["description", "hreflang", "openGraph", "twitter", "jsonLd"]);
  });

  it("does not mistake the RSS/oEmbed rel=alternate links for hreflang", () => {
    expect(home.hreflang).toHaveLength(0);
  });
});

describe("extractSeoSurface — the positive path", () => {
  const full = extractSeoSurface(fixture("head.full-seo.html"));

  it("reads every field, so 'absent' is a measurement rather than a blind spot", () => {
    expect(full.absent).toEqual([]);
    expect(full.title).toBe("Full SEO surface & entities — Fixture");
    expect(full.description).toBe('A description with an & entity and a "quoted" phrase.');
    expect(full.robots).toBe("index, follow, max-image-preview:large");
    expect(full.canonical).toBe("https://example.test/full-seo/");
  });

  it("collects OpenGraph pairs in document order and Twitter separately", () => {
    expect(full.openGraph.map((pair) => pair.key)).toEqual([
      "og:title",
      "og:description",
      "og:image",
    ]);
    expect(full.twitter.map((pair) => pair.key)).toEqual(["twitter:card", "twitter:title"]);
  });

  it("reads a three-entry hreflang set including x-default, lowercased", () => {
    expect(full.hreflang).toEqual([
      { hreflang: "en-ca", href: "https://example.test/full-seo/" },
      { hreflang: "fr-ca", href: "https://example.test/fr/full-seo/" },
      { hreflang: "x-default", href: "https://example.test/full-seo/" },
    ]);
  });

  it("summarises JSON-LD without keeping the payload, counting unparseable blocks", () => {
    expect(full.jsonLd.count).toBe(2);
    expect(full.jsonLd.types).toEqual(["Organization", "WebSite", "WebPage"]);
    expect(full.jsonLd.invalid).toBe(1);
  });
});

describe("extractSeoSurface — a partial surface", () => {
  const partial = extractSeoSurface(fixture("head.partial.html"));

  it("reports exactly the fields this page lacks, per field", () => {
    expect(partial.description).toBe("Only a description is present here.");
    expect(partial.openGraph).toHaveLength(1);
    expect(partial.absent).toEqual(["robots", "hreflang", "twitter", "jsonLd"]);
  });

  it("treats a fragment with no head at all as fully absent rather than throwing", () => {
    const fragment = extractSeoSurface('<div class="et_pb_section"><p>body only</p></div>');
    expect(fragment.absent).toEqual([...SEO_FIELDS]);
    expect(fragment.title).toBeNull();
  });
});

describe("absentFields — derived from the values, never passed in", () => {
  it("agrees with the surface it is derived from", () => {
    const surface = extractSeoSurface(fixture("head.home.html"));
    expect(absentFields(surface)).toEqual(surface.absent);
    expect(absentFields({ ...surface, robots: "noindex" })).not.toContain("robots");
  });
});

describe("summariseSeo — the site-wide omission", () => {
  const pages = [
    { url: "/", surface: extractSeoSurface(fixture("head.home.html")) },
    { url: "/ush/privacy-policy/", surface: extractSeoSurface(fixture("head.privacy.html")) },
    { url: "/fixture-full/", surface: extractSeoSurface(fixture("head.full-seo.html")) },
  ];

  it("counts presence per field across pages", () => {
    const summary = summariseSeo(pages);
    expect(summary.pages).toBe(3);
    expect(summary.presentOn.title).toBe(3);
    expect(summary.presentOn.description).toBe(1);
    expect(summary.presentOn.robots).toBe(3);
    expect(summary.presentOn.jsonLd).toBe(1);
  });

  it("names a field site-wide absent only when no page carries it", () => {
    const summary = summariseSeo(pages.slice(0, 2));
    expect(summary.absentSiteWide).toEqual([
      "description",
      "hreflang",
      "openGraph",
      "twitter",
      "jsonLd",
    ]);
  });

  it("drops a field from the site-wide list as soon as one page carries it", () => {
    // Every field appears on at least one page once the full-SEO fixture is included,
    // so nothing is site-wide absent — the list is an intersection, not a vote.
    expect(summariseSeo(pages).absentSiteWide).toEqual([]);
  });

  it("lists pages with no title rather than silently counting zero", () => {
    const summary = summariseSeo([
      { url: "/broken/", surface: extractSeoSurface("<html><head></head><body></body></html>") },
    ]);
    expect(summary.pagesWithoutTitle).toEqual(["/broken/"]);
    expect(summary.presentOn.title).toBe(0);
  });
});
