/**
 * Unit tests for the emit-time rewrite table and the cascade rebuild.
 *
 * These are the two places where the emitter is allowed to change bytes, so each has
 * to be provable in isolation: the site-level test
 * (`tests/emit-static-site.test.ts`) proves the whole tree, and this one pins the
 * primitives it is built from.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CascadeError,
  assertSequenceMatchesCascade,
  emittedStylePath,
  findCascadeStyleLinks,
  findStylesheetLinks,
  indexStyles,
  rebuildHead,
  resolvePageCascade,
} from "../src/emit/static-html/cascade.js";
import type { CascadeEntry } from "../src/emit/static-html/cascade.js";
import {
  RewriteMapError,
  buildRewriteTable,
  lookupRewrite,
  relativeRewrite,
  rewriteCssUrls,
  rewriteHtmlUrls,
} from "../src/emit/static-html/rewrite.js";
import type { Page, Style } from "../src/schema/site-ir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const TABLE = buildRewriteTable(
  {
    baseUrl: "https://upscalehavens.ca",
    version: 1,
    rewrite: {
      "https://upscalehavens.ca/wp-content/uploads/a.jpg": "wp-content/uploads/a.jpg",
      "https://fonts.gstatic.com/s/inter/i.woff2": "external/fonts.gstatic.com/s/inter/i.woff2",
      "/s/inter/i.woff2": "external/fonts.gstatic.com/s/inter/i.woff2",
      "https://upscalehavens.ca/wp-content/uploads/a-300x200.jpg":
        "wp-content/uploads/a-300x200.jpg",
    },
  },
  "fixture map",
);

describe("rewrite table", () => {
  it("maps an absolute captured url to its mirrored local path", () => {
    const hit = lookupRewrite(TABLE, "https://upscalehavens.ca/wp-content/uploads/a.jpg");
    expect(hit).toEqual({
      key: "https://upscalehavens.ca/wp-content/uploads/a.jpg",
      path: "wp-content/uploads/a.jpg",
      suffix: "",
    });
  });

  it("maps a protocol-relative url through the capture's own scheme", () => {
    // Divi's @font-face blocks use `//host/path`; the map recorded the absolute form.
    expect(lookupRewrite(TABLE, "//upscalehavens.ca/wp-content/uploads/a.jpg")?.path).toBe(
      "wp-content/uploads/a.jpg",
    );
  });

  it("maps a site-relative url through the capture's base url", () => {
    expect(lookupRewrite(TABLE, "/s/inter/i.woff2")?.path).toBe(
      "external/fonts.gstatic.com/s/inter/i.woff2",
    );
  });

  it("keeps the query/fragment suffix verbatim", () => {
    const value = relativeRewrite(TABLE, "//upscalehavens.ca/wp-content/uploads/a.jpg?#iefix", 2);
    expect(value?.value).toBe("../../wp-content/uploads/a.jpg?#iefix");
  });

  it("returns null for a reference the map does not know", () => {
    expect(lookupRewrite(TABLE, "https://example.com/x.png")).toBeNull();
    expect(lookupRewrite(TABLE, "#anchor")).toBeNull();
    expect(lookupRewrite(TABLE, "")).toBeNull();
  });

  it("refuses a map whose paths are absolute or traverse", () => {
    expect(() =>
      buildRewriteTable({
        baseUrl: "https://x.test",
        version: 1,
        rewrite: { "https://x.test/a": "/a" },
      }),
    ).toThrow(RewriteMapError);
    expect(() =>
      buildRewriteTable({
        baseUrl: "https://x.test",
        version: 1,
        rewrite: { "https://x.test/a": "../a" },
      }),
    ).toThrow(RewriteMapError);
  });

  it("refuses a map with no entries: a capture with no assets is a defect, not a site", () => {
    expect(() => buildRewriteTable({ baseUrl: "https://x.test", version: 1, rewrite: {} })).toThrow(
      RewriteMapError,
    );
  });
});

describe("CSS url() rewriting", () => {
  const css = [
    "@font-face{font-family:X;src:url( https://fonts.gstatic.com/s/inter/i.woff2 ) format('woff2')}",
    ".a{background:url('/wp-content/uploads/a.jpg')}",
    '.b{background:url("https://upscalehavens.ca/wp-content/uploads/a.jpg")}',
    ".c{background:url(pen.svg)}",
    ".d{contain:'url(not-a-token)'}",
  ].join("\n");

  it("substitutes only mapped url bodies and counts each one", () => {
    const result = rewriteCssUrls(css, TABLE, 1);
    expect(result.count).toBe(3);
    expect(result.text).toContain("url( ../external/fonts.gstatic.com/s/inter/i.woff2 )");
    expect(result.text).toContain("url('../wp-content/uploads/a.jpg')");
    expect(result.text).toContain('url("../wp-content/uploads/a.jpg")');
  });

  it("leaves a relative url the map does not know exactly as captured", () => {
    // `pen.svg` resolves against the stylesheet's captured absolute path, and linked
    // CSS is emitted at that same path, so touching it could only break it.
    expect(rewriteCssUrls(css, TABLE, 1).text).toContain("url(pen.svg)");
  });

  it("changes nothing but url bodies", () => {
    const emitted = rewriteCssUrls(css, TABLE, 1).text;
    const split = (text: string): string[] =>
      text.split(/url\(\s*(?:"[^"]*"|'[^']*'|[^)\s]*)\s*\)/g);

    // Every text segment outside the url() tokens is byte-identical, and the token
    // count is unchanged: the diff can only ever be a url substitution.
    expect(split(emitted)).toEqual(split(css));
    expect(emitted.split("url(").length).toBe(css.split("url(").length);
  });

  it("is idempotent on its own output, so a second pass cannot double-rewrite", () => {
    const once = rewriteCssUrls(css, TABLE, 1);
    const twice = rewriteCssUrls(once.text, TABLE, 1);
    expect(twice.text).toBe(once.text);
    expect(twice.count).toBe(0);
  });
});

describe("HTML attribute rewriting", () => {
  const html = [
    "<body>",
    '<img src="https://upscalehavens.ca/wp-content/uploads/a.jpg" alt="a">',
    '<img srcset="https://upscalehavens.ca/wp-content/uploads/a.jpg 1x, /wp-content/uploads/a-300x200.jpg 2x" src="x">',
    '<source srcset="https://upscalehavens.ca/wp-content/uploads/a.jpg 800w">',
    '<link rel="icon" href="https://upscalehavens.ca/wp-content/uploads/a.jpg">',
    '<a href="https://upscalehavens.ca/care/">care</a>',
    '<div style="background:url(https://upscalehavens.ca/wp-content/uploads/a.jpg)"></div>',
    "<script>var s = '<img src=\"https://upscalehavens.ca/wp-content/uploads/a.jpg\">';</script>",
    "</body>",
  ].join("\n");

  it("rewrites img/src, img/srcset, source/srcset and link/href only", () => {
    const result = rewriteHtmlUrls(html, TABLE, 2);
    expect(result.text).toContain('<img src="../../wp-content/uploads/a.jpg" alt="a">');
    expect(result.text).toContain(
      'srcset="../../wp-content/uploads/a.jpg 1x, ../../wp-content/uploads/a-300x200.jpg 2x"',
    );
    expect(result.text).toContain('<source srcset="../../wp-content/uploads/a.jpg 800w">');
    expect(result.text).toContain('<link rel="icon" href="../../wp-content/uploads/a.jpg">');
    // 1 img/src + 2 srcset candidates + 1 source/srcset + 1 link/href
    expect(result.count).toBe(5);
  });

  it("never rewrites navigation, inline styles or script text", () => {
    const result = rewriteHtmlUrls(html, TABLE, 2);
    expect(result.text).toContain('<a href="https://upscalehavens.ca/care/">care</a>');
    expect(result.text).toContain(
      '<div style="background:url(https://upscalehavens.ca/wp-content/uploads/a.jpg)"></div>',
    );
    expect(result.text).toContain(
      "var s = '<img src=\"https://upscalehavens.ca/wp-content/uploads/a.jpg\">';",
    );
  });

  it("counts nothing when no reference is known", () => {
    const result = rewriteHtmlUrls('<img src="https://example.com/x.png">', TABLE, 0);
    expect(result.count).toBe(0);
    expect(result.text).toBe('<img src="https://example.com/x.png">');
  });
});

// ---------------------------------------------------------------------------
// Cascade rebuild
// ---------------------------------------------------------------------------

const INLINE_A: Style = {
  origin: "inline",
  localPath: "assets/inline/aaaa.css",
  sha256: "a".repeat(64),
  order: 0,
};
const LINKED_B: Style = {
  href: "https://upscalehavens.ca/wp-content/themes/x/site.css?ver=1",
  localPath: "wp-content/themes/x/site.css",
  sha256: "b".repeat(64),
  order: 1,
};
const INLINE_C: Style = {
  origin: "inline",
  localPath: "assets/inline/cccc.css",
  sha256: "c".repeat(64),
  order: 2,
};

const HEAD = [
  '\n\t<meta charset="UTF-8" />\n',
  "\t<title>Care</title>\n",
  "<link rel='stylesheet' id='site-css' href='https://upscalehavens.ca/wp-content/themes/x/site.css?ver=1' media='all' />\n",
  '<meta name="viewport" content="width=device-width" />\n',
  '<link rel="icon" href="https://upscalehavens.ca/wp-content/uploads/icon.png" />\n',
  '<link rel="preload" as="style" href="https://upscalehavens.ca/wp-content/et-cache/deferred.css" onload="this.rel=\'stylesheet\'" />\n',
];

const PAGE: Page = {
  url: "/care/",
  slug: "care",
  status: "publish",
  template: "",
  dom: { html: `<html><head>${HEAD.join("")}</head><body></body></html>` },
  styleOrder: [INLINE_A.sha256, LINKED_B.sha256, INLINE_C.sha256],
};

describe("cascade rebuild", () => {
  it("emits styleOrder as one block, in order, at the first captured stylesheet link", () => {
    const rebuilt = rebuildHead(
      HEAD.join(""),
      resolvePageCascade(PAGE, indexStyles([INLINE_A, LINKED_B, INLINE_C])),
      {
        dirDepth: 1,
        table: TABLE,
        cssFor: (entry) => `/* ${entry.sha256.slice(0, 1)} */`,
      },
    );

    const order = rebuilt.markup
      .split("\n")
      .map((piece) => (piece.startsWith("<style") ? "inline" : "linked"));
    expect(order).toEqual(["inline", "linked", "inline"]);
    expect(rebuilt.removedLinks).toBe(1);

    // The linked entry is emitted at its mirrored path, relative to the page.
    expect(rebuilt.markup).toContain('href="../wp-content/themes/x/site.css"');
    // The captured tag is reused, so its id and media survive.
    expect(rebuilt.markup).toContain("id='site-css'");
    expect(rebuilt.markup).toContain("media='all'");

    // Every non-stylesheet head element survives, and the deferred preload stays put.
    for (const fragment of [
      '<meta charset="UTF-8" />',
      "<title>Care</title>",
      '<meta name="viewport" content="width=device-width" />',
      '<link rel="icon" href="https://upscalehavens.ca/wp-content/uploads/icon.png" />',
      'rel="preload"',
    ]) {
      expect(rebuilt.headHtml).toContain(fragment);
    }

    // No captured stylesheet link survives outside the rebuilt block.
    expect(findStylesheetLinks(rebuilt.headHtml)).toHaveLength(1);
    expect(rebuilt.replacedDeferredLinks).toBe(0);
    expect(rebuilt.preservedDeferredLinks).toBe(1);
    expect(rebuilt.headHtml.indexOf("<style")).toBeLessThan(rebuilt.headHtml.indexOf('rel="icon"'));
  });

  it("replaces a deferred link the cascade carries with a real stylesheet link", () => {
    const deferredHref = "https://upscalehavens.ca/wp-content/et-cache/deferred.css";
    const deferred: Style = {
      href: deferredHref,
      localPath: "deferred/dddd.css",
      sha256: "d".repeat(64),
      order: 3,
    };
    const page: Page = {
      ...PAGE,
      styleOrder: [...(PAGE.styleOrder ?? []), deferred.sha256],
    };
    const rebuilt = rebuildHead(
      HEAD.join(""),
      resolvePageCascade(page, indexStyles([INLINE_A, LINKED_B, INLINE_C, deferred])),
      { dirDepth: 1, table: TABLE, cssFor: () => "a{}" },
    );

    // The preload is gone, and a normal stylesheet link sits at the end of the chain.
    expect(rebuilt.headHtml).not.toContain('rel="preload"');
    expect(rebuilt.headHtml).not.toContain("onload=");
    expect(rebuilt.replacedDeferredLinks).toBe(1);
    expect(rebuilt.preservedDeferredLinks).toBe(0);
    expect(rebuilt.markup.split("\n").at(-1)).toBe(
      '<link rel="stylesheet" href="../deferred/dddd.css" />',
    );
    // One stylesheet link for the captured sheet plus one for the deferred entry.
    expect(findStylesheetLinks(rebuilt.headHtml)).toHaveLength(2);
  });

  it("keeps the id and media of a replaced deferred link, dropping only as/onload", () => {
    const href = "https://upscalehavens.ca/wp-content/et-cache/x-deferred.css?ver=1";
    const tag =
      "<link rel='preload' as='style' id='divi-dynamic-css' media='all' " +
      `href='${href}' onload="this.onload=null;this.rel='stylesheet'" />`;
    const deferred: Style = {
      href,
      localPath: "deferred/eeee.css",
      sha256: "e".repeat(64),
      order: 0,
      media: "all",
    };
    const page: Page = {
      url: "/x/",
      slug: "x",
      status: "publish",
      template: "",
      dom: { html: `<html><head>${tag}</head><body></body></html>` },
      styleOrder: [deferred.sha256],
    };
    const rebuilt = rebuildHead(tag, resolvePageCascade(page, indexStyles([deferred])), {
      dirDepth: 0,
      table: TABLE,
      cssFor: () => null,
    });
    expect(rebuilt.markup).toBe(
      "<link rel=\"stylesheet\" id='divi-dynamic-css' media='all' href=\"deferred/eeee.css\" />",
    );
  });

  it("wraps inline bytes and nothing else, which is the before-rewriting artifact", () => {
    const bytes = "@font-face{src:url(https://fonts.gstatic.com/s/inter/i.woff2)}";
    const entry: CascadeEntry = {
      order: 0,
      origin: "inline",
      sha256: INLINE_A.sha256,
      emittedPath: INLINE_A.localPath,
    };

    // With no table the bytes are emitted verbatim.
    const verbatim = rebuildHead("<head></head>".slice(6, 6), [entry], {
      dirDepth: 0,
      table: null,
      cssFor: () => bytes,
    });
    expect(verbatim.markup).toBe(`<style>${bytes}</style>`);

    // With the table, only the url() body moves.
    const rewritten = rebuildHead("", [entry], {
      dirDepth: 0,
      table: TABLE,
      cssFor: () => bytes,
    });
    expect(rewritten.markup).toBe(
      "<style>@font-face{src:url(external/fonts.gstatic.com/s/inter/i.woff2)}</style>",
    );
  });

  it("keeps the media attribute on an inline style", () => {
    const printStyle: Style = { ...INLINE_C, media: "print" };
    const rebuilt = rebuildHead(
      "",
      [
        {
          order: printStyle.order,
          origin: "inline",
          sha256: printStyle.sha256,
          emittedPath: printStyle.localPath,
          media: "print",
        },
      ],
      { dirDepth: 0, table: null, cssFor: () => "a{}" },
    );
    expect(rebuilt.markup).toBe('<style media="print">a{}</style>');
  });

  it("resolves the one shared sha256 by the page's own captured links", () => {
    // Captured fact: the inline `#et-critical-inline-css` block and the linked
    // `et-divi-customizer-global.min.css` are the same 977 bytes. No page loads both,
    // so the page's own dom decides which entry it is.
    const shared = "f".repeat(64);
    const inlineVersion: Style = {
      origin: "inline",
      localPath: `assets/inline/${shared}.css`,
      sha256: shared,
      order: 38,
    };
    const linkedVersion: Style = {
      href: "https://upscalehavens.ca/wp-content/et-cache/global/et-divi-customizer-global.min.css?ver=1",
      localPath: "wp-content/et-cache/global/et-divi-customizer-global.min.css",
      sha256: shared,
      order: 51,
    };
    const index = indexStyles([inlineVersion, linkedVersion]);

    const withoutHref: Page = { ...PAGE, dom: { html: "<head></head>" }, styleOrder: [shared] };
    expect(resolvePageCascade(withoutHref, index)[0]?.origin).toBe("inline");

    const withHref: Page = {
      ...PAGE,
      dom: {
        html: `<head><link rel="stylesheet" href="${linkedVersion.href}" /></head>`,
      },
      styleOrder: [shared],
    };
    expect(resolvePageCascade(withHref, index)[0]?.origin).toBe("linked");
  });

  it("refuses a page with no styleOrder instead of falling back to the site chain", () => {
    const page: Page = { ...PAGE };
    delete page.styleOrder;
    expect(() => resolvePageCascade(page, indexStyles([INLINE_A]))).toThrow(CascadeError);
  });

  it("refuses a styleOrder entry that resolves to nothing", () => {
    const page: Page = { ...PAGE, styleOrder: ["9".repeat(64)] };
    expect(() => resolvePageCascade(page, indexStyles([INLINE_A]))).toThrow(CascadeError);
  });

  it("fails, and does not warn, when the emitted sequence drifts from styleOrder", () => {
    const sequence = resolvePageCascade(PAGE, indexStyles([INLINE_A, LINKED_B, INLINE_C]));
    expect(() => assertSequenceMatchesCascade(PAGE, sequence)).not.toThrow();
    expect(() => assertSequenceMatchesCascade(PAGE, sequence.slice(0, 2))).toThrow(CascadeError);
    expect(() => assertSequenceMatchesCascade(PAGE, [...sequence].reverse())).toThrow(CascadeError);
  });

  it("adds a .css extension only where the captured path has none, in the same directory", () => {
    expect(emittedStylePath(LINKED_B)).toBe("wp-content/themes/x/site.css");
    expect(
      emittedStylePath({
        href: "https://fonts.googleapis.com/css?family=X",
        localPath: "external/fonts.googleapis.com/css-6722c894",
        sha256: "d".repeat(64),
        order: 11,
      }),
    ).toBe("external/fonts.googleapis.com/css-6722c894.css");
  });
});

