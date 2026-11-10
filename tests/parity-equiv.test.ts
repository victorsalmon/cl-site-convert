/**
 * B5.1 — the positive contract: the committed capture emits an **equivalent** tree.
 *
 * This is the assertion the gate exists for, and it is deliberately narrow: one real
 * emit, one verification run, then assertions on the report and on the artefacts the
 * report claims to have measured. It does not re-implement the checks — the mutation
 * suite (`parity-mutation.test.ts`) proves they can fail, and `parity-tree.test.ts`
 * proves the permitted-rewrite matrix is exact.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emitStaticSite } from "../src/emit/static-html/index.js";
import type { SiteIr } from "../src/schema/site-ir.js";
import { artefactPathFor, formatParityReport, verifyParity } from "../src/verify/parity/index.js";
import type { ParityReport } from "../src/verify/parity/index.js";
import { CHECKS } from "../src/verify/parity/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CAPTURE = join(REPO_ROOT, "capture");

const IR = JSON.parse(readFileSync(join(CAPTURE, "site-ir.json"), "utf8")) as SiteIr;

let workDir: string;
let outDir: string;
let reportPath: string;
let report: ParityReport;
let reportJson: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cl-site-convert-parity-equiv-"));
  outDir = join(workDir, "site");
  reportPath = join(workDir, "parity-report.json");
  await emitStaticSite({
    irPath: join(CAPTURE, "site-ir.json"),
    rewriteMapPath: join(CAPTURE, "asset-rewrite-map.json"),
    routesPath: join(CAPTURE, "routes.manifest.json"),
    assetsRoot: join(CAPTURE, "assets"),
    outDir,
    reportPath: join(workDir, "emit-report.json"),
  });
  report = await verifyParity({
    irPath: join(CAPTURE, "site-ir.json"),
    rewriteMapPath: join(CAPTURE, "asset-rewrite-map.json"),
    routesPath: join(CAPTURE, "routes.manifest.json"),
    assetsRoot: join(CAPTURE, "assets"),
    outDir,
    reportPath,
  });
  reportJson = await readFile(reportPath, "utf8");
}, 300_000);

afterAll(async () => {
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

describe("the emitted tree is equivalent to the IR", () => {
  it("passes every check on every page", () => {
    expect(report.verdict, JSON.stringify(report.failures.slice(0, 5), null, 2)).toBe("pass");
    expect(report.failures).toEqual([]);
    expect(report.pages).toHaveLength(IR.pages.length);
    expect(report.totals.pagesPassed).toBe(IR.pages.length);
    for (const page of report.pages) {
      expect(page.verdict, `${page.url}: ${JSON.stringify(page.failures)}`).toBe("pass");
    }
  });

  it("runs the whole check set and says so in the report", () => {
    expect(report.checks).toEqual(CHECKS);
    expect(report.gate).toBe("equivalence");
    expect(report.irVersion).toMatch(/^1\./);
    expect(report.authority).toContain("site-ir.json");
  });

  it("compares every cascade position the IR records", () => {
    const declared = IR.pages.reduce((total, page) => total + (page.styleOrder ?? []).length, 0);
    expect(report.totals.stylesCompared).toBe(declared);
    expect(report.totals.stylesCompared).toBeGreaterThan(IR.pages.length);
  });

  it("compares a real share of the document tree, not a token sample", () => {
    // 8,254 nodes is every element and text node of 19 pages' bodies and heads — a
    // token sample would be a few hundred.
    expect(report.totals.nodesCompared).toBeGreaterThan(5_000);
    for (const page of report.pages) {
      expect(page.nodesCompared, `${page.url} body nodes`).toBeGreaterThan(50);
    }
  });

  it("verifies every referenced local asset against its recorded hash", () => {
    expect(report.totals.assetsVerified).toBeGreaterThan(0);
    expect(report.totals.assetsHashed).toBe(report.totals.assetsVerified);
  });

  it("carries the captured body byte-for-byte apart from permitted reference rewrites", () => {
    const rewrites = report.totals.rewrites;
    expect(rewrites.asset).toBeGreaterThan(0);
    expect(rewrites.navigation).toBeGreaterThan(0);
    expect(rewrites["internal-path"]).toBeGreaterThan(0);
    // Every captured `form[action]` that pointed at the source host is re-pointed.
    expect(rewrites["form-sink"]).toBeGreaterThan(0);
    expect(rewrites["meta-asset"]).toBeGreaterThan(0);
    // The default emit declares the captured origin, so no canonical value moved. The
    // permitted-canonical path is exercised in `parity-tree.test.ts` and by an emit
    // with a different `--base-url`.
    expect(rewrites.canonical).toBe(0);
  });

  it("re-derives the residual allowlist entry by entry", () => {
    const composition = report.totals.residualComposition;
    const declared =
      composition.canonical + composition["deferred-css"] + composition.unlocalisable;
    // The composition is the allowlist: every surviving reference is counted under
    // exactly one justified category, and nothing survives outside them.
    expect(declared).toBe(report.totals.residualRefs);
    expect(report.totals.residualRefs).toBeGreaterThan(0);
    expect(composition.canonical).toBeGreaterThan(0);
    // Deferred Divi CSS is now CAPTURED (bead mzi), so there is nothing left to
    // allowlist in this category. Asserting zero is the regression guard: a
    // reappearing deferred reference means the capture or the emitter regressed.
    expect(composition["deferred-css"]).toBe(0);
    expect(composition.unlocalisable).toBeGreaterThan(0);
  });

  it("ships no script and no mount slot, because no page mounts an island", () => {
    expect(report.totals.scriptTags).toBe(0);
    for (const page of report.pages) {
      expect(page.mounts, `${page.url} mount slots`).toBe(0);
      expect(page.scriptTags, `${page.url} scripts`).toBe(0);
    }
  });

  it("records the pixel diff as a documented secondary stage it did not run", () => {
    expect(report.pixelDiff.status).toBe("not-run");
    expect(report.pixelDiff.stage).toBe("secondary");
    expect(report.pixelDiff.reason).toMatch(/docs\/fidelity-gate\.md/);
  });
});

describe("the artefact the report describes is the artefact on disk", () => {
  it("names the file that actually holds each route", async () => {
    for (const page of report.pages) {
      expect(page.outputPath).toBe(artefactPathFor(page.url));
      const html = await readFile(join(outDir, page.outputPath), "utf8");
      expect(html, `${page.url} is a full document`).toContain("<body");
    }
  });

  it("writes the report to disk as machine-readable JSON", () => {
    const written = JSON.parse(reportJson) as ParityReport;
    expect(written.verdict).toBe("pass");
    expect(written.totals).toEqual(report.totals);
    expect(written.pages.map((page) => page.url)).toEqual(report.pages.map((page) => page.url));
  });

  it("prints a per-page table and a summary", () => {
    const table = formatParityReport(report);
    for (const page of report.pages) expect(table).toContain(page.url);
    expect(table).toContain(`${String(IR.pages.length)} page(s)`);
    expect(table).toContain("VERDICT: PASS");
    expect(table).toContain("permitted rewrites, by category");
    for (const category of ["asset", "navigation", "internal-path", "form-sink", "meta-asset"]) {
      expect(table).toContain(category);
    }
  });
});
