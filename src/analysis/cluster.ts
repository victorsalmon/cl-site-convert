/**
 * Template clustering — how many page *shapes* does this capture actually have?
 *
 * "Convert 19 pages" is a poor unit of work. Pages come in templates, and the
 * thing that decides effort and risk is how many structurally distinct page
 * skeletons the emitter, the QA pass and the visual-parity baseline each have to
 * cover. This module measures that number instead of guessing it.
 *
 * ## Why the signature is Divi section/row/column *shape*, not markup
 *
 * The capture is a real Divi 4.27.7 site. Two pages built from the same template
 * differ in text, image sources, link targets, module instance numbers
 * (`et_pb_heading_7` vs `et_pb_heading_2`) and navigation state — and in nothing
 * structural. A signature that hashed the markup would report 19 templates; one
 * that hashed only the text would report 1. The stable signal is the page-builder
 * skeleton:
 *
 * ```text
 * section → row → column
 * ```
 *
 * so a page's signature is the ordered list of its content sections, each section
 * being the ordered column counts of its rows (`[[1,3],[3],[2],[2,2]]` = "four
 * sections: a 2-row section with 1 and 3 columns, then a 3-column row, then a
 * 2-column row, then a 2-row section with 2 and 2 columns"). Nesting is preserved
 * because the row grouping is part of the signature, and the top-level section
 * count is `sections.length`.
 *
 * Deliberately ignored, because each of them varies with content and would split
 * one template into many clusters:
 *
 *  - all text, `src`, `srcset`, `href`, `alt`, form field values;
 *  - instance-suffixed class tokens (`et_pb_section_3`, `et_pb_heading_12`,
 *    `page-id-557`, `wp-image-662`, `menu-item-529`), which Divi renumbers per
 *    page and per edit;
 *  - module *type* choice (`et_pb_text` vs `et_pb_blurb`): a template's text can
 *    be a heading on one property's page and body copy on the other.
 *
 * ## Site chrome is not the page template
 *
 * Divi's Theme Builder renders the global footer as a real `et_pb_section`, so
 * every one of the 16 theme-builder pages ends in the same `<footer>` section
 * (`et_pb_section_1_tb_footer`). Counting it as page structure would make every
 * page look like every other page — the single failure mode that would collapse
 * this measurement into "1 template".
 *
 * Sections carrying a Divi theme-builder marker (`_tb_footer` / `_tb_header`) are
 * therefore recorded as `siteChrome` and excluded from the shape that is compared.
 * The rule is a marker, not a guess, and it is corroborated by the capture: the
 * only 3 pages without that footer are exactly the 3 pages whose WP `template` is
 * `page-template-blank.php` (measured 19/19 in `capture/template-registry.json`).
 *
 * ## The similarity measure and the threshold
 *
 * Two shapes are compared by a weighted longest-common-subsequence over their
 * sections, where a matched pair of sections scores the LCS ratio of their row
 * shapes:
 *
 * ```text
 * sectionSim(a, b) = 2·LCS(a.rows, b.rows) / (|a.rows| + |b.rows|)     (both empty ⇒ 1)
 * shapeSim(A, B)    = 2·max(Σ matched sectionSim) / (|A| + |B|)        (both empty ⇒ 1)
 * ```
 *
 * Both are bounded 0..1, are 1 exactly when the structures are identical, and
 * tolerate a page that adds or drops a section without scoring 0. Order is
 * respected (LCS), so a page whose sections are reordered is *not* the same shape.
 *
 * Clustering is **complete-link** agglomerative: two clusters merge only when
 * *every* cross-pair scores at least the threshold, and the highest-scoring pair
 * merges first. That is the contract the registry promises its reader — "any
 * member of this cluster is the exemplar for the rest" — which single-link would
 * break by chaining (`A~B`, `B~C`, but `A≁C`).
 *
 * `CLUSTER_THRESHOLD` is 0.85 because of the data, not because it is round. The
 * measured merge ladder for the 19 captured pages is:
 *
 * ```text
 * 1.000  identical shapes (3 pairs: /mlm/+/tmh/, the two onboard pages, the two
 *        chrome-only /ush/ pages)
 * 0.875  /care/sweepy-admin/ + /care/ttlock-admin/ — same four sections, one row's
 *        column count differs (4 vs 5)
 * 0.800  /care/showings/ + /resources/sweepy/ — one section against one section,
 *        both matched, so the page score *is* the section score (2 rows vs 3)
 * 0.667  a page that does not have the same section count at all
 * ```
 *
 * 0.800 is a false positive: those two pages have genuinely different content
 * blocks and only share a two-row prefix, so the threshold must be above it.
 * 0.875 is the cheapest genuine template match, so the threshold must not exceed
 * it. Any value in `(0.800, 0.875]` therefore produces the identical partition,
 * and 0.85 is its midpoint — the point of maximum distance from both sides. A
 * test re-clusters at 0.81, 0.83, 0.85 and 0.875 and asserts the same 15
 * clusters, so the exact number is not magic; it is a place inside a proven
 * plateau.
 *
 * The same test asserts the measured answer: **19 pages → 15 shapes**. Divi pages
 * here are hand-built per page, so this site does not have "a few templates with
 * content slots"; it has fifteen skeletons, four of which are shared by two pages
 * each.
 *
 * ## Why the WP `template` field is not folded into the similarity
 *
 * `page-template-*` body classes *are* part of the emitted signature, and the
 * registry cross-checks them against the REST `template` field. They are not,
 * however, compared as part of the shape. Folding them in would make the
 * cross-check circular: the two would agree by construction, and a real
 * divergence — two pages on one WP template with different structures, or one
 * structure under two templates — could never be reported. Cluster members carry
 * their own WP identity so a mixed cluster is visible, and
 * `classifyWpTemplateCrossCheck` names every disagreement it finds.
 *
 * Pure analysis: no network, no filesystem, no dependency beyond `parse5`, which
 * the capture path already uses.
 */

