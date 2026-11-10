/**
 * `emit/static-html` — Site IR → a complete static tree under `dist/site/`.
 *
 * The contract this emitter keeps:
 *
 *  1. **One directory per route**, WordPress-permalink shaped: `/care/` →
 *     `dist/site/care/index.html`, `/` → `dist/site/index.html`.
 *  2. **The cascade is rebuilt from `page.styleOrder`**, not from the `<link>` tags
 *     left in `dom.html` (`./cascade.ts`). A sequence that does not match
 *     `styleOrder` exactly throws; it is not a warning.
 *  3. **Asset references are rewritten** through `capture/asset-rewrite-map.json`
 *     (`./rewrite.ts`) — `img[src]`, `img[srcset]`, `source[srcset]`, `link[href]`
 *     and `url(...)` inside linked *and* inline CSS.
 *  4. **Self-references are localised** (`./localise.ts`): every absolute reference
 *     to the captured origin becomes site-root relative, form actions point at a
 *     configured sink instead of the live WordPress site, meta images localise
 *     through the asset map, and canonical links stay absolute on a per-target
 *     `--base-url`. The artifact is therefore self-contained — nothing in it points
 *     home — which is what makes it deployable anywhere.
 *  5. **The body is the captured body.** Tags, attribute order, class lists and
 *     text nodes are byte-identical apart from (3) and (4). Nothing is wrapped,
 *     reordered, deleted or "fixed".
 *  6. **No island bootloader**, because no page mounts an island. The decision comes
 *     from `bundlesForHtml` on the *emitted* HTML, and a page that mounts something
 *     this emitter cannot serve is refused rather than shipped inert.
 *
 * `dist/` is generated output and is gitignored: the artifact is reproducible from
 * the IR plus `capture/assets/**`, so it is never committed.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { IslandBundleManifest } from "../../islands/manifest.js";
import { MissingBundleError } from "../../islands/manifest.js";
import { ISLAND_BUDGET_BROTLI_BYTES } from "../../islands/manifest.js";
import { bundlesForHtml } from "../../islands/mounts.js";
import type { Asset, Page, SiteIr, Style } from "../../schema/site-ir.js";
import { isLinkedStyle, isSiteIr } from "../../schema/site-ir.js";
import {
  assertSequenceMatchesCascade,
  countOrigins,
  emittedStylePath,
  findStylesheetLinks,
  indexStyles,
  rebuildHead,
  resolvePageCascade,
} from "./cascade.js";
import type { CascadeEntry } from "./cascade.js";
import type {
  LocalisationConfig,
  LocalisationResult,
  ResidualCategory,
  SelfReferenceCategory,
} from "./localise.js";
import {
  classifyCapturedReference,
  classifyResidual,
  findAbsoluteSelfReferences,
  normaliseFormSink,
  normaliseOrigin,
  RESIDUAL_REASONS,
  rewriteSelfReferences,
} from "./localise.js";
import { buildRewriteTable, lookupRewrite, rewriteCssUrls, rewriteHtmlUrls } from "./rewrite.js";
import type { RewriteTable } from "./rewrite.js";

/** Repo-relative inputs, as the CLI runs from the repository root. */
export const DEFAULT_IR_PATH = "capture/site-ir.json";
export const DEFAULT_REWRITE_MAP_PATH = "capture/asset-rewrite-map.json";
export const DEFAULT_ROUTES_PATH = "capture/routes.manifest.json";
export const DEFAULT_ASSETS_ROOT = "capture/assets";
export const DEFAULT_OUT_DIR = "dist/site";
export const DEFAULT_REPORT_PATH = "dist/emit-static.report.json";

/**
 * Where a form submission goes when no sink is configured.
 *
 * It **does not exist yet**: the forms-sink bead (`src/sinks/`) owns the endpoint
 * that will receive these POSTs. Pointing the default at nothing is deliberate —
 * posting to the live WordPress site would be a silent write to production, whereas
 * a 404 from `/api/submit` is visible and harmless. Any deployment that ships forms
 * must pass `--form-sink`.
 */
export const DEFAULT_FORM_SINK = "/api/submit";

/**
 * Capture layout: media blobs and captured CSS live under different homes inside
 * `capture/assets`, while their `localPath` mirrors the site's own absolute path.
 */
export const ASSET_HOME = "media";
export const STYLE_HOME = "styles";
export const INLINE_STYLE_HOME = "styles/inline";

/** Thrown for any emit failure that must stop the build. */
export class EmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmitError";
  }
}

/**
 * The bundle manifest static emission works against.
 *
 * `--emit static` ships no island bundles and no bootloader, so it has no bundles
 * available: any page that mounts a component must fail here rather than ship a slot
 * that can never mount. `--emit islands` is the arm that will supply a real manifest.
 */
