/**
 * Asset capture: the pass that turns the *references* left in the Site IR into
 * **bytes on disk**, plus the ordered stylesheet chain and a URL rewrite map.
 *
 * Why this is a separate pass (B1.3, after B1.2):
 *
 *  - A `style` entry requires the `sha256` of the bytes that will ship. It cannot
 *    be invented, so it can only exist after the bytes are actually fetched.
 *  - Divi 4.27.7 inlines 5-14 `<style>` blocks per page (the theme, the dynamic
 *    critical CSS, global styles). `dom.ts` deletes those blocks because markup
 *    normalisation is deletion-only; their `sha256` is recorded in the capture
 *    report. This pass re-fetches the page, proves every block still hashes to
 *    the recorded value, and materialises the CSS as files. Nothing is invented
 *    and nothing is dropped on the floor.
 *
 * The four rules that govern every line here:
 *
 *  1. **CSS is verbatim.** Bytes are fetched with `fetchBytes` and written
 *     untouched. No minification, no pruning, no `url()` rewriting, no reordering.
 *  2. **Order is document order across *all* styles**, linked and inline
 *     interleaved. Per-page sequences are merged into one cascade (a topological
 *     merge, so a contradiction is an error rather than a silent reorder).
 *  3. **A recorded hash is verified against the disk**, not trusted. A mismatch
 *     is a failure, never a warning.
 *  4. **Relative URLs keep resolving.** Emitted paths mirror the site's own
 *     absolute paths, so a CSS file's `url(../fonts/x.woff)` and a page's
 *     `src="/wp-content/uploads/x.jpg"` work byte-identically without rewriting
 *     either one.
 *
 * Politeness: every request goes through `PoliteFetcher` (serialised, >=600 ms,
 * robots-aware). Read-only GETs; nothing here ever posts.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  Asset,
  AssetKind,
  SiteIr,
  Style,
  UnsupportedCapability,
} from "../../schema/site-ir.js";
import { decodeEntities, elementPayloads, parseTagAttributes } from "./dom.js";
import { DEFAULT_MIN_INTERVAL_MS, PoliteFetcher, isPathAllowed } from "./http.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const DEFAULT_IR_PATH = "capture/site-ir.json";
export const DEFAULT_CAPTURE_REPORT_PATH = "capture/site-ir.capture-report.json";
export const DEFAULT_STYLE_CHAIN_PATH = "capture/style-chain.json";
export const DEFAULT_REWRITE_MAP_PATH = "capture/asset-rewrite-map.json";
export const DEFAULT_ASSET_REPORT_PATH = "capture/assets.capture-report.json";

/** Capture-side roots. Every downloaded byte lives under one of these. */
export const STYLE_ROOT = "capture/assets/styles";
export const INLINE_ROOT = `${STYLE_ROOT}/inline`;
export const MEDIA_ROOT = "capture/assets/media";

/** Emitted path for the materialised inline blocks (used only when linked). */
export const INLINE_OUTPUT_ROOT = "assets/inline";

const TOOL_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Hashing helpers
// ---------------------------------------------------------------------------

/** SHA-256 of a string as UTF-8, or of raw bytes. Always lowercase hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function shortHash(value: string, length = 8): string {
  return sha256Hex(value).slice(0, length);
}

// ---------------------------------------------------------------------------
// Style extraction — linked and inline, in one document-order scan
// ---------------------------------------------------------------------------

export interface LinkedStyleRef {
  origin: "linked";
  /** The `href` exactly as captured (may still contain HTML entities). */
  href: string;
  /** The same target decoded and resolved, ready to fetch. */
  hrefUrl: string;
  media: string | null;
}

export interface InlineStyleRef {
  origin: "inline";
  /** SHA-256 of the whole `<style>` element, matching the capture report's record. */
  elementSha256: string;
  /** The CSS between the tags, byte-identical, never trimmed. */
  css: string;
  /** The element's identifying detail (`#global-styles-inline-css`, a type, …). */
  detail: string;
}

export type StyleRef = LinkedStyleRef | InlineStyleRef;

/** Order-insensitive identity of a style in the site-wide chain. */
export function styleKey(ref: StyleRef): string {
  return ref.origin === "linked"
    ? `linked:${ref.href}|${ref.media ?? ""}`
    : `inline:${ref.elementSha256}`;
}

/** `<link rel="stylesheet">` hrefs on a page, in document order. */
function linkedStyleRefs(
  html: string,
  pageUrl: string,
  baseUrl: string,
): { start: number; ref: StyleRef }[] {
  const found: { start: number; ref: StyleRef }[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseTagAttributes(match[0]);
    const rels = (attributes["rel"] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!rels.includes("stylesheet")) continue;
    const href = attributes["href"];
    if (href === undefined) continue;
    const decoded = decodeEntities(href).trim();
    if (decoded.length === 0) continue;
    const hrefUrl = resolveAssetUrl(decoded, new URL(pageUrl, baseUrl).toString());
    // An unresolvable href is still a style in the chain; it just cannot be fetched.
    const media = (attributes["media"] ?? "").trim();
    found.push({
      start: match.index,
      ref: {
        origin: "linked",
        href,
        hrefUrl: hrefUrl ?? decoded,
        media: media === "" ? null : media,
      },
    });
  }
  return found;
}

/** Every style element on a page, linked and inline interleaved by byte offset. */
export function pageStyleRefs(html: string, pageUrl: string, baseUrl: string): StyleRef[] {
  const inline = elementPayloads(html, "style").map((payload) => ({
    start: payload.start,
    ref: {
      origin: "inline",
      elementSha256: sha256Hex(payload.element),
      css: payload.inner,
      detail: payload.detail,
    } satisfies StyleRef,
  }));
  return [...linkedStyleRefs(html, pageUrl, baseUrl), ...inline]
    .sort((a, b) => a.start - b.start)
    .map((entry) => entry.ref);
}

// ---------------------------------------------------------------------------
// Order merge — per-page sequences into one site-wide cascade
// ---------------------------------------------------------------------------

export interface StyleSequence {
  /** Page the sequence was observed on. */
  page: string;
  /** Style identities in document order. */
  keys: string[];
}

/**
 * Merge per-page document orders into one global order.
 *
 * v1 `styles[]` is a single chain with a single `order`, but each page observes
 * its own order (page-specific plugins add sheets in different places). The only
 * merge that cannot misrepresent a page is a topological one: every "A before B"
 * observed on any page becomes an edge, and the result is a stable linearisation.
 * A cycle means two pages genuinely disagree, which is a finding — it throws
 * rather than silently reordering a page.
 */
