/**
 * Asset integrity — every local file the artefact points at exists, and is the file
 * the capture recorded.
 *
 * The equivalence claim covers rendering, but rendering a page whose stylesheet
 * points at a missing font, or whose `<img>` points at a deleted image, is a
 * *different page*. So the gate resolves every reference the artefact makes and
 * proves the target: existence always, and `sha256` equality wherever the IR records
 * a hash for it.
 *
 * Two sources of references, because a page references assets two ways:
 *
 *  - **attributes** — `img[src]`, `img[srcset]`, `source[srcset]`, `link[href]`
 *    (except stylesheet links, which the cascade check owns), `video[poster]` and the
 *    localised `msapplication-TileImage` meta;
 *  - **CSS** — every `url()` in the page's inline `<style>` blocks (resolved against
 *    the page) and in its linked stylesheets (resolved against the stylesheet).
 *
 * Absolute, protocol-relative, `data:` and fragment references are skipped: they are
 * not artefacts of the emitted tree, and the residual check owns the absolute ones.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import type { SiteIr } from "../../schema/site-ir.js";
import { splitCss } from "./cascade.js";
import {
  attributeOf,
  elementChildren,
  findElement,
  isStylesheetLink,
  isStyleNode,
  relTokens,
  textContent,
  type HtmlNode,
} from "./dom.js";
import type { ParityFailure } from "./types.js";

/** The measurement plus its first failures. */
export interface AssetResult {
  readonly assetsVerified: number;
  readonly assetsHashed: number;
  readonly failures: readonly ParityFailure[];
}

export interface AssetOptions {
  readonly page: string;
  readonly document: HtmlNode;
  readonly outDir: string;
  readonly emittedPagePath: string;
  readonly ir: SiteIr;
}

/** Attributes that name a local file, per element. */
const ASSET_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  img: ["src", "srcset"],
  source: ["srcset"],
  link: ["href"],
  video: ["poster"],
};

/** A reference that is not a path into the artefact. */
function isExternalReference(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  );
}

/** `srcset` candidates, or `[]` when the value carries `data:` commas. */
function srcsetUrls(value: string): string[] {
  if (value.includes("data:")) return [];
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter((url) => url.length > 0);
}

/**
 * Collect the local references a document and its CSS make.
 *
 * Each entry carries the directory the reference resolves against, because that is
 * the only thing a relative reference means.
 */
function referencesOf(options: AssetOptions): { value: string; baseDir: string }[] {
  const references: { value: string; baseDir: string }[] = [];
  const pageDir = dirname(options.emittedPagePath);
  const body = findElement(options.document, "body") ?? options.document;

  const collectElement = (element: HtmlNode): void => {
    const tag = element.nodeName ?? "";

    if (tag === "meta") {
      // Only the one meta value the emitter localises to a path in the tree.
      if ((attributeOf(element, "name") ?? "") === "msapplication-TileImage") {
        const content = attributeOf(element, "content") ?? "";
        if (!isExternalReference(content)) references.push({ value: content, baseDir: pageDir });
      }
      return;
    }

    const attributes = ASSET_ATTRIBUTES[tag];
    if (attributes === undefined) return;

    for (const name of attributes) {
      const value = attributeOf(element, name);
      if (value === null) continue;
      if (tag === "link") {
        // Stylesheet links are the cascade's business; a canonical is absolute.
        if (isStylesheetLink(element) || relTokens(element).includes("canonical")) continue;
      }
      for (const reference of name === "srcset" ? srcsetUrls(value) : [value]) {
        if (isExternalReference(reference)) continue;
        references.push({ value: reference, baseDir: pageDir });
      }
    }
  };

  const visit = (node: HtmlNode): void => {
    if (node.nodeName !== undefined) collectElement(node);
    if (isStyleNode(node)) {
      for (const url of splitCss(textContent(node)).urls) {
        if (isExternalReference(url)) continue;
        references.push({ value: url, baseDir: pageDir });
      }
    }
    for (const child of elementChildren(node)) visit(child);
  };
  visit(body);

  // Linked stylesheets: their own `url()` references resolve against their directory.
  const head = findElement(options.document, "head");
  for (const node of head === null ? [] : elementChildren(head)) {
    if (!isStylesheetLink(node)) continue;
    const href = attributeOf(node, "href") ?? "";
    const file = resolve(pageDir, href.split(/[?#]/)[0] ?? "");
    if (!existsSync(file)) continue;
    const inside = relative(options.outDir, file);
    if (inside.startsWith("..")) continue;
    for (const url of splitCss(readFileSync(file, "utf8")).urls) {
      if (isExternalReference(url)) continue;
      references.push({ value: url, baseDir: dirname(file) });
    }
  }

  return references;
}

/** Verify every local asset one emitted page references. */
export function verifyAssets(options: AssetOptions): AssetResult {
  const failures: ParityFailure[] = [];
  const fail = (path: string, message: string, expected?: string, actual?: string): void => {
    failures.push({
      check: "assets",
      page: options.page,
      path,
      message,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
    });
  };

  const recorded = new Map<string, string>();
  for (const asset of options.ir.assets) {
    recorded.set(asset.localPath.split("\\").join("/"), asset.sha256);
  }

  const verified = new Set<string>();
  const hashed = new Set<string>();

  for (const reference of referencesOf(options)) {
    const target = resolve(reference.baseDir, reference.value.split(/[?#]/)[0] ?? "");
    const inside = relative(options.outDir, target);
    if (inside.startsWith("..") || resolve(options.outDir, inside) !== target) {
      fail("", `${reference.value} resolves outside the artefact`);
      continue;
    }
    const localPath = inside.split("\\").join("/");
    if (!existsSync(target) || !statSync(target).isFile()) {
      fail("", `${localPath} is referenced but does not exist in the artefact`);
      continue;
    }
    verified.add(localPath);

    const expectedSha = recorded.get(localPath);
    if (expectedSha === undefined) continue;
    const actualSha = createHash("sha256").update(readFileSync(target)).digest("hex");
    if (actualSha !== expectedSha) {
      fail("", `${localPath} does not match the hash the IR recorded`, expectedSha, actualSha);
      continue;
    }
    hashed.add(localPath);
  }

  // A stylesheet's own bytes are the cascade check's contract, but its existence is
  // this check's: an artefact cannot reference a stylesheet it does not ship.
  for (const node of elementChildren(findElement(options.document, "head") ?? {})) {
    if (!isStylesheetLink(node)) continue;
    const href = attributeOf(node, "href") ?? "";
    if (href.length === 0) continue;
    const target = resolve(dirname(options.emittedPagePath), href.split(/[?#]/)[0] ?? "");
    const inside = relative(options.outDir, target);
    if (inside.startsWith("..")) {
      fail("html > head", `stylesheet ${href} resolves outside the artefact`);
      continue;
    }
    if (!existsSync(target)) {
      fail("html > head", `stylesheet ${href} is linked but does not exist in the artefact`);
    }
  }

  return { assetsVerified: verified.size, assetsHashed: hashed.size, failures };
}
