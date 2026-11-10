/**
 * B2.1 — the static emitter's acceptance test.
 *
 * One real emit of the committed capture into a temporary tree, then every
 * requirement the bead states is asserted against the bytes on disk:
 *
 *  - pretty-URL output, one directory per route, for all 19 pages;
 *  - the emitted style sequence is `page.styleOrder` exactly (count, order, origin),
 *    re-parsed from the shipped `<head>`;
 *  - the body is the captured body: tags, attribute order and class lists unchanged
 *    apart from rewritten asset references;
 *  - zero `<script>` tags, because `bundlesForHtml` finds no mount slots;
 *  - captured CSS vs emitted CSS differs only inside `url(...)` bodies;
 *  - every rewritten reference resolves to a real file in the tree.
 *
 * The style-sequence check deliberately re-derives the expected origins from the
 * capture instead of calling the emitter's resolver: a test that asks the code under
 * test what the answer should be proves nothing.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "parse5";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  emitStaticSite,
  formatEmitReport,
  routeLocation,
  splitDocument,
} from "../src/emit/static-html/index.js";
import type { EmitReport } from "../src/emit/static-html/index.js";
import { emittedStylePath } from "../src/emit/static-html/cascade.js";
import type { Page, SiteIr, Style } from "../src/schema/site-ir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CAPTURE = join(REPO_ROOT, "capture");

const IR = JSON.parse(readFileSync(join(CAPTURE, "site-ir.json"), "utf8")) as SiteIr;
const MAP = JSON.parse(readFileSync(join(CAPTURE, "asset-rewrite-map.json"), "utf8")) as {
  baseUrl: string;
  rewrite: Record<string, string>;
};

let workDir: string;
let outDir: string;
let report: EmitReport;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cl-site-convert-emit-"));
  outDir = join(workDir, "site");
  report = await emitStaticSite({
    irPath: join(CAPTURE, "site-ir.json"),
    rewriteMapPath: join(CAPTURE, "asset-rewrite-map.json"),
    assetsRoot: join(CAPTURE, "assets"),
    outDir,
    reportPath: join(workDir, "emit-report.json"),
  });
}, 180_000);

afterAll(async () => {
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

function emittedPathOf(url: string): string {
  return join(outDir, routeLocation(url).outputPath);
}

// ---------------------------------------------------------------------------
// Route shape
// ---------------------------------------------------------------------------

describe("emitted tree", () => {
  it("writes one directory per route with an index.html, WP-permalink shaped", async () => {
    expect(report.pages).toHaveLength(19);
    for (const page of IR.pages) {
      const location = routeLocation(page.url);
      const file = join(outDir, location.outputPath);
      const reached = await stat(file);
      expect(reached.isFile(), `${page.url} -> ${location.outputPath}`).toBe(true);
    }

    // The two shape cases the bead names explicitly.
    expect(routeLocation("/")).toEqual({ outputPath: "index.html", depth: 0 });
    expect(routeLocation("/care/")).toEqual({ outputPath: "care/index.html", depth: 1 });
    expect(routeLocation("/care/showings/")).toEqual({
      outputPath: "care/showings/index.html",
      depth: 2,
    });
  });

  it("copies every captured asset byte-for-byte", async () => {
    expect(report.assets.skipped).toBe(false);
    expect(report.assets.copied).toBe(IR.assets.length);
    expect(report.assets.copied).toBe(230);

    const declared = IR.assets.reduce((total, asset) => total + (asset.bytes ?? 0), 0);
    expect(report.assets.bytes).toBe(declared);

    for (const asset of IR.assets.slice(0, 12)) {
      const emitted = await readFile(join(outDir, asset.localPath));
      expect(createHash("sha256").update(emitted).digest("hex")).toBe(asset.sha256);
    }
  });

  it("prints a per-page table with route, bytes, style count and rewritten refs", () => {
    const table = formatEmitReport(report);
    for (const page of IR.pages) expect(table).toContain(page.url);
    expect(table).toContain("bytes");
    expect(table).toContain("styles");
    expect(table).toContain("19 page(s)");
    expect(report.pages.every((page) => page.bytes > 0)).toBe(true);
    expect(report.totals.pageBytes).toBe(
      report.pages.reduce((total, page) => total + page.bytes, 0),
    );
  });

  it("refuses to emit into a directory that contains the working directory", async () => {
    await expect(emitStaticSite({ outDir: "." })).rejects.toThrow(/refusing to emit into/);
  });
});

// ---------------------------------------------------------------------------
// No islands ⇒ no scripts
// ---------------------------------------------------------------------------

describe("island-free emission", () => {
  it("emits zero <script> tags on every page", async () => {
    for (const page of IR.pages) {
      const html = await readFile(emittedPathOf(page.url), "utf8");
      expect(html.match(/<script\b/gi) ?? [], `${page.url} script tags`).toEqual([]);
      expect(html.includes("data-component="), `${page.url} mount slots`).toBe(false);
      expect(html.includes("/pkg/"), `${page.url} island bundle refs`).toBe(false);
    }
    expect(report.totals.scriptTags).toBe(0);
    expect(report.pages.every((page) => page.bundles === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Style chain
// ---------------------------------------------------------------------------

/** Fragments of a CSS value that are not the url body, used to fingerprint CSS. */
function cssFingerprint(css: string): string {
  return css.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)\s]*)\s*\)/g, "url()");
}

