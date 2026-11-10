/**
 * DOM normalisation fidelity tests — the invariant this bead lives or dies on.
 *
 * Three real pages recorded from `upscalehavens.ca` (front page, `/tmh/apply/`,
 * `/care/`) are normalised, then re-parsed with **parse5** — an independent,
 * spec-compliant HTML parser — and compared against the same page parsed from the
 * raw bytes with the same removals applied *as a tree operation*.
 *
 * Two independent mechanisms agreeing is the point:
 *
 *  - the normaliser cuts ranges out of a **string** (so surviving bytes cannot move);
 *  - the test prunes nodes from a **tree** (so nesting and class attributes are
 *    checked by a parser, not by the code under test).
 *
 * If the string surgery ever moved a byte, split a tag, or dropped a class from a
 * surviving element, these tests fail. A normaliser that changes the tree is a bug,
 * so there is no "acceptable" tolerance here: the trees must be deep-equal.
 *
 * Nothing in this file touches the network. The fixtures are committed recordings
 * taken with `PoliteFetcher` (600 ms serialised, robots-aware).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse, serialize } from "parse5";
import { describe, expect, it } from "vitest";

import {
  classAttributeValues,
  decodeEntities,
  isOrderedSubsequence,
  normaliseDocument,
  parseTagAttributes,
  summariseStripped,
  textFromHtml,
} from "../src/source/wp-rest/dom.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "wp-rest", "pages");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const PAGES = {
  home: fixture("home.html"),
  apply: fixture("tmh-apply.html"),
  care: fixture("care.html"),
} as const;

/** A minimal structural view of a parse5 node, so the tests own their own shape. */
interface TreeNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: TreeNode[];
}

const asTree = (html: string): TreeNode => parse(html) as unknown as TreeNode;

function attribute(node: TreeNode, name: string): string | null {
  return node.attrs?.find((entry) => entry.name === name)?.value ?? null;
}

/** The analytics/telemetry hosts the normaliser is allowed to delete. */
const TELEMETRY =
  /google-analytics\.com|googletagmanager\.com|connect\.facebook\.net|facebook\.com\/tr\b|stats?\.wp\.com|pixel\.wp\.com|doubleclick\.net|hotjar\.com|clarity\.ms|bat\.bing\.com|snap\.licdn\.com|ct\.pinterest\.com|analytics\.tiktok\.com|cdn\.segment\.com|matomo|piwik/i;

const RESOURCE_HINTS = new Set(["preconnect", "dns-prefetch", "prefetch", "prerender"]);

/**
 * The expected transformation, expressed on the tree: remove scripts, styles,
 * comments, the admin bar and telemetry nodes. Deliberately written independently
 * of `dom.ts` so agreement means something.
 */
function prune(node: TreeNode): TreeNode | null {
  if (node.nodeName === "#comment") return null;
  const isElement = node.tagName !== undefined;
  if (isElement && (node.tagName === "script" || node.tagName === "style")) return null;
  if (isElement && attribute(node, "id") === "wpadminbar") return null;

  if (
    isElement &&
    (node.tagName === "img" || node.tagName === "link" || node.tagName === "iframe")
  ) {
    const url = attribute(node, "src") ?? attribute(node, "href") ?? "";
    const rels = new Set((attribute(node, "rel") ?? "").toLowerCase().split(/\s+/));
    const isHint = node.tagName === "link" && [...rels].some((rel) => RESOURCE_HINTS.has(rel));
    const isStylesheet = node.tagName === "link" && rels.has("stylesheet");
    if (TELEMETRY.test(url) && !isStylesheet && (node.tagName !== "link" || isHint)) return null;
  }

  if (node.childNodes === undefined) return { ...node };
  const children = node.childNodes.flatMap((child) => {
    const kept = prune(child);
    return kept === null ? [] : [kept];
  });
  // Removing a node between two text nodes leaves them adjacent; the browser (and
  // the normalised string) sees one text run, so the expected tree merges them.
  const merged: TreeNode[] = [];
  for (const child of children) {
    const last = merged.at(-1);
    if (
      child.nodeName === "#text" &&
      last !== undefined &&
      last.nodeName === "#text" &&
      last.value !== undefined &&
      child.value !== undefined
    ) {
      merged[merged.length - 1] = { ...last, value: last.value + child.value };
      continue;
    }
    merged.push(child);
  }
  return { ...node, childNodes: merged };
}

/** Deep structure: node name, tag, every attribute in order, and text exactly. */
function shape(node: TreeNode): unknown {
  return {
    nodeName: node.nodeName,
    tagName: node.tagName ?? null,
    attrs: node.attrs?.map((entry) => `${entry.name}=${entry.value}`) ?? null,
    value: node.value ?? null,
    children: node.childNodes?.map(shape) ?? null,
  };
}

/** Ordered `[tag, class]` pairs — the class list under test. */
function classPairs(node: TreeNode, into: [string, string][] = []): [string, string][] {
  if (node.tagName !== undefined) {
    into.push([node.tagName, attribute(node, "class") ?? ""]);
  }
  for (const child of node.childNodes ?? []) classPairs(child, into);
  return into;
}

