/**
 * The capture's own claim, checked against the bytes on disk.
 *
 * `capture/site-ir.json` says every style and asset hashes to `sha256`. That
 * claim is only worth anything if it is re-derivable from the committed tree, so
 * this test recomputes it — no network, no capture, just the bytes git holds.
 *
 * A failure here means one of: the evidence was edited, a checkout transformed
 * line endings, or a merge dropped a file. All three are bugs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  pageAssetRefs,
  pageStyleRefs,
  sha256Hex,
  verifyFiles,
} from "../src/source/wp-rest/assets.js";
import type { StyleChain, RewriteMap } from "../src/source/wp-rest/assets.js";
import type { AssetCaptureReport } from "../src/source/wp-rest/assets.js";
import { isLinkedStyle } from "../src/schema/site-ir.js";
import type { SiteIr } from "../src/schema/site-ir.js";

const ROOT = process.cwd();
const read = <T>(path: string): T => JSON.parse(readFileSync(join(ROOT, path), "utf8")) as T;

const ir = read<SiteIr>("capture/site-ir.json");
const chain = read<StyleChain>("capture/style-chain.json");
const map = read<RewriteMap>("capture/asset-rewrite-map.json");
const report = read<AssetCaptureReport>("capture/assets.capture-report.json");
/**
 * The deferred-CSS pass ran after B1.3 and has its own report: its bytes live under
 * `capture/assets/styles/deferred/`, so the B1.3 report cannot claim them.
 */
const deferred = read<{
  totals: { references: number; uniqueFiles: number; bytesUnique: number };
}>("capture/deferred-css.capture-report.json");

function bytesAt(capturePath: string): Uint8Array {
  return new Uint8Array(readFileSync(join(ROOT, capturePath)));
}