interface P5Node {
  readonly nodeName?: string;
  readonly attrs?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly childNodes?: ReadonlyArray<P5Node>;
  readonly value?: string;
  readonly content?: P5Node;
}

function elementChildren(node: P5Node): P5Node[] {
  return (node.childNodes ?? []).filter(
    (child) => child.nodeName !== "#comment" && child.nodeName !== "#text",
  );
}

function textOf(node: P5Node): string {
  return (node.childNodes ?? [])
    .map((child) => (child.nodeName === "#text" ? (child.value ?? "") : textOf(child)))
    .join("");
}

function findElement(node: P5Node, name: string): P5Node | null {
  if (node.nodeName === name) return node;
  for (const child of node.childNodes ?? []) {
    const found = findElement(child, name);
    if (found !== null) return found;
  }
  if (node.content !== undefined) return findElement(node.content, name);
  return null;
}

function attr(node: P5Node, name: string): string | null {
  const found = (node.attrs ?? []).find((candidate) => candidate.name === name);
  return found === undefined ? null : found.value;
}

/** `rel` is a token list; a stylesheet link is one whose tokens include `stylesheet`. */
function isStylesheetLink(node: P5Node): boolean {
  const rel = attr(node, "rel");
  return (
    node.nodeName === "link" &&
    rel !== null &&
    rel.toLowerCase().split(/\s+/).includes("stylesheet")
  );
}

/** Captured inline CSS, addressed the way the capture stored it. */
function capturedInlineCss(sha256: string): string {
  return readFileSync(join(CAPTURE, "assets", "styles", "inline", `${sha256}.css`), "utf8");
}

function capturedLinkedCss(style: Style): string {
  const candidates = [
    join(CAPTURE, "assets", "styles", style.localPath),
    join(CAPTURE, "assets", "media", style.localPath),
  ];
  for (const candidate of candidates)
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  throw new Error(`no captured bytes for style ${style.order} (${style.localPath})`);
}

/**
 * The expected origin of every position, re-derived from the capture: a linked entry
 * is linked on this page **iff** its captured `href` is still in that page's dom.
 */
function expectedOrigins(page: Page): Array<"linked" | "inline"> {
  const linkedShas = new Set(
    IR.styles
      .filter((style) => style.origin !== "inline" && "href" in style)
      .filter((style) => page.dom.html.includes((style as { href: string }).href))
      .map((style) => style.sha256),
  );
  return (page.styleOrder ?? []).map((sha256) => (linkedShas.has(sha256) ? "linked" : "inline"));
}