export const NO_BUNDLES_MANIFEST: IslandBundleManifest = {
  manifestVersion: 1,
  target: "wasm32-unknown-unknown",
  budgetBrotliBytes: ISLAND_BUDGET_BROTLI_BYTES,
  components: {},
};

/** The emitted location of one route. */
export interface RouteLocation {
  /** Path inside `dist/site/`, always forward-slashed. */
  readonly outputPath: string;
  /** Number of directory segments: the `../` depth a relative reference needs. */
  readonly depth: number;
}

/**
 * Map a site-relative route to its emitted file.
 *
 * Pretty URLs only: this is the WP permalink shape the capture recorded
 * (`site.permalinks.structure`), not a `care.html` flat-file mirror.
 */
export function routeLocation(url: string): RouteLocation {
  if (!url.startsWith("/")) {
    throw new EmitError(`route ${JSON.stringify(url)} is not site-relative (expected a leading /)`);
  }
  const segments = url.split("/").filter((segment) => segment.length > 0);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new EmitError(`route ${JSON.stringify(url)} contains a traversal segment`);
    }
  }
  if (segments.length === 0) return { outputPath: "index.html", depth: 0 };
  return { outputPath: `${segments.join("/")}/index.html`, depth: segments.length };
}

/** The three byte regions of a captured document, so the head can be rebuilt in place. */
export interface DocumentParts {
  /** Everything before `</head>`: doctype, `<html …>`, `<head …>` and the head content. */
  readonly upToHeadContent: string;
  /** Head content between `<head …>` and `</head>`. */
  readonly headContent: string;
  /** `</head>` and everything after it, byte-identical to capture. */
  readonly fromHeadClose: string;
}

export function splitDocument(html: string): DocumentParts {
  const open = /<head\b[^>]*>/i.exec(html);
  if (open === null) throw new EmitError("captured document has no <head> element");
  const contentStart = open.index + open[0].length;

  const closePattern = /<\/head\s*>/i;
  closePattern.lastIndex = contentStart;
  const rest = html.slice(contentStart);
  const close = closePattern.exec(rest);
  if (close === null) throw new EmitError("captured document has no </head> element");

  return {
    upToHeadContent: html.slice(0, contentStart),
    headContent: rest.slice(0, close.index),
    fromHeadClose: rest.slice(close.index),
  };
}

/** One page's emitted result, for the CLI table. */
export interface PageEmitResult {
  readonly url: string;
  readonly outputPath: string;
  /** Bytes of the emitted `index.html`. */
  readonly bytes: number;
  readonly styleCount: number;
  readonly linkedStyles: number;
  readonly inlineStyles: number;
  /** Asset references rewritten in this page's HTML attributes. */
  readonly htmlRefs: number;
  /** `url(...)` targets rewritten inside this page's inline `<style>` blocks. */
  readonly inlineCssRefs: number;
  /** Absolute self-references rewritten to a local form on this page. */
  readonly selfRefs: number;
  /** Absolute self-references this page still carries, all allowlisted. */
  readonly residualRefs: number;
  readonly scriptTags: number;
  readonly bundles: number;
}

/** One emitted linked stylesheet. */
export interface LinkedStyleResult {
  readonly order: number;
  readonly emittedPath: string;
  readonly bytes: number;
  readonly cssRefs: number;
}

/** One allowlisted survivor: what it is, and why it is allowed to stay absolute. */
export interface AllowlistEntry {
  readonly category: ResidualCategory;
  readonly reason: string;
  readonly count: number;
  /** The distinct values that survive, so the list can be read as an allowlist. */
  readonly values: readonly string[];
}

/** Before/after evidence for the self-reference localisation pass. */
export interface SelfReferenceReport {
  /** The capture's origin: the only host treated as "self". */
  readonly sourceOrigin: string;
  /** The origin canonical links declare for this target. */
  readonly baseUrl: string;
  readonly formSink: string;
  /** True when no `--form-sink` was supplied and the loud default is in force. */
  readonly formSinkIsDefault: boolean;
  /** Captured routes navigation is allowed to target. */
  readonly routeCount: number;
  /** Absolute self-references in the capture, per category. */
  readonly before: Readonly<Record<string, number>>;
  /** Absolute self-references that survive, per category. */
  readonly after: Readonly<Record<string, number>>;
  /** Rewrites actually applied, per category. */
  readonly rewritten: Readonly<Record<SelfReferenceCategory, number>>;
  /** The complete allowlist of survivors, with a reason per entry. */
  readonly allowlist: readonly AllowlistEntry[];
  /** References the capture holds no bytes for, reported rather than dropped. */
  readonly unlocalisable: readonly {
    readonly page: string;
    readonly tag: string;
    readonly attribute: string;
    readonly value: string;
    readonly reason: string;
  }[];
}

