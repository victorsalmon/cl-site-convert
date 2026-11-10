/**
 * Body-tree equality — the heart of the equivalence claim.
 *
 * The emitter does not re-implement layout: it replays the captured body. So the
 * emitted body must be the captured body **except** where a reference was re-pointed
 * at the emitted tree. This module states exactly which differences are allowed and
 * re-derives each expected value from the captured one, so a wrong rewrite cannot
 * agree with a wrong expectation.
 *
 * The permitted set is deliberately small and closed:
 *
 * | Difference | Rule |
 * | :--- | :--- |
 * | `img[src]`, `img[srcset]`, `source[srcset]`, `link[href]` | must equal the path `capture/asset-rewrite-map.json` prescribes, relative to the page |
 * | `a[href]`, `link[href]` to the source host | must equal the site-root-relative form of the captured path; a target that is a captured route is classified `navigation`, anything else `internal-path` |
 * | `form[action]` to the source host | must equal the configured sink |
 * | `link[rel=canonical][href]` | must equal `${baseUrl}` + the captured path |
 * | `meta[content]` naming a captured image | must equal the asset-map path relative to the page |
 *
 * Anything else — a tag, an attribute name, an attribute order, a class token, a text
 * node, an unclassified value — is a failure. The comparison stops at the **first**
 * difference and reports its node path: a page with 400 differences is one diagnosis,
 * not 400.
 */

import { toSiteRootRelative, routeOf } from "../../emit/static-html/localise.js";
import { lookupRewrite, relativePrefix } from "../../emit/static-html/rewrite.js";
import type { RewriteTable } from "../../emit/static-html/rewrite.js";
import {
  attributeOf,
  comparableChildren,
  isElementNode,
  isTextNode,
  nodeLabel,
  pathSegment,
  relTokens,
  type HtmlNode,
} from "./dom.js";
import {
  emptyRewriteCounts,
  type CheckId,
  type ParityFailure,
  type RewriteCategory,
  type RewriteCounts,
} from "./types.js";

/** Everything the comparison needs to know about the target, never about the emitter. */
export interface TreeRules {
  readonly page: string;
  readonly check: CheckId;
  /** Page depth, i.e. how many `../` a reference from this page needs. */
  readonly dirDepth: number;
  readonly sourceOrigin: string;
  readonly baseUrl: string;
  readonly formSink: string;
  readonly routes: ReadonlySet<string>;
  readonly table: RewriteTable;
}

/** The outcome of comparing one tree. */
export interface TreeComparison {
  readonly nodesCompared: number;
  /** The first difference, or `null` when the trees are equivalent. */
  readonly difference: ParityFailure | null;
  readonly rewrites: RewriteCounts;
}

/** What a value change is allowed to be, or why it is not allowed at all. */
type ValueChange =
  | { readonly allowed: true; readonly category: RewriteCategory }
  | { readonly allowed: false; readonly reason: string };

/** The emitted reference the asset map prescribes for a captured one. */
function mappedReference(rules: TreeRules, captured: string): string | null {
  const hit = lookupRewrite(rules.table, captured.trim());
  if (hit === null) return null;
  return `${relativePrefix(rules.dirDepth)}${hit.path}${hit.suffix}`;
}

/** Is this captured value an absolute reference to the site's own origin? */
function isSelfReference(value: string, sourceOrigin: string): boolean {
  return toSiteRootRelative(value, sourceOrigin) !== null;
}

/** A `srcset` split into its candidate urls and their `2x`/`320w` descriptors. */
function srcsetCandidates(value: string): { url: string; descriptor: string }[] | null {
  // A `data:` candidate carries commas of its own; the emitter leaves such an
  // attribute verbatim, so there is nothing to compare candidate by candidate.
  if (value.includes("data:")) return null;
  return value.split(",").map((part) => {
    const trimmed = part.trim();
    const breakAt = trimmed.search(/\s/);
    return breakAt < 0
      ? { url: trimmed, descriptor: "" }
      : { url: trimmed.slice(0, breakAt), descriptor: trimmed.slice(breakAt) };
  });
}