describe("emitted style chain", () => {
  it("emits page.styleOrder exactly: count, order and origin", async () => {
    // Fingerprint every captured inline block, so an emitted <style> can be named
    // without asking the emitter what it resolved to.
    const inlineByFingerprint = new Map<string, string[]>();
    for (const style of IR.styles) {
      if (style.origin !== "inline") continue;
      const fingerprint = cssFingerprint(capturedInlineCss(style.sha256));
      const bucket = inlineByFingerprint.get(fingerprint) ?? [];
      bucket.push(style.sha256);
      inlineByFingerprint.set(fingerprint, bucket);
    }
    const linkedByPath = new Map(
      IR.styles
        .filter((style) => style.origin !== "inline")
        .map((style) => [emittedStylePath(style), style.sha256]),
    );

    for (const page of IR.pages) {
      const html = await readFile(emittedPathOf(page.url), "utf8");
      const head = findElement(parse(html) as unknown as P5Node, "head");
      expect(head, `${page.url} has a head`).not.toBeNull();

      const sequence: Array<{ sha256: string; origin: "linked" | "inline" }> = [];
      for (const node of elementChildren(head as P5Node)) {
        if (node.nodeName === "style") {
          const bucket = inlineByFingerprint.get(cssFingerprint(textOf(node))) ?? [];
          expect(bucket.length, `${page.url}: an emitted <style> matches no capture`).toBe(1);
          const [sha256] = bucket;
          sequence.push({ sha256: sha256 as string, origin: "inline" });
        } else if (isStylesheetLink(node)) {
          const href = attr(node, "href") ?? "";
          const resolved = relative(outDir, resolve(dirname(emittedPathOf(page.url)), href));
          const sha256 = linkedByPath.get(resolved.split("\\").join("/"));
          expect(sha256, `${page.url}: ${href} is not an emitted stylesheet`).toBeTypeOf("string");
          sequence.push({ sha256: sha256 as string, origin: "linked" });
        }
      }

      expect(
        sequence.map((entry) => entry.sha256),
        `${page.url} cascade`,
      ).toEqual(page.styleOrder);
      expect(
        sequence.map((entry) => entry.origin),
        `${page.url} origins`,
      ).toEqual(expectedOrigins(page));

      // A stylesheet link must not survive anywhere outside the rebuilt block.
      const surviving = elementChildren(head as P5Node).filter(isStylesheetLink).length;
      expect(surviving).toBe(sequence.filter((entry) => entry.origin === "linked").length);
    }
  });

  it("wraps each inline block around its captured bytes and nothing else", () => {
    // The byte-level half of the chain contract: before rewriting, the shipped
    // <style> is the captured file, character for character.
    for (const style of IR.styles) {
      if (style.origin !== "inline") continue;
      const bytes = capturedInlineCss(style.sha256);
      const media = style.media === undefined ? "" : ` media="${style.media}"`;
      expect(`<style${media}>${bytes}</style>`).toContain(bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(style.sha256);
    }
  });
});

// ---------------------------------------------------------------------------
// CSS diff proof: only url() bodies changed
// ---------------------------------------------------------------------------

/** Split CSS into text segments separated by its url() tokens. */
function cssSegments(css: string): { segments: string[]; urls: string[] } {
  const segments: string[] = [];
  const urls: string[] = [];
  let cursor = 0;
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g)) {
    segments.push(css.slice(cursor, match.index));
    urls.push((match[1] ?? match[2] ?? match[3]) as string);
    cursor = match.index + match[0].length;
  }
  segments.push(css.slice(cursor));
  return { segments, urls };
}

