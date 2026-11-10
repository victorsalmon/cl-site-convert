/**
 * B5.1 — the permitted-difference matrix, as a unit contract.
 *
 * `body-tree` is only credible if its permitted set is exact: too permissive and a
 * drift passes, too strict and the gate is red for the emitter's documented
 * transforms. These cases pin both halves without an emit, so a change to the matrix
 * fails here in milliseconds rather than after a 30-second build.
 */

import { describe, expect, it } from "vitest";

import { buildRewriteTable } from "../src/emit/static-html/rewrite.js";
import type { RewriteTable } from "../src/emit/static-html/rewrite.js";
import { findElement, parseDocument, type HtmlNode } from "../src/verify/parity/dom.js";
import { compareTrees } from "../src/verify/parity/tree.js";
import type { TreeRules } from "../src/verify/parity/tree.js";

const ORIGIN = "https://upscalehavens.ca";
const BASE_URL = "https://site.upscalehavens.ca";
const FORM_SINK = "/api/submit";

const TABLE: RewriteTable = buildRewriteTable(
  {
    baseUrl: ORIGIN,
    version: 1,
    rewrite: {
      [`${ORIGIN}/wp-content/uploads/a.jpg`]: "wp-content/uploads/a.jpg",
      [`${ORIGIN}/wp-content/uploads/b.jpg`]: "wp-content/uploads/b.jpg",
      [`${ORIGIN}/wp-content/uploads/logo.png`]: "wp-content/uploads/logo.png",
    },
  },
  "test map",
);

const RULES: TreeRules = {
  page: "/care/",
  check: "body-tree",
  dirDepth: 1,
  sourceOrigin: ORIGIN,
  baseUrl: BASE_URL,
  formSink: FORM_SINK,
  routes: new Set(["/care/", "/tmh/"]),
  table: TABLE,
};

/** Parse a document and return the `<body>` (or `<head>`) element. */
function elementOf(markup: string, container: "body" | "head" = "body"): HtmlNode {
  const document = parseDocument(`<html><head></head><body>${markup}</body></html>`);
  const found = findElement(document, container);
  if (found === null) throw new Error(`no <${container}> in the fixture`);
  return found;
}

/** Compare a captured body snippet against an emitted one. */
function compare(captured: string, emitted: string) {
  return compareTrees(elementOf(captured), elementOf(emitted), RULES);
}

describe("permitted differences", () => {
  it("allows an asset reference re-pointed through the rewrite map", () => {
    const result = compare(
      `<img src="${ORIGIN}/wp-content/uploads/a.jpg" alt="a" />`,
      `<img src="../wp-content/uploads/a.jpg" alt="a" />`,
    );
    expect(result.difference).toBeNull();
    expect(result.rewrites.asset).toBe(1);
  });

  it("allows every srcset candidate the map knows, and keeps their descriptors", () => {
    const result = compare(
      `<img srcset="${ORIGIN}/wp-content/uploads/a.jpg 1x, ${ORIGIN}/wp-content/uploads/b.jpg 2x" />`,
      `<img srcset="../wp-content/uploads/a.jpg 1x, ../wp-content/uploads/b.jpg 2x" />`,
    );
    expect(result.difference).toBeNull();
    expect(result.rewrites.asset).toBe(1);
  });

  it("allows navigation to a captured route", () => {
    const result = compare(`<a href="${ORIGIN}/care/">care</a>`, `<a href="/care/">care</a>`);
    expect(result.difference).toBeNull();
    expect(result.rewrites.navigation).toBe(1);
  });

  it("allows a source-host path that is not a route, as an internal path", () => {
    const result = compare(`<a href="${ORIGIN}/feed/">feed</a>`, `<a href="/feed/">feed</a>`);
    expect(result.difference).toBeNull();
    expect(result.rewrites["internal-path"]).toBe(1);
  });

  it("allows a form action pointing at the configured sink", () => {
    const result = compare(
      `<form method="get" action="${ORIGIN}/"><input name="s" /></form>`,
      `<form method="get" action="${FORM_SINK}"><input name="s" /></form>`,
    );
    expect(result.difference).toBeNull();
    expect(result.rewrites["form-sink"]).toBe(1);
  });

  it("allows a canonical kept absolute on the target's own base url", () => {
    const result = compare(
      `<link rel="canonical" href="${ORIGIN}/care/" />`,
      `<link rel="canonical" href="${BASE_URL}/care/" />`,
    );
    expect(result.difference).toBeNull();
    expect(result.rewrites.canonical).toBe(1);
  });

  it("allows a meta tile image localised through the map", () => {
    const result = compare(
      `<meta name="msapplication-TileImage" content="${ORIGIN}/wp-content/uploads/logo.png" />`,
      `<meta name="msapplication-TileImage" content="../wp-content/uploads/logo.png" />`,
    );
    expect(result.difference).toBeNull();
    expect(result.rewrites["meta-asset"]).toBe(1);
  });

  it("allows a linked asset reference re-pointed through the map", () => {
    const result = compare(
      `<link rel="icon" href="${ORIGIN}/wp-content/uploads/logo.png" />`,
      `<link rel="icon" href="../wp-content/uploads/logo.png" />`,
    );
    expect(result.difference).toBeNull();
    expect(result.rewrites.asset).toBe(1);
  });

  it("compares the <head> too, when the cascade block is excluded", () => {
    const result = compareTrees(
      elementOf("<title>x</title>", "head"),
      elementOf("<title>x</title>", "head"),
      {
        ...RULES,
        check: "head-tree",
      },
    );
    expect(result.difference).toBeNull();
  });
});

