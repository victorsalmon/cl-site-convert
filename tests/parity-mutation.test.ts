/**
 * B5.1 — the negative proof: **the gate fails on every mutant it must**.
 *
 * A gate that has only ever been seen green is not evidence. Each test here takes the
 * real emitted tree, applies one deliberate drift, and asserts that the gate rejects
 * it **and names the check that caught it**. The mutants are the six defects a
 * replay-based emitter can plausibly ship:
 *
 * | Mutant | Caught by |
 * | :--- | :--- |
 * | two adjacent styles swapped | `cascade` (order) |
 * | one class name changed | `body-tree` (class list) |
 * | one referenced asset deleted | `assets` (existence) |
 * | one byte changed inside a `<style>` block | `cascade` (bytes outside `url()`) |
 * | a node moved from page A into page B | `cross-page-leak` (and both bodies) |
 * | a `<script>` added to an island-free page | `scripts` |
 *
 * The tree is mutated **in place and restored in a `finally`**, so a failing assertion
 * cannot leave the fixture broken for the next test.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emitStaticSite } from "../src/emit/static-html/index.js";
import type { SiteIr } from "../src/schema/site-ir.js";
import { artefactPathFor, verifyParity } from "../src/verify/parity/index.js";
import type { ParityReport } from "../src/verify/parity/index.js";
import { fingerprint } from "../src/verify/parity/leak.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CAPTURE = join(REPO_ROOT, "capture");

const IR = JSON.parse(readFileSync(join(CAPTURE, "site-ir.json"), "utf8")) as SiteIr;

let workDir: string;
let outDir: string;
let reportPath: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cl-site-convert-parity-mutation-"));
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
}, 240_000);

afterAll(async () => {
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

function pageFile(url: string): string {
  return join(outDir, artefactPathFor(url));
}

async function readPage(url: string): Promise<string> {
  return readFile(pageFile(url), "utf8");
}

async function gate(): Promise<ParityReport> {
  return verifyParity({
    irPath: join(CAPTURE, "site-ir.json"),
    rewriteMapPath: join(CAPTURE, "asset-rewrite-map.json"),
    routesPath: join(CAPTURE, "routes.manifest.json"),
    assetsRoot: join(CAPTURE, "assets"),
    outDir,
    reportPath,
  });
}

/** A fresh regex each call: a shared `g` regex is stateful across `exec` calls. */
function styleBlocks(html: string): RegExpExecArray[] {
  return [...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/g)];
}

/** Apply a mutation, run the gate, and restore the original bytes. */
async function withMutation<T>(
  url: string,
  mutate: (html: string) => string,
  assertion: (report: ParityReport, checks: string[]) => T,
): Promise<T> {
  const file = pageFile(url);
  const original = await readFile(file, "utf8");
  const mutated = mutate(original);
  expect(mutated, `${url}: the mutation changed nothing`).not.toBe(original);
  await writeFile(file, mutated, "utf8");
  try {
    const report = await gate();
    return assertion(report, [...new Set(report.failures.map((failure) => failure.check))]);
  } finally {
    await writeFile(file, original, "utf8");
  }
}

describe("the gate is green before any mutation", () => {
  it("passes on the emitted tree, so every mutant below starts from a pass", async () => {
    const report = await gate();
    expect(report.verdict, JSON.stringify(report.failures.slice(0, 5), null, 2)).toBe("pass");
    expect(report.pages).toHaveLength(IR.pages.length);
    expect(report.totals.failures).toBe(0);
  }, 240_000);
});

