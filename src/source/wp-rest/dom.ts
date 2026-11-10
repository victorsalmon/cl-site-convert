/**
 * DOM normalisation for captured rendered pages — the fidelity carrier.
 *
 * This file is deliberately **string surgery, not a DOM round-trip**. Parsing the
 * page into a tree and re-serialising it would rewrite attribute quoting, entity
 * spelling and void-element syntax, and any of those can change rendering. The
 * only defensible normalisation is deletion: whole elements and comments are cut
 * out, and every surviving byte stays where the server put it.
 *
 * What is removed (and nothing else):
 *
 *  1. `<script>` elements — including inline tracking, the Divi config blob and
 *     the WP emoji loader. JSON-LD must be read *before* calling this.
 *  2. `<style>` elements — see the warning on `StrippedNode` below: on Divi these
 *     carry the per-page critical CSS, so removing them is a real fidelity loss
 *     that a stylesheet-capture pass has to repay.
 *  3. HTML comments — Divi's `<!-- #main-header -->` closing markers and the
 *     LiteSpeed cache stamp. Conditional (`<!--[if …]>`) comments are kept: they
 *     are the one comment form that can affect rendering.
 *  4. The WordPress admin bar (`#wpadminbar`) — only present for logged-in users.
 *  5. Inline telemetry: tracking pixels (`<img>`), resource hints (`<link
 *     rel=preconnect|dns-prefetch|prefetch|prerender>`) and tracking frames whose
 *     URL matches a known analytics host. A stylesheet `<link>` is never removed
 *     by this rule.
 *
 * Whitespace: CR/CRLF become LF (the HTML parser does this itself, so it cannot
 * change rendering, and it makes byte offsets stable); nothing else is collapsed.
 * Inter-element whitespace is layout in an inline formatting context and is left
 * exactly as captured.
 *
 * Every removal is recorded with its byte size and, for `<style>`/`<script>`
 * payloads, a SHA-256 so a later pass can prove it recovered the exact bytes.
 */

import { createHash } from "node:crypto";

export type StrippedKind = "script" | "style" | "comment" | "admin-bar" | "telemetry";

export interface StrippedNode {
  kind: StrippedKind;
  /** Identifying detail: element id, src/href, comment prefix, or host. */
  detail: string;
  /** Bytes removed, measured on the normalised (LF) document. */
  bytes: number;
  /** SHA-256 of the removed payload, so recovery can be proven byte-exact. */
  sha256?: string;
}

export interface NormalisedDocument {
  /** The `<html …>…</html>` element, byte-identical to capture except for removals. */
  html: string;
  /** The full doctype declaration exactly as served, when the page had one. */
  doctype?: string;
  stripped: StrippedNode[];
  /** Things a human has to know; never silently swallowed. */
  notes: string[];
  inputBytes: number;
  outputBytes: number;
  /** Ordered `class` attribute values seen on input and on output. */
  classes: { input: number; output: number };
  /** Bytes outside `<html>…</html>` that were not carried into the IR. */
  outsideDocument: { before: number; after: number };
}

/** Analytics/telemetry hosts. Matched against `src`/`href` of pixels, hints and frames. */
const TELEMETRY_HOST_PATTERNS: readonly RegExp[] = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /connect\.facebook\.net/i,
  /facebook\.com\/tr\b/i,
  /stats?\.wp\.com/i,
  /pixel\.wp\.com/i,
  /doubleclick\.net/i,
  /hotjar\.com/i,
  /clarity\.ms/i,
  /bat\.bing\.com/i,
  /snap\.licdn\.com/i,
  /ct\.pinterest\.com/i,
  /analytics\.tiktok\.com/i,
  /cdn\.segment\.com/i,
  /matomo|piwik/i,
];

/** `<link>` relations that are pure resource hints; safe to drop when they are telemetry. */
const RESOURCE_HINT_RELS = new Set(["preconnect", "dns-prefetch", "prefetch", "prerender"]);

/** Parse a single tag's attributes. Tolerates unquoted values and either quote style. */
export function parseTagAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  // Everything after the tag name, before the closing `>` / `/>`.
  const body = tag.replace(/^<\/?[\w:-]+/, "").replace(/\/?>$/, "");
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of body.matchAll(pattern)) {
    const name = match[1];
    if (name === undefined) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    attributes[name.toLowerCase()] = value;
  }
  return attributes;
}