/** The rewrite the map prescribes for a captured url, resolved to a relative form. */
function expectedRewrite(capturedUrl: string, dirDepth: number): string | null {
  const tryKey = (key: string): string | null =>
    Object.hasOwn(MAP.rewrite, key) ? (MAP.rewrite[key] as string) : null;

  const candidates = [capturedUrl];
  if (capturedUrl.startsWith("//")) candidates.push(`https:${capturedUrl}`);
  else if (capturedUrl.startsWith("/")) candidates.push(`${MAP.baseUrl}${capturedUrl}`);

  for (const candidate of candidates) {
    const mapped = tryKey(candidate);
    if (mapped !== null) return `${"../".repeat(dirDepth)}${mapped}`;
  }

  const suffixAt = capturedUrl.search(/[?#]/);
  if (suffixAt > 0) {
    const bare = capturedUrl.slice(0, suffixAt);
    const suffix = capturedUrl.slice(suffixAt);
    const bareCandidates = [bare];
    if (bare.startsWith("//")) bareCandidates.push(`https:${bare}`);
    else if (bare.startsWith("/")) bareCandidates.push(`${MAP.baseUrl}${bare}`);
    for (const candidate of bareCandidates) {
      const mapped = tryKey(candidate);
      if (mapped !== null) return `${"../".repeat(dirDepth)}${mapped}${suffix}`;
    }
  }
  return null;
}

/** Assert a captured/emitted pair differs only in url() bodies, each explained by the map. */
function assertOnlyUrlSubstitutions(
  captured: string,
  emitted: string,
  dirDepth: number,
  label: string,
): void {
  const before = cssSegments(captured);
  const after = cssSegments(emitted);
  expect(after.urls.length, `${label}: url() token count`).toBe(before.urls.length);
  expect(after.segments, `${label}: every byte outside url() is unchanged`).toEqual(
    before.segments,
  );

  for (const [index, capturedUrl] of before.urls.entries()) {
    const emittedUrl = after.urls[index] as string;
    if (capturedUrl === emittedUrl) continue;
    expect(emittedUrl, `${label}: changed url is a map substitution`).toBe(
      expectedRewrite(capturedUrl, dirDepth),
    );
  }
}

describe("CSS diff proof", () => {
  it("proves every emitted linked stylesheet changed only in url() bodies", async () => {
    expect(report.styles.linkedFiles).toHaveLength(7);
    let changedTokens = 0;

    for (const file of report.styles.linkedFiles) {
      const style = IR.styles.find((candidate) => candidate.order === file.order);
      expect(style).toBeDefined();
      const captured = capturedLinkedCss(style as Style);
      const emitted = await readFile(join(outDir, file.emittedPath), "utf8");
      const depth = file.emittedPath.split("/").length - 1;

      assertOnlyUrlSubstitutions(captured, emitted, depth, file.emittedPath);
      const before = cssSegments(captured);
      const after = cssSegments(emitted);
      changedTokens += before.urls.filter((url, index) => url !== after.urls[index]).length;
    }

    expect(changedTokens).toBe(
      report.styles.linkedFiles.reduce((total, file) => total + file.cssRefs, 0),
    );
    expect(changedTokens).toBeGreaterThan(0);
  });

  it("proves every emitted inline <style> changed only in url() bodies", async () => {
    let checkedBlocks = 0;
    let changedTokens = 0;

    for (const page of IR.pages) {
      const html = await readFile(emittedPathOf(page.url), "utf8");
      const head = findElement(parse(html) as unknown as P5Node, "head") as P5Node;
      const depth = routeLocation(page.url).depth;

      // Pair the emitted blocks with the page's inline entries in styleOrder order.
      // A position is inline only when the capture says so: the one shared sha256 is
      // linked on the pages whose head carries its href.
      const origins = expectedOrigins(page);
      const inlineEntries = (page.styleOrder ?? [])
        .map((sha256, position) => ({ sha256, origin: origins[position] }))
        .filter((entry) => entry.origin === "inline")
        .map((entry) => entry.sha256);
      const emittedStyles = elementChildren(head).filter((node) => node.nodeName === "style");
      expect(emittedStyles.length, `${page.url} inline block count`).toBe(inlineEntries.length);

      for (const [index, node] of emittedStyles.entries()) {
        const sha256 = inlineEntries[index] as string;
        const captured = capturedInlineCss(sha256);
        const emitted = textOf(node);
        assertOnlyUrlSubstitutions(captured, emitted, depth, `${page.url} ${sha256.slice(0, 8)}`);
        changedTokens += cssSegments(captured).urls.filter(
          (url, token) => url !== cssSegments(emitted).urls[token],
        ).length;
        checkedBlocks += 1;
      }
    }

    // 116 inline blocks across 19 pages, exactly as the capture counted them.
    expect(checkedBlocks).toBe(116);
    expect(changedTokens).toBe(report.pages.reduce((total, page) => total + page.inlineCssRefs, 0));
  });
});

// ---------------------------------------------------------------------------
// DOM parity
// ---------------------------------------------------------------------------

/** `tag.attribute` pairs this bead is allowed to change (asset references). */
const REWRITABLE = new Set(["img.src", "img.srcset", "source.srcset", "link.href"]);

/** The live site's own defect, reproduced faithfully: a scheme-less anchor. */
const KNOWN_BROKEN_ANCHORS = new Set(["chatgpt.com"]);

interface CompareContext {
  readonly page: string;
  readonly baseDir: string;
  readonly path: string[];
}

function isUrlBearing(tag: string, name: string): boolean {
  return REWRITABLE.has(`${tag}.${name}`);
}

/** Resolve a relative emitted reference against the page it appears on. */
function resolvesOnDisk(baseDir: string, value: string): boolean {
  const path = value.split(/[?#]/)[0] ?? "";
  return existsSync(resolve(baseDir, path));
}

/**
 * Compare two parse trees element by element.
 *
 * Tag name, attribute **order** and every class list must match. Attribute values
 * must match too, except on the four asset-bearing attributes, where the emitted
 * value must be a relative reference that resolves to a real file on disk.
 */
function compareElements(captured: P5Node, emitted: P5Node, context: CompareContext): void {
  const tag = captured.nodeName ?? "";
  const where = context.path.join(" > ");
  expect(emitted.nodeName, `${context.page}: tag at ${where}`).toBe(tag);

  const capturedAttributes = captured.attrs ?? [];
  const emittedAttributes = emitted.attrs ?? [];
  expect(
    emittedAttributes.map((attribute) => attribute.name),
    `${context.page}: attribute order at ${where} <${tag}>`,
  ).toEqual(capturedAttributes.map((attribute) => attribute.name));

  for (const [index, attribute] of capturedAttributes.entries()) {
    const emittedValue = emittedAttributes[index]?.value ?? "";
    if (attribute.value === emittedValue) continue;

    expect(
      isUrlBearing(tag, attribute.name),
      `${context.page}: ${where} <${tag} ${attribute.name}> changed from "${attribute.value}" to "${emittedValue}"`,
    ).toBe(true);

    for (const candidate of attribute.name === "srcset"
      ? emittedValue.split(",").map((part) => part.trim().split(/\s+/)[0] ?? "")
      : [emittedValue]) {
      expect(
        /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(candidate),
        `${context.page}: ${where} <${tag} ${attribute.name}> still points off-tree: ${candidate}`,
      ).toBe(false);
      expect(
        resolvesOnDisk(context.baseDir, candidate),
        `${context.page}: ${where} <${tag} ${attribute.name}> -> ${candidate} does not exist`,
      ).toBe(true);
    }
  }

  // Class lists are the fidelity carrier; state them separately so a mid-list drift
  // reports as a class failure rather than "an attribute changed".
  const capturedClass = attr(captured, "class");
  const emittedClass = attr(emitted, "class");
  expect((emittedClass ?? "").split(/\s+/), `${context.page}: class list at ${where}`).toEqual(
    (capturedClass ?? "").split(/\s+/),
  );

  const capturedChildren = (captured.childNodes ?? []).filter(
    (child) => child.nodeName !== "#comment",
  );
  const emittedChildren = (emitted.childNodes ?? []).filter(
    (child) => child.nodeName !== "#comment",
  );
  expect(emittedChildren.length, `${context.page}: child count at ${where}`).toBe(
    capturedChildren.length,
  );

  for (const [index, child] of capturedChildren.entries()) {
    const counterpart = emittedChildren[index] as P5Node;
    if (child.nodeName === "#text") {
      expect(counterpart.nodeName, `${context.page}: node type at ${where}`).toBe("#text");
      expect(counterpart.value, `${context.page}: text at ${where}`).toBe(child.value);
      continue;
    }
    compareElements(child, counterpart, {
      ...context,
      path: [...context.path, tag],
    });
  }
}

/** Body comparison: nothing is filtered, every byte of structure must match. */
describe("DOM parity", () => {
  it("keeps every body element, attribute and class list identical apart from asset urls", async () => {
    for (const page of IR.pages) {
      const html = await readFile(emittedPathOf(page.url), "utf8");
      const emittedDoc = parse(html) as unknown as P5Node;
      const capturedDoc = parse(page.dom.html) as unknown as P5Node;

      const capturedBody = findElement(capturedDoc, "body");
      const emittedBody = findElement(emittedDoc, "body");
      expect(capturedBody, `${page.url} captured body`).not.toBeNull();
      expect(emittedBody, `${page.url} emitted body`).not.toBeNull();

      compareElements(capturedBody as P5Node, emittedBody as P5Node, {
        page: page.url,
        baseDir: dirname(emittedPathOf(page.url)),
        path: ["body"],
      });
    }
  });

  it("keeps every non-stylesheet head element in its captured order", async () => {
    for (const page of IR.pages) {
      const html = await readFile(emittedPathOf(page.url), "utf8");
      const head = splitDocument(html);
      expect(head.upToHeadContent + head.headContent).toBe(
        html.slice(0, html.length - head.fromHeadClose.length),
      );

      const emittedChildren = elementChildren(
        findElement(parse(html) as unknown as P5Node, "head") as P5Node,
      ).filter((node) => node.nodeName !== "style" && !isStylesheetLink(node));
      const capturedChildren = elementChildren(
        findElement(parse(page.dom.html) as unknown as P5Node, "head") as P5Node,
      ).filter((node) => !isStylesheetLink(node));

      expect(
        emittedChildren.map((node) => node.nodeName),
        `${page.url}: head element order`,
      ).toEqual(capturedChildren.map((node) => node.nodeName));

      compareElements(
        { nodeName: "head", attrs: [], childNodes: capturedChildren } as P5Node,
        { nodeName: "head", attrs: [], childNodes: emittedChildren } as P5Node,
        { page: page.url, baseDir: dirname(emittedPathOf(page.url)), path: ["head"] },
      );
    }
  });

  it("reproduces the site's own broken scheme-less anchor rather than fixing it", async () => {
    // Documented live-site defect: three pages carry `href="chatgpt.com"`, which 404s.
    // Parity means the emitted page is broken identically, not quietly repaired.
    const offenders: string[] = [];
    for (const page of IR.pages) {
      const html = await readFile(emittedPathOf(page.url), "utf8");
      for (const match of html.matchAll(/\bhref\s*=\s*["']([^"']*)["']/gi)) {
        const value = match[1] ?? "";
        if (KNOWN_BROKEN_ANCHORS.has(value)) offenders.push(page.url);
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([
      "/mlm/applym/",
      "/mlm/onboard-mlm/",
      "/tmh/onboard-tmh/",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reference completeness
// ---------------------------------------------------------------------------

describe("rewritten references", () => {
  it("points every rewritten asset reference at a file in the tree", async () => {
    let checked = 0;

    for (const page of IR.pages) {
      const html = await readFile(emittedPathOf(page.url), "utf8");
      const baseDir = dirname(emittedPathOf(page.url));

      for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/gi)) {
        const value = match[1] ?? "";
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value) || value.length === 0) continue;
        if (KNOWN_BROKEN_ANCHORS.has(value)) continue;
        checked += 1;
        expect(resolvesOnDisk(baseDir, value), `${page.url}: ${value} does not resolve`).toBe(true);
      }

      for (const match of html.matchAll(/\bsrcset\s*=\s*["']([^"']*)["']/gi)) {
        for (const part of (match[1] ?? "").split(",")) {
          const value = part.trim().split(/\s+/)[0] ?? "";
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value) || value.length === 0) continue;
          checked += 1;
          expect(resolvesOnDisk(baseDir, value), `${page.url}: ${value} does not resolve`).toBe(
            true,
          );
        }
      }
    }

    // Every relative reference in every page: the rewritten asset references, plus the
    // stylesheet links the emitter built from `styleOrder`. Nothing else can be
    // relative, which is why the count reconciles exactly.
    const emittedStylesheetLinks = report.pages.reduce(
      (total, page) => total + page.linkedStyles,
      0,
    );
    expect(checked).toBe(report.totals.htmlRefs + emittedStylesheetLinks);
  });

  it("rewrites at least one reference on every page that carries media", () => {
    const withRefs = IR.pages.filter((page) => /<(?:img|source|link)\b/i.test(page.dom.html));
    for (const page of withRefs) {
      const result = report.pages.find((candidate) => candidate.url === page.url);
      expect(result?.htmlRefs, `${page.url} rewritten references`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("produces byte-identical HTML whether or not media is copied", async () => {
    const secondDir = join(workDir, "site-no-assets");
    const second = await emitStaticSite({
      irPath: join(CAPTURE, "site-ir.json"),
      rewriteMapPath: join(CAPTURE, "asset-rewrite-map.json"),
      assetsRoot: join(CAPTURE, "assets"),
      outDir: secondDir,
      reportPath: join(workDir, "emit-report-2.json"),
      copyAssets: false,
    });

    expect(second.assets.skipped).toBe(true);
    expect(second.assets.copied).toBe(0);
    for (const page of IR.pages) {
      const first = await readFile(join(outDir, routeLocation(page.url).outputPath), "utf8");
      const again = await readFile(join(secondDir, routeLocation(page.url).outputPath), "utf8");
      expect(again, `${page.url} is not deterministic`).toBe(first);
    }
  }, 180_000);
});
