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
 *     and `url(...)` inside linked *and* inline CSS. That is the only transform.
 *  4. **The body is the captured body.** Tags, attribute order, class lists and
 *     text nodes are byte-identical apart from (3). Nothing is wrapped, reordered
 *     or "fixed".
 *  5. **No island bootloader**, because no page mounts an island. The decision comes
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
import { buildRewriteTable, rewriteCssUrls, rewriteHtmlUrls } from "./rewrite.js";
import type { RewriteTable } from "./rewrite.js";

/** Repo-relative inputs, as the CLI runs from the repository root. */
export const DEFAULT_IR_PATH = "capture/site-ir.json";
export const DEFAULT_REWRITE_MAP_PATH = "capture/asset-rewrite-map.json";
export const DEFAULT_ASSETS_ROOT = "capture/assets";
export const DEFAULT_OUT_DIR = "dist/site";
export const DEFAULT_REPORT_PATH = "dist/emit-static.report.json";

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
  readonly totals: {
    readonly pages: number;
    readonly pageBytes: number;
    readonly htmlRefs: number;
    readonly cssRefs: number;
    readonly scriptTags: number;
  };
  readonly notes: readonly string[];
}

export interface EmitOptions {
  readonly irPath?: string;
  readonly rewriteMapPath?: string;
  readonly assetsRoot?: string;
  readonly outDir?: string;
  readonly reportPath?: string;
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
  },
): { html: string; result: PageEmitResult } {
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

  const doctype = page.dom.doctype;
  const html = doctype === undefined ? rewritten.text : `${doctype}\n${rewritten.text}`;

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
      scriptTags,
      bundles: bundles.length,
    },
  };
}

/** Emit the whole site. Writes `dist/site/` and returns the report. */
export async function emitStaticSite(options: EmitOptions = {}): Promise<EmitReport> {
  const irPath = options.irPath ?? DEFAULT_IR_PATH;
  const rewriteMapPath = options.rewriteMapPath ?? DEFAULT_REWRITE_MAP_PATH;
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

  for (const page of ir.pages) {
    const location = routeLocation(page.url);
    const { html, result } = emitPage(page, {
      table,
      styleIndex,
      cssFor,
      dirDepth: location.depth,
    });
    const target = join(resolvedOut, location.outputPath);
    outputs.claim(location.outputPath, `page ${page.url}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, html, "utf8");
    pages.push(result);
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
    '<link rel="preload" as="style" onload="this.rel=\'stylesheet\'"> tags are not stylesheet links: they are preserved as captured and their CSS was not captured by B1.3, so they still point at the source host. Deferred-CSS capture is a separate gap.',
    "Navigation links (<a href>) are not rewritten: this bead rewrites asset references only.",
    "No island bootloader is emitted: bundlesForHtml returns nothing for every page in this IR, and a page with mount slots is refused.",
  ];

  const report: EmitReport = {
    generatedAt: new Date().toISOString(),
    irVersion: ir.irVersion,
    baseUrl: ir.site.baseUrl,
    outDir: resolvedOut,
    pages,
    styles: {
      total: ir.styles.length,
      linkedFiles: [...linkedFiles.values()].sort((left, right) => left.order - right.order),
      inlineBlocksShipped: pages.reduce((total, page) => total + page.inlineStyles, 0),
    },
    assets: { copied: assetsCopied, bytes: assetBytes, skipped: !copyAssets },
    totals: {
      pages: pages.length,
      pageBytes: pages.reduce((total, page) => total + page.bytes, 0),
      htmlRefs: pages.reduce((total, page) => total + page.htmlRefs, 0),
      cssRefs:
        pages.reduce((total, page) => total + page.inlineCssRefs, 0) +
        [...linkedFiles.values()].reduce((total, file) => total + file.cssRefs, 0),
      scriptTags: pages.reduce((total, page) => total + page.scriptTags, 0),
    },
    notes,
  };

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
  lines.push(`  <script> tags emitted: ${report.totals.scriptTags}`);

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
  assetsRoot: string;
  outDir: string;
  reportPath: string;
  copyAssets: boolean;
}

const USAGE = [
  "Usage: node dist/emit/static-html/index.js [options]",
  "",
  "Emit the Site IR as a complete static tree (pretty URLs, rebuilt CSS cascade,",
  "rewritten asset references).",
  "",
  "Options:",
  `  --ir <path>       Site IR (default ${DEFAULT_IR_PATH})`,
  `  --map <path>      asset rewrite map (default ${DEFAULT_REWRITE_MAP_PATH})`,
  `  --assets <dir>    capture assets root (default ${DEFAULT_ASSETS_ROOT})`,
  `  --out <dir>       output directory (default ${DEFAULT_OUT_DIR})`,
  `  --report <path>   report path (default ${DEFAULT_REPORT_PATH})`,
  "  --no-assets       emit HTML and CSS only, do not copy media",
  "  -h, --help        show this help",
].join("\n");

function parseArgs(argv: readonly string[]): CliArgs | null {
  const args: CliArgs = {
    irPath: DEFAULT_IR_PATH,
    rewriteMapPath: DEFAULT_REWRITE_MAP_PATH,
    assetsRoot: DEFAULT_ASSETS_ROOT,
    outDir: DEFAULT_OUT_DIR,
    reportPath: DEFAULT_REPORT_PATH,
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
    } else if (arg === "--assets" && value !== undefined) {
      args.assetsRoot = value;
      index += 1;
    } else if (arg === "--out" && value !== undefined) {
      args.outDir = value;
      index += 1;
    } else if (arg === "--report" && value !== undefined) {
      args.reportPath = value;
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
    assetsRoot: args.assetsRoot,
    outDir: args.outDir,
    reportPath: args.reportPath,
    copyAssets: args.copyAssets,
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
  findStylesheetLinks,
  indexStyles,
  rebuildHead,
  resolvePageCascade,
  rewriteCssUrls,
  rewriteHtmlUrls,
};
export type { CascadeEntry, RewriteTable };