import { parse } from "parse5";

/** Similarity at or above which two page shapes are the same template. */
export const CLUSTER_THRESHOLD = 0.85;

/**
 * The band of thresholds that produces the partition `CLUSTER_THRESHOLD` produces.
 * Any `t` with `above < t <= atMost` yields the identical clusters; the constant
 * sits at the midpoint. Measured, not assumed — see the module doc.
 */
export const THRESHOLD_BAND = { above: 0.8, atMost: 0.875 } as const;

/** Divi class token marking a Theme Builder layout section (global chrome). */
const CHROME_MARKER = /_tb_(?:footer|header)$/;

/** Divi structural class tokens this module reads. Exact token match, never prefix. */
const SECTION_CLASS = "et_pb_section";
const ROW_CLASS = "et_pb_row";
const COLUMN_CLASS = "et_pb_column";

/** Body classes that identify the WP page template. */
const TEMPLATE_CLASS_PREFIX = "page-template-";

/**
 * Content-dependent class tokens: WordPress identity, attachment ids and menu
 * item ids. Each is different on every page, so none of them is template shape.
 */
const VOLATILE_CLASS_PATTERNS: readonly RegExp[] = [
  /^page-id-\d+$/,
  /^postid-\d+$/,
  /^parent-pageid-\d+$/,
  /^menu-item-\d+$/,
  /^wp-image-\d+$/,
];

/**
 * Float noise guard. Similarities are ratios of small integers, so exact values
 * repeat; the epsilon only stops `0.875` printing as `0.8749999999`.
 */
const EPSILON = 1e-12;

// ---- the slice of parse5's tree this module walks --------------------------

interface P5Node {
  readonly nodeName?: string;
  readonly attrs?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly childNodes?: ReadonlyArray<P5Node>;
  readonly content?: P5Node;
}

function isElement(node: P5Node): boolean {
  const name = node.nodeName ?? "";
  return name.length > 0 && !name.startsWith("#");
}

function attributeOf(node: P5Node, name: string): string | null {
  for (const attribute of node.attrs ?? []) {
    if (attribute.name === name) return attribute.value;
  }
  return null;
}

function classTokens(node: P5Node): string[] {
  const value = attributeOf(node, "class");
  if (value === null) return [];
  return value.split(/\s+/).filter((token) => token.length > 0);
}

function hasClass(node: P5Node, token: string): boolean {
  return classTokens(node).includes(token);
}

/** Depth-first walk over elements, including `<template>` content. */
function visit(node: P5Node, visitElement: (element: P5Node) => void): void {
  if (isElement(node)) visitElement(node);
  for (const child of node.childNodes ?? []) visit(child, visitElement);
  if (node.content !== undefined) visit(node.content, visitElement);
}

// ---- one page's shape ------------------------------------------------------

/**
 * One section's layout: the column count of each of its rows, in DOM order.
 *
 * `[1,3]` is a two-row section whose first row has one column and second has
 * three. An empty array is a section with no rows at all, which is a real thing
 * in Divi (a background/CTA band carrying only a shortcode) and is kept rather
 * than dropped — dropping it would make the section count lie.
 */
export type SectionShape = readonly number[];

/** A single page's measured structure. This is what clustering compares. */
export interface PageShape {
  /** Site-relative route, e.g. `/care/sweepy-admin/`. */
  readonly route: string;
  /** WP REST `template` field verbatim; `""` when the site declares none. */
  readonly template: string;
  /** Sorted `page-template-*` body classes: the WP-side shell identity. */
  readonly templateClasses: readonly string[];
  /** Ordered content-section shapes. Theme-builder chrome is excluded. */
  readonly sections: readonly SectionShape[];
  /** Ordered theme-builder section shapes (global header/footer), recorded but not compared. */
  readonly siteChrome: readonly SectionShape[];
  /**
   * Content-region class tokens with instance classes removed, sorted.
   * Used for `sharedCssClasses` — the selectors a template actually depends on.
   */
  readonly contentClasses: readonly string[];
}