describe("captured assets", () => {
  it("has every recorded hash reproduce from the committed bytes", async () => {
    const records = [
      ...chain.styleChain.map((entry) => ({
        capturePath: entry.capturePath,
        sha256: entry.sha256,
      })),
      ...map.assets.map((entry) => ({ capturePath: entry.capturePath, sha256: entry.sha256 })),
    ];
    expect(records.length).toBeGreaterThan(0);
    expect(await verifyFiles(records, ROOT)).toEqual([]);
    expect(report.verification.ok).toBe(true);
    expect(report.verification.problems).toEqual([]);
  });

  it("keeps the Site IR, the chain and the rewrite map in agreement", () => {
    const mapStyles = new Map(map.styles.map((style) => [style.order, style]));
    // P1.7: `styles[]` carries the whole 55-entry chain, not the linked subset.
    expect(ir.styles.length).toBe(chain.styleChain.length);
    for (const style of ir.styles) {
      const entry = mapStyles.get(style.order);
      expect(entry, `style order ${style.order} is missing from the rewrite map`).toBeDefined();
      // Absent `origin` is the v1.0 spelling of `linked`.
      expect(style.origin ?? "linked").toBe(entry?.origin);
      expect(entry?.sha256).toBe(style.sha256);
      expect(entry?.localPath).toBe(style.localPath);
    }
    // The linked entries are exactly the ones that carry a real url; no inline
    // block is given a fake one.
    expect(ir.styles.filter(isLinkedStyle)).toHaveLength(
      chain.styleChain.filter((entry) => entry.origin === "linked").length,
    );
    expect(ir.styles.filter(isLinkedStyle).every((style) => style.href.startsWith("http"))).toBe(
      true,
    );
    expect(
      ir.styles.filter((style) => !isLinkedStyle(style)).every((style) => style.href === undefined),
    ).toBe(true);

    const mapAssets = new Map(map.assets.map((asset) => [asset.sourceUrl, asset]));
    for (const asset of ir.assets) {
      const entry = mapAssets.get(asset.sourceUrl);
      expect(entry, `${asset.sourceUrl} is missing from the rewrite map`).toBeDefined();
      expect(entry?.sha256).toBe(asset.sha256);
      expect(entry?.localPath).toBe(asset.localPath);
      expect(entry?.kind).toBe(asset.kind);
    }
    expect(ir.assets.length).toBe(map.assets.length);
  });

  it("keeps style order unique and ascending in the IR and in the chain", () => {
    const irOrders = ir.styles.map((style) => style.order);
    expect(new Set(irOrders).size).toBe(irOrders.length);
    expect([...irOrders].sort((a, b) => a - b)).toEqual(irOrders);

    const chainOrders = chain.styleChain.map((entry) => entry.order);
    expect(chainOrders).toEqual(chainOrders.map((_, index) => index));
  });

  it("materialises exactly one file per unique inline block, deduplicated by sha256", () => {
    const inlineEntries = chain.styleChain.filter((entry) => entry.origin === "inline");
    const uniqueHashes = new Set(inlineEntries.map((entry) => entry.sha256));
    const files = readdirSync(join(ROOT, "capture/assets/styles/inline")).sort();
    expect(files).toEqual([...uniqueHashes].sort().map((hash) => `${hash}.css`));

    expect(chain.totals.inlineUnique).toBe(uniqueHashes.size);
    expect(chain.totals.inlineBlocks).toBe(report.totals.inlineBlocksTotal);
    expect(chain.totals.inlineBlocks).toBeGreaterThanOrEqual(uniqueHashes.size);

    // Dedup is real: the total block bytes exceed the unique file bytes.
    expect(report.totals.inlineBytesTotal).toBeGreaterThan(report.totals.inlineBytesUnique);
    expect(report.totals.inlineBytesSaved).toBe(
      report.totals.inlineBytesTotal - report.totals.inlineBytesUnique,
    );

    let onDisk = 0;
    for (const name of files) {
      const bytes = bytesAt(`capture/assets/styles/inline/${name}`);
      expect(sha256Hex(bytes)).toBe(name.replace(/\.css$/, ""));
      onDisk += bytes.length;
    }
    expect(onDisk).toBe(report.totals.inlineBytesUnique);
  });

  it("accounts for every byte it claims to have written", () => {
    // B1.3's linked sheets only: the deferred ones were captured later and their
    // bytes are accounted for by the deferred report's own test.
    const linked = chain.styleChain.filter(
      (entry) => entry.origin === "linked" && !entry.localPath.startsWith("deferred/"),
    );
    const linkedBytes = linked.reduce(
      (total, entry) => total + bytesAt(entry.capturePath).length,
      0,
    );
    expect(linkedBytes).toBe(report.totals.linkedStyleBytes);

    const mediaBytes = map.assets.reduce(
      (total, entry) => total + bytesAt(entry.capturePath).length,
      0,
    );
    expect(mediaBytes).toBe(report.totals.mediaBytes);
    expect(map.assets.length).toBe(report.totals.media);
    expect(report.totals.diskBytes).toBe(
      report.totals.linkedStyleBytes + report.totals.inlineBytesUnique + report.totals.mediaBytes,
    );
  });

  it("cross-checked the inline bytes it recovered against the B1.2 capture record", () => {
    // The whole point of this pass: the CSS normalisation deleted is recoverable
    // and provably the same bytes. A mismatch would mean the served page changed.
    expect(report.reconCrossCheck.length).toBe(ir.pages.length);
    for (const entry of report.reconCrossCheck) {
      expect(entry.hashesMatch, `${entry.url}: inline hashes differ from the B1.2 record`).toBe(
        true,
      );
      expect(entry.expectedSha256, `${entry.url}: re-read page has other block count`).toEqual(
        entry.actualSha256,
      );
    }
    const recorded = report.reconCrossCheck.reduce(
      (total, entry) => total + entry.expectedSha256.length,
      0,
    );
    expect(recorded).toBe(chain.totals.inlineBlocks);
  });

  it("accounts for every reference in the captured DOM: local file or recorded 404", () => {
    const known = new Set(Object.keys(map.rewrite));
    const broken = new Set(report.brokenReferences.map((entry) => entry.ref));
    const uncovered: string[] = [];
    for (const page of ir.pages) {
      for (const ref of pageAssetRefs(page.dom.html, page.url, map.baseUrl)) {
        if (!known.has(ref.url) && !broken.has(ref.url)) uncovered.push(`${page.url} ${ref.url}`);
      }
      for (const style of pageStyleRefs(page.dom.html, page.url, map.baseUrl)) {
        if (style.origin === "linked" && !known.has(style.href)) {
          uncovered.push(`${page.url} ${style.href}`);
        }
      }
    }
    expect(uncovered).toEqual([]);
    // The two known defects are the site's own missing files, and they must not
    // be silently mapped to some other file.
    for (const entry of report.brokenReferences) expect(known.has(entry.ref)).toBe(false);
  });

  it("has a real local file for every reference the emitter will rewrite", () => {
    const rewriteKeys = Object.keys(map.rewrite);
    expect(rewriteKeys.length).toBeGreaterThan(ir.assets.length);
    for (const [source, target] of Object.entries(map.rewrite)) {
      expect(target.startsWith("/"), `${source} must map to a relative path`).toBe(false);
      // Linked stylesheets live under styles/, everything else under media/.
      const candidates = [`capture/assets/styles/${target}`, `capture/assets/media/${target}`];
      expect(
        candidates.some((candidate) => existsSync(join(ROOT, candidate))),
        `${source} -> ${target} has no file on disk`,
      ).toBe(true);
    }
  });

  it("records the LiteSpeed cache verdict for every asset response", () => {
    expect(report.cache.evidence.length).toBeGreaterThan(0);
    expect(report.cache.hits + report.cache.misses).toBe(report.cache.evidence.length);
    for (const entry of report.cache.evidence) {
      expect(entry.cache).toHaveProperty("litespeed");
      expect(entry.status).toBeGreaterThan(0);
    }
  });

  it("reports the inspected asset tree size, and it agrees with the directory", () => {
    const walk = (dir: string): number => {
      let total = 0;
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = statSync(path);
        total += stat.isDirectory() ? walk(path) : stat.size;
      }
      return total;
    };
    // B1.3's report covers its own pass; the deferred-CSS pass added files afterwards
    // under the same root and records their bytes in its own report.
    expect(walk(join(ROOT, "capture/assets"))).toBe(
      report.totals.diskBytes + deferred.totals.bytesUnique,
    );
  });

  it("materialises every deferred sheet as one file per sha256, with its own report", () => {
    const deferredEntries = chain.styleChain.filter((entry) =>
      entry.localPath.startsWith("deferred/"),
    );
    expect(deferredEntries.length).toBe(deferred.totals.references);
    expect(new Set(deferredEntries.map((entry) => entry.localPath)).size).toBe(
      deferred.totals.uniqueFiles,
    );

    const directory = "capture/assets/styles/deferred";
    const files = readdirSync(join(ROOT, directory)).sort();
    expect(files).toEqual(
      [...new Set(deferredEntries.map((entry) => entry.sha256))]
        .sort()
        .map((hash) => `${hash}.css`),
    );

    let onDisk = 0;
    for (const name of files) {
      const bytes = bytesAt(`${directory}/${name}`);
      expect(sha256Hex(bytes)).toBe(name.replace(/\.css$/, ""));
      onDisk += bytes.length;
    }
    expect(onDisk).toBe(deferred.totals.bytesUnique);
    expect(chain.totals.deferredFiles).toBe(deferred.totals.uniqueFiles);
    expect(chain.totals.deferredLinks).toBe(deferred.totals.references);
  });
});