export interface EmitReport {
  readonly generatedAt: string;
  readonly irVersion: string;
  readonly baseUrl: string;
  readonly outDir: string;
  readonly pages: readonly PageEmitResult[];
  readonly styles: {
    readonly total: number;
    readonly linkedFiles: readonly LinkedStyleResult[];
    readonly inlineBlocksShipped: number;
  };
  readonly assets: { readonly copied: number; readonly bytes: number; readonly skipped: boolean };
  readonly selfReferences: SelfReferenceReport;
  readonly totals: {
    readonly pages: number;
    readonly pageBytes: number;
    readonly htmlRefs: number;
    readonly cssRefs: number;
    readonly selfRefs: number;
    readonly residualRefs: number;
    readonly scriptTags: number;
  };
  readonly notes: readonly string[];
}

export interface EmitOptions {
  readonly irPath?: string;
  readonly rewriteMapPath?: string;
  readonly routesPath?: string;
  readonly assetsRoot?: string;
  readonly outDir?: string;
  readonly reportPath?: string;
  /** Canonical origin declared by `link[rel=canonical]`. Defaults to the capture's. */
  readonly baseUrl?: string;
  /** Where form submissions go. Defaults to {@link DEFAULT_FORM_SINK}. */
  readonly formSink?: string;
  /** Copy `assets[]` into the tree. Off only for a pages-only spot check. */
  readonly copyAssets?: boolean;
}

/** Byte-level read with the hash check that makes "verbatim" provable. */
interface CapturedBlob {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly path: string;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBlob(
  candidates: readonly string[],
  expectedSha256: string,
  what: string,
): Promise<CapturedBlob> {
  const tried: string[] = [];
  for (const candidate of candidates) {
    let bytes: Buffer;
    try {
      bytes = await readFile(candidate);
    } catch {
      tried.push(candidate);
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== expectedSha256) {
      throw new EmitError(
        `${what}: ${candidate} hashes to ${actual}, but the IR records ${expectedSha256}`,
      );
    }
    return { bytes, sha256: actual, path: candidate };
  }
  throw new EmitError(`${what}: no captured bytes found (tried ${tried.join(", ")})`);
}

/** Every place a style's bytes can legitimately live in the capture. */
function styleCandidates(style: Style, assetsRoot: string): string[] {
  if (isLinkedStyle(style)) {
    return [
      join(assetsRoot, STYLE_HOME, style.localPath),
      join(assetsRoot, ASSET_HOME, style.localPath),
    ];
  }
  return [
    join(assetsRoot, INLINE_STYLE_HOME, `${style.sha256}.css`),
    join(assetsRoot, STYLE_HOME, style.localPath),
    join(assetsRoot, ASSET_HOME, style.localPath),
  ];
}

/** Tracks emitted paths so two producers cannot silently overwrite each other. */
class OutputIndex {
  private readonly owners = new Map<string, string>();