/** The minimum a caller must supply to measure a page. */
export interface PageShapeInput {
  readonly url: string;
  readonly template: string;
  readonly html: string;
}

/**
 * True when a class token is an instance number rather than a layout rule.
 *
 * `et_pb_heading_12`, `et_pb_section_0`, `et_pb_column_3`, `et_pb_button_0_wrapper`
 * and `et_pb_heading_2_tb_footer` are per-page instance names. `et_pb_column_1_3`
 * and `et_pb_column_4_4` are **layout fractions** and survive: they describe a
 * one-third and a full-width column, which is structure.
 */
export function isInstanceClass(token: string): boolean {
  if (VOLATILE_CLASS_PATTERNS.some((pattern) => pattern.test(token))) return true;
  if (CHROME_MARKER.test(token)) return true;

  const segments = token.split("_");
  let trailingIntegers = 0;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] ?? "";
    if (!/^\d+$/.test(segment)) break;
    trailingIntegers += 1;
  }
  // One trailing integer is an instance index; two are a column fraction.
  if (trailingIntegers === 1) return true;
  if (/^[\w-]+_\d+_[a-z][a-z_]*$/.test(token)) return true;
  return false;
}

/** Divi sections directly inside a container, in document order. */
function collectSections(root: P5Node): P5Node[] {
  const sections: P5Node[] = [];
  const scan = (node: P5Node): void => {
    for (const child of node.childNodes ?? []) {
      if (!isElement(child)) {
        scan(child);
        continue;
      }
      if (hasClass(child, SECTION_CLASS)) {
        sections.push(child);
        continue;
      }
      scan(child);
    }
  };
  scan(root);
  return sections;
}

/** Columns inside one row. `et_pb_column_inner` is a different token and is not counted. */
function countColumns(row: P5Node): number {
  let columns = 0;
  visit(row, (element) => {
    if (hasClass(element, COLUMN_CLASS)) columns += 1;
  });
  return columns;
}

/**
 * A section's row layout.
 *
 * Rows are found by descent, not by direct-child inspection, because Divi wraps
 * rows in `<div class="et_pb_row …">` today but a wrapper div is not guaranteed.
 * A nested section (not present in this capture, measured: 0) contributes its
 * rows to its parent's shape rather than being silently dropped.
 */
function sectionShape(section: P5Node): SectionShape {
  const rows: number[] = [];
  const scan = (node: P5Node): void => {
    for (const child of node.childNodes ?? []) {
      if (!isElement(child)) {
        scan(child);
        continue;
      }
      if (hasClass(child, ROW_CLASS)) {
        rows.push(countColumns(child));
        continue;
      }
      scan(child);
    }
  };
  scan(section);
  return rows;
}

function isChromeSection(section: P5Node): boolean {
  return classTokens(section).some((token) => CHROME_MARKER.test(token));
}

/** `<body>` element, or the document itself when the capture has no body. */
function findBody(document: P5Node): P5Node {
  let body: P5Node | null = null;
  visit(document, (element) => {
    if (body === null && element.nodeName === "body") body = element;
  });
  return body ?? document;
}

/**
 * Measure one page.
 *
 * Reads the captured `dom.html` only. Text, `src`, `href` and instance class
 * numbers are never consulted, so two pages built from one template measure
 * identically no matter how different their content is.
 */
export function extractPageShape(page: PageShapeInput): PageShape {
  const document = parse(page.html) as unknown as P5Node;
  const body = findBody(document);

  const sections: SectionShape[] = [];
  const siteChrome: SectionShape[] = [];
  const contentClasses = new Set<string>();

  for (const section of collectSections(body)) {
    const shape = sectionShape(section);
    if (isChromeSection(section)) {
      siteChrome.push(shape);
      continue;
    }
    sections.push(shape);
    visit(section, (element) => {
      for (const token of classTokens(element)) {
        if (!isInstanceClass(token)) contentClasses.add(token);
      }
    });
  }

  const templateClasses = Array.from(new Set(classTokens(body))).filter((token) =>
    token.startsWith(TEMPLATE_CLASS_PREFIX),
  );

  return {
    route: page.url,
    template: page.template,
    templateClasses: templateClasses.sort(),
    sections,
    siteChrome,
    contentClasses: Array.from(contentClasses).sort(),
  };
}

// ---- similarity ------------------------------------------------------------

