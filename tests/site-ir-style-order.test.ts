/**
 * P1.7 — per-page cascade in the Site IR.
 *
 * Measured problem: the 19 captured pages have 18 distinct style chains (7 entries
 * at `/resources/`, 17 at `/ush/privacy-policy/`), while `styles[].order` is one
 * **site-level** sequence. A single site chain therefore cannot say what a page
 * loads, or in what order, and an emitter that sorted by `styles[].order` would
 * emit CSS the page never had.
 *
 * The fix is `page.styleOrder`: an ordered list of `sha256` values resolving to
 * `styles[]`. This test proves the committed artifact carries it for every page and
 * that each list is the captured chain — `capture/style-chain.json`'s `pages[]`
 * filtered to the page and sorted by its `order` — not a re-derivation, a guess, or
 * the site sequence.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

interface ChainEntry {
  order: number;
  origin: "linked" | "inline";
  sha256: string;
  localPath: string;
  href?: string;
  pages: string[];
}

interface IrStyle {
  order: number;
  origin?: "linked" | "inline";
  sha256: string;
  localPath: string;
  href?: string;
}

interface IrPage {
  url: string;
  styleOrder?: string[];
}

interface Ir {
  irVersion: string;
  pages: IrPage[];
  styles: IrStyle[];
}

const chain = JSON.parse(readFileSync(join(REPO_ROOT, "capture", "style-chain.json"), "utf8")) as {
  styleChain: ChainEntry[];
};
const ir = JSON.parse(readFileSync(join(REPO_ROOT, "capture", "site-ir.json"), "utf8")) as Ir;

/** The captured cascade for one route: its chain entries, in document order. */
function capturedChain(url: string): ChainEntry[] {
  return chain.styleChain
    .filter((entry) => entry.pages.includes(url))
    .sort((left, right) => left.order - right.order);
}

function page(url: string): IrPage {
  const found = ir.pages.find((candidate) => candidate.url === url);
  if (found === undefined) throw new Error(`the IR has no page ${url}`);
  return found;
}

function styleOrderOf(url: string): string[] {
  const order = page(url).styleOrder;
  if (order === undefined) throw new Error(`page ${url} carries no styleOrder`);
  return order;
}

/** Every page url the capture measured, with the chain length it was captured at. */
const MEASURED_CHAIN_LENGTHS: Record<string, number> = {
  "/": 8,
  "/care/": 9,
  "/care/showings/": 8,
  "/care/signal-admin/": 10,
  "/care/sweepy-admin/": 10,
  "/care/ttlock-admin/": 10,
  "/mlm/": 10,
  "/mlm/applym/": 11,
  "/mlm/onboard-mlm/": 9,
  "/resources/": 7,
  "/resources/checklists/": 8,
  "/resources/sweepy/": 8,
  "/tmh/": 10,
  "/tmh/apply/": 14,
  "/tmh/offboard/": 9,
  "/tmh/onboard-tmh/": 9,
  "/ush/owner/": 16,
  "/ush/privacy-policy/": 17,
  "/ush/thanks/": 9,
};

