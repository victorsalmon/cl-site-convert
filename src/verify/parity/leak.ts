/**
 * Cross-page leak — the check tree equality structurally cannot make.
 *
 * Every page is compared to *its own* IR entry, so a page built from the wrong
 * template, or a node pasted from a sibling route, is still "equal to itself" as long
 * as it equals whatever the IR says for that route. That is a real failure mode of a
 * template/cache bug, and it is invisible to a per-page diff.
 *
 * The rule here is derived only from the capture: a token — an `id`, or a run of text —
 * that appears in **exactly one** captured page is unique to that page. No emitted page
 * may contain a token that is unique to a different page. Nothing is asserted about
 * text shared across pages (the header, the footer, the nav), because that is not a
 * leak.
 *
 * The threshold on text length keeps the check about content rather than punctuation:
 * a unique three-character run is noise, a unique sentence is a page.
 */

import { attributeOf, findElement, type HtmlNode, parseDocument } from "./dom.js";
import type { ParityFailure } from "./types.js";

/** Text shorter than this is not treated as page identity. */
export const MIN_UNIQUE_TEXT_LENGTH = 24;

/** Elements whose text is code, not content. */
const OPAQUE_ELEMENTS = new Set(["style", "script", "title", "template"]);

/** What makes a page recognisable: its element ids and its content text. */
export interface PageFingerprint {
  readonly url: string;
  readonly ids: ReadonlySet<string>;
  readonly texts: ReadonlySet<string>;
}

function normaliseText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Fingerprint one document from its body. */
export function fingerprint(url: string, html: string): PageFingerprint {
  const document = parseDocument(html);
  const body = findElement(document, "body") ?? document;
  const ids = new Set<string>();
  const texts = new Set<string>();

  const visit = (node: HtmlNode): void => {
    const id = attributeOf(node, "id");
    if (id !== null && id.length > 0) ids.add(id);
    if (node.nodeName !== undefined && OPAQUE_ELEMENTS.has(node.nodeName)) return;

    for (const child of node.childNodes ?? []) {
      if (child.nodeName === "#text") {
        const text = normaliseText(child.value ?? "");
        if (text.length >= MIN_UNIQUE_TEXT_LENGTH) texts.add(text);
        continue;
      }
      if (child.nodeName === undefined || child.nodeName.startsWith("#")) continue;
      visit(child);
    }
  };
  visit(body);

  return { url, ids, texts };
}

function tokensOf(page: PageFingerprint): string[] {
  return [
    ...[...page.ids].map((id) => `id:${id}`),
    ...[...page.texts].map((text) => `text:${text}`),
  ];
}

/**
 * Compare every emitted page against the capture's unique tokens.
 *
 * `captured` and `emitted` are parallel: the same page under the same url.
 */
export function verifyCrossPageLeaks(
  captured: readonly PageFingerprint[],
  emitted: readonly PageFingerprint[],
  options: { readonly limitPerPage?: number } = {},
): ParityFailure[] {
  const limit = options.limitPerPage ?? 3;

  // A token is unique to a page when exactly one captured page carries it.
  const owners = new Map<string, Set<string>>();
  for (const page of captured) {
    for (const token of tokensOf(page)) {
      const bucket = owners.get(token) ?? new Set<string>();
      bucket.add(page.url);
      owners.set(token, bucket);
    }
  }
  const uniqueOwner = new Map<string, string>();
  for (const [token, pages] of owners) {
    if (pages.size !== 1) continue;
    const [only] = pages;
    if (only !== undefined) uniqueOwner.set(token, only);
  }

  const failures: ParityFailure[] = [];
  for (const page of emitted) {
    let reported = 0;
    for (const token of tokensOf(page)) {
      if (reported >= limit) break;
      const owner = uniqueOwner.get(token);
      if (owner === undefined || owner === page.url) continue;
      reported += 1;
      failures.push({
        check: "cross-page-leak",
        page: page.url,
        path: "",
        message: `content unique to ${owner}'s capture appears on ${page.url}: ${JSON.stringify(
          token.slice(0, 120),
        )}`,
        expected: owner,
        actual: token.slice(0, 120),
      });
    }
  }
  return failures;
}
