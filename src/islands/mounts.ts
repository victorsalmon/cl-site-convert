/**
 * Mount-slot scanning — the emitter's half of the island contract.
 *
 * The emitter decides which bundles a page ships by asking what the page
 * actually contains. It must never say "ship everything": that is exactly the
 * single-merged-bundle problem this bead exists to remove.
 *
 * The scan runs on the **emitted HTML**, not on the Site IR, on purpose. The
 * question is "what will this document contain when a browser parses it?", and
 * the answer has to come from the bytes being shipped. A selector match on the
 * IR would be a claim about intent; this is a measurement of the artifact.
 *
 * Mount slot shape (frozen by `docs/islands-runtime.md`):
 *
 * ```html
 * <div id="island-fluent-form" data-component="FluentForm" data-props='{"formId":3}'></div>
 * ```
 *
 * Scanning is deliberately forgiving about *shape* and unforgiving about
 * *identity*: any element carrying `data-component` is a mount, but a
 * `data-component` value that is not a valid component name is reported, never
 * coerced.
 */

import { parse } from "parse5";

import { resolveBundles } from "./manifest.js";
import type { IslandBundleEntry, IslandBundleManifest } from "./manifest.js";

/** Attribute that marks an element as an island mount. */
export const COMPONENT_ATTRIBUTE = "data-component";

/** Attribute carrying the island's props as a JSON object. */
export const PROPS_ATTRIBUTE = "data-props";

/** Attribute the runtime sets to expose what happened to a mount. */
export const STATE_ATTRIBUTE = "data-island-state";

/** One mount slot found in a document. */
export interface IslandMount {
  /** 1-based document order among mounts, so a report can cite one. */
  readonly index: number;
  /** Raw `data-component` value. Never trimmed or case-folded. */
  readonly component: string;
  /** Raw `data-props` value, or `null` when the attribute is absent. */
  readonly props: string | null;
}

/** A `data-component` value that cannot be a component name. */
export interface InvalidMount {
  readonly index: number;
  readonly value: string;
  readonly message: string;
}

export interface MountScan {
  /** Valid mount slots, in document order. */
  readonly mounts: IslandMount[];
  /**
   * Present `data-component` values that are not valid component names.
   *
   * Reported instead of dropped: an emitter that silently ignored a typo would
   * ship a page whose island never mounts, and nothing would say why.
   */
  readonly invalid: InvalidMount[];
  /** Distinct component names needing a bundle, in first-appearance order. */
  readonly components: string[];
}

/** Component names are identifiers because they are `data-component` values. */
const COMPONENT_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

/** The slice of parse5's tree this module walks. Deliberately structural. */
interface P5Node {
  readonly nodeName?: string;
  readonly attrs?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly childNodes?: ReadonlyArray<P5Node>;
  readonly content?: P5Node;
}

function attributeOf(node: P5Node, name: string): string | null {
  for (const attribute of node.attrs ?? []) {
    if (attribute.name === name) return attribute.value;
  }
  return null;
}

/** Depth-first walk including `<template>` content, which parse5 nests away. */
function visit(node: P5Node, visitElement: (element: P5Node) => void): void {
  const nodeName = node.nodeName ?? "";
  const isElement = nodeName.length > 0 && !nodeName.startsWith("#");
  if (isElement) visitElement(node);

  for (const child of node.childNodes ?? []) visit(child, visitElement);
  if (node.content !== undefined) visit(node.content, visitElement);
}

/**
 * Find every island mount slot in an HTML document.
 *
 * Works on a fragment as well as a full document: parse5 wraps a fragment in an
 * `#document` node with the same tree shape underneath.
 */
export function scanIslandMounts(html: string): MountScan {
  const document = parse(html) as unknown as P5Node;

  const mounts: IslandMount[] = [];
  const invalid: InvalidMount[] = [];
  const components: string[] = [];
  const seen = new Set<string>();
  let index = 0;

  visit(document, (element) => {
    const value = attributeOf(element, COMPONENT_ATTRIBUTE);
    if (value === null) return;

    index += 1;
    if (!COMPONENT_PATTERN.test(value)) {
      invalid.push({
        index,
        value,
        message: `"${value}" is not a valid component name (expected /^[A-Z][A-Za-z0-9]*$/)`,
      });
      return;
    }

    mounts.push({ index, component: value, props: attributeOf(element, PROPS_ATTRIBUTE) });
    if (!seen.has(value)) {
      seen.add(value);
      components.push(value);
    }
  });

  return { mounts, invalid, components };
}

/**
 * The bundles a page must ship — and nothing else.
 *
 * An island-free page returns `[]`, so an emitter built on this function cannot
 * emit wasm bytes for a page with no islands. That is the "no islands ⇒ no wasm
 * bytes" guarantee, expressed as data rather than as a promise.
 *
 * Throws `MissingBundleError` when the page mounts a component the manifest does
 * not describe: a page that cannot mount is a build failure.
 */
export function bundlesForHtml(html: string, manifest: IslandBundleManifest): IslandBundleEntry[] {
  return resolveBundles(scanIslandMounts(html).components, manifest);
}