  claim(path: string, owner: string): void {
    const existing = this.owners.get(path);
    if (existing !== undefined) {
      throw new EmitError(`two artifacts claim ${path}: ${existing} and ${owner}`);
    }
    this.owners.set(path, owner);
  }
}

/** Emit one page's HTML. Returns the document and the evidence for the table. */
export function emitPage(
  page: Page,
  options: {
    readonly table: RewriteTable;
    readonly styleIndex: Map<string, Style[]>;
    readonly cssFor: (entry: CascadeEntry) => string | null;
    readonly dirDepth: number;
    readonly localisation: LocalisationConfig;
  },
): { html: string; result: PageEmitResult; localisation: LocalisationResult } {
  const sequence = resolvePageCascade(page, options.styleIndex);
  assertSequenceMatchesCascade(page, sequence);

  const parts = splitDocument(page.dom.html);
  const rebuilt = rebuildHead(parts.headContent, sequence, {
    dirDepth: options.dirDepth,
    table: options.table,
    cssFor: options.cssFor,
  });

  const withChain = parts.upToHeadContent + rebuilt.headHtml + parts.fromHeadClose;
  const rewritten = rewriteHtmlUrls(withChain, options.table, options.dirDepth);
  const localised = rewriteSelfReferences(rewritten.text, options.localisation);

  const doctype = page.dom.doctype;
  const html = doctype === undefined ? localised.text : `${doctype}\n${localised.text}`;

  const scriptTags = (html.match(/<script\b/gi) ?? []).length;
  if (scriptTags > 0) {
    // `--emit islands` is the only arm allowed to write scripts. A static page with
    // one would be a bootloader nobody asked for.
    throw new EmitError(
      `page ${page.url} emitted ${scriptTags} <script> tag(s); --emit static ships none`,
    );
  }

  let bundles: readonly unknown[] = [];
  try {
    bundles = bundlesForHtml(html, NO_BUNDLES_MANIFEST);
  } catch (error) {
    if (error instanceof MissingBundleError) {
      throw new EmitError(
        `page ${page.url} contains island mount slots (${error.missing
          .map((entry) => entry.component)
          .join(", ")}); static emission ships no bootloader — implement --emit islands (B3.x)`,
      );
    }
    throw error;
  }
  if (bundles.length > 0) {
    throw new EmitError(
      `page ${page.url} asked for ${bundles.length} island bundle(s) in static mode`,
    );
  }

  const origins = countOrigins(sequence);
  const residual = findAbsoluteSelfReferences(html, options.localisation.sourceOrigin).length;
  return {
    html,
    result: {
      url: page.url,
      outputPath: routeLocation(page.url).outputPath,
      bytes: Buffer.byteLength(html, "utf8"),
      styleCount: sequence.length,
      linkedStyles: origins.linked,
      inlineStyles: origins.inline,
      htmlRefs: rewritten.count,
      inlineCssRefs: rebuilt.cssRewrites,
      selfRefs: localised.rewrites.length,
      residualRefs: residual,
      scriptTags,
      bundles: bundles.length,
    },
    localisation: localised,
  };
}

/** Emit the whole site. Writes `dist/site/` and returns the report. */
export async function emitStaticSite(options: EmitOptions = {}): Promise<EmitReport> {
  const irPath = options.irPath ?? DEFAULT_IR_PATH;
  const rewriteMapPath = options.rewriteMapPath ?? DEFAULT_REWRITE_MAP_PATH;
  const routesPath = options.routesPath ?? DEFAULT_ROUTES_PATH;
  const assetsRoot = options.assetsRoot ?? DEFAULT_ASSETS_ROOT;
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const reportPath = options.reportPath ?? DEFAULT_REPORT_PATH;
  const copyAssets = options.copyAssets ?? true;

  const ir = await readIr(irPath);
  const table = buildRewriteTable(
    JSON.parse(await readFile(rewriteMapPath, "utf8")),
    rewriteMapPath,
  );
  if (table.baseUrl !== ir.site.baseUrl.replace(/\/+$/, "")) {
    throw new EmitError(
      `${rewriteMapPath} was captured for ${table.baseUrl}, but ${irPath} is for ${ir.site.baseUrl}; refusing to mix captures`,
    );
  }

  const routes = await readRoutes(routesPath);
  const sourceOrigin = normaliseOrigin(ir.site.baseUrl, `${irPath} site.baseUrl`);
  const baseUrl = normaliseOrigin(options.baseUrl ?? sourceOrigin, "--base-url");
  const formSink = normaliseFormSink(options.formSink ?? DEFAULT_FORM_SINK);
  const formSinkIsDefault = options.formSink === undefined;

  if (baseUrl !== sourceOrigin) {
    process.stdout.write(
      `note: canonical links point at ${baseUrl} (--base-url), not the captured ${sourceOrigin}\n`,
    );
  }

  const resolvedOut = resolve(outDir);
  if (resolvedOut === resolve(".") || resolve(".").startsWith(`${resolvedOut}`)) {
    throw new EmitError(`refusing to emit into ${resolvedOut}: it contains the working directory`);
  }
  await rm(resolvedOut, { recursive: true, force: true });
  await mkdir(resolvedOut, { recursive: true });

  const styleIndex = indexStyles(ir.styles);
  const blobs = new Map<string, CapturedBlob>();

  const blobKey = (style: Style): string => `${style.sha256}:${style.order}`;
  const loadStyle = (style: Style): CapturedBlob => {
    const key = blobKey(style);
    const cached = blobs.get(key);
    if (cached !== undefined) return cached;
    throw new EmitError(`internal: style blob ${key} was not preloaded`);
  };

  // Preload every style's bytes once: 19 pages share 55 entries, and each read is
  // hash-checked against the IR so a drifting capture fails here and not in a browser.
  const stylesByOrder = new Map<number, Style>();
  for (const style of ir.styles) {
    const cachedCandidates = styleCandidates(style, assetsRoot);
    blobs.set(
      blobKey(style),
      await readBlob(
        cachedCandidates,
        style.sha256,
        `style ${style.order} (${style.sha256.slice(0, 8)})`,
      ),
    );
    stylesByOrder.set(style.order, style);
  }

  const cssFor = (entry: CascadeEntry): string | null => {
    const style = stylesByOrder.get(entry.order);
    if (style === undefined) return null;
    return loadStyle(style).bytes.toString("utf8");
  };

  const outputs = new OutputIndex();
  const pages: PageEmitResult[] = [];
  const rewrittenByCategory: Record<SelfReferenceCategory, number> = {
    navigation: 0,
    "internal-link": 0,
    canonical: 0,
    "form-action": 0,
    "meta-asset": 0,
  };
  const unlocalisable: {
    page: string;
    tag: string;
    attribute: string;
    value: string;
    reason: string;
  }[] = [];
  const residualByCategory: Record<string, number> = {
    canonical: 0,
    "deferred-css": 0,
    unlocalisable: 0,
  };
  const beforeByCategory: Record<string, number> = {};
  const allowlistValues = new Map<ResidualCategory, Set<string>>();
  const localisationConfig = (dirDepth: number): LocalisationConfig => ({
    sourceOrigin,
    baseUrl,
    formSink,
    routes,
    dirDepth,
    table,
  });

  for (const page of ir.pages) {
    const location = routeLocation(page.url);
    const { html, result, localisation } = emitPage(page, {
      table,
      styleIndex,
      cssFor,
      dirDepth: location.depth,
      localisation: localisationConfig(location.depth),
    });
    const target = join(resolvedOut, location.outputPath);
    outputs.claim(location.outputPath, `page ${page.url}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, html, "utf8");
    pages.push(result);

    for (const rewrite of localisation.rewrites) rewrittenByCategory[rewrite.category] += 1;
    for (const entry of localisation.unlocalisable) {
      unlocalisable.push({ page: page.url, ...entry });
    }

    // "Before" is measured on the capture, not on the document entering this pass, so
    // the table reports the real problem. Every captured reference is then attributed
    // to exactly one step: an earlier pass, a rewrite here, or an allowlisted survivor.
    const captured = findAbsoluteSelfReferences(page.dom.html, sourceOrigin);
    const pageBefore: Record<string, number> = {};
    for (const reference of captured) {
      const category = classifyCapturedReference(reference, localisationConfig(location.depth));
      beforeByCategory[category] = (beforeByCategory[category] ?? 0) + 1;
      pageBefore[category] = (pageBefore[category] ?? 0) + 1;
    }

    // The residual set is measured on the bytes that ship, then every survivor must
    // justify itself. An unjustified survivor is a localisation defect, not an entry.
    const residual = findAbsoluteSelfReferences(html, sourceOrigin);
    for (const reference of residual) {
      const { category } = classifyResidual(reference, {
        resolvable: (value) => lookupRewrite(table, value) !== null,
      });
      residualByCategory[category] = (residualByCategory[category] ?? 0) + 1;
      const bucket = allowlistValues.get(category) ?? new Set<string>();
      bucket.add(reference.value);
      allowlistValues.set(category, bucket);
    }

    // Nothing may be lost or double-counted. The document that reaches this pass holds
    // every captured reference except the ones an earlier pass already localised
    // (stylesheet links rebuilt by the cascade, asset references rewritten by the asset
    // pass), and each of those must be either rewritten here or still present.
    const earlierPasses = (pageBefore["stylesheet"] ?? 0) + (pageBefore["asset"] ?? 0);
    const entering = captured.length - earlierPasses;
    const handled = localisation.rewrites.length + residual.length;
    if (entering !== handled) {
      throw new EmitError(
        `page ${page.url}: ${entering} self-reference(s) entered localisation but ${handled} were ` +
          `accounted for (${localisation.rewrites.length} rewritten + ${residual.length} residual)`,
      );
    }
  }

  // Every linked stylesheet a page ships is written once, at its mirrored path, with
  // its own `url(...)` targets rewritten relative to that file's directory.
  const linkedFiles = new Map<string, LinkedStyleResult>();
  for (const page of ir.pages) {
    const sequence = resolvePageCascade(page, styleIndex);
    for (const entry of sequence) {
      if (entry.origin !== "linked") continue;
      if (linkedFiles.has(entry.emittedPath)) continue;

      const style = stylesByOrder.get(entry.order);
      if (style === undefined || !isLinkedStyle(style)) {
        throw new EmitError(`internal: linked entry ${entry.sha256} has no styles[] record`);
      }
      const blob = loadStyle(style);
      const dirDepth = entry.emittedPath.split("/").length - 1;
      const rewritten = rewriteCssUrls(blob.bytes.toString("utf8"), table, dirDepth);

      outputs.claim(entry.emittedPath, `linked stylesheet ${entry.order}`);
      const target = join(resolvedOut, entry.emittedPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, rewritten.text, "utf8");

      linkedFiles.set(entry.emittedPath, {
        order: entry.order,
        emittedPath: entry.emittedPath,
        bytes: Buffer.byteLength(rewritten.text, "utf8"),
        cssRefs: rewritten.count,
      });
    }
  }

  let assetBytes = 0;
  let assetsCopied = 0;
  if (copyAssets) {
    for (const asset of ir.assets) {
      const bytes = await copyAsset(asset, assetsRoot, resolvedOut, outputs);
      assetBytes += bytes;
      assetsCopied += 1;
    }
  }

  const notes = [
    "dist/ is generated and gitignored; the tree is reproducible from the IR plus capture/assets/**.",
    "Linked stylesheets keep their mirrored absolute path so their own relative url(...) references still resolve; a path with no .css extension gains one in the same directory so a static host serves it as text/css.",
    '<link rel="preload" as="style" onload="this.rel=\'stylesheet\'"> tags are not stylesheet links: they are preserved as captured and their CSS was not captured by B1.3, so they still point at the source host. Deferred-CSS capture is a separate gap (cl-site-convert-mzi).',
    "Every other absolute reference to the captured origin is rewritten to a site-root-relative path, so the artifact is portable and internal navigation cannot leave the new site.",
    `Canonical links stay absolute and declare ${baseUrl}; a preview deployment and the apex MUST be emitted with different --base-url values or search engines will be told the new site duplicates the old one.`,
    formSinkIsDefault
      ? `Form actions point at ${formSink}, which DOES NOT EXIST YET: the forms-sink bead owns it. Nothing is posted to the live WordPress site, but a submitted form will 404 until a sink endpoint is deployed — pass --form-sink to point at one.`
      : `Form actions point at the configured sink ${formSink}; nothing is posted to the live WordPress site.`,
    "External references (signal.org, youtube.com, sweepy.com, support.hp.com, mailto:, …) are never rewritten.",
    "No island bootloader is emitted: bundlesForHtml returns nothing for every page in this IR, and a page with mount slots is refused.",
  ];

  const selfReferences: SelfReferenceReport = {
    sourceOrigin,
    baseUrl,
    formSink,
    formSinkIsDefault,
    routeCount: routes.size,
    before: {
      ...beforeByCategory,
      total: Object.values(beforeByCategory).reduce((sum, count) => sum + count, 0),
    },
    after: {
      canonical: residualByCategory["canonical"] ?? 0,
      "deferred-css": residualByCategory["deferred-css"] ?? 0,
      unlocalisable: residualByCategory["unlocalisable"] ?? 0,
      total: pages.reduce((total, page) => total + page.residualRefs, 0),
    },
    rewritten: rewrittenByCategory,
    // Every residual category is allowlisted with its reason; nothing survives silently.
    allowlist: (["canonical", "deferred-css", "unlocalisable"] as const)
      .filter((category) => (residualByCategory[category] ?? 0) > 0)
      .map((category) => ({
        category,
        reason: RESIDUAL_REASONS[category],
        count: residualByCategory[category] ?? 0,
        values: [...(allowlistValues.get(category) ?? [])].sort(),
      })),
    unlocalisable,
  };

  const report: EmitReport = {
    generatedAt: new Date().toISOString(),
    irVersion: ir.irVersion,
    baseUrl,
    outDir: resolvedOut,
    pages,
    styles: {
      total: ir.styles.length,
      linkedFiles: [...linkedFiles.values()].sort((left, right) => left.order - right.order),
      inlineBlocksShipped: pages.reduce((total, page) => total + page.inlineStyles, 0),
    },
    assets: { copied: assetsCopied, bytes: assetBytes, skipped: !copyAssets },
    selfReferences,
    totals: {
      pages: pages.length,
      pageBytes: pages.reduce((total, page) => total + page.bytes, 0),
      htmlRefs: pages.reduce((total, page) => total + page.htmlRefs, 0),
      cssRefs:
        pages.reduce((total, page) => total + page.inlineCssRefs, 0) +
        [...linkedFiles.values()].reduce((total, file) => total + file.cssRefs, 0),
      selfRefs: pages.reduce((total, page) => total + page.selfRefs, 0),
      residualRefs: pages.reduce((total, page) => total + page.residualRefs, 0),
      scriptTags: pages.reduce((total, page) => total + page.scriptTags, 0),
    },
    notes,
  };

  if (selfReferences.after["total"] !== report.totals.residualRefs) {
    throw new EmitError(
      `internal: ${String(selfReferences.after["total"])} classified residual reference(s) but ` +
        `${report.totals.residualRefs} page(s) reported — the allowlist would be incomplete`,
    );
  }

  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return report;
}

/** Copy one `assets[]` blob into the tree, proving the bytes first. */
async function copyAsset(
  asset: Asset,
  assetsRoot: string,
  outDir: string,
  outputs: OutputIndex,
): Promise<number> {
  const blob = await readBlob(
    [join(assetsRoot, ASSET_HOME, asset.localPath)],
    asset.sha256,
    `asset ${asset.localPath}`,
  );
  outputs.claim(asset.localPath, `asset ${asset.sourceUrl}`);
  const target = join(outDir, asset.localPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, blob.bytes);
  return blob.bytes.length;
}

async function readIr(path: string): Promise<SiteIr> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isSiteIr(parsed)) {
    throw new EmitError(`${path} is not a Site IR document this emitter can read`);
  }
  return parsed;
}

/**
 * Read the captured route set from `capture/routes.manifest.json`.
 *
 * Only `path` is used: navigation is localised to a **site-root-relative** form, and
 * a route whose path is `/care/` is served at `/care/` no matter what host serves it.
 * A manifest with no routes is a build failure — an emitter that cannot tell a route
 * from a WordPress endpoint would rewrite navigation into dead links and call it done.
 */
async function readRoutes(path: string): Promise<ReadonlySet<string>> {
  const document: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof document !== "object" || document === null) {
    throw new EmitError(`${path} is not a route manifest`);
  }
  const routes = (document as { routes?: unknown }).routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new EmitError(`${path} carries no routes; navigation cannot be localised`);
  }
  const paths = new Set<string>();
  for (const route of routes) {
    if (typeof route !== "object" || route === null) continue;
    const candidate = (route as { path?: unknown }).path;
    if (typeof candidate !== "string" || !candidate.startsWith("/")) {
      throw new EmitError(`${path}: a route has no site-relative path`);
    }
    paths.add(candidate);
  }
  if (paths.size === 0) throw new EmitError(`${path}: no route path could be read`);
  return paths;
}

/** Before/after totals: a category's captured count is "rewritten here" + "still absolute". */

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** The per-page table: route, bytes, style count, rewritten asset references. */
export function formatEmitReport(report: EmitReport): string {
  const lines: string[] = [];
  lines.push(`static-html emit — ${report.baseUrl} (IR ${report.irVersion})`);
  lines.push(`  out: ${report.outDir}`);
  lines.push("");

  const width = Math.max("route".length, ...report.pages.map((page) => page.url.length));
  lines.push(
    `  ${pad("route", width)}  ${padStart("bytes", 9)}  ${padStart("styles", 6)}  ` +
      `${padStart("linked", 6)}  ${padStart("inline", 6)}  ${padStart("refs", 6)}`,
  );
  lines.push(`  ${"-".repeat(width + 47)}`);
  for (const page of report.pages) {
    lines.push(
      `  ${pad(page.url, width)}  ${padStart(page.bytes.toLocaleString("en-CA"), 9)}  ` +
        `${padStart(String(page.styleCount), 6)}  ${padStart(String(page.linkedStyles), 6)}  ` +
        `${padStart(String(page.inlineStyles), 6)}  ` +
        `${padStart(String(page.htmlRefs + page.inlineCssRefs), 6)}`,
    );
  }
  lines.push(`  ${"-".repeat(width + 47)}`);
  lines.push(
    `  ${pad(`${report.totals.pages} page(s)`, width)}  ` +
      `${padStart(report.totals.pageBytes.toLocaleString("en-CA"), 9)}  ` +
      `${padStart(String(report.pages.reduce((total, page) => total + page.styleCount, 0)), 6)}  ` +
      `${padStart(String(report.pages.reduce((total, page) => total + page.linkedStyles, 0)), 6)}  ` +
      `${padStart(String(report.pages.reduce((total, page) => total + page.inlineStyles, 0)), 6)}  ` +
      `${padStart(String(report.totals.htmlRefs + report.pages.reduce((total, page) => total + page.inlineCssRefs, 0)), 6)}`,
  );

  lines.push("");
  lines.push(
    `  linked stylesheets   : ${report.styles.linkedFiles.length} file(s), ` +
      `${report.styles.linkedFiles.reduce((total, file) => total + file.bytes, 0).toLocaleString("en-CA")} B, ` +
      `${report.styles.linkedFiles.reduce((total, file) => total + file.cssRefs, 0)} url() rewrite(s)`,
  );
  lines.push(`  inline blocks shipped: ${report.styles.inlineBlocksShipped} across all pages`);
  lines.push(
    `  assets               : ${
      report.assets.skipped
        ? "not copied (--no-assets)"
        : `${report.assets.copied} file(s), ${report.assets.bytes.toLocaleString("en-CA")} B`
    }`,
  );
  lines.push(`  html refs rewritten  : ${report.totals.htmlRefs}`);
  lines.push(`  css refs rewritten   : ${report.totals.cssRefs}`);
  lines.push(
    `  self refs rewritten  : ${report.totals.selfRefs} ` +
      `(of ${String(report.selfReferences.before["total"])} captured; ` +
      `${report.totals.residualRefs} allowlisted survivors)`,
  );
  lines.push(`  <script> tags emitted: ${report.totals.scriptTags}`);

  lines.push("");
  lines.push(
    `  self-reference localisation — source ${report.selfReferences.sourceOrigin}, ` +
      `canonical ${report.selfReferences.baseUrl}, forms → ${report.selfReferences.formSink}` +
      `${report.selfReferences.formSinkIsDefault ? " (default; endpoint not implemented yet)" : ""}`,
  );
  const categories = Object.keys(report.selfReferences.before).sort();
  const width2 = Math.max(...categories.map((category) => category.length), "category".length);
  lines.push(`    ${pad("category", width2)}  ${padStart("before", 7)}  ${padStart("after", 6)}`);
  for (const category of categories) {
    if (category === "total") continue;
    lines.push(
      `    ${pad(category, width2)}  ${padStart(String(report.selfReferences.before[category] ?? 0), 7)}  ` +
        `${padStart(String(report.selfReferences.after[category] ?? 0), 6)}`,
    );
  }
  lines.push(
    `    ${pad("total", width2)}  ${padStart(String(report.selfReferences.before["total"] ?? 0), 7)}  ` +
      `${padStart(String(report.totals.residualRefs), 6)}`,
  );
  for (const entry of report.selfReferences.allowlist) {
    lines.push(`    allowlist ${entry.category} (${entry.count}): ${entry.reason}`);
  }
  if (report.selfReferences.unlocalisable.length > 0) {
    const distinct = new Set(report.selfReferences.unlocalisable.map((entry) => entry.value));
    lines.push(
      `    unlocalisable: ${report.selfReferences.unlocalisable.length} reference(s), ` +
        `${distinct.size} distinct — left untouched, reported, not dropped`,
    );
  }

  if (report.notes.length > 0) {
    lines.push("");
    for (const note of report.notes) lines.push(`  note: ${note}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  irPath: string;
  rewriteMapPath: string;
  routesPath: string;
  assetsRoot: string;
  outDir: string;
  reportPath: string;
  baseUrl: string | undefined;
  formSink: string | undefined;
  copyAssets: boolean;
}

const USAGE = [
  "Usage: node dist/emit/static-html/index.js [options]",
  "",
  "Emit the Site IR as a complete static tree (pretty URLs, rebuilt CSS cascade,",
  "rewritten asset references, self-contained internal references).",
  "",
  "Options:",
  `  --ir <path>        Site IR (default ${DEFAULT_IR_PATH})`,
  `  --map <path>       asset rewrite map (default ${DEFAULT_REWRITE_MAP_PATH})`,
  `  --routes <path>    route manifest, for navigation targets (default ${DEFAULT_ROUTES_PATH})`,
  `  --assets <dir>     capture assets root (default ${DEFAULT_ASSETS_ROOT})`,
  `  --out <dir>        output directory (default ${DEFAULT_OUT_DIR})`,
  `  --report <path>    report path (default ${DEFAULT_REPORT_PATH})`,
  "  --base-url <url>   origin canonical links declare for THIS target",
  "                     (default: the captured origin). A *.pages.dev preview and the",
  "                     apex MUST be emitted with different values.",
  `  --form-sink <url>  where form submissions go (default ${DEFAULT_FORM_SINK}, which`,
  "                     does not exist yet — the forms-sink bead owns the endpoint)",
  "  --no-assets        emit HTML and CSS only, do not copy media",
  "  -h, --help         show this help",
].join("\n");

function parseArgs(argv: readonly string[]): CliArgs | null {
  const args: CliArgs = {
    irPath: DEFAULT_IR_PATH,
    rewriteMapPath: DEFAULT_REWRITE_MAP_PATH,
    routesPath: DEFAULT_ROUTES_PATH,
    assetsRoot: DEFAULT_ASSETS_ROOT,
    outDir: DEFAULT_OUT_DIR,
    reportPath: DEFAULT_REPORT_PATH,
    baseUrl: undefined,
    formSink: undefined,
    copyAssets: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--no-assets") {
      args.copyAssets = false;
    } else if (arg === "--ir" && value !== undefined) {
      args.irPath = value;
      index += 1;
    } else if (arg === "--map" && value !== undefined) {
      args.rewriteMapPath = value;
      index += 1;
    } else if (arg === "--routes" && value !== undefined) {
      args.routesPath = value;
      index += 1;
    } else if (arg === "--assets" && value !== undefined) {
      args.assetsRoot = value;
      index += 1;
    } else if (arg === "--out" && value !== undefined) {
      args.outDir = value;
      index += 1;
    } else if (arg === "--report" && value !== undefined) {
      args.reportPath = value;
      index += 1;
    } else if (arg === "--base-url" && value !== undefined) {
      args.baseUrl = value;
      index += 1;
    } else if (arg === "--form-sink" && value !== undefined) {
      args.formSink = value;
      index += 1;
    } else {
      return null;
    }
  }
  return args;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    process.stdout.write(`${USAGE}\n`);
    return argv.includes("--help") || argv.includes("-h") ? 0 : 1;
  }

  const report = await emitStaticSite({
    irPath: args.irPath,
    rewriteMapPath: args.rewriteMapPath,
    routesPath: args.routesPath,
    assetsRoot: args.assetsRoot,
    outDir: args.outDir,
    reportPath: args.reportPath,
    copyAssets: args.copyAssets,
    ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
    ...(args.formSink === undefined ? {} : { formSink: args.formSink }),
  });

  process.stdout.write(`${formatEmitReport(report)}\n`);
  process.stdout.write(`\nwrote ${report.outDir} and ${args.reportPath}\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

// Re-exported so tests and later beads have one import path for the emitter seam.
export {
  buildRewriteTable,
  emittedStylePath,
  findAbsoluteSelfReferences,
  findStylesheetLinks,
  indexStyles,
  rebuildHead,
  resolvePageCascade,
  rewriteCssUrls,
  rewriteHtmlUrls,
  rewriteSelfReferences,
};
export type { CascadeEntry, RewriteTable };
