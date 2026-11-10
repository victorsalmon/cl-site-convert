/**
 * The style-chain rebuild — `page.styleOrder` is the cascade authority.
 *
 * What the captured document says and what the IR can represent are not the same
 * thing:
 *
 *  - `dom.html` still carries the `<link rel="stylesheet">` tags that were in the
 *    `<head>`, but **not** the `<style>` blocks: DOM normalisation deleted those
 *    nodes, leaving their bytes in `capture/assets` with a recorded `sha256`.
 *  - `styles[]` holds both kinds in one site-level sequence, and `page.styleOrder`
 *    holds the page's own cascade as an ordered list of `sha256` values.
 *
 * So the `<link>` tags are evidence of *which* linked sheets a page had, never the
 * authority on order, and the inline blocks are not in the document at all. The
 * emitter rebuilds one contiguous style block from `styleOrder`:
 *
 *  - every non-stylesheet `<head>` element keeps its captured bytes and its
 *    position relative to the other non-stylesheet elements;
 *  - all stylesheet `<link>` tags are removed and the whole chain is emitted where
 *    the first one stood;
 *  - a page whose emitted sequence does not match `styleOrder` **exactly** — count,
 *    order, origin — fails the build. This module cannot return a drifting chain.
 *
 * Losing the distinction between "this inline block came before that link" is not
 * possible here: the sequence emitted is `styleOrder` itself, in order. What is
 * deliberately not attempted is reconstructing the *interleaved* positions of
 * inline blocks between non-CSS elements, because the capture did not record them
 * and inventing them would be the drift this rebuild exists to prevent.
 */

import type { Page, Style } from "../../schema/site-ir.js";
import { isLinkedStyle } from "../../schema/site-ir.js";
import type { RewriteTable } from "./rewrite.js";
import { relativePrefix, rewriteCssUrls } from "./rewrite.js";

/** Where a chain entry's CSS came from. Absent `origin` in the IR means `linked`. */
export type StyleOrigin = "linked" | "inline";

/** One resolved cascade entry: an IR `styles[]` entry plus its emitted location. */
export interface CascadeEntry {
  /** Site-chain index, kept so a report can cite the captured entry. */
  readonly order: number;
  readonly origin: StyleOrigin;
  readonly sha256: string;
  /** Path inside the emitted tree, e.g. `wp-content/…/app.min.css`. */
  readonly emittedPath: string;
  /** Captured url for a linked entry; absent for inline CSS. */
  readonly href?: string;
  readonly media?: string;
}

/** Thrown when a page's cascade cannot be resolved, or does not round-trip. */
export class CascadeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CascadeError";
  }
}

/**
 * The emitted file path for a linked stylesheet.
 *
 * `localPath` mirrors the captured absolute path, which is what keeps the CSS's own
 * relative `url(...)` references resolving. Three captured sheets (Google Fonts)
 * have no extension, and a host that sniffs nothing serves those as
 * `application/octet-stream`, which a browser refuses to apply as CSS — so a
 * missing `.css` extension is appended *in the same directory*. Renaming in place
 * cannot invalidate a relative reference.
 */
export function emittedStylePath(style: Style): string {
  const path = style.localPath;
  return /\.css$/i.test(path) ? path : `${path}.css`;
}

/** Index `styles[]` by `sha256`; the per-page cascade is a list of those hashes. */
export function indexStyles(styles: readonly Style[]): Map<string, Style[]> {
  const index = new Map<string, Style[]>();
  for (const style of styles) {
    const bucket = index.get(style.sha256);
    if (bucket === undefined) index.set(style.sha256, [style]);
    else bucket.push(style);
  }
  return index;
}