export function mergeStyleOrder(sequences: readonly StyleSequence[]): string[] {
  const appearance = new Map<string, number>();
  const edges = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  const see = (key: string): void => {
    if (appearance.has(key)) return;
    appearance.set(key, appearance.size);
    edges.set(key, new Set<string>());
    indegree.set(key, 0);
  };

  for (const sequence of sequences) {
    for (const key of sequence.keys) see(key);
    for (let i = 0; i + 1 < sequence.keys.length; i += 1) {
      const from = sequence.keys[i];
      const to = sequence.keys[i + 1];
      if (from === undefined || to === undefined || from === to) continue;
      const outgoing = edges.get(from);
      if (outgoing === undefined || outgoing.has(to)) continue;
      outgoing.add(to);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }
  }

  const remaining = new Set(appearance.keys());
  const ordered: string[] = [];
  while (remaining.size > 0) {
    // Lowest first-appearance index among nodes with no unmet predecessor. This
    // is what makes the merge deterministic rather than merely valid.
    let chosen: string | null = null;
    let chosenIndex = Number.POSITIVE_INFINITY;
    for (const key of remaining) {
      if ((indegree.get(key) ?? 0) !== 0) continue;
      const index = appearance.get(key) ?? Number.POSITIVE_INFINITY;
      if (index < chosenIndex) {
        chosen = key;
        chosenIndex = index;
      }
    }
    if (chosen === null) {
      const blocked = [...remaining].sort().join(", ");
      throw new Error(
        `style order is contradictory: ${blocked} are each required to precede another; ` +
          "two pages disagree about their cascade and v1 has no per-page override",
      );
    }
    remaining.delete(chosen);
    ordered.push(chosen);
    for (const next of edges.get(chosen) ?? []) {
      indegree.set(next, Math.max(0, (indegree.get(next) ?? 0) - 1));
    }
  }

  return ordered;
}

// ---------------------------------------------------------------------------
// URL resolution and path planning
// ---------------------------------------------------------------------------

/** Schemes that are not something we can (or should) fetch. */
const NON_FETCHABLE = /^(?:data|mailto|tel|javascript|blob|about|whatsapp|intent):/i;

/**
 * Resolve a captured reference to an absolute http(s) URL.
 *
 * Returns null for anything that is not a fetchable asset: `data:` URIs are
 * already inline, and `#` / `mailto:` / `tel:` are not files. Entities are
 * decoded first because WordPress escapes the `&` in query strings
 * (`?family=…&#038;subset=…`), and fetching the escaped form would 404.
 */
export function resolveAssetUrl(ref: string, baseUrl: string): string | null {
  const decoded = decodeEntities(ref.trim());
  if (decoded.length === 0 || decoded.startsWith("#")) return null;
  if (NON_FETCHABLE.test(decoded)) return null;
  if (decoded.startsWith("//")) {
    const scheme = /^https:\/\//i.test(baseUrl) ? "https:" : "http:";
    try {
      return new URL(`${scheme}${decoded}`).toString();
    } catch {
      return null;
    }
  }
  try {
    const resolved = new URL(decoded, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/** Extension → `kind`, per the schema's enum. */
const KIND_BY_EXTENSION: Readonly<Record<string, AssetKind>> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  svg: "image",
  ico: "image",
  bmp: "image",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  eot: "font",
  mp4: "media",
  webm: "media",
  mov: "media",
  m4v: "media",
  mp3: "media",
  wav: "media",
  ogg: "media",
  oga: "media",
  pdf: "document",
  doc: "document",
  docx: "document",
  xls: "document",
  xlsx: "document",
  ppt: "document",
  pptx: "document",
  csv: "document",
  js: "script",
  mjs: "script",
};

/** Classify an asset by extension, falling back to the served content type. */
export function assetKind(url: string, contentType?: string | null): AssetKind {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not a URL; classify the string as-is.
  }
  const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase();
  if (extension !== undefined) {
    const byExtension = KIND_BY_EXTENSION[extension];
    if (byExtension !== undefined) return byExtension;
  }
  const lower = (contentType ?? "").toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("font/") || lower.includes("font")) return "font";
  if (lower.startsWith("video/") || lower.startsWith("audio/")) return "media";
  if (lower.includes("pdf") || lower.includes("wordprocessingml") || lower.includes("msword")) {
    return "document";
  }
  if (lower.includes("javascript")) return "script";
  return "other";
}

/** One asset's planned home: capture-side path and emitted path. */
export interface PathAssignment {
  url: string;
  /** Where the bytes live in `capture/`. */
  capturePath: string;
  /** Where the emitter must serve them; site-absolute path, no leading slash. */
  outputPath: string;
}

/**
 * Site-relative path of a URL, mirroring the *original* path on the same host.
 *
 * Mirroring is not cosmetic: a stylesheet's `url(../fonts/x.woff)` resolves
 * relative to the stylesheet's own URL, and CSS may not be rewritten. Keeping the
 * original path shape is what lets verbatim CSS keep working.
 * Off-host references are namespaced under `external/<host>/` because their
 * original path says nothing about where they belong in our tree.
 */
function outputPathFor(url: string, siteHost: string): string {
  const parsed = new URL(url);
  let pathname = parsed.pathname.replace(/^\/+/, "");
  if (pathname.endsWith("/")) pathname += "index";
  if (pathname.length === 0) pathname = "index";
  return parsed.host === siteHost ? pathname : `external/${parsed.host}/${pathname}`;
}

/** Insert a suffix before the extension, e.g. `a/b.css` → `a/b-1a2b3c4d.css`. */
function withSuffix(path: string, suffix: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash) return `${path}-${suffix}`;
  return `${path.slice(0, dot)}-${suffix}${path.slice(dot)}`;
}

/**
 * Plan capture + output paths for a set of URLs.
 *
 * Two different URLs can share a pathname and differ only by query string
 * (`googleapis.com/css?family=A` vs `?family=B`). The query is not part of the
 * file name, so a pure pathname mapping would collide. Colliding URLs get a
 * deterministic URL-hash suffix — decided before anything is written, so a
 * re-run produces the same names.
 */
export function assignPaths(
  urls: readonly string[],
  kindRoot: string,
  siteHost: string,
): PathAssignment[] {
  const planned = urls.map((url) => {
    const outputPath = outputPathFor(url, siteHost);
    return { url, outputPath, capturePath: `${kindRoot}/${outputPath}` };
  });

  const byCapturePath = new Map<string, PathAssignment[]>();
  for (const entry of planned) {
    const group = byCapturePath.get(entry.capturePath);
    if (group === undefined) byCapturePath.set(entry.capturePath, [entry]);
    else group.push(entry);
  }

  return planned.map((entry) => {
    const group = byCapturePath.get(entry.capturePath) ?? [];
    if (group.length <= 1) return entry;
    const outputPath = withSuffix(entry.outputPath, shortHash(entry.url));
    return { url: entry.url, outputPath, capturePath: `${kindRoot}/${outputPath}` };
  });
}