describe("per-page style order in the captured IR", () => {
  it("projects the whole chain, not just the linked stylesheets", () => {
    const inline = ir.styles.filter((style) => style.origin === "inline");
    const linked = ir.styles.filter((style) => style.origin !== "inline");

    expect(ir.irVersion).toBe("1.1.0");
    expect(ir.styles).toHaveLength(chain.styleChain.length);
    expect(ir.styles).toHaveLength(73);
    // 7 sheets captured by B1.3 plus 18 Divi deferred sheets captured by mzi.
    expect(linked).toHaveLength(25);
    // 116 captured inline blocks, deduplicated by sha256 to 48 distinct files.
    expect(inline).toHaveLength(48);
    expect(new Set(inline.map((style) => style.sha256)).size).toBe(48);

    // `styles[].order` stays the site-level chain index: 0..72, no gaps, no repeats.
    expect(ir.styles.map((style) => style.order)).toEqual(
      Array.from({ length: 73 }, (_, index) => index),
    );

    for (const style of inline) {
      expect(style.href, "inline CSS has no url").toBeUndefined();
      expect(style.localPath, "the bytes still land somewhere").toBeTruthy();
      expect(style.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const style of linked) {
      expect(style.href, "a linked style keeps its url").toBeTruthy();
      expect(style.localPath).toBeTruthy();
    }
  });

  it("carries a cascade for all 19 pages, and the 19 pages have 18 distinct chains", () => {
    expect(ir.pages).toHaveLength(19);
    for (const candidate of ir.pages) {
      expect(Array.isArray(candidate.styleOrder), `${candidate.url} styleOrder`).toBe(true);
    }
    const distinct = new Set(ir.pages.map((candidate) => (candidate.styleOrder ?? []).join(",")));
    expect(distinct.size).toBe(18);
  });

  it("matches the measured chain length of every captured page", () => {
    const lengths = Object.fromEntries(
      ir.pages.map((candidate) => [candidate.url, (candidate.styleOrder ?? []).length]),
    );
    expect(lengths).toEqual(MEASURED_CHAIN_LENGTHS);
  });

  it("derives every cascade from the chain's pages[] and order", () => {
    for (const candidate of ir.pages) {
      const expected = capturedChain(candidate.url).map((entry) => entry.sha256);
      expect(expected.length, `${candidate.url} has no captured chain`).toBeGreaterThan(0);
      expect(candidate.styleOrder, `${candidate.url} order`).toEqual(expected);
    }
  });

  it("resolves every styleOrder sha256 to a styles[] entry", () => {
    const known = new Set(ir.styles.map((style) => style.sha256));
    for (const candidate of ir.pages) {
      for (const sha256 of candidate.styleOrder ?? []) {
        expect(known.has(sha256), `${candidate.url} references ${sha256}`).toBe(true);
      }
    }
  });

  it("distinguishes two pages whose chains genuinely differ", () => {
    const resources = styleOrderOf("/resources/");
    const privacy = styleOrderOf("/ush/privacy-policy/");

    expect(resources).toHaveLength(7);
    expect(privacy).toHaveLength(17);
    expect(resources).not.toEqual(privacy);

    // The privacy page does not open with `#global-styles-inline-css`, so the
    // difference is real rather than a length difference. Four entries are shared.
    expect(resources[0]).not.toBe(privacy[0]);
    expect(resources.filter((sha256) => privacy.includes(sha256))).toHaveLength(4);
  });

  it("orders `/` and `/care/` exactly as the captured documents did", () => {
    const byOrder = new Map(chain.styleChain.map((entry) => [entry.order, entry]));
    const shaAt = (order: number): string => {
      const entry = byOrder.get(order);
      if (entry === undefined) throw new Error(`the chain has no entry ${order}`);
      return entry.sha256;
    };

    const home = capturedChain("/");
    const care = capturedChain("/care/");

    expect(styleOrderOf("/")).toEqual(home.map((entry) => shaAt(entry.order)));
    expect(styleOrderOf("/care/")).toEqual(care.map((entry) => shaAt(entry.order)));

    // Both pages start with the same site-level prefix; the Divi dynamic-critical
    // block and the font subset differ, which is exactly what the site chain loses.
    // `/care/` also gained its deferred sheet, and it is measured last, not appended
    // by accident: the live document put it after every other style element.
    expect(home.map((entry) => entry.order)).not.toEqual(care.map((entry) => entry.order));
    expect(styleOrderOf("/")).not.toEqual(styleOrderOf("/care/"));
    expect(care).toHaveLength(9);
    expect(care.at(-1)?.origin).toBe("linked");
  });

  it("never emits the site sequence as a page cascade", () => {
    // The failure mode this bead closes: an emitter sorting the site chain would
    // give every page all 73 entries.
    const siteSequence = ir.styles.map((style) => style.sha256);
    expect(ir.styles).toHaveLength(73);
    for (const candidate of ir.pages) {
      expect(candidate.styleOrder).not.toEqual(siteSequence);
    }
  });

  it("keeps per-page resolution unambiguous despite entries sharing a sha256", () => {
    // Captured data, reported rather than hidden. Four payloads are shared by more
    // than one entry: the inline `#et-critical-inline-css` and the linked
    // `et-divi-customizer-global.min.css` (977 bytes), a 159-byte deferred sheet three
    // pages share, a 23872-byte deferred sheet two pages share, and a 2092-byte
    // deferred sheet five pages share plus the inline block with the same bytes.
    // `styles[]` therefore holds 73 entries but only 64 distinct hashes. No page loads
    // both halves of a collision, so a sha256 still names exactly one entry within any
    // one page.
    const bySha = new Map<string, IrStyle[]>();
    for (const style of ir.styles) {
      const bucket = bySha.get(style.sha256) ?? [];
      bucket.push(style);
      bySha.set(style.sha256, bucket);
    }
    const collisions = [...bySha.entries()].filter(([, styles]) => styles.length > 1);
    expect(collisions).toHaveLength(4);
    expect(bySha.size).toBe(64);

    const collisionSizes = collisions.map(([, styles]) => styles.length).sort((a, b) => a - b);
    expect(collisionSizes).toEqual([2, 2, 3, 6]);

    // The real invariant: within one page's cascade, a hash names one entry.
    for (const candidate of ir.pages) {
      const order = candidate.styleOrder ?? [];
      expect(new Set(order).size, `${candidate.url} loads a hash twice`).toBe(order.length);
      for (const [sharedSha, sharingStyles] of collisions) {
        const occurrences = capturedChain(candidate.url).filter(
          (entry) => entry.sha256 === sharedSha,
        );
        expect(
          occurrences.length,
          `${candidate.url} loads the shared hash from ${sharingStyles.length} entries`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });
});