/**
 * Localisation of a link or anchor whose target was on the source host.
 *
 * A captured route becomes navigation (a target the artefact actually serves);
 * anything else on the source host is an internal path the static host does not
 * serve, which is still localised rather than left pointing at production.
 */
function localisedTarget(rules: TreeRules, captured: string, emitted: string): ValueChange {
  const relative = toSiteRootRelative(captured, rules.sourceOrigin);
  if (relative === null) {
    return { allowed: false, reason: `"${captured}" is not a reference to ${rules.sourceOrigin}` };
  }
  if (emitted !== relative) {
    return {
      allowed: false,
      reason: `expected the site-root-relative form ${JSON.stringify(relative)}, found ${JSON.stringify(emitted)}`,
    };
  }
  return {
    allowed: true,
    category: rules.routes.has(routeOf(relative)) ? "navigation" : "internal-path",
  };
}

/**
 * Classify one attribute-value change, re-deriving the expected value from the
 * captured one. This is the whole permitted set; there is no fallthrough.
 */
function classifyValueChange(
  element: HtmlNode,
  attributeName: string,
  captured: string,
  emitted: string,
  rules: TreeRules,
): ValueChange {
  const tag = element.nodeName ?? "";
  const rel = relTokens(element);

  // 1. A form must never post to the live WordPress install.
  if (
    tag === "form" &&
    attributeName === "action" &&
    isSelfReference(captured, rules.sourceOrigin)
  ) {
    return emitted === rules.formSink
      ? { allowed: true, category: "form-sink" }
      : {
          allowed: false,
          reason: `form action must be the configured sink ${JSON.stringify(rules.formSink)}, found ${JSON.stringify(emitted)}`,
        };
  }

  // 2. A canonical URL stays absolute, on this target's own origin.
  if (tag === "link" && attributeName === "href" && rel.includes("canonical")) {
    const relative = toSiteRootRelative(captured, rules.sourceOrigin);
    if (relative === null) {
      return {
        allowed: false,
        reason: `"${captured}" is not a reference to ${rules.sourceOrigin}`,
      };
    }
    const expected = `${rules.baseUrl}${relative}`;
    return emitted === expected
      ? { allowed: true, category: "canonical" }
      : {
          allowed: false,
          reason: `expected the canonical ${JSON.stringify(expected)}, found ${JSON.stringify(emitted)}`,
        };
  }

  // 3. `<meta content>` naming a captured image is localised through the asset map.
  if (tag === "meta" && attributeName === "content") {
    const expected = mappedReference(rules, captured);
    return expected !== null && emitted === expected
      ? { allowed: true, category: "meta-asset" }
      : {
          allowed: false,
          reason:
            expected === null
              ? `"${captured}" has no entry in the asset rewrite map, so it must be unchanged`
              : `expected the mapped path ${JSON.stringify(expected)}, found ${JSON.stringify(emitted)}`,
        };
  }

  // 4. Asset references: `img[src]`, `img[srcset]`, `source[srcset]`, `link[href]`.
  const assetBearing =
    (tag === "img" && (attributeName === "src" || attributeName === "srcset")) ||
    (tag === "source" && attributeName === "srcset");

  if (assetBearing && attributeName === "srcset") {
    const before = srcsetCandidates(captured);
    const after = srcsetCandidates(emitted);
    if (before === null || after === null) {
      return { allowed: false, reason: "a data: srcset must be preserved verbatim" };
    }
    if (before.length !== after.length) {
      return {
        allowed: false,
        reason: `srcset has ${String(after.length)} candidate(s), the capture has ${String(before.length)}`,
      };
    }
    for (const [index, candidate] of before.entries()) {
      const counterpart = after[index] as { url: string; descriptor: string };
      if (counterpart.descriptor !== candidate.descriptor) {
        return {
          allowed: false,
          reason: `srcset candidate ${String(index)} descriptor changed from ${JSON.stringify(candidate.descriptor)} to ${JSON.stringify(counterpart.descriptor)}`,
        };
      }
      if (counterpart.url === candidate.url) continue;
      const expected = mappedReference(rules, candidate.url);
      if (expected === null || counterpart.url !== expected) {
        return {
          allowed: false,
          reason: `srcset candidate ${String(index)} ${JSON.stringify(candidate.url)} may only become its mapped path${expected === null ? " (the map has no entry)" : ` ${JSON.stringify(expected)}`}, found ${JSON.stringify(counterpart.url)}`,
        };
      }
    }
    return { allowed: true, category: "asset" };
  }

  if (assetBearing) {
    const expected = mappedReference(rules, captured);
    return expected !== null && emitted === expected
      ? { allowed: true, category: "asset" }
      : {
          allowed: false,
          reason:
            expected === null
              ? `"${captured}" has no entry in the asset rewrite map, so it must be unchanged`
              : `expected the mapped path ${JSON.stringify(expected)}, found ${JSON.stringify(emitted)}`,
        };
  }

  // 5. `link[href]`: an asset when the map knows it, otherwise a localised target.
  if (tag === "link" && attributeName === "href") {
    const expected = mappedReference(rules, captured);
    if (expected !== null) {
      return emitted === expected
        ? { allowed: true, category: "asset" }
        : {
            allowed: false,
            reason: `expected the mapped path ${JSON.stringify(expected)}, found ${JSON.stringify(emitted)}`,
          };
    }
    if (isSelfReference(captured, rules.sourceOrigin)) {
      return localisedTarget(rules, captured, emitted);
    }
    return {
      allowed: false,
      reason: `"${captured}" is neither in the asset map nor self-referential`,
    };
  }

  // 6. Anchors: navigation and internal links are localised, nothing else moves.
  if (tag === "a" && attributeName === "href" && isSelfReference(captured, rules.sourceOrigin)) {
    return localisedTarget(rules, captured, emitted);
  }

  return {
    allowed: false,
    reason: `<${tag} ${attributeName}> is not an attribute emission may rewrite`,
  };
}