/** Length of the longest common subsequence of two numeric sequences. */
export function longestCommonSubsequence(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const left of a) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let index = 1; index <= b.length; index += 1) {
      const right = b[index - 1] ?? 0;
      current[index] =
        left === right
          ? (previous[index - 1] ?? 0) + 1
          : Math.max(previous[index] ?? 0, current[index - 1] ?? 0);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * How alike two sections' row layouts are: the LCS ratio, 0..1.
 *
 * Two sections with no rows are identical (score 1); one empty and one with rows
 * share nothing (score 0).
 */
export function sectionSimilarity(a: SectionShape, b: SectionShape): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return (2 * longestCommonSubsequence(a, b)) / (a.length + b.length);
}

/**
 * How alike two pages are, 0..1, ignoring everything except section/row/column
 * structure. Alignment is order-preserving, so reordered sections score lower
 * than the same sections in the same order.
 */
export function shapeSimilarity(a: PageShape, b: PageShape): number {
  if (a.sections.length === 0 && b.sections.length === 0) return 1;
  if (a.sections.length === 0 || b.sections.length === 0) return 0;

  const rows = a.sections.length + 1;
  const columns = b.sections.length + 1;
  let previous = new Array<number>(columns).fill(0);
  for (let left = 1; left < rows; left += 1) {
    const current = new Array<number>(columns).fill(0);
    for (let right = 1; right < columns; right += 1) {
      const match =
        (previous[right - 1] ?? 0) +
        sectionSimilarity(a.sections[left - 1] ?? [], b.sections[right - 1] ?? []);
      current[right] = Math.max(match, previous[right] ?? 0, current[right - 1] ?? 0);
    }
    previous = current;
  }

  const matched = previous[columns - 1] ?? 0;
  return (2 * matched) / (a.sections.length + b.sections.length);
}

// ---- clustering ------------------------------------------------------------

/** The signature recorded in the registry. JSON-shaped, so it is stable to diff. */
export interface TemplateSignature {
  readonly sectionCount: number;
  readonly rowCount: number;
  readonly columnCount: number;
  /** Per section, the column count of each row. */
  readonly sections: readonly (readonly number[])[];
  readonly templateClasses: readonly string[];
  readonly siteChrome: {
    readonly sectionCount: number;
    readonly shapes: readonly (readonly number[])[];
  };
}

export function signatureOf(page: PageShape): TemplateSignature {
  let rowCount = 0;
  let columnCount = 0;
  for (const section of page.sections) {
    rowCount += section.length;
    for (const columns of section) columnCount += columns;
  }
  return {
    sectionCount: page.sections.length,
    rowCount,
    columnCount,
    sections: page.sections,
    templateClasses: page.templateClasses,
    siteChrome: {
      sectionCount: page.siteChrome.length,
      shapes: page.siteChrome,
    },
  };
}

/** One page's WP identity as recorded inside a cluster. */
export interface ClusterMember {
  readonly route: string;
  /** REST `template` verbatim; `""` for none. */
  readonly template: string;
  readonly templateClasses: readonly string[];
}

export interface TemplateCluster {
  /** Stable id for this run: `tpl-01` … ordered by size then exemplar route. */
  readonly id: string;
  /** Deterministic shape description, e.g. `4 sections [1 | 1+4 | 1+3 | 1+4]`. */
  readonly label: string;
  /** Lexicographically first member route: the page to open first. */
  readonly exemplarRoute: string;
  readonly memberRoutes: readonly string[];
  /** The exemplar's signature; `shapeVariants` says whether members differ at all. */
  readonly signature: TemplateSignature;
  readonly sectionCount: number;
  /** Classes present on every member's content region, instance classes removed. */
  readonly sharedCssClasses: readonly string[];
  /** Distinct section-shape sequences among members (1 for an exact match). */
  readonly shapeVariants: number;
  /** Distinct WP `template` values among members: >1 is a shell divergence. */
  readonly wpTemplates: readonly string[];
  /** Union of members' `page-template-*` body classes. */
  readonly templateClasses: readonly string[];
  /** Pairwise similarity range inside the cluster, the complete-link guarantee. */
  readonly similarity: { readonly min: number; readonly max: number };
  readonly members: readonly ClusterMember[];
}

/** Human-readable shape label. Kept pure so cluster ids and labels stay diffable. */
export function shapeLabel(sections: readonly SectionShape[]): string {
  if (sections.length === 0) return "0 sections (site chrome only)";
  const parts = sections.map((rows) => (rows.length === 0 ? "empty" : rows.join("+")));
  return `${sections.length} section${sections.length === 1 ? "" : "s"} [${parts.join(" | ")}]`;
}

interface WorkingCluster {
  members: PageShape[];
}

function clusterKey(members: readonly PageShape[]): string {
  return members
    .map((member) => member.route)
    .sort()
    .join("\u0000");
}

function intersectAll(values: readonly (readonly string[])[]): string[] {
  if (values.length === 0) return [];
  const [first, ...rest] = values;
  if (first === undefined) return [];
  return first.filter((token) => rest.every((list) => list.includes(token)));
}