/**
 * Resolve one page's cascade, in order.
 *
 * `styleOrder` is a list of hashes, and the capture holds 55 entries for 54 distinct
 * hashes: the inline `#et-critical-inline-css` block and the linked
 * `et-divi-customizer-global.min.css` are the same 977 bytes. No page loads both, so
 * a hash still names exactly one entry *within a page* — and the page's own
 * `dom.html` says which one, because a linked sheet's `href` is still in the
 * document. That is the only disambiguation used; there is no guessing and no
 * fallback to the site chain.
 */
export function resolvePageCascade(page: Page, index: Map<string, Style[]>): CascadeEntry[] {
  const order = page.styleOrder;
  if (order === undefined) {
    // A v1.0 document without a cascade would silently inherit the site chain, which
    // for this artifact means shipping CSS the page never had. Refuse instead.
    throw new CascadeError(
      `page ${page.url} has no styleOrder; the emitter will not fall back to the site-wide chain`,
    );
  }

  return order.map((sha256, position) => {
    const candidates = index.get(sha256);
    if (candidates === undefined || candidates.length === 0) {
      throw new CascadeError(
        `page ${page.url} position ${position} references ${sha256}, which no styles[] entry has`,
      );
    }

    const style = disambiguate(page, candidates, position, sha256);
    const entry: CascadeEntry = {
      order: style.order,
      origin: isLinkedStyle(style) ? "linked" : "inline",
      sha256: style.sha256,
      emittedPath: isLinkedStyle(style) ? emittedStylePath(style) : style.localPath,
      ...(isLinkedStyle(style) ? { href: style.href } : {}),
      ...(style.media === undefined ? {} : { media: style.media }),
    };
    return entry;
  });
}

function disambiguate(
  page: Page,
  candidates: readonly Style[],
  position: number,
  sha256: string,
): Style {
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return only;

  const capturedHtml = page.dom.html;
  const linkedHere = candidates.filter(
    (style) => isLinkedStyle(style) && capturedHtml.includes(style.href),
  );
  if (linkedHere.length === 1) {
    const [match] = linkedHere;
    if (match !== undefined) return match;
  }

  const inline = candidates.filter((style) => !isLinkedStyle(style));
  if (inline.length === 1 && linkedHere.length === 0) {
    const [match] = inline;
    if (match !== undefined) return match;
  }

  throw new CascadeError(
    `page ${page.url} position ${position} is ambiguous: ${sha256} names ` +
      `${candidates.length} styles[] entries (orders ${candidates
        .map((style) => style.order)
        .join(", ")}) and ${linkedHere.length} of them are linked from this page`,
  );
}

/** A stylesheet `<link>` found in the captured head. */
export interface CapturedStyleLink {
  /** Verbatim tag text, e.g. `<link rel='stylesheet' id='x' href='…' media='all' />`. */
  readonly text: string;
  /** Offset of the tag inside the head content. */
  readonly start: number;
  /** Offset just past the tag. */
  readonly end: number;
  /** Raw `href` value, unquoted; `null` when the tag has none. */
  readonly href: string | null;
}

/** An attribute inside a tag, with the span it occupies. */
interface TagAttribute {
  readonly name: string;
  readonly value: string;
  /** Offset of the value inside the tag, including quotes. */
  readonly start: number;
  readonly end: number;
}

const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/g;

function tagAttributes(tag: string): TagAttribute[] {
  const attributes: TagAttribute[] = [];
  for (const match of tag.matchAll(ATTRIBUTE_PATTERN)) {
    const rawValue = match[3] ?? "";
    const name = match[1] ?? "";
    const separator = match[2] ?? "";
    const start = match.index + name.length + separator.length;
    const quoted = rawValue.length >= 2 && (rawValue.startsWith('"') || rawValue.startsWith("'"));
    attributes.push({
      name: name.toLowerCase(),
      value: quoted ? rawValue.slice(1, -1) : rawValue,
      start,
      end: start + rawValue.length,
    });
  }
  return attributes;
}

function attributeValue(attributes: readonly TagAttribute[], name: string): string | null {
  const found = attributes.find((attribute) => attribute.name === name);
  return found === undefined ? null : found.value;
}

