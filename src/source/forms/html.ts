/**
 * Reading a captured document for form markup — string surgery, not a DOM
 * round-trip, matching the rule the rest of `src/source` follows.
 *
 * A form extractor only needs four things from a document: the element ranges,
 * their attributes, their text, and which element a given offset sits inside.
 * Parsing the page into a tree and re-serialising it would give none of those
 * cheaply and would put the extractor on a path that could rewrite the capture.
 *
 * The scan is forward-moving and reports an unclosed element as unclosed rather
 * than swallowing the rest of the document (a truncated capture must fail loudly,
 * not produce a form that runs to the end of the file).
 */

import { decodeEntities, parseTagAttributes, textFromHtml } from "../wp-rest/dom.js";

export interface TagOccurrence {
  /** Byte offset of the opening `<`. */
  start: number;
  /** Byte offset just past the element's `>`. */
  end: number;
  attributes: Record<string, string>;
  /** The opening tag exactly as captured. */
  openingTag: string;
}

export interface ElementBlock extends TagOccurrence {
  /** Everything between the opening and closing tag. */
  inner: string;
  /** The whole element, opening tag through closing tag. */
  markup: string;
  /** False when no closing tag was found; such a block is never treated as a field. */
  closed: boolean;
}

/** Remove HTML comments so a commented-out form is not counted as markup. */
export function withoutComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** Every opening `<tag …>` occurrence, in document order. */
export function openingTags(html: string, tag: string): TagOccurrence[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const found: TagOccurrence[] = [];
  for (const match of html.matchAll(pattern)) {
    found.push({
      start: match.index,
      end: match.index + match[0].length,
      attributes: parseTagAttributes(match[0]),
      openingTag: match[0],
    });
  }
  return found;
}

/** Every `<tag>…</tag>` element in document order, with its inner markup. */
export function elementBlocks(html: string, tag: string): ElementBlock[] {
  const found: ElementBlock[] = [];
  const closePattern = new RegExp(`</${tag}\\s*>`, "gi");
  for (const tagOccurrence of openingTags(html, tag)) {
    const selfClosing = /\/>$/.test(tagOccurrence.openingTag);
    if (selfClosing) {
      found.push({ ...tagOccurrence, inner: "", markup: tagOccurrence.openingTag, closed: true });
      continue;
    }
    closePattern.lastIndex = tagOccurrence.end;
    const close = closePattern.exec(html);
    if (close === null) {
      found.push({
        ...tagOccurrence,
        inner: html.slice(tagOccurrence.end),
        markup: html.slice(tagOccurrence.start),
        closed: false,
      });
      continue;
    }
    found.push({
      ...tagOccurrence,
      inner: html.slice(tagOccurrence.end, close.index),
      markup: html.slice(tagOccurrence.start, close.index + close[0].length),
      closed: true,
    });
  }
  return found;
}

/**
 * Every `<tag>…</tag>` element with **nesting-aware** range detection.
 *
 * `elementBlocks` pairs an opening tag with the first closing tag, which is right
 * for `<form>`, `<select>` and `<textarea>` (they cannot nest) and wrong for
 * containers: `<div class="ff-el-group" data-conditionals="…"><div class="label">…`
 * closes on the inner `</div>`, so a containment test against that range misses
 * the field the container actually wraps. Depth counting fixes it.
 *
 * Only call this for elements that are actually paired; `<input>` has no closing
 * tag and its depth would never return to zero.
 */
export function nestedElementBlocks(html: string, tag: string): ElementBlock[] {
  interface Token {
    closing: boolean;
    start: number;
    end: number;
    text: string;
  }
  interface Opening {
    start: number;
    end: number;
    text: string;
  }

  const tokens: Token[] = [];
  const pattern = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, "gi");
  for (const match of html.matchAll(pattern)) {
    tokens.push({
      closing: match[0].startsWith("</"),
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }

  const blocks: ElementBlock[] = [];
  const open: Opening[] = [];
  for (const token of tokens) {
    if (!token.closing) {
      if (/\/>$/.test(token.text)) continue;
      open.push({ start: token.start, end: token.end, text: token.text });
      continue;
    }
    const opening = open.pop();
    if (opening === undefined) continue;
    blocks.push({
      start: opening.start,
      end: token.end,
      attributes: parseTagAttributes(opening.text),
      openingTag: opening.text,
      inner: html.slice(opening.end, token.start),
      markup: html.slice(opening.start, token.end),
      closed: true,
    });
  }

  // Unclosed openings are reported as unclosed rather than silently dropped.
  for (const opening of open) {
    blocks.push({
      start: opening.start,
      end: html.length,
      attributes: parseTagAttributes(opening.text),
      openingTag: opening.text,
      inner: html.slice(opening.end),
      markup: html.slice(opening.start),
      closed: false,
    });
  }

  return blocks.sort((left, right) => left.start - right.start);
}

/** The innermost recorded block that contains `offset`, or null. */
export function innermostBlockAt(
  blocks: readonly ElementBlock[],
  offset: number,
): ElementBlock | null {
  let best: ElementBlock | null = null;
  for (const block of blocks) {
    if (block.start <= offset && offset < block.start + block.markup.length) {
      if (best === null || block.start > best.start) best = block;
    }
  }
  return best;
}

/** Visible text of a fragment, entities decoded, whitespace collapsed. */
export function text(markup: string): string {
  return textFromHtml(markup);
}

/** Entity-decoded attribute value, or undefined when absent. */
export function attr(attributes: Record<string, string>, name: string): string | undefined {
  const value = attributes[name];
  return value === undefined ? undefined : decodeEntities(value);
}

/** `class` attribute split into tokens. */
export function classTokens(attributes: Record<string, string>): string[] {
  const value = attributes["class"] ?? "";
  return value.split(/\s+/).filter((token) => token.length > 0);
}

/** Is a boolean HTML attribute present, whether or not it carries a value? */
export function hasFlag(attributes: Record<string, string>, name: string): boolean {
  if (!(name in attributes)) return false;
  const value = attributes[name];
  return value === undefined || value === "" || value.toLowerCase() === name;
}

/** Every `data-*` attribute on an element, keeping the literal attribute names. */
export function dataAttributes(attributes: Record<string, string>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (name.startsWith("data-")) found[name] = decodeEntities(value);
  }
  return found;
}

/** True when a key looks like a CSRF/session token rather than form data. */
export function isSecurityTokenName(name: string): boolean {
  return /nonce|token/i.test(name);
}

/**
 * Parse a JSON attribute (`data-conditionals`, `data-conditional_logics`, …).
 * Returns the raw string too: a rule set this extractor cannot decode is still
 * worth recording verbatim, because dropping it would silently make a
 * conditional field unconditional.
 */
export function parseJsonAttribute(
  attributes: Record<string, string>,
  name: string,
): { value: unknown; raw: string } | null {
  const raw = attributes[name];
  if (raw === undefined || raw.trim().length === 0) return null;
  const candidates = [raw, decodeEntities(raw)];
  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate), raw: candidate };
    } catch {
      // Try the next spelling; the raw text is still recorded by the caller.
    }
  }
  return { value: null, raw };
}