function similarityRange(members: readonly PageShape[]): { min: number; max: number } {
  if (members.length < 2) return { min: 1, max: 1 };
  let min = 1;
  let max = 0;
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) {
      const score = shapeSimilarity(members[left] as PageShape, members[right] as PageShape);
      min = Math.min(min, score);
      max = Math.max(max, score);
    }
  }
  return { min, max };
}

/**
 * Complete-link agglomerative clustering over page shapes.
 *
 * Merges the pair with the highest minimum cross-similarity first, and stops when
 * that best score would fall below `threshold`. Ties are broken by the clusters'
 * sorted member routes so the result does not depend on input order.
 */
export function clusterShapes(
  pages: readonly PageShape[],
  threshold: number = CLUSTER_THRESHOLD,
): TemplateCluster[] {
  const unique = new Map<string, PageShape>();
  for (const page of pages) {
    if (!unique.has(page.route)) unique.set(page.route, page);
  }
  const shapes = Array.from(unique.values());
  if (shapes.length === 0) return [];

  let clusters: WorkingCluster[] = shapes.map((shape) => ({ members: [shape] }));

  for (;;) {
    let best: { left: number; right: number; score: number } | null = null;
    let bestKey = "";
    for (let left = 0; left < clusters.length; left += 1) {
      for (let right = left + 1; right < clusters.length; right += 1) {
        let score = Number.POSITIVE_INFINITY;
        for (const a of (clusters[left] as WorkingCluster).members) {
          for (const b of (clusters[right] as WorkingCluster).members) {
            score = Math.min(score, shapeSimilarity(a, b));
          }
        }
        if (Number.isNaN(score)) continue;
        const pairKey = [keyOf(clusters[left]), keyOf(clusters[right])].sort().join("\u0001");
        if (
          best === null ||
          score > best.score + EPSILON ||
          (Math.abs(score - best.score) <= EPSILON && pairKey < bestKey)
        ) {
          best = { left, right, score };
          bestKey = pairKey;
        }
      }
    }

    if (best === null || best.score + EPSILON < threshold) break;

    const merged: WorkingCluster = {
      members: [
        ...(clusters[best.left] as WorkingCluster).members,
        ...(clusters[best.right] as WorkingCluster).members,
      ],
    };
    clusters = clusters
      .filter((_cluster, index) => index !== best?.left && index !== best?.right)
      .concat([merged]);
  }

  const built = clusters.map((cluster) => buildCluster(cluster.members));
  built.sort((a, b) => {
    if (a.memberRoutes.length !== b.memberRoutes.length) {
      return b.memberRoutes.length - a.memberRoutes.length;
    }
    return a.exemplarRoute < b.exemplarRoute ? -1 : a.exemplarRoute > b.exemplarRoute ? 1 : 0;
  });
  return built.map((cluster, index) => ({
    ...cluster,
    id: `tpl-${String(index + 1).padStart(2, "0")}`,
  }));
}

function keyOf(cluster: WorkingCluster | undefined): string {
  return cluster === undefined ? "" : clusterKey(cluster.members);
}

function buildCluster(members: readonly PageShape[]): TemplateCluster {
  const ordered = [...members].sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
  const exemplar = ordered[0] as PageShape;
  const signatures = new Set(ordered.map((member) => JSON.stringify(member.sections)));
  const wpTemplates = Array.from(new Set(ordered.map((member) => member.template))).sort();
  const templateClasses = Array.from(
    new Set(ordered.flatMap((member) => member.templateClasses)),
  ).sort();

  return {
    id: "",
    label: shapeLabel(exemplar.sections),
    exemplarRoute: exemplar.route,
    memberRoutes: ordered.map((member) => member.route),
    signature: signatureOf(exemplar),
    sectionCount: exemplar.sections.length,
    sharedCssClasses: intersectAll(ordered.map((member) => member.contentClasses)).sort(),
    shapeVariants: signatures.size,
    wpTemplates,
    templateClasses,
    similarity: similarityRange(ordered),
    members: ordered.map((member) => ({
      route: member.route,
      template: member.template,
      templateClasses: member.templateClasses,
    })),
  };
}

// ---- the registry ----------------------------------------------------------

/** One WP `template` value's measured spread across DOM-shape clusters. */
export interface WpTemplateGroup {
  /** REST `template` verbatim; `""` when the site declares none. */
  readonly template: string;
  readonly pageCount: number;
  readonly routes: readonly string[];
  readonly clusterIds: readonly string[];
  readonly clusterCount: number;
  /** Distinct structural signatures among its pages. */
  readonly shapeCount: number;
  /** Distinct site-chrome profiles, e.g. `["theme-builder-footer"]` or `["none"]`. */
  readonly chromeProfiles: readonly string[];
  /** Highest and lowest pairwise shape similarity *within* this template. */
  readonly similarity: { readonly min: number; readonly max: number };
}