/** Concatenated text nodes, with no whitespace normalisation at all. */
function textOf(node: TreeNode, into: string[] = []): string {
  if (node.nodeName === "#text" && node.value !== undefined) into.push(node.value);
  for (const child of node.childNodes ?? []) textOf(child, into);
  return into.join("");
}

/** The `<html>…</html>` region of a raw page, re-derived here on purpose. */
function documentRegion(raw: string): string {
  const html = raw.replace(/\r\n?/g, "\n");
  const open = /<html\b[^>]*>/i.exec(html);
  const close = html.toLowerCase().lastIndexOf("</html");
  if (open === null || close < open.index)
    throw new Error("fixture has no complete <html> element");
  return html.slice(open.index, html.indexOf(">", close) + 1);
}

describe.each(Object.entries(PAGES))("fidelity invariant — %s", (_name, raw) => {
  const normalised = normaliseDocument(raw);
  /** What the page must look like once the removable nodes are gone. */
  const expectedTree = (): TreeNode => {
    const pruned = prune(asTree(`${normalised.doctype ?? ""}${documentRegion(raw)}`));
    if (pruned === null) throw new Error("pruned tree was empty");
    return pruned;
  };
  const actualTree = (): TreeNode => asTree(`${normalised.doctype ?? ""}${normalised.html}`);

  it("re-parses to exactly the pruned input tree (element tree + class list identical)", () => {
    expect(shape(actualTree())).toEqual(shape(expectedTree()));
  });

  it("preserves every surviving class attribute byte-for-byte and in order", () => {
    expect(classPairs(actualTree())).toEqual(classPairs(expectedTree()));
    // Sanity: the page really does carry classes, so this is not a vacuous pass.
    expect(classPairs(actualTree()).length).toBeGreaterThan(100);
  });

  it("preserves every surviving text node byte-for-byte (no whitespace collapsing)", () => {
    expect(textOf(actualTree())).toEqual(textOf(expectedTree()));
  });

  it("round-trips: re-rendering the skeleton yields an identical tree", () => {
    const first = actualTree();
    const rendered = serialize(first as never);
    const second = asTree(rendered);
    expect(shape(second)).toEqual(shape(first));
    expect(classPairs(second)).toEqual(classPairs(first));
  });

  it("leaves no script, style or comment behind", () => {
    expect(normalised.html).not.toMatch(/<script\b/i);
    expect(normalised.html).not.toMatch(/<style\b/i);
    expect(normalised.html).not.toMatch(/<!--/);
  });

  it("accounts for every removed byte", () => {
    const doctypeBytes = normalised.doctype?.length ?? 0;
    const documentBytes =
      normalised.inputBytes -
      doctypeBytes -
      normalised.outsideDocument.before -
      normalised.outsideDocument.after;
    const removedBytes = normalised.stripped.reduce((total, node) => total + node.bytes, 0);
    expect(documentBytes - normalised.outputBytes).toBe(removedBytes);
  });

  it("keeps every stylesheet link as captured (B1.3's input)", () => {
    const rawLinks = [
      ...documentRegion(raw).matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi),
    ];
    const outLinks = [...normalised.html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)];
    expect(outLinks.map((match) => match[0])).toEqual(rawLinks.map((match) => match[0]));
    expect(rawLinks.length).toBeGreaterThan(0);
  });
});