describe("rejected differences", () => {
  it("rejects an asset path the map does not prescribe", () => {
    const result = compare(
      `<img src="${ORIGIN}/wp-content/uploads/a.jpg" />`,
      `<img src="../wp-content/uploads/b.jpg" />`,
    );
    expect(result.difference?.check).toBe("body-tree");
    expect(result.difference?.message).toMatch(/expected the mapped path/);
  });

  it("rejects a rewritten srcset descriptor", () => {
    const result = compare(
      `<img srcset="${ORIGIN}/wp-content/uploads/a.jpg 1x" />`,
      `<img srcset="../wp-content/uploads/a.jpg 2x" />`,
    );
    expect(result.difference?.message).toMatch(/descriptor changed/);
  });

  it("rejects a self-reference left absolute", () => {
    const result = compare(
      `<a href="${ORIGIN}/care/">care</a>`,
      `<a href="${ORIGIN}/care/">care</a>`,
    );
    // Unchanged is fine: the residual allowlist is what rejects a survivor, not the
    // tree comparison. This case proves the comparator does not silently normalise.
    expect(result.difference).toBeNull();

    const wrong = compare(`<a href="${ORIGIN}/care/">care</a>`, `<a href="/wrong/">care</a>`);
    expect(wrong.difference?.message).toMatch(/site-root-relative form/);
  });

  it("rejects a form action that is not the configured sink", () => {
    const result = compare(
      `<form action="${ORIGIN}/"></form>`,
      `<form action="${ORIGIN}/wp-json/"></form>`,
    );
    expect(result.difference?.message).toMatch(/configured sink/);
  });

  it("rejects a canonical on the wrong origin", () => {
    const result = compare(
      `<link rel="canonical" href="${ORIGIN}/care/" />`,
      `<link rel="canonical" href="${ORIGIN}/tmh/" />`,
    );
    expect(result.difference?.message).toMatch(/expected the canonical/);
  });

  it("rejects a meta image the map cannot explain", () => {
    const result = compare(
      `<meta name="msapplication-TileImage" content="${ORIGIN}/wp-content/uploads/a.jpg" />`,
      `<meta name="msapplication-TileImage" content="/somewhere.png" />`,
    );
    expect(result.difference?.message).toMatch(/mapped path/);
  });

  it("rejects one class name changed", () => {
    const result = compare(
      `<div class="et_pb_section et_pb_section_1"></div>`,
      `<div class="et_pb_section et_pb_section_2"></div>`,
    );
    expect(result.difference?.message).toBe("class list differs");
    expect(result.difference?.expected).toBe("et_pb_section et_pb_section_1");
  });

  it("rejects an attribute added, removed or reordered", () => {
    expect(
      compare(`<div id="a" class="b"></div>`, `<div class="b" id="a"></div>`).difference?.message,
    ).toMatch(/attribute names or their order/);
    expect(
      compare(`<div class="b"></div>`, `<div class="b" data-x="1"></div>`).difference?.message,
    ).toMatch(/attribute names or their order/);
  });

  it("rejects a changed text node", () => {
    const result = compare(`<p>Upscale Havens</p>`, `<p>Upscale Haven</p>`);
    expect(result.difference?.message).toBe("text node differs");
    expect(result.difference?.path).toContain("p");
  });

  it("rejects a changed tag", () => {
    const result = compare(`<p>x</p>`, `<div>x</div>`);
    expect(result.difference?.message).toBe("element tag differs");
  });

  it("rejects an added or removed node", () => {
    const added = compare(`<div><p>x</p></div>`, `<div><p>x</p><p>y</p></div>`);
    expect(added.difference?.message).toMatch(/child count differs/);
    expect(added.difference?.path).toContain("div");
  });

  it("rejects a change to an attribute no rule covers", () => {
    const result = compare(`<div title="a"></div>`, `<div title="b"></div>`);
    expect(result.difference?.message).toMatch(/not an attribute emission may rewrite/);
  });

  it("reports the first difference with a readable node path, not a node count", () => {
    const result = compare(
      `<div id="outer"><section class="a"><p>one</p></section></div>`,
      `<div id="outer"><section class="b"><p>one</p></section></div>`,
    );
    expect(result.difference?.path).toBe("html > body > div#outer > section.a");
    expect(result.nodesCompared).toBeGreaterThan(1);
  });
});