export type CrossCheckKind =
  | "same-template-different-shapes"
  | "cluster-mixes-wp-templates"
  | "template-predicts-site-chrome"
  | "template-does-not-predict-shape";

/** A measured statement about where DOM shape and the WP `template` field disagree or agree. */
export interface CrossCheckFinding {
  readonly kind: CrossCheckKind;
  readonly detail: string;
  readonly template?: string;
  readonly clusterIds?: readonly string[];
  readonly routes?: readonly string[];
}

export interface WpTemplateCrossCheck {
  readonly groups: readonly WpTemplateGroup[];
  /** Clusters whose members do not all share one WP `template`. */
  readonly clustersMixingWpTemplates: readonly string[];
  readonly findings: readonly CrossCheckFinding[];
}

export interface TemplateRegistrySummary {
  readonly pageCount: number;
  readonly templateCount: number;
  readonly clustersWithMultiplePages: number;
  readonly clustersWithOnePage: number;
  readonly pagesInSharedTemplates: number;
  readonly largestClusterSize: number;
  readonly measuredSections: number;
  readonly measuredRows: number;
  readonly measuredColumns: number;
  /** Pages whose whole body is site chrome: no content section at all. */
  readonly chromeOnlyRoutes: readonly string[];
  /** Lowest and highest within-cluster similarity (the complete-link floor). */
  readonly withinClusterSimilarity: { readonly min: number; readonly max: number };
  /** Highest similarity between two pages that did *not* land in one cluster. */
  readonly highestBetweenClusterSimilarity: number;
}

export interface TemplateRegistry {
  /** `computed` is the only status that may be read as a measurement. */
  readonly status: "computed" | "cannot-evaluate";
  readonly generatedBy: string;
  readonly irVersion: string;
  readonly capturedAt: string | null;
  readonly pageCount: number;
  readonly templateCount: number;
  readonly threshold: {
    readonly value: number;
    readonly band: { readonly above: number; readonly atMost: number };
    readonly link: "complete";
    readonly rationale: string;
  };
  readonly clusters: readonly TemplateCluster[];
  readonly summary: TemplateRegistrySummary;
  readonly wpTemplateCrossCheck: WpTemplateCrossCheck;
  readonly reasons: readonly string[];
}

export interface RegistryInput {
  readonly pages: readonly PageShape[];
  readonly irVersion?: string;
  readonly capturedAt?: string | null;
}

const THRESHOLD_RATIONALE =
  "Complete-link, measured on this capture: identical shapes score 1.000 (3 pairs), the cheapest genuine " +
  "template match scores 0.875 (/care/sweepy-admin/ + /care/ttlock-admin/, one row's column count differs), " +
  "and the highest false positive scores 0.800 (/care/showings/ + /resources/sweepy/, 2 rows vs 3). Every " +
  "threshold in (0.800, 0.875] yields the identical partition; 0.85 is its midpoint.";

/**
 * Assemble the registry.
 *
 * An empty page list is `cannot-evaluate`, never "0 templates": a measurement
 * with no input looks exactly like a site with no structure, and that is the one
 * reading a consumer must not be able to take (ADR 0012).
 */
export function buildTemplateRegistry(input: RegistryInput): TemplateRegistry {
  const pages = input.pages;
  const reasons: string[] = [];
  if (pages.length === 0) {
    reasons.push("cannot-evaluate: no pages were supplied, so no template count can be measured");
  }

  const clusters = clusterShapes(pages);
  const computed = pages.length > 0;

  const chromeOnlyRoutes = pages
    .filter((page) => page.sections.length === 0)
    .map((page) => page.route)
    .sort();

  let measuredSections = 0;
  let measuredRows = 0;
  let measuredColumns = 0;
  for (const page of pages) {
    measuredSections += page.sections.length;
    for (const section of page.sections) {
      measuredRows += section.length;
      for (const columns of section) measuredColumns += columns;
    }
  }

  let withinMin = 1;
  let withinMax = 1;
  for (const cluster of clusters) {
    if (cluster.memberRoutes.length < 2) continue;
    withinMin = Math.min(withinMin, cluster.similarity.min);
    withinMax = Math.max(withinMax, cluster.similarity.max);
  }

  const clusterOfRoute = new Map<string, string>();
  for (const cluster of clusters) {
    for (const route of cluster.memberRoutes) clusterOfRoute.set(route, cluster.id);
  }

  let highestBetweenCluster = 0;
  for (let left = 0; left < pages.length; left += 1) {
    for (let right = left + 1; right < pages.length; right += 1) {
      const a = pages[left] as PageShape;
      const b = pages[right] as PageShape;
      if (clusterOfRoute.get(a.route) === clusterOfRoute.get(b.route)) continue;
      highestBetweenCluster = Math.max(highestBetweenCluster, shapeSimilarity(a, b));
    }
  }

  const summary: TemplateRegistrySummary = {
    pageCount: pages.length,
    templateCount: clusters.length,
    clustersWithMultiplePages: clusters.filter((cluster) => cluster.memberRoutes.length > 1).length,
    clustersWithOnePage: clusters.filter((cluster) => cluster.memberRoutes.length === 1).length,
    pagesInSharedTemplates: clusters
      .filter((cluster) => cluster.memberRoutes.length > 1)
      .reduce((total, cluster) => total + cluster.memberRoutes.length, 0),
    largestClusterSize: clusters.reduce(
      (size, cluster) => Math.max(size, cluster.memberRoutes.length),
      0,
    ),
    measuredSections,
    measuredRows,
    measuredColumns,
    chromeOnlyRoutes,
    withinClusterSimilarity: { min: withinMin, max: withinMax },
    highestBetweenClusterSimilarity: highestBetweenCluster,
  };

  return {
    status: computed ? "computed" : "cannot-evaluate",
    generatedBy: "src/analysis/cluster.ts",
    irVersion: input.irVersion ?? "unknown",
    capturedAt: input.capturedAt ?? null,
    pageCount: pages.length,
    templateCount: clusters.length,
    threshold: {
      value: CLUSTER_THRESHOLD,
      band: { above: THRESHOLD_BAND.above, atMost: THRESHOLD_BAND.atMost },
      link: "complete",
      rationale: THRESHOLD_RATIONALE,
    },
    clusters,
    summary,
    wpTemplateCrossCheck: classifyWpTemplateCrossCheck(pages, clusters),
    reasons,
  };
}

