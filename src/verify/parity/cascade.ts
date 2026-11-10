/**
 * Cascade equality — `page.styleOrder` against the artefact's own `<style>`/`<link>`.
 *
 * The emitter rebuilds the page's CSS block from `page.styleOrder` and ships the
 * captured bytes, so the artefact's style sequence must be that list exactly: same
 * count, same order, same origin per position, and the same CSS bytes.
 *
 * Two details keep this honest rather than circular:
 *
 *  1. **The expected origins are re-derived from the capture**, not taken from the
 *     emitter's resolver: an entry is `linked` on this page iff its recorded `href`
 *     is still present in that page's captured `dom.html`. Nothing is asked of
 *     `src/emit/`.
 *  2. **The bytes are compared, positionally.** An inline block must equal the
 *     captured file outside `url()` bodies; a linked file must equal its captured
 *     file the same way. The stylesheet's emitted *location* is not part of the
 *     claim — what matters is that the bytes at that location are the bytes the
 *     capture recorded — so a swapped pair is caught by the bytes, not by the path.
 *
 * Every `url()` body that differs must be the substitution
 * `capture/asset-rewrite-map.json` prescribes, resolved relative to the page (inline)
 * or to the stylesheet's own directory (linked).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { ASSET_HOME, INLINE_STYLE_HOME, STYLE_HOME } from "../../emit/static-html/index.js";
import { lookupRewrite, relativePrefix } from "../../emit/static-html/rewrite.js";
import type { RewriteTable } from "../../emit/static-html/rewrite.js";
import type { Page, SiteIr, Style } from "../../schema/site-ir.js";
import { isLinkedStyle } from "../../schema/site-ir.js";
import {
  attributeOf,
  elementChildren,
  isStylesheetLink,
  isStyleNode,
  nodeLabel,
  textContent,
  type HtmlNode,
} from "./dom.js";
import type { ParityFailure } from "./types.js";

/** One resolved cascade entry, re-derived from the capture. */
interface ExpectedEntry {
  readonly sha256: string;
  readonly origin: "linked" | "inline";
  readonly style: Style;
}

/** The cascade comparison's measurements plus its first failures. */
export interface CascadeResult {
  readonly stylesCompared: number;
  readonly inlineCssRewrites: number;
  readonly linkedCssRewrites: number;
  readonly linkedFilesVerified: number;
  readonly failures: readonly ParityFailure[];
}

export interface CascadeOptions {
  readonly page: Page;
  readonly ir: SiteIr;
  readonly emittedDocument: HtmlNode;
  readonly assetsRoot: string;
  readonly outDir: string;
  readonly emittedPagePath: string;
  readonly table: RewriteTable;
  readonly dirDepth: number;
}

/** CSS split into its `url()` bodies and the literal text between them. */
export function splitCss(css: string): { segments: string[]; urls: string[] } {
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

function sha256(css: string): string {
  return createHash("sha256").update(css, "utf8").digest("hex");
}

/**
 * A stylesheet's identity for diagnostics: the text outside its `url()` bodies.
 *
 * Used only to say *which* entry a drifted position actually holds, so a reordering
 * reports as "this position ships the CSS captured at position 3" instead of a
 * 200-character byte diff.
 */
function cssFingerprint(css: string): string {
  return splitCss(css).segments.join("\u0000");
}

/** Where a linked stylesheet's captured bytes may live, per the documented capture layout. */
function capturedLinkedCandidates(style: Style, assetsRoot: string): string[] {
  if (!isLinkedStyle(style)) return [];
  return [
    join(assetsRoot, STYLE_HOME, style.localPath),
    join(assetsRoot, ASSET_HOME, style.localPath),
  ];
}

function capturedInlinePath(style: Style, assetsRoot: string): string {
  return join(assetsRoot, INLINE_STYLE_HOME, `${style.sha256}.css`);
}

/** Read the captured bytes for an entry, failing loudly when they are not there. */
function readCapturedCss(style: Style, assetsRoot: string): { css: string; path: string } | null {
  const candidates = isLinkedStyle(style)
    ? capturedLinkedCandidates(style, assetsRoot)
    : [capturedInlinePath(style, assetsRoot)];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return { css: readFileSync(candidate, "utf8"), path: candidate };
  }
  return null;
}

/**
 * Resolve `page.styleOrder` to concrete entries.
 *
 * The only judgement call is the one the capture forces: two `styles[]` entries can
 * share a `sha256` (Divi's inline critical CSS and a customizer stylesheet are the
 * same 977 bytes), and no page loads both — so a page's own `dom.html` decides which
 * one a position names.
 */