// ---------------------------------------------------------------------------
// Asset reference extraction
// ---------------------------------------------------------------------------

export interface AssetReference {
  /** Absolute http(s) URL. */
  url: string;
  kind: AssetKind;
  /** How it was referenced: `img`, `srcset`, `icon`, `style-attr`, `css-url`, … */
  where: string;
}

/** Parse a `srcset` value into the URLs it names. Descriptors are dropped. */
export function srcsetUrls(value: string): string[] {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter((candidate) => candidate.length > 0);
}

/** Every `url(…)` target in a CSS text or an inline `style` attribute. */
export function cssUrlRefs(css: string): string[] {
  const refs: string[] = [];
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined && value.trim().length > 0) refs.push(value.trim());
  }
  // `@import "x.css"` also pulls bytes in; it is a reference like any other.
  for (const match of css.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
    const value = match[1];
    if (value !== undefined && value.trim().length > 0) refs.push(value.trim());
  }
  return refs;
}

/** References in a CSS file, resolved against that file's own URL. */
export function cssAssetRefs(css: string, cssUrl: string): AssetReference[] {
  const found: AssetReference[] = [];
  for (const ref of cssUrlRefs(css)) {
    const url = resolveAssetUrl(ref, cssUrl);
    if (url === null) continue;
    found.push({ url, kind: assetKind(url), where: "css-url" });
  }
  return found;
}

/**
 * Attribute names Divi (and WP lazy-load plugins) put URLs in.
 *
 * Divi's background module writes `data-bg` for lazily applied backgrounds, so a
 * capture that only reads `src`/`href` would silently lose section artwork.
 */
const URL_ATTRIBUTES = ["src", "href", "poster", "data-bg", "data-bg-webp", "data-thumb"];

/** References in a captured DOM skeleton, resolved against the page URL. */
export function pageAssetRefs(html: string, pageUrl: string, baseUrl: string): AssetReference[] {
  const found: AssetReference[] = [];
  const push = (ref: string, where: string): void => {
    const url = resolveAssetUrl(ref, new URL(pageUrl, baseUrl).toString());
    if (url !== null) found.push({ url, kind: assetKind(url), where });
  };

  for (const match of html.matchAll(/<(img|source|video|audio|link)\b[^>]*>/gi)) {
    const tag = (match[1] ?? "").toLowerCase();
    const attributes = parseTagAttributes(match[0]);
    if (tag === "link") {
      const rels = (attributes["rel"] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const href = attributes["href"];
      if (href === undefined) continue;
      if (rels.includes("icon") || rels.includes("shortcut")) {
        push(href, "icon");
      } else if (rels.includes("preload")) {
        const as = (attributes["as"] ?? "").toLowerCase();
        if (as === "font") push(href, "preload-font");
        else if (as === "image") push(href, "preload-image");
      }
      continue;
    }
    for (const attribute of URL_ATTRIBUTES) {
      const value = attributes[attribute];
      if (value !== undefined && value.trim().length > 0) push(value, `${tag}:${attribute}`);
    }
    for (const attribute of ["srcset", "data-srcset"]) {
      const value = attributes[attribute];
      if (value === undefined) continue;
      for (const candidate of srcsetUrls(value)) push(candidate, `${tag}:${attribute}`);
    }
  }

  // `style="background-image:url(…)"` survives normalisation and is a real ref.
  for (const match of html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)) {
    for (const ref of cssUrlRefs(match[1] ?? "")) push(ref, "style-attr");
  }

  return found;
}

// ---------------------------------------------------------------------------
// Records written into `capture/`
// ---------------------------------------------------------------------------

/** One entry of the site-wide, interleaved style chain. */
export interface ChainEntry {
  /** Position across every style on the site, linked and inline. 0-based, unique. */
  order: number;
  origin: "linked" | "inline";
  /** Present for linked styles only: the `href` as captured. */
  href?: string;
  media?: string;
  /** Hash of the bytes on disk. */
  sha256: string;
  bytes: number;
  /** Capture-side path, e.g. `capture/assets/styles/wp-content/…/x.css`. */
  capturePath: string;
  /** Emitted path, e.g. `wp-content/…/x.css`. */
  localPath: string;
  /** Pages whose document order placed this style in the chain. */
  pages: string[];
  /** Inline only: hash of the whole `<style>` element, as the capture report recorded it. */
  sourceElementSha256?: string;
  /** Inline only: element identity (`#global-styles-inline-css`). */
  detail?: string;
}

export interface StyleChain {
  generatedAt: string;
  baseUrl: string;
  /** Every style, ascending `order`. Linked and inline interleaved. */
  styleChain: ChainEntry[];
  totals: {
    linked: number;
    inlineBlocks: number;
    inlineUnique: number;
    inlineBytesTotal: number;
    inlineBytesUnique: number;
  };
  notes: string[];
}

export interface RewriteMapAsset {
  sourceUrl: string;
  kind: AssetKind;
  sha256: string;
  bytes: number;
  contentType: string | null;
  capturePath: string;
  /** Emitted path: what the emitter writes and the browser requests. */
  localPath: string;
  referencedBy: string[];
}

export interface RewriteMapStyle {
  order: number;
  origin: "linked" | "inline";
  href?: string;
  media?: string;
  sha256: string;
  bytes: number;
  capturePath: string;
  localPath: string;
  pages: string[];
}

export interface RewriteMap {
  generatedAt: string;
  baseUrl: string;
  version: 1;
  /** How emitted paths relate to the captured site. Read this before wiring an emitter. */
  mount: { note: string; externalPrefix: string };
  /** Original absolute URL (and its root-relative form) → emitted path. */
  rewrite: Record<string, string>;
  styles: RewriteMapStyle[];
  assets: RewriteMapAsset[];
  notes: string[];
}

/** Per-asset HTTP evidence, including LiteSpeed's cache verdict on the response. */
export interface AssetHttpEvidence {
  url: string;
  status: number;
  contentType: string | null;
  cache: { litespeed: string | null; age: string | null; etag: string | null };
}