describe("Divi/WordPress specifics", () => {
  it("removes Divi's inline critical CSS and records its hash so recovery can be proven", () => {
    const normalised = normaliseDocument(PAGES.home);
    const styles = normalised.stripped.filter((node) => node.kind === "style");
    // Divi 4 inlines the theme, critical CSS and global styles on every page.
    expect(styles.length).toBeGreaterThanOrEqual(3);
    for (const style of styles) {
      expect(style.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(style.bytes).toBeGreaterThan(0);
      expect(style.detail.length).toBeGreaterThan(0);
    }
  });

  it("strips Divi's closing markers and reports the cache stamp as outside the document", () => {
    const normalised = normaliseDocument(PAGES.home);
    const comments = normalised.stripped.filter((node) => node.kind === "comment");
    expect(comments.some((node) => /#main-header|\.container/.test(node.detail))).toBe(true);
    // LiteSpeed appends its stamp *after* `</html>`, so it never reaches dom.html.
    expect(normalised.stripped.some((node) => /LiteSpeed/.test(node.detail))).toBe(false);
    expect(normalised.outsideDocument.after).toBeGreaterThan(0);
  });

  it("does not report an admin bar on an anonymous page (the selector only lives in CSS)", () => {
    const normalised = normaliseDocument(PAGES.home);
    expect(normalised.stripped.some((node) => node.kind === "admin-bar")).toBe(false);
  });

  it("summarises what it removed, per kind", () => {
    const summary = summariseStripped(normaliseDocument(PAGES.home).stripped);
    expect(summary).toMatch(/script/);
    expect(summary).toMatch(/style/);
    expect(summary).toMatch(/comment/);
  });
});

describe("normaliser edge cases", () => {
  it("removes a nested admin bar and its body class without touching other divs", () => {
    const raw = [
      "<!DOCTYPE html>",
      '<html lang="en-US" class="wp-toolbar x">',
      '<body class="admin-bar home wp-theme">',
      '<div id="wpadminbar" class="nojq nojs"><div class="quicklinks"><div id="wp-toolbar">bar</div></div></div>',
      '<div class="keep"><p class="a">content</p></div>',
      "</body></html>",
    ].join("\n");
    const normalised = normaliseDocument(raw);
    expect(normalised.html).not.toContain("wpadminbar");
    expect(normalised.html).not.toContain("bar</div>");
    expect(normalised.html).toContain('<div class="keep"><p class="a">content</p></div>');
    expect(normalised.html).toContain('<html lang="en-US" class="x">');
    expect(normalised.html).toContain('<body class="home wp-theme">');
    const adminBar = normalised.stripped.filter((node) => node.kind === "admin-bar");
    expect(adminBar.filter((node) => node.detail === "#wpadminbar")).toHaveLength(1);
    expect(adminBar.filter((node) => /class> token/.test(node.detail))).toHaveLength(2);
  });

  it("keeps IE conditional comments and removes ordinary ones", () => {
    const raw = `<html><body><!--[if IE]><p class="ie">x</p><![endif]--><!-- drop me --><p>y</p></body></html>`;
    const normalised = normaliseDocument(raw);
    expect(normalised.html).toContain("[if IE]");
    expect(normalised.html).not.toContain("drop me");
  });

  it("drops telemetry pixels and resource hints but never a stylesheet", () => {
    const raw = [
      "<html><head>",
      '<link rel="preconnect" href="https://www.google-analytics.com">',
      '<link rel="stylesheet" href="https://example.com/a.css">',
      "</head><body>",
      '<img src="https://www.facebook.com/tr?id=1" width="1" height="1">',
      '<img src="/wp-content/uploads/real.png" alt="real">',
      '<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-1"></iframe>',
      "</body></html>",
    ].join("");
    const normalised = normaliseDocument(raw);
    expect(normalised.html).not.toContain("google-analytics");
    expect(normalised.html).not.toContain("facebook.com/tr");
    expect(normalised.html).not.toContain("googletagmanager");
    expect(normalised.html).toContain("https://example.com/a.css");
    expect(normalised.html).toContain("real.png");
    expect(normalised.stripped.filter((node) => node.kind === "telemetry")).toHaveLength(3);
  });

  it("treats an unclosed <script> the way a browser does: the rest is script text", () => {
    const raw = "<html><body><p>before</p><script>var x = 1; <p>not markup</p></body></html>";
    const normalised = normaliseDocument(raw);
    expect(normalised.html).toContain("<p>before</p>");
    expect(normalised.html).not.toContain("not markup");
    expect(normalised.notes.some((note) => /unclosed <script>/.test(note))).toBe(true);
  });

  it("normalises CRLF while leaving inter-element whitespace alone", () => {
    const raw = "<html><body>\r\n<span>a</span> <span>b</span>\r\n\r\n<span>c</span></body></html>";
    const normalised = normaliseDocument(raw);
    expect(normalised.html).toContain("<span>a</span> <span>b</span>\n\n<span>c</span>");
  });

  it("captures a page with no </html> rather than emitting nothing", () => {
    const normalised = normaliseDocument("<html><body><p>truncated");
    expect(normalised.html).toContain("<p>truncated");
    expect(normalised.notes.some((note) => /no complete <html>/.test(note))).toBe(true);
  });
});

describe("attribute and entity helpers", () => {
  it("parses attributes in any order, any quoting, and unquoted values", () => {
    expect(parseTagAttributes('<meta content="a b" name=description>')).toEqual({
      content: "a b",
      name: "description",
    });
    expect(parseTagAttributes("<link rel='stylesheet' href='/x.css' media>")).toEqual({
      rel: "stylesheet",
      href: "/x.css",
      media: "",
    });
  });

  it("decodes the entities WordPress emits", () => {
    expect(decodeEntities("Tom &amp; Jerry &#8211; &#x27;quoted&#x27; &nbsp;")).toBe(
      "Tom & Jerry \u2013 'quoted' \u00a0",
    );
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });

  it("reduces markup to visible text", () => {
    expect(textFromHtml("<p>Hello   <strong>world</strong></p>")).toBe("Hello world");
  });

  it("recognises an ordered subsequence, which is what class preservation means", () => {
    expect(isOrderedSubsequence(["a", "c"], ["a", "b", "c"])).toBe(true);
    expect(isOrderedSubsequence(["c", "a"], ["a", "b", "c"])).toBe(false);
    expect(isOrderedSubsequence(["a", "d"], ["a", "b", "c"])).toBe(false);
  });

  it("reads class attributes without splitting or trimming them", () => {
    expect(classAttributeValues("<p class=\"a  b\"><span class='c'>")).toEqual(["a  b", "c"]);
  });
});