/** Decode the entity forms WordPress actually emits. Unknown entities are left alone. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    const lowered = entity.toLowerCase();
    if (lowered.startsWith("#x")) {
      const code = Number.parseInt(lowered.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (lowered.startsWith("#")) {
      const code = Number.parseInt(lowered.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: "\u00a0",
      hellip: "\u2026",
      mdash: "\u2014",
      ndash: "\u2013",
      rsquo: "\u2019",
      lsquo: "\u2018",
      ldquo: "\u201c",
      rdquo: "\u201d",
      copy: "\u00a9",
      reg: "\u00ae",
      trade: "\u2122",
    };
    return named[lowered] ?? whole;
  });
}

/** Visible text of an HTML fragment, entities decoded, whitespace collapsed. */
export function textFromHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Ordered `class` attribute values, exactly as written (no trimming, no splitting). */
export function classAttributeValues(html: string): string[] {
  const values: string[] = [];
  for (const match of html.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = match[1] ?? match[2];
    if (value !== undefined) values.push(value);
  }
  return values;
}

/** Is `candidate` an ordered subsequence of `source`? Deleting elements keeps this true. */
export function isOrderedSubsequence(
  candidate: readonly string[],
  source: readonly string[],
): boolean {
  let index = 0;
  for (const value of source) {
    if (index < candidate.length && value === candidate[index]) index += 1;
  }
  return index === candidate.length;
}

interface ElementRange {
  start: number;
  end: number;
  openingTag: string;
  closed: boolean;
}

/**
 * Ranges of every `<tag>…</tag>` occurrence, using a forward scan rather than a
 * single regex: an unclosed element is reported as `closed: false` instead of
 * swallowing the rest of the document.
 */
function elementRanges(html: string, tag: string): ElementRange[] {
  const ranges: ElementRange[] = [];
  const open = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");

  let cursor = 0;
  for (;;) {
    open.lastIndex = cursor;
    const match = open.exec(html);
    if (match === null) break;
    const start = match.index;
    const openingTag = match[0];
    // An XHTML-style self-closing script/style is not valid HTML, but a page can
    // still serve it; treat it as the whole element rather than hunting for a
    // closing tag that will never come.
    if (/\/>$/.test(openingTag)) {
      ranges.push({ start, end: start + openingTag.length, openingTag, closed: true });
      cursor = start + openingTag.length;
      continue;
    }
    closeRe.lastIndex = start + openingTag.length;
    const close = closeRe.exec(html);
    if (close === null) {
      ranges.push({ start, end: html.length, openingTag, closed: false });
      break;
    }
    ranges.push({
      start,
      end: close.index + close[0].length,
      openingTag,
      closed: true,
    });
    cursor = close.index + close[0].length;
  }
  return ranges;
}

/** Cut the given ranges out of `html`, in one pass. */
function cutRanges(html: string, ranges: readonly ElementRange[]): string {
  if (ranges.length === 0) return html;
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    out += html.slice(cursor, range.start);
    cursor = range.end;
  }
  return out + html.slice(cursor);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function describeElement(openingTag: string, kind: StrippedKind): string {
  const attributes = parseTagAttributes(openingTag);
  const parts: string[] = [];
  if (attributes["id"] !== undefined && attributes["id"] !== "") parts.push(`#${attributes["id"]}`);
  const url = attributes["src"] ?? attributes["href"];
  if (url !== undefined && url !== "") parts.push(url);
  if (attributes["type"] !== undefined && kind === "script")
    parts.push(`type=${attributes["type"]}`);
  return parts.length > 0 ? parts.join(" ") : openingTag.replace(/\s+/g, " ").slice(0, 80);
}

/** Remove `<script>`/`<style>` elements, recording each payload's hash. */
function stripPairedElement(
  html: string,
  tag: "script" | "style",
  stripped: StrippedNode[],
  notes: string[],
): string {
  const ranges = elementRanges(html, tag);
  for (const range of ranges) {
    const payload = html.slice(range.start, range.end);
    stripped.push({
      kind: tag,
      detail: describeElement(range.openingTag, tag),
      bytes: payload.length,
      sha256: sha256(payload),
    });
    if (!range.closed) {
      notes.push(
        `unclosed <${tag}> at byte ${range.start}: removed to end of document; the page is malformed`,
      );
    }
  }
  return cutRanges(html, ranges);
}

/**
 * Remove an element by id, balancing nested tags of the same name.
 *
 * A regex cannot do this: `#wpadminbar` contains a variable number of nested
 * `<div>`s, so a non-greedy match would cut the bar in half and leave markup
 * behind. This is the one removal that needs real structure.
 */