/** `rel` is a space-separated token list; `stylesheet` must be one of the tokens. */
function isStylesheetLink(attributes: readonly TagAttribute[]): boolean {
  const rel = attributeValue(attributes, "rel");
  if (rel === null) return false;
  return rel.toLowerCase().split(/\s+/).filter(Boolean).includes("stylesheet");
}

/**
 * Find the captured stylesheet links in a head's content.
 *
 * `rel="preload" as="style" onload="this.rel='stylesheet'"` is deliberately **not** a
 * stylesheet link: it is a non-stylesheet head element for this purpose, it is kept,
 * and its href is whatever the capture recorded. Deferred-CSS capture is a separate
 * gap, reported rather than silently reordered.
 */
export function findStylesheetLinks(headHtml: string): CapturedStyleLink[] {
  const links: CapturedStyleLink[] = [];
  for (const match of headHtml.matchAll(/<link\b[^>]*>/gi)) {
    const text = match[0];
    const attributes = tagAttributes(text);
    if (!isStylesheetLink(attributes)) continue;
    const start = match.index;
    links.push({
      text,
      start,
      end: start + text.length,
      href: attributeValue(attributes, "href"),
    });
  }
  return links;
}

/** Replace a tag's `href` value in place, keeping every other byte of the tag. */
function withHref(tag: string, href: string): string {
  const attributes = tagAttributes(tag);
  const target = attributes.find((attribute) => attribute.name === "href");
  if (target === undefined) {
    throw new CascadeError(`captured stylesheet tag has no href: ${tag}`);
  }
  return `${tag.slice(0, target.start)}"${href}"${tag.slice(target.end)}`;
}

/** An inline `<style>` block wrapping the shipped bytes exactly. */
export function renderInlineStyle(style: CascadeEntry, css: string): string {
  const media = style.media === undefined ? "" : ` media="${style.media}"`;
  return `<style${media}>${css}</style>`;
}

/** A linked stylesheet tag, reusing the captured tag's attributes when there is one. */
export function renderLinkedStyle(
  style: CascadeEntry,
  href: string,
  captured: CapturedStyleLink | null,
): string {
  if (captured !== null) return withHref(captured.text, href);
  const media = style.media === undefined ? "" : ` media="${style.media}"`;
  return `<link rel="stylesheet" href="${href}"${media} />`;
}

/** One entry's emitted markup, plus the inline-CSS rewrite count it contributed. */
export interface RenderedStyle {
  readonly markup: string;
  readonly cssRewrites: number;
}

/**
 * Render one cascade entry.
 *
 * `css` is the captured file's bytes. With `table` absent the bytes are wrapped
 * verbatim — that is the "before rewriting" artifact the byte-level test asserts
 * against.
 */
export function renderCascadeEntry(
  style: CascadeEntry,
  css: string | null,
  options: {
    readonly dirDepth: number;
    readonly table: RewriteTable | null;
    readonly captured: CapturedStyleLink | null;
  },
): RenderedStyle {
  if (style.origin === "linked") {
    const href = `${relativePrefix(options.dirDepth)}${style.emittedPath}`;
    return { markup: renderLinkedStyle(style, href, options.captured), cssRewrites: 0 };
  }

  if (css === null) {
    throw new CascadeError(`inline style ${style.sha256} has no captured bytes to emit`);
  }
  const rewritten =
    options.table === null
      ? { text: css, count: 0 }
      : rewriteCssUrls(css, options.table, options.dirDepth);
  return {
    markup: renderInlineStyle(style, rewritten.text),
    cssRewrites: rewritten.count,
  };
}