export interface CaptureReportCrossCheck {
  url: string;
  /** Page size the B1.2 capture recorded, so a changed page is visible. */
  expectedBytes: number;
  actualBytes: number;
  bytesMatch: boolean;
  inlineBlocks: number;
  /** Inline block hashes the B1.2 capture recorded. */
  expectedSha256: string[];
  actualSha256: string[];
  hashesMatch: boolean;
}

export interface AssetCaptureReport {
  generatedAt: string;
  baseUrl: string;
  tool: { name: string; version: string; minIntervalMs: number; requests: number };
  totals: {
    pages: number;
    stylesLinked: number;
    inlineBlocksTotal: number;
    inlineBlocksUnique: number;
    inlineBytesTotal: number;
    inlineBytesUnique: number;
    inlineBytesSaved: number;
    linkedStyleBytes: number;
    media: number;
    mediaBytes: number;
    /** Everything written under `capture/assets/`. */
    diskBytes: number;
    files: number;
  };
  verification: {
    recorded: number;
    verified: number;
    problems: IntegrityProblem[];
    ok: boolean;
  };
  reconCrossCheck: CaptureReportCrossCheck[];
  cache: { hits: number; misses: number; note: string; evidence: AssetHttpEvidence[] };
  /** References the live site cannot satisfy. A site defect, not a capture failure. */
  brokenReferences: BrokenReference[];
  skipped: { ref: string; where: string; reason: string }[];
  failures: string[];
  notes: string[];
}

export interface IntegrityProblem {
  capturePath: string;
  expected: string;
  actual: string | null;
  reason: string;
}

/**
 * A reference the captured page makes that the live site cannot satisfy (404/410).
 *
 * It is recorded because it is a real defect on the site being converted: the
 * emitted page will render the same broken reference, so visual parity is
 * unaffected — but somebody has to know, and the IR's capabilities say so.
 */
export interface BrokenReference {
  ref: string;
  /** How it was referenced (`img:src`, `srcset`, `css-url`, …). */
  where: string;
  /** Pages whose DOM or CSS points at it. */
  pages: string[];
  reason: string;
}

// ---------------------------------------------------------------------------
// Integrity verification — the gate, not a warning
// ---------------------------------------------------------------------------

/**
 * Recompute every recorded hash from the bytes on disk.
 *
 * Used twice: by the capture pass (so a corrupt write never reaches the IR) and
 * by `tests/asset-integrity.test.ts` (so a later edit, a line-ending change, or a
 * bad merge cannot quietly invalidate the "verbatim" claim).
 */
