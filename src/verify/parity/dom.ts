/**
 * The small, honest slice of parse5 the parity gate walks.
 *
 * Both sides of every comparison are parsed with the **same** HTML parser. That is
 * what makes tree equality meaningful: the capture is parsed once by the emitter's
 * design and once here, and the artefact is parsed here, so a difference is a
 * difference in the document rather than in two parsers' opinions.
 *
 * Nothing in this module decides what is *allowed* to differ — that is `tree.ts`.
 */

import { parse } from "parse5";

/** One attribute, in document order. `name` is lowercased by the parser. */
export interface HtmlAttribute {
  readonly name: string;
  readonly value: string;
}

/** The structural subset of parse5's node shape. Deliberately read-only. */
export interface HtmlNode {
  readonly nodeName?: string;
  readonly tagName?: string;
  readonly attrs?: ReadonlyArray<HtmlAttribute>;
  readonly childNodes?: ReadonlyArray<HtmlNode>;
  readonly value?: string;
  /** `<template>` content, which parse5 nests away from `childNodes`. */
  readonly content?: HtmlNode;
}

const TEXT_NODE = "#text";
const COMMENT_NODE = "#comment";

/** Parse a document (or a fragment) into the shape above. */
export function parseDocument(html: string): HtmlNode {
  return parse(html) as unknown as HtmlNode;
}

/** True for a real element, false for `#text`, `#comment`, `#document`. */
export function isElementNode(node: HtmlNode): boolean {
  const name = node.nodeName ?? "";
  return name.length > 0 && !name.startsWith("#");
}

export function isTextNode(node: HtmlNode): boolean {
  return node.nodeName === TEXT_NODE;
}

/**
 * The children the tree comparison walks.
 *
 * Comments are excluded, matching the emitter's own acceptance test: the capture's
 * comments are preserved byte-for-byte by construction (no transform rewrites them),
 * so comparing them adds noise without adding a guarantee. Everything that can affect
 * rendering — elements, attributes, classes and text — is walked.
 */
export function comparableChildren(node: HtmlNode): HtmlNode[] {
  return (node.childNodes ?? []).filter((child) => child.nodeName !== COMMENT_NODE);
}

/** Element children only, in document order. */
export function elementChildren(node: HtmlNode): HtmlNode[] {
  return (node.childNodes ?? []).filter(isElementNode);
}

/** Depth-first search including `<template>` content. */
export function findElement(node: HtmlNode, name: string): HtmlNode | null {
  if (node.nodeName === name) return node;
  for (const child of node.childNodes ?? []) {
    const found = findElement(child, name);
    if (found !== null) return found;
  }
  if (node.content !== undefined) return findElement(node.content, name);
  return null;
}

/** An attribute's value, or `null` when the element does not carry it. */
export function attributeOf(node: HtmlNode, name: string): string | null {
  for (const attribute of node.attrs ?? []) {
    if (attribute.name === name) return attribute.value;
  }
  return null;
}

/** `rel` is a space-separated token list; the tokens, lowercased. */
export function relTokens(node: HtmlNode): string[] {
  return (attributeOf(node, "rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
}

/** A `<link rel="stylesheet">`: the cascade's linked entries. */
export function isStylesheetLink(node: HtmlNode): boolean {
  return node.nodeName === "link" && relTokens(node).includes("stylesheet");
}

/**
 * A Divi deferred-CSS link (`rel="preload" as="style" onload="…"`).
 *
 * It is **not** a stylesheet link for cascade purposes: its bytes were never
 * captured, so it is preserved as captured and appears in the residual allowlist.
 */
export function isDeferredStyleLink(node: HtmlNode): boolean {
  if (node.nodeName !== "link") return false;
  const rel = relTokens(node);
  const preloads = rel.includes("preload") || rel.includes("preload-as-style");
  return preloads && (attributeOf(node, "as") === "style" || rel.includes("style"));
}

/** `<style>` — the cascade's inline entries. */
export function isStyleNode(node: HtmlNode): boolean {
  return node.nodeName === "style";
}

/** The concatenated text of a node's descendants. */
export function textContent(node: HtmlNode): string {
  let text = "";
  for (const child of node.childNodes ?? []) {
    text += isTextNode(child) ? (child.value ?? "") : textContent(child);
  }
  return text;
}

/** A readable node label: `div#et-boc.et-l`, `p`, `#text`. */
export function nodeLabel(node: HtmlNode): string {
  const name = node.nodeName ?? "#unknown";
  if (!isElementNode(node)) return name;
  const id = attributeOf(node, "id");
  const classes = (attributeOf(node, "class") ?? "").split(/\s+/).filter(Boolean);
  const suffix = [id === null ? "" : `#${id}`, ...classes.map((token) => `.${token}`)].join("");
  return `${name}${suffix}`;
}

/** The path segment for a child: its label plus its index among siblings of that name. */
export function pathSegment(node: HtmlNode, siblings: readonly HtmlNode[]): string {
  const label = nodeLabel(node);
  const sameName = siblings.filter((candidate) => candidate.nodeName === node.nodeName);
  if (sameName.length <= 1) return label;
  const position = sameName.indexOf(node);
  return `${label}[${String(position)}]`;
}
