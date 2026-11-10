/**
 * The style-chain rebuild — `page.styleOrder` is the cascade authority.
 *
 * What the captured document says and what the IR can represent are not the same
 * thing:
 *
 *  - `dom.html` still carries the `<link rel="stylesheet">` tags and Divi's deferred
 *    `<link rel="preload" as="style">` tags that were in the `<head>`, but **not**
 *    the `<style>` blocks: DOM normalisation deleted those nodes, leaving their
 *    bytes in `capture/assets` with a recorded `sha256`.
 *  - `styles[]` holds both kinds in one site-level sequence, and `page.styleOrder`
 *    holds the page's own cascade as an ordered list of `sha256` values.
 *
 * So the `<link>` tags are evidence of *which* linked sheets a page had, never the
 * authority on order, and the inline blocks are not in the document at all. The
 * emitter rebuilds one contiguous style block from `styleOrder`:
 *
 *  - every non-stylesheet `<head>` element keeps its captured bytes and its
 *    position relative to the other non-stylesheet elements;
 *  - all stylesheet `<link>` tags, and every deferred link whose bytes the cascade
 *    carries, are removed and the whole chain is emitted where the first one stood;
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
  /**
   * True for Divi's deferred form (`rel="preload" as="style" onload="…"`), which is
   * a stylesheet the browser applies once its preload finishes, not a stylesheet
   * link in the captured markup.
   */
  readonly deferred: boolean;
}

/** An attribute inside a tag, with the span it occupies. */
interface TagAttribute {
  readonly name: string;
  readonly value: string;
  /** Offset of the name inside the tag. */
  readonly nameStart: number;
  /** Offset of the value inside the tag, including quotes. */
  readonly start: number;
  readonly end: number;
  /** Verbatim source text, e.g. `media='all'`. */
  readonly raw: string;
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
      nameStart: match.index,
      start,
      end: start + rawValue.length,
      raw: tag.slice(match.index, start + rawValue.length),
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

/** Divi's deferred form: `rel="preload" as="style"` (normally with `onload`). */
function isDeferredStyleLink(attributes: readonly TagAttribute[]): boolean {
  const rel = attributeValue(attributes, "rel");
  if (rel === null) return false;
  const tokens = rel.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.includes("preload")) return false;
  return (attributeValue(attributes, "as") ?? "").trim().toLowerCase() === "style";
}

function linksWhere(
  headHtml: string,
  predicate: (attributes: readonly TagAttribute[]) => boolean,
  deferred: boolean,
): CapturedStyleLink[] {
  const links: CapturedStyleLink[] = [];
  for (const match of headHtml.matchAll(/<link\b[^>]*>/gi)) {
    const text = match[0];
    const attributes = tagAttributes(text);
    if (!predicate(attributes)) continue;
    const start = match.index;
    links.push({
      text,
      start,
      end: start + text.length,
      href: attributeValue(attributes, "href"),
      deferred,
    });
  }
  return links;
}

/**
 * Find the captured `<link rel="stylesheet">` tags in a head's content.
 *
 * A deferred (`rel="preload" as="style"`) link is **not** included: it is a
 * different element with a different meaning, and the caller decides separately
 * whether its bytes are now represented in the page's cascade (see
 * {@link findDeferredStyleLinks}).
 */
export function findStylesheetLinks(headHtml: string): CapturedStyleLink[] {
  return linksWhere(headHtml, isStylesheetLink, false);
}

/**
 * Find the captured deferred stylesheet links (`rel="preload" as="style"`) in a
 * head's content.
 *
 * Divi emits one or two per page for its per-page dynamic CSS. Once those bytes are
 * captured and placed in `page.styleOrder`, the element is re-emitted as a normal
 * stylesheet link by the cascade rebuild and the preload tag must not survive — a
 * page would otherwise load the CSS twice. An href the cascade does **not** carry
 * is genuinely unknown, and is preserved and reported rather than dropped.
 */
export function findDeferredStyleLinks(headHtml: string): CapturedStyleLink[] {
  return linksWhere(headHtml, isDeferredStyleLink, true);
}