/**
 * Compare the DOM-shape partition with the WP `template` field.
 *
 * The point is to report **both** partitions, not to reconcile them. A WP
 * template id says which PHP template rendered the document (and therefore which
 * shell — header, footer, nav — wraps it); DOM shape says what the page is built
 * from. On this site the first barely predicts the second, and that is a finding
 * the emitter has to live with: `page-template-blank.php` is a shell, not a
 * layout, so islands and per-template QA cannot key off it.
 *
 * `describeTemplate` exists so the generated prose reads as English for the
 * `""` case, which is WordPress's "theme default", not a missing value.
 */
function describeTemplate(template: string): string {
  return template === "" ? 'no template ("" = theme default)' : `template ${template}`;
}

export function classifyWpTemplateCrossCheck(
  pages: readonly PageShape[],
  clusters: readonly TemplateCluster[],
): WpTemplateCrossCheck {
  const clusterOfRoute = new Map<string, string>();
  for (const cluster of clusters) {
    for (const route of cluster.memberRoutes) clusterOfRoute.set(route, cluster.id);
  }

  const byTemplate = new Map<string, PageShape[]>();
  for (const page of pages) {
    const group = byTemplate.get(page.template);
    if (group === undefined) byTemplate.set(page.template, [page]);
    else group.push(page);
  }

  const groups: WpTemplateGroup[] = [];
  for (const [template, members] of Array.from(byTemplate.entries()).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    const clusterIds = Array.from(
      new Set(members.map((member) => clusterOfRoute.get(member.route) ?? "?")),
    ).sort();
    const shapes = new Set(members.map((member) => JSON.stringify(member.sections)));
    const chromeProfiles = Array.from(
      new Set(members.map((member) => (member.siteChrome.length === 0 ? "none" : "theme-builder"))),
    ).sort();

    let min = 1;
    let max = 1;
    if (members.length > 1) {
      min = 1;
      max = 0;
      for (let left = 0; left < members.length; left += 1) {
        for (let right = left + 1; right < members.length; right += 1) {
          const score = shapeSimilarity(members[left] as PageShape, members[right] as PageShape);
          min = Math.min(min, score);
          max = Math.max(max, score);
        }
      }
    }

    groups.push({
      template,
      pageCount: members.length,
      routes: members.map((member) => member.route).sort(),
      clusterIds,
      clusterCount: clusterIds.length,
      shapeCount: shapes.size,
      chromeProfiles,
      similarity: { min, max },
    });
  }

  const clustersMixingWpTemplates = clusters
    .filter((cluster) => cluster.wpTemplates.length > 1)
    .map((cluster) => cluster.id)
    .sort();

  const findings: CrossCheckFinding[] = [];

  for (const group of groups) {
    const label = describeTemplate(group.template);
    if (group.clusterCount > 1) {
      findings.push({
        kind: "same-template-different-shapes",
        template: group.template,
        clusterIds: group.clusterIds,
        routes: group.routes,
        detail:
          `${group.pageCount} page(s) declare ${label} but fall into ${group.clusterCount} DOM-shape ` +
          `cluster(s) (${group.shapeCount} distinct signature(s)); pairwise shape similarity inside the group ` +
          `ranges ${group.similarity.min.toFixed(3)}–${group.similarity.max.toFixed(3)}`,
      });
    }
    if (group.clusterCount === group.pageCount && group.pageCount > 1) {
      findings.push({
        kind: "template-does-not-predict-shape",
        template: group.template,
        clusterIds: group.clusterIds,
        routes: group.routes,
        detail:
          `every one of the ${group.pageCount} page(s) declaring ${label} has its own shape: the ` +
          `template field carries no layout information for this group`,
      });
    }
    if (group.chromeProfiles.length === 1) {
      findings.push({
        kind: "template-predicts-site-chrome",
        template: group.template,
        routes: group.routes,
        detail:
          `all ${group.pageCount} page(s) declaring ${label} share the site-chrome profile ` +
          `"${group.chromeProfiles[0] ?? "none"}", so the template field does predict the shell even where it ` +
          `does not predict layout`,
      });
    }
  }

  for (const cluster of clusters) {
    if (cluster.wpTemplates.length <= 1) continue;
    findings.push({
      kind: "cluster-mixes-wp-templates",
      clusterIds: [cluster.id],
      routes: cluster.memberRoutes,
      detail:
        `cluster ${cluster.id} holds ${cluster.memberRoutes.length} page(s) built from ` +
        `${cluster.wpTemplates.length} different WP template(s) ` +
        `(${cluster.wpTemplates.map((value) => (value === "" ? "(none)" : value)).join(", ")}): shape is the ` +
        `same, shell is not`,
    });
  }

  return { groups, clustersMixingWpTemplates, findings };
}