/** The rebuilt head content plus the evidence that it matches `styleOrder`. */
export interface RebuiltHead {
  /** Head content (`<head>`/`</head>` excluded), ready to ship. */
  readonly headHtml: string;
  /** The emitted sequence, in order: proof that it equals `styleOrder`. */
  readonly sequence: readonly CascadeEntry[];
  /** The contiguous style block, for a report or a focused assertion. */
  readonly markup: string;
  /** How many captured `<link rel="stylesheet">` tags were removed. */
  readonly removedLinks: number;
  /** URL substitutions performed inside inline `<style>` blocks. */
  readonly cssRewrites: number;
}

/**
 * Rebuild a page's `<head>` content: remove every captured stylesheet `<link>` and
 * emit `styleOrder` as one contiguous block where the first link stood.
 *
 * The caller supplies `cssFor(entry)`, because the bytes live on disk and this
 * module stays pure.
 */
export function rebuildHead(
  headHtml: string,
  sequence: readonly CascadeEntry[],
  options: {
    readonly dirDepth: number;
    readonly table: RewriteTable | null;
    readonly cssFor: (entry: CascadeEntry) => string | null;
  },
): RebuiltHead {
  const links = findStylesheetLinks(headHtml);
  const insertionPoint = links[0]?.start ?? headHtml.length;

  const byHref = new Map<string, CapturedStyleLink>();
  for (const link of links) {
    if (link.href !== null) byHref.set(link.href.trim(), link);
  }

  const pieces: string[] = [];
  let cssRewrites = 0;
  for (const entry of sequence) {
    const captured = entry.href === undefined ? null : (byHref.get(entry.href) ?? null);
    const rendered = renderCascadeEntry(
      entry,
      entry.origin === "inline" ? options.cssFor(entry) : null,
      {
        dirDepth: options.dirDepth,
        table: options.table,
        captured,
      },
    );
    cssRewrites += rendered.cssRewrites;
    pieces.push(rendered.markup);
  }
  const markup = pieces.join("\n");

  // One pass: copy the head up to the first stylesheet link, drop every stylesheet
  // link, and emit the whole chain where the first one was.
  let cursor = 0;
  let rebuilt = "";
  for (const link of links) {
    rebuilt += headHtml.slice(cursor, link.start);
    if (link.start === insertionPoint && link === links[0]) rebuilt += markup;
    cursor = link.end;
  }
  rebuilt += headHtml.slice(cursor);
  if (links.length === 0) {
    rebuilt = `${headHtml.slice(0, insertionPoint)}${markup}${headHtml.slice(insertionPoint)}`;
  }

  return {
    headHtml: rebuilt,
    sequence: [...sequence],
    markup,
    removedLinks: links.length,
    cssRewrites,
  };
}

/**
 * The strict check: the emitted sequence must be `styleOrder` exactly — same count,
 * same order, same origin per position.
 *
 * It compares against the resolved entries rather than the markup text, so a bug
 * that reordered, dropped or duplicated an entry cannot pass by looking plausible.
 */
export function assertSequenceMatchesCascade(page: Page, sequence: readonly CascadeEntry[]): void {
  const expected = page.styleOrder;
  if (expected === undefined) {
    throw new CascadeError(`page ${page.url} has no styleOrder to verify against`);
  }
  if (sequence.length !== expected.length) {
    throw new CascadeError(
      `page ${page.url}: emitted ${sequence.length} style entries, styleOrder has ${expected.length}`,
    );
  }
  for (const [position, entry] of sequence.entries()) {
    if (entry.sha256 !== expected[position]) {
      throw new CascadeError(
        `page ${page.url}: emitted entry ${position} is ${entry.sha256}, styleOrder says ${String(
          expected[position],
        )}`,
      );
    }
  }
}

/** Count the two origins in a sequence, for a report line. */
export function countOrigins(sequence: readonly CascadeEntry[]): {
  linked: number;
  inline: number;
} {
  let linked = 0;
  let inline = 0;
  for (const entry of sequence) {
    if (entry.origin === "linked") linked += 1;
    else inline += 1;
  }
  return { linked, inline };
}