export function resolveExpectedCascade(
  page: Page,
  ir: SiteIr,
): { entries: ExpectedEntry[] } | { problem: string } {
  const order = page.styleOrder;
  if (order === undefined) {
    return {
      problem: `page has no styleOrder; there is no captured cascade to verify the artefact against`,
    };
  }

  const entries: ExpectedEntry[] = [];
  for (const [position, hash] of order.entries()) {
    const candidates = ir.styles.filter((style) => style.sha256 === hash);
    if (candidates.length === 0) {
      return {
        problem: `styleOrder position ${String(position)} names ${hash}, which no styles[] entry has`,
      };
    }
    const [only] = candidates;
    if (candidates.length === 1 && only !== undefined) {
      entries.push({
        sha256: hash,
        origin: isLinkedStyle(only) ? "linked" : "inline",
        style: only,
      });
      continue;
    }

    const linkedHere = candidates.filter(
      (style) => isLinkedStyle(style) && page.dom.html.includes(style.href),
    );
    const [linked] = linkedHere;
    if (linkedHere.length === 1 && linked !== undefined) {
      entries.push({ sha256: hash, origin: "linked", style: linked });
      continue;
    }

    const inline = candidates.filter((style) => !isLinkedStyle(style));
    const [inlineOnly] = inline;
    if (linkedHere.length === 0 && inline.length === 1 && inlineOnly !== undefined) {
      entries.push({ sha256: hash, origin: "inline", style: inlineOnly });
      continue;
    }

    return {
      problem: `styleOrder position ${String(position)} is ambiguous: ${hash} names ${String(candidates.length)} styles[] entries`,
    };
  }
  return { entries };
}

/** The emitted cascade nodes, in document order. */
function emittedCascadeNodes(document: HtmlNode): HtmlNode[] {
  const head = findHead(document);
  if (head === null) return [];
  return elementChildren(head).filter((node) => isStyleNode(node) || isStylesheetLink(node));
}