describe("mutants the gate must reject", () => {
  it("catches two adjacent styles swapped (cascade order)", async () => {
    const url = "/ush/privacy-policy/";
    await withMutation(
      url,
      (html) => {
        const blocks = styleBlocks(html);
        expect(blocks.length, "the page has at least two <style> blocks").toBeGreaterThan(1);
        const first = blocks[0];
        const second = blocks[1];
        if (first === undefined || second === undefined) return html;
        return (
          html.slice(0, first.index) +
          second[0] +
          html.slice(first.index + first[0].length, second.index) +
          first[0] +
          html.slice(second.index + second[0].length)
        );
      },
      (report, checks) => {
        expect(report.verdict).toBe("fail");
        expect(checks).toContain("cascade");
        const failure = report.failures.find((candidate) => candidate.check === "cascade");
        // The positional byte comparison is what catches a swap, and it names the
        // position whose CSS this position actually holds.
        expect(failure?.message).toMatch(/cascade order drifted/);
      },
    );
  }, 240_000);

  it("catches one class name changed on one element (body tree)", async () => {
    const url = "/care/";
    await withMutation(
      url,
      (html) => {
        const bodyAt = html.indexOf("<body");
        expect(bodyAt, "the document has a body").toBeGreaterThan(0);
        const head = html.slice(0, bodyAt);
        const body = html.slice(bodyAt);
        const mutated = body.replace(/class="([^"]*)"/, 'class="$1 parity-drift"');
        expect(mutated, "a classed body element exists").not.toBe(body);
        return head + mutated;
      },
      (report, checks) => {
        expect(report.verdict).toBe("fail");
        expect(checks).toContain("body-tree");
        const failure = report.failures.find((candidate) => candidate.check === "body-tree");
        expect(failure?.message).toMatch(/class list differs/);
      },
    );
  }, 240_000);

  it("catches one referenced asset deleted (asset integrity)", async () => {
    const url = "/care/";
    const html = await readPage(url);
    const match = /\bsrc="((?:\.\.\/)+[^"]+)"/.exec(html);
    expect(match, "the page references a relative asset").not.toBeNull();
    const reference = String((match as RegExpExecArray)[1]);
    const file = resolve(dirname(pageFile(url)), reference.split(/[?#]/)[0] ?? "");
    expect(existsSync(file), `${reference} exists before the mutation`).toBe(true);

    const bytes = await readFile(file);
    await rm(file);
    try {
      const report = await gate();
      const checks = [...new Set(report.failures.map((failure) => failure.check))];
      expect(report.verdict).toBe("fail");
      expect(checks).toContain("assets");
      expect(
        report.failures.some(
          (failure) => failure.check === "assets" && /does not exist/.test(failure.message),
        ),
      ).toBe(true);
    } finally {
      await writeFile(file, bytes);
    }
  }, 240_000);

  it("catches one byte changed inside an emitted <style> block (cascade bytes)", async () => {
    const url = "/care/";
    await withMutation(
      url,
      (html) => {
        const block = styleBlocks(html)[0];
        expect(block, "the page has a <style> block").toBeDefined();
        const text = (block as RegExpExecArray)[0];
        const start = (block as RegExpExecArray).index;
        const brace = text.indexOf("{", text.indexOf(">") + 1);
        expect(brace, "the block has a rule").toBeGreaterThan(0);
        return `${html.slice(0, start + brace + 1)} ${html.slice(start + brace + 1)}`;
      },
      (report, checks) => {
        expect(report.verdict).toBe("fail");
        expect(checks).toContain("cascade");
        expect(
          report.failures.some(
            (failure) =>
              failure.check === "cascade" && /differs outside url\(\)/.test(failure.message),
          ),
        ).toBe(true);
      },
    );
  }, 240_000);

  it("catches a node moved from page A into page B (cross-page leak)", async () => {
    // `/tmh/offboard/` owns 50 text runs no other page carries; `/care/` owns none of
    // them, so a node lifted from the first into the second is a genuine leak.
    const from = "/tmh/offboard/";
    const to = "/care/";

    const fingerprints = new Map(
      IR.pages.map((page) => [page.url, fingerprint(page.url, page.dom.html)]),
    );
    const source = fingerprints.get(from);
    if (source === undefined) throw new Error(`${from} is not a captured page`);
    const unique = [...source.texts].find((text) =>
      [...fingerprints.entries()].every(([url, page]) => url === from || !page.texts.has(text)),
    );
    if (unique === undefined) throw new Error(`${from} owns no text that is unique to it`);

    const text = unique.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    await withMutation(
      to,
      (html) => html.replace("</body>", `<p class="parity-moved">${text}</p>\n</body>`),
      (report, checks) => {
        expect(report.verdict).toBe("fail");
        expect(checks).toContain("cross-page-leak");
        const failure = report.failures.find((candidate) => candidate.check === "cross-page-leak");
        expect(failure?.expected).toBe(from);
        // The receiving page's body also stops matching its own capture: two checks,
        // two different truths, and the leak is the one tree equality cannot see.
        expect(checks).toContain("body-tree");
      },
    );
  }, 240_000);

  it("catches a <script> added to an island-free page (no scripts)", async () => {
    const url = "/resources/";
    await withMutation(
      url,
      (html) => html.replace("</body>", "<script>void 0;</script>\n</body>"),
      (report, checks) => {
        expect(report.verdict).toBe("fail");
        expect(checks).toContain("scripts");
        expect(
          report.failures.some(
            (failure) =>
              failure.check === "scripts" &&
              /mounts no island but carries 1 <script>/.test(failure.message),
          ),
        ).toBe(true);
      },
    );
  }, 240_000);
});
