/**
 * Deferred-CSS capture (bead `cl-site-convert-mzi`) — the artifacts and the rules.
 *
 * Three things are proved here, none of them by asking the capture code what the
 * answer should be:
 *
 *  - the pure scanner reads a head's style elements in document order and names the
 *    three kinds distinctly;
 *  - every deferred chain entry has bytes on disk whose sha256 is its file name;
 *  - the recorded position of each deferred sheet is the index it actually occupies
 *    in that page's `styleOrder` — and at least some of them are mid-cascade, which is
 *    the evidence that they were placed rather than appended.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  chainIdentity,
  documentStyleElements,
  isDeferredStyleLink,
} from "../src/source/wp-rest/deferred-css.js";
import type { DeferredCssReport } from "../src/source/wp-rest/deferred-css.js";
import type { ChainEntry, StyleChain } from "../src/source/wp-rest/assets.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const ORIGIN = "https://upscalehavens.ca";

interface IrPage {
  url: string;
  styleOrder?: string[];
}

const ir = JSON.parse(readFileSync(join(REPO_ROOT, "capture", "site-ir.json"), "utf8")) as {
  pages: IrPage[];
  styles: { order: number; origin?: string; sha256: string; localPath: string; href?: string }[];
};
const chain = JSON.parse(
  readFileSync(join(REPO_ROOT, "capture", "style-chain.json"), "utf8"),
) as StyleChain;
const report = JSON.parse(
  readFileSync(join(REPO_ROOT, "capture", "deferred-css.capture-report.json"), "utf8"),
) as DeferredCssReport;

const DEFERRED = chain.styleChain.filter((entry) => entry.localPath.startsWith("deferred/"));

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("document style scan", () => {
  const head = [
    "<style id='a'>body{color:red}</style>",
    "<link rel='stylesheet' id='b' href='https://upscalehavens.ca/wp-content/x.css' media='all' />",
    "<style id='c'>p{margin:0}</style>",
    "<link rel='preload' as='style' id='d' href='https://upscalehavens.ca/wp-content/et-cache/1/d-deferred.css?ver=2' onload=\"this.rel='stylesheet'\" />",
    "<link rel='stylesheet' id='e' href='https://fonts.googleapis.com/css?family=X' />",
  ].join("\n");

  it("reads linked, inline and deferred elements in document order", () => {
    const elements = documentStyleElements(head, "/care/", ORIGIN);
    expect(elements.map((element) => element.kind)).toEqual([
      "inline",
      "linked",
      "inline",
      "deferred",
      "linked",
    ]);
    expect(elements.map((element) => element.start)).toEqual(
      [...elements.map((element) => element.start)].sort((left, right) => left - right),
    );
  });

  it("keys every element the way the chain does", () => {
    const elements = documentStyleElements(head, "/care/", ORIGIN);
    const linked = elements.filter((element) => element.kind === "linked");
    expect(linked[0]?.key).toBe("linked:https://upscalehavens.ca/wp-content/x.css|all");
    // A table-less third-party stylesheet is still named by its captured href.
    expect(linked[1]?.key).toBe("linked:https://fonts.googleapis.com/css?family=X|");
    // A deferred element keeps its href verbatim, entities and query included.
    const deferred = elements.find((element) => element.kind === "deferred");
    expect(deferred?.href).toBe(
      "https://upscalehavens.ca/wp-content/et-cache/1/d-deferred.css?ver=2",
    );
    expect(deferred?.tag).toContain("rel='preload'");
    // The inline key is the hash of the payload, not of the element.
    const inline = elements.filter((element) => element.kind === "inline");
    const first = inline[0]?.sha256 ?? "";
    expect(first).toBe(createHash("sha256").update("body{color:red}").digest("hex"));
  });

  it("recognises the deferred form and nothing that only looks similar", () => {
    expect(isDeferredStyleLink({ rel: "preload", as: "style" })).toBe(true);
    expect(isDeferredStyleLink({ rel: "Preload", as: "STYLE" })).toBe(true);
    expect(isDeferredStyleLink({ rel: "preload", as: "script" })).toBe(false);
    expect(isDeferredStyleLink({ rel: "preload" })).toBe(false);
    expect(isDeferredStyleLink({ rel: "stylesheet", as: "style" })).toBe(false);
    expect(isDeferredStyleLink({ rel: "preload", as: "style", media: "print" })).toBe(true);
  });

  it("identifies a chain entry by what it is, not where it sits", () => {
    const entry = DEFERRED[0] as ChainEntry;
    expect(chainIdentity(entry)).toBe(`linked:${entry.href}|${entry.media ?? ""}`);
    expect(chainIdentity({ ...entry, order: entry.order + 99 })).toBe(chainIdentity(entry));
  });
});

describe("captured deferred sheets", () => {
  it("captured all 18 references into 11 distinct files", () => {
    expect(report.totals.references).toBe(18);
    expect(report.totals.uniqueHrefs).toBe(18);
    expect(report.totals.uniqueFiles).toBe(11);
    expect(report.totals.bytesTotal).toBe(128_679);
    expect(report.totals.bytesUnique).toBe(96_121);
    expect(report.totals.savedBytes).toBe(report.totals.bytesTotal - report.totals.bytesUnique);
    expect(report.totals.pagesGained).toBe(11);
    expect(DEFERRED).toHaveLength(18);
  });

  it("keeps one file per unique sha256, each hashing to its own name", () => {
    const hashes = [...new Set(DEFERRED.map((entry) => entry.sha256))];
    expect(hashes).toHaveLength(11);
    let bytes = 0;
    for (const hash of hashes) {
      const path = join(REPO_ROOT, "capture", "assets", "styles", "deferred", `${hash}.css`);
      expect(sha256OfFile(path), `${hash}.css`).toBe(hash);
      bytes += readFileSync(path).length;
    }
    expect(bytes).toBe(report.totals.bytesUnique);
  });

  it("enters every deferred sheet in the IR and the chain with the same bytes", () => {
    for (const entry of DEFERRED) {
      const style = ir.styles.find((candidate) => candidate.order === entry.order);
      expect(style, `styles[${entry.order}]`).toBeDefined();
      expect(style?.sha256).toBe(entry.sha256);
      expect(style?.localPath).toBe(entry.localPath);
      expect(style?.href).toBe(entry.href);
      expect(style?.origin).not.toBe("inline");
      expect(entry.bytes).toBe(readFileSync(join(REPO_ROOT, entry.capturePath)).length);
    }
  });

  it("records the position each page's cascade actually gives it, mid-chain included", () => {
    let midCascade = 0;
    for (const page of report.pages) {
      const order = ir.pages.find((candidate) => candidate.url === page.url)?.styleOrder ?? [];
      expect(page.sequence, `${page.url} cascade`).toHaveLength(order.length);
      for (const entry of page.added) {
        const style = chain.styleChain.find((candidate) => candidate.href === entry.href);
        expect(style, `${page.url}: ${entry.href}`).toBeDefined();
        expect(order[entry.position], `${page.url} position ${entry.position}`).toBe(style?.sha256);
        expect(entry.order).toBe(style?.order);
        if (entry.position < order.length - 1) midCascade += 1;
      }
    }
    // Not an append: 9 of the 18 land between existing style elements (position 4 on
    // seven pages, position 9 on `/mlm/applym/` and `/tmh/apply/`, which both have
    // entries after them). The other nine are last because the live document put them
    // last, not because the capture appended them.
    expect(midCascade).toBe(9);
    const positions = report.pages.flatMap((page) => page.added.map((entry) => entry.position));
    expect(positions).toHaveLength(18);
    expect(positions.some((position) => position === 0)).toBe(false);
  });

  it("shifted existing chain entries instead of renumbering their order", () => {
    // 55 entries became 73; 27 existing entries moved index, and every one of them
    // kept its identity. The count is the honest evidence that the insertion was a
    // shift, not a re-derivation that could reorder unrelated sheets.
    expect(report.totals.chainEntries).toBe(73);
    expect(report.totals.shiftedEntries).toBe(27);
    const orders = chain.styleChain.map((entry) => entry.order);
    expect(orders).toEqual(orders.map((_, index) => index));
  });

  it("leaves no deferred href outside the cascade", () => {
    const styles = new Set(
      ir.styles.filter((style) => style.origin !== "inline").map((style) => style.href),
    );
    let checked = 0;
    for (const page of capturedPages()) {
      for (const href of pageDeferredHrefs(page)) {
        expect(styles.has(href), `${page.url}: ${href}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBe(18);
  });
});

interface CapturedPage {
  readonly url: string;
  readonly dom: { readonly html: string };
}

function capturedPages(): CapturedPage[] {
  return (
    JSON.parse(readFileSync(join(REPO_ROOT, "capture", "site-ir.json"), "utf8")) as {
      pages: CapturedPage[];
    }
  ).pages;
}

/** Deferred hrefs the captured page's own DOM carries — the capture's claim. */
function pageDeferredHrefs(page: CapturedPage): string[] {
  return documentStyleElements(page.dom.html, page.url, ORIGIN)
    .filter((element) => element.kind === "deferred")
    .map((element) => element.href ?? "");
}