function findHead(node: HtmlNode): HtmlNode | null {
  if (node.nodeName === "head") return node;
  for (const child of node.childNodes ?? []) {
    const found = findHead(child);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Compare one captured CSS file against one emitted block.
 *
 * The contract is narrow on purpose: every byte outside `url()` is identical, and
 * every `url()` that moved is the map's substitution for it. `dirDepth` is the
 * directory the reference resolves against — the page for an inline block, the
 * stylesheet's own directory for a linked file.
 */
function compareCss(
  capturedCss: string,
  emittedCss: string,
  table: RewriteTable,
  dirDepth: number,
): { rewrites: number; problem: string | null } {
  const before = splitCss(capturedCss);
  const after = splitCss(emittedCss);

  if (before.urls.length !== after.urls.length) {
    return {
      rewrites: 0,
      problem: `url() token count changed: the capture has ${String(before.urls.length)}, the artefact has ${String(after.urls.length)}`,
    };
  }
  for (const [index, segment] of before.segments.entries()) {
    const counterpart = after.segments[index] as string;
    if (counterpart === segment) continue;
    return {
      rewrites: 0,
      problem: `CSS differs outside url() at segment ${String(index)}: expected ${JSON.stringify(segment.slice(0, 80))}, found ${JSON.stringify(counterpart.slice(0, 80))}`,
    };
  }

  let rewrites = 0;
  for (const [index, url] of before.urls.entries()) {
    const emittedUrl = after.urls[index] as string;
    if (emittedUrl === url) continue;
    const hit = lookupRewrite(table, url.trim());
    const expected = hit === null ? null : `${relativePrefix(dirDepth)}${hit.path}${hit.suffix}`;
    if (expected === null || emittedUrl !== expected) {
      return {
        rewrites: 0,
        problem: `url() ${JSON.stringify(url.slice(0, 80))} changed to ${JSON.stringify(emittedUrl.slice(0, 80))}, which the asset map does not prescribe`,
      };
    }
    rewrites += 1;
  }
  return { rewrites, problem: null };
}

/** Verify one page's cascade against `page.styleOrder`. */
export function verifyCascade(options: CascadeOptions): CascadeResult {
  const { page, table } = options;
  const failures: ParityFailure[] = [];
  const fail = (path: string, message: string, expected?: string, actual?: string): void => {
    if (failures.length > 0) return;
    failures.push({
      check: "cascade",
      page: page.url,
      path,
      message,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
    });
  };

  const resolution = resolveExpectedCascade(page, options.ir);
  if ("problem" in resolution) {
    fail("html > head", resolution.problem);
    return {
      stylesCompared: 0,
      inlineCssRewrites: 0,
      linkedCssRewrites: 0,
      linkedFilesVerified: 0,
      failures,
    };
  }
  const expected = resolution.entries;
  const emitted = emittedCascadeNodes(options.emittedDocument);

  if (emitted.length !== expected.length) {
    fail(
      "html > head",
      `the artefact ships ${String(emitted.length)} style entries, page.styleOrder has ${String(expected.length)}`,
      expected.map((entry) => entry.origin).join(" "),
      emitted.map(nodeLabel).join(" "),
    );
    return {
      stylesCompared: 0,
      inlineCssRewrites: 0,
      linkedCssRewrites: 0,
      linkedFilesVerified: 0,
      failures,
    };
  }

  let inlineCssRewrites = 0;
  let linkedCssRewrites = 0;
  let linkedFilesVerified = 0;
  let stylesCompared = 0;

  // Read every captured block once, and index the CSS *outside* its url() bodies so a
  // drifted position can name the entry it actually holds.
  const capturedBlobs = expected.map((entry) => readCapturedCss(entry.style, options.assetsRoot));
  const positionsByFingerprint = new Map<string, number[]>();
  for (const [index, blob] of capturedBlobs.entries()) {
    if (blob === null) continue;
    const fingerprint = cssFingerprint(blob.css);
    const bucket = positionsByFingerprint.get(fingerprint) ?? [];
    bucket.push(index);
    positionsByFingerprint.set(fingerprint, bucket);
  }

  /** If this position holds another position's CSS, say which one. */
  const misdelivered = (position: number, emittedCss: string): string | null => {
    const owners = positionsByFingerprint.get(cssFingerprint(emittedCss)) ?? [];
    const others = owners.filter((candidate) => candidate !== position);
    if (others.length === 0) return null;
    return `this position ships the CSS captured at position ${others.join(", ")} — the cascade order drifted`;
  };

  for (const [position, entry] of expected.entries()) {
    const node = emitted[position] as HtmlNode;
    const path = `html > head > ${nodeLabel(node)}[${String(position)}]`;
    const isInline = isStyleNode(node);
    const actualOrigin = isInline ? "inline" : "linked";

    if (actualOrigin !== entry.origin) {
      fail(path, `position ${String(position)} has the wrong origin`, entry.origin, actualOrigin);
      break;
    }

    const captured = capturedBlobs[position] ?? null;
    if (captured === null) {
      fail(
        path,
        `the capture holds no bytes for ${entry.sha256} (${entry.style.localPath}); nothing to verify against`,
      );
      break;
    }

    // The record must describe the bytes: a capture that drifted from its own hashes
    // cannot certify anything.
    const capturedHash = sha256(captured.css);
    if (capturedHash !== entry.sha256) {
      fail(
        path,
        `captured bytes at ${captured.path} hash to ${capturedHash}, but the IR records ${entry.sha256}`,
        entry.sha256,
        capturedHash,
      );
      break;
    }

    const expectedMedia = entry.style.media ?? null;
    const actualMedia = attributeOf(node, "media");
    if (actualMedia !== expectedMedia) {
      fail(
        path,
        "the media attribute does not match the captured entry",
        String(expectedMedia),
        String(actualMedia),
      );
      break;
    }

    stylesCompared += 1;

    if (isInline) {
      const emittedCss = textContent(node);
      const comparison = compareCss(captured.css, emittedCss, table, options.dirDepth);
      if (comparison.problem !== null) {
        fail(path, misdelivered(position, emittedCss) ?? comparison.problem);
        break;
      }
      inlineCssRewrites += comparison.rewrites;
      continue;
    }

    // A linked file: the href must resolve to a real file inside the artefact.
    const href = attributeOf(node, "href") ?? "";
    if (href.length === 0) {
      fail(path, "a linked stylesheet has no href");
      break;
    }
    const file = resolve(dirname(options.emittedPagePath), href.split(/[?#]/)[0] ?? "");
    if (!existsSync(file)) {
      fail(path, `linked stylesheet ${href} does not exist in the artefact`, file);
      break;
    }
    const inside = relative(options.outDir, file);
    if (inside.startsWith("..") || resolve(options.outDir, inside) !== file) {
      fail(path, `linked stylesheet ${href} resolves outside the artefact`);
      break;
    }

    const emittedCss = readFileSync(file, "utf8");
    const stylesheetDepth = inside.split(/[\\/]/).length - 1;
    const comparison = compareCss(captured.css, emittedCss, table, stylesheetDepth);
    if (comparison.problem !== null) {
      fail(path, `${inside}: ${misdelivered(position, emittedCss) ?? comparison.problem}`);
      break;
    }
    linkedCssRewrites += comparison.rewrites;
    linkedFilesVerified += 1;
  }

  return {
    stylesCompared,
    inlineCssRewrites,
    linkedCssRewrites,
    linkedFilesVerified,
    failures,
  };
}