/**
 * Compare two trees.
 *
 * `captured` is the authority (the IR's `dom.html`), `emitted` the artefact. Both are
 * parse5 trees. The walk stops at the first difference and returns it with the node
 * path, because the second difference is almost always a consequence of the first.
 */
export function compareTrees(
  captured: HtmlNode,
  emitted: HtmlNode,
  rules: TreeRules,
): TreeComparison {
  const rewrites = emptyRewriteCounts();
  let nodesCompared = 0;
  let difference: ParityFailure | null = null;
  const rootPath =
    captured.nodeName === "body"
      ? ["html", "body"]
      : captured.nodeName === "head"
        ? ["html", "head"]
        : ["html"];

  const fail = (
    path: readonly string[],
    message: string,
    expected?: string,
    actual?: string,
  ): void => {
    if (difference !== null) return;
    difference = {
      check: rules.check,
      page: rules.page,
      path: path.join(" > "),
      message,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
    };
  };

  const compareSequences = (
    capturedNodes: readonly HtmlNode[],
    emittedNodes: readonly HtmlNode[],
    path: readonly string[],
  ): void => {
    if (difference !== null) return;
    if (capturedNodes.length !== emittedNodes.length) {
      fail(
        path,
        `child count differs: the capture has ${String(capturedNodes.length)} node(s), the artefact has ${String(emittedNodes.length)}`,
        capturedNodes.map(nodeLabel).join(", "),
        emittedNodes.map(nodeLabel).join(", "),
      );
      return;
    }
    for (const [index, node] of capturedNodes.entries()) {
      if (difference !== null) return;
      const counterpart = emittedNodes[index] as HtmlNode;
      compareNode(node, counterpart, [...path, pathSegment(node, capturedNodes)]);
    }
  };

  const compareNode = (
    capturedNode: HtmlNode,
    emittedNode: HtmlNode,
    path: readonly string[],
  ): void => {
    if (difference !== null) return;

    if (isTextNode(capturedNode)) {
      if (!isTextNode(emittedNode)) {
        fail(path, "a captured text node became a different kind of node");
        return;
      }
      nodesCompared += 1;
      if (emittedNode.value !== capturedNode.value) {
        fail(
          path,
          "text node differs",
          JSON.stringify(capturedNode.value ?? ""),
          JSON.stringify(emittedNode.value ?? ""),
        );
      }
      return;
    }

    if (!isElementNode(capturedNode)) return;
    nodesCompared += 1;

    if (emittedNode.nodeName !== capturedNode.nodeName) {
      fail(path, "element tag differs", capturedNode.nodeName ?? "", emittedNode.nodeName ?? "");
      return;
    }

    const capturedAttributes = capturedNode.attrs ?? [];
    const emittedAttributes = emittedNode.attrs ?? [];

    const capturedNames = capturedAttributes.map((attribute) => attribute.name);
    const emittedNames = emittedAttributes.map((attribute) => attribute.name);
    if (capturedNames.join("\u0000") !== emittedNames.join("\u0000")) {
      fail(
        path,
        "attribute names or their order differ",
        capturedNames.join(" "),
        emittedNames.join(" "),
      );
      return;
    }

    // Class lists are the fidelity carrier; state them on their own so a mid-list
    // drift reads as a class failure rather than "an attribute changed".
    const capturedClasses = (attributeOf(capturedNode, "class") ?? "").split(/\s+/);
    const emittedClasses = (attributeOf(emittedNode, "class") ?? "").split(/\s+/);
    if (capturedClasses.join("\u0000") !== emittedClasses.join("\u0000")) {
      fail(path, "class list differs", capturedClasses.join(" "), emittedClasses.join(" "));
      return;
    }

    for (const attribute of capturedAttributes) {
      const emittedValue = attributeOf(emittedNode, attribute.name);
      if (emittedValue === attribute.value) continue;
      if (emittedValue === null) {
        fail(path, `<${capturedNode.nodeName ?? ""} ${attribute.name}> disappeared`);
        return;
      }
      const change = classifyValueChange(
        capturedNode,
        attribute.name,
        attribute.value,
        emittedValue,
        rules,
      );
      if (!change.allowed) {
        fail(
          path,
          `<${capturedNode.nodeName ?? ""} ${attribute.name}> ${change.reason}`,
          attribute.value,
          emittedValue,
        );
        return;
      }
      rewrites[change.category] += 1;
    }

    compareSequences(comparableChildren(capturedNode), comparableChildren(emittedNode), path);
  };

  compareNode(captured, emitted, rootPath);
  return { nodesCompared, difference, rewrites };
}

/**
 * Compare two child sequences that are expected to line up one-for-one — used for the
 * head, where the cascade block has already been removed from both sides.
 *
 * A synthetic element wrapper is used so the shared walker can be reused unchanged.
 */
export function compareSiblingSequences(
  capturedNodes: readonly HtmlNode[],
  emittedNodes: readonly HtmlNode[],
  rules: TreeRules,
): TreeComparison {
  const wrapper = (children: readonly HtmlNode[]): HtmlNode => ({
    nodeName: "head",
    childNodes: children,
  });
  const result = compareTrees(wrapper(capturedNodes), wrapper(emittedNodes), {
    ...rules,
    check: "head-tree",
  });
  // The wrapper is this function's own scaffolding, not a node of the document.
  return { ...result, nodesCompared: Math.max(0, result.nodesCompared - 1) };
}