function stripElementById(
  html: string,
  id: string,
  tag: string,
  stripped: StrippedNode[],
  notes: string[],
): string {
  const open = new RegExp(`<${tag}\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`, "i");
  const match = open.exec(html);
  if (match === null) return html;

  const start = match.index;
  const tagRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tagRe.lastIndex = start;
  let depth = 0;
  let end = -1;
  for (;;) {
    const tagMatch = tagRe.exec(html);
    if (tagMatch === null) break;
    const closing = tagMatch[1] === "/";
    if (!closing) {
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) {
        end = tagMatch.index + tagMatch[0].length;
        break;
      }
    }
  }

  if (end < 0) {
    stripped.push({ kind: "admin-bar", detail: `#${id} (unbalanced)`, bytes: html.length - start });
    notes.push(`#${id} was unbalanced; it and everything after it were removed`);
    return html.slice(0, start);
  }

  const payload = html.slice(start, end);
  stripped.push({
    kind: "admin-bar",
    detail: `#${id}`,
    bytes: payload.length,
    sha256: sha256(payload),
  });
  return `${html.slice(0, start)}${html.slice(end)}`;
}

/** Drop a class token from the first `scopeTag` opening tag only (`<html>`, `<body>`). */
function removeClassToken(
  html: string,
  scopeTag: string,
  token: string,
): { html: string; removedBytes: number } {
  const open = new RegExp(`<${scopeTag}\\b[^>]*>`, "i");
  const match = open.exec(html);
  if (match === null) return { html, removedBytes: 0 };
  const tag = match[0];
  const classMatch = /\bclass\s*=\s*(["'])([^"']*)\1/i.exec(tag);
  if (classMatch?.[2] === undefined) return { html, removedBytes: 0 };
  const tokens = classMatch[2].split(/\s+/).filter((value) => value.length > 0);
  if (!tokens.includes(token)) return { html, removedBytes: 0 };
  const replacement = tokens.filter((value) => value !== token).join(" ");
  const newTag = tag.replace(classMatch[0], `class=${classMatch[1]}${replacement}${classMatch[1]}`);
  return {
    html: `${html.slice(0, match.index)}${newTag}${html.slice(match.index + tag.length)}`,
    removedBytes: tag.length - newTag.length,
  };
}

/** Remove analytics pixels, resource hints and tracking frames. */
function stripTelemetry(html: string, stripped: StrippedNode[], notes: string[]): string {
  const isTelemetryUrl = (url: string): boolean =>
    TELEMETRY_HOST_PATTERNS.some((pattern) => pattern.test(url));

  let out = html;

  // Tracking frames can have fallback content, so they are removed as elements.
  const frameRanges = elementRanges(out, "iframe").filter((range) => {
    const attributes = parseTagAttributes(range.openingTag);
    return isTelemetryUrl(attributes["src"] ?? "");
  });
  for (const range of frameRanges) {
    const payload = out.slice(range.start, range.end);
    stripped.push({
      kind: "telemetry",
      detail: `iframe ${range.openingTag.slice(0, 120)}`,
      bytes: payload.length,
    });
  }
  out = cutRanges(out, frameRanges);

  // Void tags: one tag, nothing to balance.
  for (const tag of ["img", "link"] as const) {
    const re = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    const ranges: ElementRange[] = [];
    for (const match of out.matchAll(re)) {
      const attributes = parseTagAttributes(match[0]);
      const url = attributes["src"] ?? attributes["href"] ?? "";
      const isHint =
        tag === "link" && RESOURCE_HINT_RELS.has((attributes["rel"] ?? "").trim().toLowerCase());
      if (url === "" || !isTelemetryUrl(url)) continue;
      // A stylesheet is never telemetry, however odd its host looks.
      if (tag === "link" && !isHint) {
        notes.push(`kept <link rel="${attributes["rel"] ?? ""}"> from a telemetry host: ${url}`);
        continue;
      }
      const start = match.index;
      ranges.push({ start, end: start + match[0].length, openingTag: match[0], closed: true });
      stripped.push({
        kind: "telemetry",
        detail: `${tag} ${url}`,
        bytes: match[0].length,
        sha256: sha256(match[0]),
      });
    }
    out = cutRanges(out, ranges);
  }

  return out;
}

/** Remove comments except IE conditional comments, which are the only kind that render. */
function stripComments(html: string, stripped: StrippedNode[], notes: string[]): string {
  const ranges: ElementRange[] = [];
  for (const match of html.matchAll(/<!--[\s\S]*?-->/g)) {
    const text = match[0];
    const inner = text.slice(4, -3).trim();
    if (inner.startsWith("[if") || inner === "<![endif]" || inner === "[endif]") {
      notes.push(`kept conditional comment: ${text.slice(0, 80)}`);
      continue;
    }
    const start = match.index;
    ranges.push({ start, end: start + text.length, openingTag: text, closed: true });
    stripped.push({
      kind: "comment",
      detail: inner.replace(/\s+/g, " ").slice(0, 80) || "(empty)",
      bytes: text.length,
    });
  }
  return cutRanges(html, ranges);
}

/**
 * Normalise one rendered page into the IR's `dom` carrier.
 *
 * Deterministic and pure: the same bytes always produce the same document, which
 * is what makes the round-trip test meaningful.
 */
export function normaliseDocument(raw: string): NormalisedDocument {
  const stripped: StrippedNode[] = [];
  const notes: string[] = [];

  // Line endings first: the HTML parser performs this same normalisation, so it
  // cannot change rendering, and every later offset is measured on one spelling.
  let html = raw.replace(/\r\n?/g, "\n");
  const inputBytes = html.length;

  // Doctype is lifted out rather than kept inline: the schema carries it as its
  // own field, and `dom.html` starts at `<html>`.
  let doctype: string | undefined;
  const doctypeMatch = /^\s*(<!DOCTYPE[^>]*>)/i.exec(html);
  if (doctypeMatch?.[1] !== undefined) {
    doctype = doctypeMatch[1];
    html = html.slice(doctypeMatch[0].length);
  } else {
    notes.push("no doctype in the served document");
  }

  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  const htmlClose = html.toLowerCase().lastIndexOf("</html");
  let before = 0;
  let after = 0;
  if (htmlOpen !== null && htmlClose > htmlOpen.index) {
    before = htmlOpen.index;
    const closeEnd = html.indexOf(">", htmlClose) + 1;
    after = html.length - closeEnd;
    html = html.slice(htmlOpen.index, closeEnd);
  } else {
    notes.push("document has no complete <html>…</html>; captured from <body> to end instead");
    const body = /<body\b/i.exec(html);
    html = before >= 0 && body !== null ? html.slice(body.index) : html;
    before = body?.index ?? 0;
  }

  html = stripPairedElement(html, "script", stripped, notes);
  html = stripPairedElement(html, "style", stripped, notes);
  html = stripElementById(html, "wpadminbar", "div", stripped, notes);
  const removedAdminBar = stripped.some((node) => node.kind === "admin-bar");
  const removedClassTokens = new Set<string>();
  if (removedAdminBar) {
    // WordPress adds these class hooks only to reserve space for the bar; with the
    // bar gone they would add padding for an element that no longer exists.
    for (const [scope, token] of [
      ["html", "wp-toolbar"],
      ["body", "admin-bar"],
    ] as const) {
      const result = removeClassToken(html, scope, token);
      html = result.html;
      if (result.removedBytes > 0) {
        removedClassTokens.add(token);
        stripped.push({
          kind: "admin-bar",
          detail: `<${scope} class> token ${token}`,
          bytes: result.removedBytes,
        });
      }
    }
  }
  html = stripTelemetry(html, stripped, notes);
  html = stripComments(html, stripped, notes);

  const inputClasses = classAttributeValues(raw.replace(/\r\n?/g, "\n"));
  const outputClasses = classAttributeValues(html);
  // The admin-bar hooks are the only class attributes this file is allowed to
  // rewrite, so the expected class list drops those tokens before the comparison.
  const expectedClasses =
    removedClassTokens.size === 0
      ? inputClasses
      : inputClasses.map((value) =>
          value
            .split(/\s+/)
            .filter((token) => token.length > 0 && !removedClassTokens.has(token))
            .join(" "),
        );
  if (!isOrderedSubsequence(outputClasses, expectedClasses)) {
    // Deleting whole elements can only shrink the class list in order. If that is
    // ever untrue, the normaliser has altered a surviving element: refuse to emit.
    throw new Error(
      "normalisation changed a surviving element's class attribute (class order is not a subsequence of the input)",
    );
  }

  const normalised: NormalisedDocument = {
    html,
    stripped,
    notes,
    inputBytes,
    outputBytes: html.length,
    classes: { input: inputClasses.length, output: outputClasses.length },
    outsideDocument: { before, after },
  };
  if (doctype !== undefined) normalised.doctype = doctype;
  return normalised;
}

/** Human-readable one-line summary of what was stripped, for the capture report. */
export function summariseStripped(stripped: readonly StrippedNode[]): string {
  if (stripped.length === 0) return "nothing";
  const byKind = new Map<StrippedKind, { count: number; bytes: number }>();
  for (const node of stripped) {
    const entry = byKind.get(node.kind) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += node.bytes;
    byKind.set(node.kind, entry);
  }
  return [...byKind.entries()]
    .map(([kind, entry]) => `${entry.count} ${kind} (${entry.bytes} B)`)
    .join(", ");
}