export async function verifyFiles(
  records: readonly { capturePath: string; sha256: string }[],
  root = ".",
): Promise<IntegrityProblem[]> {
  const problems: IntegrityProblem[] = [];
  for (const record of records) {
    const path = join(root, record.capturePath);
    let actual: string;
    try {
      actual = sha256Hex(new Uint8Array(await readFile(path)));
    } catch {
      problems.push({
        capturePath: record.capturePath,
        expected: record.sha256,
        actual: null,
        reason: "missing: recorded file is not on disk",
      });
      continue;
    }
    if (actual !== record.sha256) {
      problems.push({
        capturePath: record.capturePath,
        expected: record.sha256,
        actual,
        reason: "sha256 mismatch: bytes on disk are not the bytes that were recorded",
      });
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Capture orchestration
// ---------------------------------------------------------------------------

interface CaptureReportPage {
  url: string;
  bytes: number;
  stripped: { kind: string; detail: string; bytes: number; sha256?: string }[];
}

interface CaptureReport {
  pages: CaptureReportPage[];
  baseUrl: string;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** Inline block bytes, deduplicated by CSS hash. */
interface InlineBlock {
  sha256: string;
  css: string;
  bytes: number;
  detail: string;
  sourceElementSha256s: Set<string>;
  pages: Set<string>;
}

export interface CaptureAssetsOptions {
  baseUrl: string;
  irPath?: string;
  captureReportPath?: string;
  styleChainPath?: string;
  rewriteMapPath?: string;
  reportOut?: string;
  minIntervalMs?: number;
  /** Directory every recorded path is resolved against. Tests point this at a temp dir. */
  rootDir?: string;
  /** Injected for tests; the default is the polite live fetcher. */
  fetcher?: PoliteFetcher;
  onProgress?: (line: string) => void;
}

export interface CaptureAssetsResult {
  ir: SiteIr;
  chain: StyleChain;
  map: RewriteMap;
  report: AssetCaptureReport;
  failures: string[];
}

const USAGE_NOTES_MOUNT =
  "Emitted paths mirror the captured site's own absolute paths (e.g. `wp-content/uploads/x.jpg`), " +
  "so a page's `/wp-content/...` reference and a stylesheet's `url(../fonts/x.woff)` both resolve " +
  "without rewriting either the DOM or the CSS. Off-host files are namespaced under `external/<host>/`.";

/** Capture every style and asset, write the files, and patch the Site IR. */
export async function captureAssets(options: CaptureAssetsOptions): Promise<CaptureAssetsResult> {
  const irPath = options.irPath ?? DEFAULT_IR_PATH;
  const captureReportPath = options.captureReportPath ?? DEFAULT_CAPTURE_REPORT_PATH;
  const chainPath = options.styleChainPath ?? DEFAULT_STYLE_CHAIN_PATH;
  const mapPath = options.rewriteMapPath ?? DEFAULT_REWRITE_MAP_PATH;
  const reportPath = options.reportOut ?? DEFAULT_ASSET_REPORT_PATH;
  const onProgress = options.onProgress ?? ((): void => {});

  const root = options.rootDir ?? ".";
  const ir = await readJson<SiteIr>(resolveStorePath(root, irPath));
  const captureReport = await readJson<CaptureReport>(resolveStorePath(root, captureReportPath));
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const siteHost = new URL(baseUrl).host;

  const fetcher =
    options.fetcher ??
    new PoliteFetcher({
      baseUrl,
      minIntervalMs: Math.max(
        DEFAULT_MIN_INTERVAL_MS,
        options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      ),
      onRequest: (line) => onProgress(`  ${line}`),
    });

  const failures: string[] = [];
  const notes: string[] = [];
  const skipped: { ref: string; where: string; reason: string }[] = [];
  /** References the *source site* cannot satisfy. Recorded, surfaced, not swallowed. */
  const brokenReferences: BrokenReference[] = [];

  // --- Pages: re-fetch to recover the bytes normalisation deleted ------------
  const rules = await fetcher.readRobots();
  if (rules.unreadable) {
    notes.push(`robots.txt unreadable (status ${rules.status ?? "no response"}); proceeding`);
  }

  const perPageSequences: StyleSequence[] = [];
  const pageHtml = new Map<string, string>();
  const crossCheck: CaptureReportCrossCheck[] = [];
  const linkedPages = new Map<string, Set<string>>();

  for (const page of ir.pages) {
    if (!isPathAllowed(page.url, rules)) {
      failures.push(`${page.url}: disallowed by robots.txt; cannot recover its inline CSS`);
      continue;
    }
    const response = await fetcher.fetch(page.url);
    if (response.status !== 200) {
      failures.push(`${page.url}: re-fetch answered ${response.status}`);
      continue;
    }
    const raw = response.body.replace(/\r\n?/g, "\n");
    pageHtml.set(page.url, raw);

    const refs = pageStyleRefs(raw, page.url, baseUrl);
    perPageSequences.push({ page: page.url, keys: refs.map(styleKey) });

    const recorded = captureReport.pages.find((entry) => entry.url === page.url);
    const expectedSha256 = (recorded?.stripped ?? [])
      .filter((node) => node.kind === "style")
      .map((node) => node.sha256 ?? "");
    const actualSha256 = refs
      .filter((ref): ref is InlineStyleRef => ref.origin === "inline")
      .map((ref) => ref.elementSha256);
    const hashesMatch =
      expectedSha256.length === actualSha256.length &&
      expectedSha256.every((hash, index) => hash === actualSha256[index]);
    crossCheck.push({
      url: page.url,
      expectedBytes: recorded?.bytes ?? 0,
      actualBytes: raw.length,
      bytesMatch: recorded === undefined ? false : recorded.bytes === raw.length,
      inlineBlocks: actualSha256.length,
      expectedSha256,
      actualSha256,
      hashesMatch,
    });
    if (!hashesMatch) {
      failures.push(
        `${page.url}: inline <style> payloads no longer hash to the B1.2 capture record ` +
          `(${expectedSha256.length} recorded, ${actualSha256.length} found); the served page changed`,
      );
    }
    for (const ref of refs) {
      if (ref.origin !== "linked") continue;
      const key = styleKey(ref);
      const pages = linkedPages.get(key) ?? new Set<string>();
      pages.add(page.url);
      linkedPages.set(key, pages);
    }
    onProgress(
      `  ${page.url}: ${refs.length} style(s) — ${crossCheck.at(-1)?.hashesMatch === true ? "inline hashes match" : "INLINE HASH MISMATCH"}`,
    );
  }

  // --- One site-wide cascade, contradictions fatal --------------------------
  const order = mergeStyleOrder(perPageSequences);
  // Every key in the merged order needs its first observed ref (href or CSS).
  const firstRef = new Map<string, StyleRef>();
  for (const [url, html] of pageHtml) {
    for (const ref of pageStyleRefs(html, url, baseUrl)) {
      const key = styleKey(ref);
      if (!firstRef.has(key)) firstRef.set(key, ref);
    }
  }

  // --- Linked stylesheets: fetch bytes verbatim ----------------------------
  const linkedUrls = [
    ...new Set(
      order
        .map((key) => firstRef.get(key))
        .filter((ref): ref is LinkedStyleRef => ref !== undefined && ref.origin === "linked")
        .map((ref) => ref.hrefUrl),
    ),
  ];
  const stylePlan = new Map(
    assignPaths(linkedUrls, STYLE_ROOT, siteHost).map((entry) => [entry.url, entry]),
  );

  const cacheEvidence: AssetHttpEvidence[] = [];
  const styleBytes = new Map<string, { bytes: Uint8Array; contentType: string | null }>();
  for (const url of linkedUrls) {
    const existing = styleBytes.get(url);
    if (existing !== undefined) continue;
    const response = await fetcher.fetchBytes(url);
    cacheEvidence.push({
      url,
      status: response.status,
      contentType: response.headers["content-type"] ?? null,
      cache: {
        litespeed: response.headers["x-litespeed-cache"] ?? null,
        age: response.headers["age"] ?? null,
        etag: response.headers["etag"] ?? null,
      },
    });
    if (response.status !== 200) {
      failures.push(`${url}: stylesheet answered ${response.status}; its bytes are unavailable`);
      continue;
    }
    const contentType = response.headers["content-type"] ?? "";
    if (contentType.length > 0 && !contentType.toLowerCase().includes("css")) {
      failures.push(
        `${url}: served ${contentType}, not CSS; refusing to record it as a stylesheet`,
      );
      continue;
    }
    styleBytes.set(url, {
      bytes: response.bytes,
      contentType: response.headers["content-type"] ?? null,
    });
  }

  // --- Inline blocks: materialise, deduplicated by CSS hash -----------------
  const inlineBlocks = new Map<string, InlineBlock>();
  let inlineBytesTotal = 0;
  let inlineBlockCount = 0;
  for (const [url, html] of pageHtml) {
    for (const ref of pageStyleRefs(html, url, baseUrl)) {
      if (ref.origin !== "inline") continue;
      inlineBlockCount += 1;
      inlineBytesTotal += ref.css.length;
      const existing = inlineBlocks.get(sha256Hex(ref.css));
      if (existing === undefined) {
        inlineBlocks.set(sha256Hex(ref.css), {
          sha256: sha256Hex(ref.css),
          css: ref.css,
          bytes: ref.css.length,
          detail: ref.detail,
          sourceElementSha256s: new Set([ref.elementSha256]),
          pages: new Set([url]),
        });
      } else {
        existing.sourceElementSha256s.add(ref.elementSha256);
        existing.pages.add(url);
      }
    }
  }

  // --- Media: the capture is not the last word, the CSS and DOM are --------
  const mediaRefs = new Map<string, { kind: AssetKind; pages: Set<string>; where: Set<string> }>();
  const addMedia = (url: string, kind: AssetKind, page: string | null, where: string): void => {
    const existing = mediaRefs.get(url);
    if (existing === undefined) {
      mediaRefs.set(url, {
        kind,
        pages: new Set(page === null ? [] : [page]),
        where: new Set([where]),
      });
      return;
    }
    existing.where.add(where);
    if (page !== null) existing.pages.add(page);
  };

  // Media is collected from the **captured DOM** (`dom.html`), not the raw page:
  // the DOM is what the emitter renders, and it has already had telemetry pixels
  // and tracking frames removed. Refs inside inline CSS are collected from the
  // materialised block text, so nothing deleted by normalisation is lost.
  for (const page of ir.pages) {
    for (const ref of pageAssetRefs(page.dom.html, page.url, baseUrl)) {
      addMedia(ref.url, ref.kind, page.url, ref.where);
    }
  }
  for (const block of inlineBlocks.values()) {
    const ownerPage = [...block.pages][0];
    if (ownerPage === undefined) continue;
    for (const ref of cssAssetRefs(block.css, new URL(ownerPage, baseUrl).toString())) {
      for (const page of block.pages) addMedia(ref.url, ref.kind, page, "inline-css");
    }
  }
  for (const [key, ref] of firstRef) {
    if (ref.origin !== "linked") continue;
    const fetched = styleBytes.get(ref.hrefUrl);
    if (fetched === undefined) continue;
    const css = new TextDecoder().decode(fetched.bytes);
    const pages = linkedPages.get(key) ?? new Set<string>();
    for (const assetRef of cssAssetRefs(css, ref.hrefUrl)) {
      for (const page of pages) addMedia(assetRef.url, assetRef.kind, page, "linked-css");
    }
  }

  const mediaPlan = new Map(
    assignPaths([...mediaRefs.keys()], MEDIA_ROOT, siteHost).map((entry) => [entry.url, entry]),
  );
  const mediaFiles = new Map<
    string,
    { bytes: Uint8Array; contentType: string | null; sha256: string }
  >();
  for (const url of mediaRefs.keys()) {
    const response = await fetcher.fetchBytes(url);
    cacheEvidence.push({
      url,
      status: response.status,
      contentType: response.headers["content-type"] ?? null,
      cache: {
        litespeed: response.headers["x-litespeed-cache"] ?? null,
        age: response.headers["age"] ?? null,
        etag: response.headers["etag"] ?? null,
      },
    });
    if (response.status !== 200) {
      const refs = mediaRefs.get(url);
      const finding = {
        ref: url,
        where: [...(refs?.where ?? [])].join(","),
        pages: [...(refs?.pages ?? [])].sort(),
        reason: `HTTP ${response.status}`,
      };
      // 404/410 is the *site's* defect: the captured DOM points at a file the
      // server no longer has. That is a finding to surface (and a bead), not a
      // reason to fail a capture that did its job — the live page is broken the
      // same way, so parity is unaffected. Anything else is our problem.
      if (response.status === 404 || response.status === 410) brokenReferences.push(finding);
      else
        failures.push(`${url}: asset answered ${response.status} (${response.error ?? "no body"})`);
      skipped.push({ ref: url, where: finding.where, reason: finding.reason });
      continue;
    }
    mediaFiles.set(url, {
      bytes: response.bytes,
      contentType: response.headers["content-type"] ?? null,
      sha256: sha256Hex(response.bytes),
    });
  }
  onProgress(`  ${mediaFiles.size} of ${mediaRefs.size} media file(s) fetched`);

  // --- Write everything ----------------------------------------------------
  const chain: ChainEntry[] = [];
  let linkedStyleBytes = 0;
  for (let index = 0; index < order.length; index += 1) {
    const key = order[index];
    if (key === undefined) continue;
    const ref = firstRef.get(key);
    if (ref === undefined) continue;
    if (ref.origin === "linked") {
      const fetched = styleBytes.get(ref.hrefUrl);
      const plan = stylePlan.get(ref.hrefUrl);
      if (fetched === undefined || plan === undefined) continue;
      await writeBytes(resolveStorePath(root, plan.capturePath), fetched.bytes);
      const entry: ChainEntry = {
        order: index,
        origin: "linked",
        href: ref.href,
        sha256: sha256Hex(fetched.bytes),
        bytes: fetched.bytes.length,
        capturePath: plan.capturePath,
        localPath: plan.outputPath,
        pages: [...(linkedPages.get(key) ?? new Set<string>())].sort(),
      };
      if (ref.media !== null) entry.media = ref.media;
      linkedStyleBytes += fetched.bytes.length;
      chain.push(entry);
      continue;
    }
    const block = inlineBlocks.get(sha256Hex(ref.css));
    if (block === undefined) continue;
    const capturePath = `${INLINE_ROOT}/${block.sha256}.css`;
    const localPath = `${INLINE_OUTPUT_ROOT}/${block.sha256}.css`;
    await writeBytes(
      resolveStorePath(root, capturePath),
      new Uint8Array(Buffer.from(block.css, "utf8")),
    );
    const entry: ChainEntry = {
      order: index,
      origin: "inline",
      sha256: block.sha256,
      bytes: block.bytes,
      capturePath,
      localPath,
      pages: [...block.pages].sort(),
      sourceElementSha256: ref.elementSha256,
      detail: block.detail,
    };
    chain.push(entry);
  }

  const writtenAssets: RewriteMapAsset[] = [];
  for (const [url, file] of mediaFiles) {
    const plan = mediaPlan.get(url);
    if (plan === undefined) continue;
    await writeBytes(resolveStorePath(root, plan.capturePath), file.bytes);
    const refs = mediaRefs.get(url);
    writtenAssets.push({
      sourceUrl: url,
      kind: refs?.kind ?? assetKind(url, file.contentType),
      sha256: file.sha256,
      bytes: file.bytes.length,
      contentType: file.contentType,
      capturePath: plan.capturePath,
      localPath: plan.outputPath,
      referencedBy: [...(refs?.pages ?? [])].sort(),
    });
  }
  writtenAssets.sort((a, b) => a.localPath.localeCompare(b.localPath));

  // --- Verify against the disk --------------------------------------------
  const records = [
    ...chain.map((entry) => ({ capturePath: entry.capturePath, sha256: entry.sha256 })),
    ...writtenAssets.map((entry) => ({ capturePath: entry.capturePath, sha256: entry.sha256 })),
  ];
  const problems = await verifyFiles(records, root);
  if (problems.length > 0) {
    for (const problem of problems) failures.push(`${problem.capturePath}: ${problem.reason}`);
  }

  // --- Project into the Site IR -------------------------------------------
  const styles: Style[] = chain
    .filter((entry) => entry.origin === "linked")
    .map((entry) => {
      // `styles[]` is the linked subset: v1 requires an `href` and forbids
      // `origin`, so inline blocks live in `capture/style-chain.json` instead of
      // being given a fabricated url here.
      const style: Style = {
        href: entry.href ?? "",
        localPath: entry.localPath,
        sha256: entry.sha256,
        order: entry.order,
      };
      if (entry.media !== undefined) style.media = entry.media;
      return style;
    });
  const assets: Asset[] = writtenAssets.map((entry) => {
    const asset: Asset = {
      sourceUrl: entry.sourceUrl,
      localPath: entry.localPath,
      sha256: entry.sha256,
      kind: entry.kind,
      bytes: entry.bytes,
    };
    if (entry.contentType !== null) asset.contentType = entry.contentType;
    if (entry.referencedBy.length > 0) asset.referencedBy = entry.referencedBy;
    return asset;
  });

  const patched: SiteIr = { ...ir, styles, assets };
  // Keep the capability statement honest: the gap moved from "bytes lost" to
  // "bytes captured, not yet representable in v1 styles[]".
  const capabilities: UnsupportedCapability[] = ir.capabilities.unsupported.map((entry) =>
    entry.capability === "inline-style-blocks"
      ? {
          ...entry,
          detail:
            `Divi inlines per-page critical CSS in <style> elements (${[...pageHtml.keys()].length} pages, ` +
            `${inlineBlockCount} blocks collapsing to ${inlineBlocks.size} unique files). ` +
            "B1.3 materialises every block under capture/assets/styles/inline/ with a verified sha256, and the " +
            "interleaved order is recorded in capture/style-chain.json. v1 styles[] still requires an href and " +
            "has no origin field, so the blocks cannot be listed there: emitted pages render without their " +
            "critical CSS until the emitter inlines the chain (B2.1) or v1.1 adds origin/inline-style entries.",
        }
      : entry,
  );
  if (brokenReferences.length > 0) {
    const affected = [...new Set(brokenReferences.flatMap((entry) => entry.pages))].sort();
    capabilities.push({
      capability: "broken-asset-reference",
      detail:
        `${brokenReferences.length} asset reference(s) in the captured DOM point at files the live site answers ` +
        `404/410 for: ${brokenReferences.map((entry) => entry.ref).join(", ")}. Captured by the site as-is, so ` +
        "parity is preserved, but the images are missing on the original too and must be replaced or removed " +
        "before cutover. Recorded in capture/assets.capture-report.json under brokenReferences.",
      blocking: false,
      where: affected,
    });
  }
  patched.capabilities = { ...ir.capabilities, unsupported: capabilities };

  const rewrite: Record<string, string> = {};
  for (const entry of chain) {
    if (entry.href === undefined) continue;
    rewrite[entry.href] = entry.localPath;
  }
  for (const entry of writtenAssets) {
    rewrite[entry.sourceUrl] = entry.localPath;
    try {
      const parsed = new URL(entry.sourceUrl);
      rewrite[`${parsed.pathname}${parsed.search}`] = entry.localPath;
    } catch {
      // Not a parseable URL; the absolute form is already recorded.
    }
  }

  const map: RewriteMap = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    version: 1,
    mount: { note: USAGE_NOTES_MOUNT, externalPrefix: "external" },
    rewrite,
    styles: chain.map((entry) => {
      const style: RewriteMapStyle = {
        order: entry.order,
        origin: entry.origin,
        sha256: entry.sha256,
        bytes: entry.bytes,
        capturePath: entry.capturePath,
        localPath: entry.localPath,
        pages: entry.pages,
      };
      if (entry.href !== undefined) style.href = entry.href;
      if (entry.media !== undefined) style.media = entry.media;
      return style;
    }),
    assets: writtenAssets,
    notes: [
      "Styles are listed in document order across linked and inline blocks; `order` is the position in that chain.",
      "HTML and CSS are not rewritten. This map is the emitter's rewrite table, and emitted paths mirror the " +
        "captured site's absolute paths so relative references keep working untouched.",
      "Off-host references (Google Fonts CSS and its gstatic payloads) are captured under `external/<host>/`; their " +
        "own absolute `url()` targets cannot be localised without rewriting CSS, which is forbidden by design.",
    ],
  };

  const inlineBytesUnique = [...inlineBlocks.values()].reduce((total, b) => total + b.bytes, 0);
  const diskBytes =
    linkedStyleBytes +
    inlineBytesUnique +
    writtenAssets.reduce((total, entry) => total + entry.bytes, 0);

  const hits = cacheEvidence.filter((entry) => entry.cache.litespeed === "hit").length;
  const report: AssetCaptureReport = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    tool: {
      name: "cl-site-convert",
      version: TOOL_VERSION,
      minIntervalMs: fetcher.minIntervalMs,
      requests: fetcher.requestCount,
    },
    totals: {
      pages: pageHtml.size,
      stylesLinked: chain.filter((entry) => entry.origin === "linked").length,
      inlineBlocksTotal: inlineBlockCount,
      inlineBlocksUnique: inlineBlocks.size,
      inlineBytesTotal,
      inlineBytesUnique,
      inlineBytesSaved: inlineBytesTotal - inlineBytesUnique,
      linkedStyleBytes,
      media: writtenAssets.length,
      mediaBytes: writtenAssets.reduce((total, entry) => total + entry.bytes, 0),
      diskBytes,
      files: chain.length + writtenAssets.length,
    },
    verification: {
      recorded: records.length,
      verified: records.length - problems.length,
      problems,
      ok: problems.length === 0,
    },
    reconCrossCheck: crossCheck,
    cache: {
      hits,
      misses: cacheEvidence.length - hits,
      note:
        "Asset responses carry their own LiteSpeed verdict. Pages were 19/19 `hit` in B1.2; CSS and media " +
        "are not necessarily cached by LiteSpeed, and no purge was attempted.",
      evidence: cacheEvidence,
    },
    brokenReferences,
    skipped,
    failures,
    notes: [
      ...notes,
      `Inline CSS: ${inlineBlockCount} blocks fetched, ${inlineBlocks.size} unique files written, ` +
        `${inlineBytesTotal} B before dedup and ${inlineBytesUnique} B after (${inlineBytesTotal - inlineBytesUnique} B saved).`,
      "Every recorded sha256 was recomputed from the file on disk after writing; a mismatch is a failure.",
    ],
  };

  const chainArtifact: StyleChain = {
    generatedAt: report.generatedAt,
    baseUrl,
    styleChain: chain,
    totals: {
      linked: report.totals.stylesLinked,
      inlineBlocks: inlineBlockCount,
      inlineUnique: inlineBlocks.size,
      inlineBytesTotal,
      inlineBytesUnique,
    },
    notes: [
      "Complete interleaved style chain. `styles[]` in the Site IR carries the linked subset only, because v1 " +
        "requires an `href` and forbids unknown properties such as `origin`; the gaps in its `order` values are " +
        "the inline blocks listed here.",
      "Deduplicated by CSS sha256: Divi repeats the same theme block on every page, so a block may carry many pages.",
    ],
  };

  await writeJson(resolveStorePath(root, irPath), patched);
  await writeJson(resolveStorePath(root, chainPath), chainArtifact);
  await writeJson(resolveStorePath(root, mapPath), map);
  await writeJson(resolveStorePath(root, reportPath), report);

  return { ir: patched, chain: chainArtifact, map, report, failures };
}

/** Resolve a recorded repo-relative path against the capture root. */
function resolveStorePath(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Emitter-facing helper
// ---------------------------------------------------------------------------

/**
 * Apply the rewrite map to an HTML fragment.
 *
 * Provided for the emitter (B2.1) and proved by a test: it is the whole of the
 * "absolute URL to local reference" conversion. It only ever *shortens* a
 * reference the capture recorded, so an unreferenced URL is left alone and a
 * reference it does not know is visible rather than silently broken.
 */
export function applyRewriteMap(html: string, map: Pick<RewriteMap, "rewrite">): string {
  const keys = Object.keys(map.rewrite).sort((a, b) => b.length - a.length);
  let out = html;
  for (const key of keys) {
    const target = map.rewrite[key];
    if (target === undefined) continue;
    out = out.split(key).join(`/${target}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Console report
// ---------------------------------------------------------------------------

/** The numbers the bead is accepted on. */
export function formatAssetReport(report: AssetCaptureReport, chain: StyleChain): string {
  const lines: string[] = [];
  const t = report.totals;
  lines.push(`Asset capture — ${report.baseUrl} (${report.generatedAt})`);
  lines.push("");
  lines.push(`  pages re-read        : ${t.pages}`);
  lines.push(
    `  requests             : ${report.tool.requests} (>= ${report.tool.minIntervalMs} ms apart)`,
  );
  lines.push("");
  lines.push(`  linked stylesheets   : ${t.stylesLinked} (${t.linkedStyleBytes} B)`);
  lines.push(
    `  inline blocks        : ${t.inlineBlocksTotal} total -> ${t.inlineBlocksUnique} unique files`,
  );
  lines.push(
    `  inline bytes         : ${t.inlineBytesTotal} B before dedup -> ${t.inlineBytesUnique} B after (${t.inlineBytesSaved} B saved)`,
  );
  lines.push(`  media files          : ${t.media} (${t.mediaBytes} B)`);
  lines.push(`  files on disk        : ${t.files}`);
  lines.push(`  capture/assets total : ${t.diskBytes} B`);
  lines.push("");
  lines.push(
    `  sha256 verification  : ${report.verification.verified}/${report.verification.recorded} verified${report.verification.ok ? "" : " — FAILED"}`,
  );
  for (const problem of report.verification.problems) {
    lines.push(`    ${problem.capturePath}: ${problem.reason}`);
  }
  lines.push(`  litespeed on assets  : ${report.cache.hits} hit / ${report.cache.misses} miss`);
  lines.push("");
  lines.push(`  chain (${chain.styleChain.length} entries, document order):`);
  for (const entry of chain.styleChain.slice(0, 40)) {
    const label =
      entry.origin === "linked"
        ? (entry.href ?? "")
        : `inline ${entry.detail ?? ""} ${entry.sha256.slice(0, 12)}`;
    lines.push(`    ${String(entry.order).padStart(3)} ${entry.origin.padEnd(6)} ${label}`);
  }
  if (chain.styleChain.length > 40) lines.push(`    … ${chain.styleChain.length - 40} more`);

  const mismatched = report.reconCrossCheck.filter(
    (entry) => !entry.hashesMatch || !entry.bytesMatch,
  );
  lines.push("");
  if (mismatched.length === 0) {
    lines.push(
      `  recon cross-check    : all ${report.reconCrossCheck.length} pages match the B1.2 byte length and inline hashes`,
    );
  } else {
    lines.push(`  recon cross-check    : ${mismatched.length} page(s) differ from the B1.2 record`);
    for (const entry of mismatched) {
      lines.push(
        `    ${entry.url}: bytes ${entry.expectedBytes} -> ${entry.actualBytes}, inline ${entry.expectedSha256.length} -> ${entry.actualSha256.length}`,
      );
    }
  }

  if (report.brokenReferences.length > 0) {
    lines.push("");
    lines.push(
      `  broken references on the SOURCE site (${report.brokenReferences.length}; a site defect, not a capture failure):`,
    );
    for (const entry of report.brokenReferences) {
      lines.push(
        `    ${entry.ref} (${entry.reason}; ${entry.where}; ${entry.pages.length} page(s))`,
      );
    }
  }
  if (report.skipped.length > 0) {
    lines.push("");
    lines.push(`  skipped references (${report.skipped.length}):`);
    for (const entry of report.skipped) lines.push(`    ${entry.ref} (${entry.reason})`);
  }
  if (report.failures.length > 0) {
    lines.push("");
    lines.push(`  FAILURES (${report.failures.length}):`);
    for (const failure of report.failures) lines.push(`    ${failure}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://upscalehavens.ca";

interface CliArgs {
  baseUrl: string;
  irPath: string;
  captureReportPath: string;
}

function parseArgs(argv: readonly string[]): CliArgs | null {
  const args: CliArgs = {
    baseUrl: DEFAULT_BASE_URL,
    irPath: DEFAULT_IR_PATH,
    captureReportPath: DEFAULT_CAPTURE_REPORT_PATH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--base-url" && value !== undefined) {
      args.baseUrl = value;
      i += 1;
    } else if (arg === "--ir" && value !== undefined) {
      args.irPath = value;
      i += 1;
    } else if (arg === "--capture-report" && value !== undefined) {
      args.captureReportPath = value;
      i += 1;
    } else {
      return null;
    }
  }
  return args;
}

const USAGE = [
  "Usage: node dist/source/wp-rest/assets.js [options]",
  "",
  `Fetch every stylesheet, inline <style> block and referenced asset into capture/assets/,`,
  `patch ${DEFAULT_IR_PATH}, and write ${DEFAULT_REWRITE_MAP_PATH}.`,
  "",
  "Options:",
  `  --base-url <url>        target site (default ${DEFAULT_BASE_URL})`,
  `  --ir <path>             Site IR to patch (default ${DEFAULT_IR_PATH})`,
  `  --capture-report <path> B1.2 capture report to cross-check (default ${DEFAULT_CAPTURE_REPORT_PATH})`,
].join("\n");

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    process.stdout.write(`${USAGE}\n`);
    return argv.includes("--help") || argv.includes("-h") ? 0 : 1;
  }
  const progress = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  const { report, chain, failures } = await captureAssets({
    baseUrl: args.baseUrl,
    irPath: args.irPath,
    captureReportPath: args.captureReportPath,
    onProgress: progress,
  });
  process.stdout.write(`${formatAssetReport(report, chain)}\n`);

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`FAILURE: ${failure}\n`);
    return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