// ---------------------------------------------------------------------------
// The committed capture: this module's real input
// ---------------------------------------------------------------------------

interface CapturedIr {
  pages: Page[];
  styles: Style[];
  site: { baseUrl: string };
}

const capture = JSON.parse(
  readFileSync(join(REPO_ROOT, "capture", "site-ir.json"), "utf8"),
) as CapturedIr;

describe("cascade rebuild against the committed capture", () => {
  it("finds the captured stylesheet links in every page and resolves every cascade", () => {
    const index = indexStyles(capture.styles);
    let linkedTags = 0;

    for (const page of capture.pages) {
      const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(page.dom.html)?.[1];
      expect(head, `${page.url} has a head`).toBeTypeOf("string");
      // Stylesheets *and* deferred preload links: both are CSS the page applies, and
      // both are managed by the rebuild once the cascade represents them.
      const links = findCascadeStyleLinks(head ?? "");
      linkedTags += links.length;

      const sequence = resolvePageCascade(page, index);
      assertSequenceMatchesCascade(page, sequence);
      // The chain's linked entries are exactly the sheets this page's head carried,
      // except the one deliberate exception (a page may load one of the two shared
      // 977-byte entries as the *inline* version).
      const sequenceLinks = sequence.filter((entry) => entry.origin === "linked");
      const missing = sequenceLinks.filter(
        (entry) => !links.some((link) => link.href === entry.href),
      );
      expect(missing.map((entry) => entry.href)).toEqual([]);
    }

    // 19 pages, 58 captured `link rel=stylesheet` tags and 18 captured deferred
    // `link rel=preload as=style` tags: 76 CSS link elements, none of them unaccounted
    // for by the page's cascade.
    expect(linkedTags).toBe(76);
  });
});