/** Every captured link the cascade rebuild manages, in document order. */
export function findCascadeStyleLinks(headHtml: string): CapturedStyleLink[] {
  return [...findStylesheetLinks(headHtml), ...findDeferredStyleLinks(headHtml)].sort(
    (left, right) => left.start - right.start,
  );
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
  if (captured === null) {
    const media = style.media === undefined ? "" : ` media="${style.media}"`;
    return `<link rel="stylesheet" href="${href}"${media} />`;
  }
  if (captured.deferred) return renderDeferredAsStylesheet(captured, href);
  return withHref(captured.text, href);
}

/**
 * Turn a captured deferred tag into a real stylesheet link.
 *
 * The element the capture recorded is `<link rel="preload" as="style" id="…"
 * href="…" onload="this.onload=null;this.rel='stylesheet';" />`. Its bytes are now
 * part of the page's cascade, so it is re-emitted in the cascade block as a normal
 * `<link rel="stylesheet">`: `as` and `onload` are dropped (they would be either
 * meaningless or a second load), `rel` is set to `stylesheet`, and `href` points at
 * the emitted copy. Every other captured attribute — `id`, `media`, … — survives,
 * in its captured order, so the node keeps its identity in the document.
 */
export function renderDeferredAsStylesheet(captured: CapturedStyleLink, href: string): string {
  const attributes = tagAttributes(captured.text);
  const parts: string[] = [];
  let hasRel = false;
  for (const attribute of attributes) {
    if (attribute.name === "as" || attribute.name === "onload") continue;
    if (attribute.name === "href") {
      parts.push(`href="${href}"`);
      continue;
    }
    if (attribute.name === "rel") {
      parts.push('rel="stylesheet"');
      hasRel = true;
      continue;
    }
    parts.push(attribute.raw);
  }
  if (!hasRel) parts.unshift('rel="stylesheet"');
  return `<link ${parts.join(" ")} />`;
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
  /** How many captured stylesheet links were removed. */
  readonly removedLinks: number;
  /** How many deferred preload tags the cascade represented and so replaced. */
  readonly replacedDeferredLinks: number;
  /** How many deferred preload tags stayed captured because no cascade entry carries them. */
  readonly preservedDeferredLinks: number;
  /** URL substitutions performed inside inline `<style>` blocks. */
  readonly cssRewrites: number;
}

/**
 * Rebuild a page's `<head>` content: remove every captured stylesheet `<link>` and
 * every deferred link the cascade now represents, and emit `styleOrder` as one
 * contiguous block where the first of them stood.
 *
 * A deferred (`rel="preload" as="style"`) link whose href **is** in the sequence is
 * replaced by the cascade's own stylesheet link — keeping it as well would load the
 * same CSS twice. A deferred link whose href is absent from the sequence was never
 * captured, so it is left byte-identical and counted in `preservedDeferredLinks`:
 * preserving-and-reporting is the honest outcome, dropping it is not.
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
  const links = findCascadeStyleLinks(headHtml);
  const linkedHrefs = new Set(
    sequence
      .filter((entry) => entry.origin === "linked" && entry.href !== undefined)
      .map((entry) => (entry.href as string).trim()),
  );
  const removals = links.filter(
    (link) => !link.deferred || (link.href !== null && linkedHrefs.has(link.href.trim())),
  );
  const preservedDeferredLinks = links.filter(
    (link) => link.deferred && !removals.includes(link),
  ).length;
  const insertionPoint = removals[0]?.start ?? headHtml.length;

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

  // One pass: copy the head up to the first managed link, drop every managed link,
  // and emit the whole chain where the first one was.
  let cursor = 0;
  let rebuilt = "";
  for (const link of removals) {
    rebuilt += headHtml.slice(cursor, link.start);
    if (link.start === insertionPoint && link === removals[0]) rebuilt += markup;
    cursor = link.end;
  }
  rebuilt += headHtml.slice(cursor);
  if (removals.length === 0) {
    rebuilt = `${headHtml.slice(0, insertionPoint)}${markup}${headHtml.slice(insertionPoint)}`;
  }

  return {
    headHtml: rebuilt,
    sequence: [...sequence],
    markup,
    removedLinks: removals.length,
    replacedDeferredLinks: removals.filter((link) => link.deferred).length,
    preservedDeferredLinks,
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