// ---- reporting -------------------------------------------------------------

/**
 * Readable table for the CLI. Fixed-width columns, no colour, one cluster per row,
 * and every count that appears in the prose section is taken from the registry.
 */
export function formatRegistryTable(registry: TemplateRegistry): string {
  const lines: string[] = [];
  const shared = registry.summary;
  lines.push(
    `template clustering — ${registry.pageCount} page(s) → ${registry.templateCount} shape template(s)`,
  );
  lines.push(
    `threshold ${registry.threshold.value} (${registry.threshold.link}-link, band ` +
      `${registry.threshold.band.above} < t <= ${registry.threshold.band.atMost})`,
  );
  lines.push(
    `${shared.clustersWithMultiplePages} shared cluster(s) covering ${shared.pagesInSharedTemplates} page(s); ` +
      `${shared.clustersWithOnePage} page(s) with a shape of their own`,
  );
  lines.push("");

  const header = ["id", "n", "sections", "shape", "exemplar", "members"];
  const rows = registry.clusters.map((cluster) => [
    cluster.id,
    String(cluster.memberRoutes.length),
    String(cluster.sectionCount),
    cluster.label.replace(/^\d+ sections? /, ""),
    cluster.exemplarRoute,
    cluster.memberRoutes.join(", "),
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const format = (row: readonly string[]): string =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  lines.push(format(header));
  lines.push(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) lines.push(format(row));
  lines.push("");

  lines.push("WP template vs DOM shape:");
  const groupHeader = ["wp template", "pages", "clusters", "shapes", "chrome"];
  const groupRows = registry.wpTemplateCrossCheck.groups.map((group) => [
    group.template === "" ? "(none)" : group.template,
    String(group.pageCount),
    String(group.clusterCount),
    String(group.shapeCount),
    group.chromeProfiles.join("|"),
  ]);
  const groupWidths = groupHeader.map((title, index) =>
    Math.max(title.length, ...groupRows.map((row) => (row[index] ?? "").length)),
  );
  const groupFormat = (row: readonly string[]): string =>
    row
      .map((cell, index) => cell.padEnd(groupWidths[index] ?? 0))
      .join("  ")
      .trimEnd();
  lines.push(groupFormat(groupHeader));
  lines.push(groupWidths.map((width) => "-".repeat(width)).join("  "));
  for (const row of groupRows) lines.push(groupFormat(row));
  lines.push("");

  if (registry.wpTemplateCrossCheck.findings.length === 0) {
    lines.push("cross-check findings: none (the two partitions agree)");
  } else {
    lines.push("cross-check findings:");
    for (const finding of registry.wpTemplateCrossCheck.findings) {
      lines.push(`  [${finding.kind}] ${finding.detail}`);
    }
  }
  lines.push("");

  if (registry.summary.chromeOnlyRoutes.length > 0) {
    lines.push(
      `site chrome only (no content section, the theme-builder footer is the whole body): ` +
        registry.summary.chromeOnlyRoutes.join(", "),
    );
  }
  lines.push(
    `measured: ${registry.summary.measuredSections} content section(s), ` +
      `${registry.summary.measuredRows} row(s), ${registry.summary.measuredColumns} column(s); ` +
      `highest similarity between two different clusters ${registry.summary.highestBetweenClusterSimilarity.toFixed(3)}`,
  );
  lines.push(`status: ${registry.status}`);
  for (const reason of registry.reasons) lines.push(`  ${reason}`);
  return lines.join("\n");
}
