/**
 * Deferred-CSS capture — the bead that closes the last real fidelity gap.
 *
 * Divi emits per-page dynamic CSS as a deferred link:
 *
 * ```html
 * <link rel="preload" as="style" id="et-core-unified-…-cached-inline-styles"
 *       href="https://…/wp-content/et-cache/557/et-core-unified-tb-393-deferred-557.min.css?ver=…"
 *       onload="this.onload=null;this.rel='stylesheet';" />
 * ```
 *
 * `rel` is `preload`, not `stylesheet`, so B1.3's chain scan never saw these files:
 * their hrefs stayed absolute and those pages were visually incomplete once the
 * source host was unavailable. This module captures the bytes and — just as
 * important — records **where in each page's cascade they belong**.
 *
 * Position is measured, never guessed. The captured `dom.html` keeps the deferred
 * `<link>` tags but DOM normalisation deleted the inline `<style>` blocks, so the
 * head alone cannot say whether a deferred sheet sat before or after an inline
 * block. The same method B1.3 used to recover the inline bytes is used again: each
 * page is re-fetched politely, every style-bearing element is scanned in document
 * order, each is matched back to its existing chain entry, and the recovered
 * sequence is required to equal `page.styleOrder` exactly. A page that drifted is a
 * failure, not a silently different cascade.
 *
 * The chain is then extended by a **stable topological merge** of the existing chain
 * path plus every page sequence, deferred links included. Existing entries keep
 * their relative order (only their index may shift) and each new entry lands where
 * every page says it belongs. Appending the new entries at the end would have
 * changed the cascade — the exact mistake this module exists to prevent.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ChainEntry, RewriteMap, RewriteMapStyle, StyleChain } from "./assets.js";
import {
  DEFAULT_IR_PATH,
  DEFAULT_REWRITE_MAP_PATH,
  DEFAULT_STYLE_CHAIN_PATH,
  mergeStyleOrder,
  resolveAssetUrl,
  STYLE_ROOT,
} from "./assets.js";
import { decodeEntities, elementPayloads, parseTagAttributes } from "./dom.js";
import { DEFAULT_MIN_INTERVAL_MS, PoliteFetcher } from "./http.js";
import { isPathAllowed } from "./http.js";

/** Capture-side directory (relative to `capture/assets`) for deferred CSS bytes. */
export const DEFERRED_STYLE_HOME = "styles/deferred";
/** Emitted path prefix (`deferred/<sha256>.css`), which is also the chain `localPath`. */
export const DEFERRED_OUTPUT_ROOT = "deferred";
/** Default report path. */
export const DEFAULT_DEFERRED_REPORT_PATH = "capture/deferred-css.capture-report.json";

/** One style-bearing element found in a document, in document order. */
export interface DocumentStyleElement {
  readonly kind: "linked" | "inline" | "deferred";
  /** Byte offset of the element in the document, used to order the sequence. */
  readonly start: number;
  /** Chain identity: `styleKey()` for linked/inline, `linked:<href>|<media>` deferred. */
  readonly key: string;
  /** Captured `href`, verbatim (linked and deferred). */
  readonly href?: string;
  /** Captured `href`, entities decoded and resolved, for fetching. */
  readonly hrefUrl?: string;
  /** `media` attribute, trimmed, when present. */
  readonly media?: string;
  /** Inline only: sha256 of the CSS payload. */
  readonly sha256?: string;
  /** Deferred only: the captured tag verbatim. */
  readonly tag?: string;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** `<link rel="preload" as="style">` is a deferred stylesheet, not a stylesheet. */
export function isDeferredStyleLink(attributes: Record<string, string>): boolean {
  const rel = (attributes["rel"] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const as = (attributes["as"] ?? "").trim().toLowerCase();
  return rel.includes("preload") && as === "style";
}

/**
 * Every style-bearing element of a document, in document order.
 *
 * Linked (`rel=stylesheet`), inline (`<style>`) and deferred (`rel=preload
 * as=style`) share one sequence, because that is the sequence a browser applies.
 */
export function documentStyleElements(
  html: string,
  pageUrl: string,
  baseUrl: string,
): DocumentStyleElement[] {
  const pageAbsolute = new URL(pageUrl, baseUrl).toString();
  const elements: DocumentStyleElement[] = [];

  for (const payload of elementPayloads(html, "style")) {
    const sha256 = sha256Hex(payload.inner);
    elements.push({ kind: "inline", start: payload.start, key: `inline:${sha256}`, sha256 });
  }

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const attributes = parseTagAttributes(tag);
    const rel = (attributes["rel"] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const href = attributes["href"];
    if (href === undefined) continue;
    const decoded = decodeEntities(href).trim();
    if (decoded.length === 0) continue;
    const media = (attributes["media"] ?? "").trim();
    const key = media === "" ? `linked:${href}|` : `linked:${href}|${media}`;

    if (rel.includes("stylesheet")) {
      const hrefUrl = resolveAssetUrl(decoded, pageAbsolute) ?? decoded;
      elements.push({
        kind: "linked",
        start: match.index,
        key,
        href,
        hrefUrl,
        ...(media === "" ? {} : { media }),
      });
      continue;
    }
    if (!isDeferredStyleLink(attributes)) continue;
    const hrefUrl = resolveAssetUrl(decoded, pageAbsolute) ?? decoded;
    elements.push({
      kind: "deferred",
      start: match.index,
      key,
      href,
      hrefUrl,
      tag,
      ...(media === "" ? {} : { media }),
    });
  }

  return elements.sort((left, right) => left.start - right.start);
}

/** One deferred sheet gained by one page, with the position it occupies. */
export interface DeferredPageEntry {
  readonly href: string;
  /** Index in the page's resulting `styleOrder` (0-based). */
  readonly position: number;
  /** Site-chain index the entry owns after the merge. */
  readonly order: number;
  readonly sha256: string;
  readonly bytes: number;
}

/** Per-page evidence: the recovered cascade and what was added to it. */
export interface DeferredPageReport {
  readonly url: string;
  /** The recovered cascade, `linked:<href>|<media>` / `inline:<sha256>` alike. */
  readonly sequence: readonly string[];
  readonly added: readonly DeferredPageEntry[];
}

/** The capture report — machine-readable evidence for the CLI and the tests. */
export interface DeferredCssReport {
  readonly generatedAt: string;
  readonly baseUrl: string;
  readonly tool: { readonly minIntervalMs: number; readonly requests: number };
  readonly pages: readonly DeferredPageReport[];
  readonly totals: {
    /** Deferred `<link>` occurrences across all pages. */
    readonly references: number;
    /** Distinct hrefs fetched. */
    readonly uniqueHrefs: number;
    /** Distinct payloads, deduplicated by sha256. */
    readonly uniqueFiles: number;
    /** Bytes across every page occurrence, before dedup. */
    readonly bytesTotal: number;
    /** Bytes on disk after dedup. */
    readonly bytesUnique: number;
    readonly savedBytes: number;
    readonly pagesGained: number;
    /** Chain entries after the merge. */
    readonly chainEntries: number;
    /** Existing chain entries whose index shifted to make room. */
    readonly shiftedEntries: number;
  };
  readonly notes: readonly string[];
}

export interface CaptureDeferredCssOptions {
  /** Site root. Defaults to `site.baseUrl` from the IR. */
  baseUrl?: string;
  irPath?: string;
  chainPath?: string;
  rewriteMapPath?: string;
  assetsRoot?: string;
  reportOut?: string;
  /** Directory every recorded path is resolved against (tests point this at a temp dir). */
  rootDir?: string;
  minIntervalMs?: number;
  /** Injected for determinism in tests; the default is the polite live fetcher. */
  fetcher?: PoliteFetcher;
  onProgress?: (line: string) => void;
  /** Write the chain, the rewrite map and the report. Off for a read-only probe. */
  write?: boolean;
}

export interface CaptureDeferredCssResult {
  readonly chain: StyleChain;
  readonly map: RewriteMap;
  readonly report: DeferredCssReport;
  readonly unchanged: boolean;
}

interface CapturedIr {
  readonly site: { readonly baseUrl: string };
  readonly pages: readonly {
    readonly url: string;
    readonly dom: { readonly html: string };
    readonly styleOrder?: readonly string[];
  }[];
}

/** Identity of a chain entry, independent of its (movable) `order`. */
export function chainIdentity(entry: ChainEntry): string {
  return entry.origin === "inline"
    ? `inline:${entry.sha256}`
    : `linked:${entry.href ?? ""}|${entry.media ?? ""}`;
}

function mapStyle(entry: ChainEntry): RewriteMapStyle {
  return {
    order: entry.order,
    origin: entry.origin,
    ...(entry.href === undefined ? {} : { href: entry.href }),
    ...(entry.media === undefined ? {} : { media: entry.media }),
    sha256: entry.sha256,
    bytes: entry.bytes,
    capturePath: entry.capturePath,
    localPath: entry.localPath,
    pages: entry.pages,
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/** Capture every deferred stylesheet, extend the chain, and rewrite the map. */
export async function captureDeferredCss(
  options: CaptureDeferredCssOptions = {},
): Promise<CaptureDeferredCssResult> {
  const onProgress = options.onProgress ?? ((): void => {});
  const root = options.rootDir ?? ".";
  const irPath = resolve(root, options.irPath ?? DEFAULT_IR_PATH);
  const chainPath = resolve(root, options.chainPath ?? DEFAULT_STYLE_CHAIN_PATH);
  const mapPath = resolve(root, options.rewriteMapPath ?? DEFAULT_REWRITE_MAP_PATH);
  const assetsRoot = resolve(root, options.assetsRoot ?? "capture/assets");
  const reportPath = resolve(root, options.reportOut ?? DEFAULT_DEFERRED_REPORT_PATH);

  const ir = await readJson<CapturedIr>(irPath);
  const chainFile = await readJson<StyleChain>(chainPath);
  const map = await readJson<RewriteMap>(mapPath);

  const baseUrl = (options.baseUrl ?? ir.site.baseUrl).replace(/\/+$/, "");
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

  const rules = await fetcher.readRobots();
  if (rules.unreadable) onProgress("  robots.txt unreadable; proceeding (recorded)");

  const oldEntries = [...chainFile.styleChain].sort((left, right) => left.order - right.order);
  const byIdentity = new Map(oldEntries.map((entry) => [chainIdentity(entry), entry]));
  const inlineBySha = new Map(
    oldEntries.filter((entry) => entry.origin === "inline").map((entry) => [entry.sha256, entry]),
  );

  /** Per-page recovered sequence: existing chain entries plus deferred elements. */
  const recoveredPages: { url: string; items: DocumentStyleElement[]; keys: string[] }[] = [];
  const failures: string[] = [];
  const deferredByHref = new Map<
    string,
    { href: string; hrefUrl: string; media?: string; pages: Set<string> }
  >();
  let references = 0;

  for (const page of ir.pages) {
    if (!isPathAllowed(page.url, rules)) {
      failures.push(`${page.url}: disallowed by robots.txt; its cascade cannot be measured`);
      continue;
    }
    const response = await fetcher.fetch(page.url);
    if (response.status !== 200) {
      failures.push(`${page.url}: re-fetch answered ${response.status}`);
      continue;
    }
    const html = response.body.replace(/\r\n?/g, "\n");
    const elements = documentStyleElements(html, page.url, baseUrl);

    // --- Recover the page's existing cascade and prove it is still the captured one.
    const resolvedShas: string[] = [];
    for (const element of elements) {
      if (element.kind === "deferred") continue;
      const entry =
        element.kind === "inline"
          ? inlineBySha.get(element.sha256 ?? "")
          : byIdentity.get(element.key);
      if (entry === undefined) {
        failures.push(
          `${page.url}: ${element.kind} style ${element.href ?? element.sha256 ?? element.key} ` +
            `has no entry in the captured chain; the served page changed`,
        );
        continue;
      }
      resolvedShas.push(entry.sha256);
    }
    const expected = page.styleOrder ?? [];
    if (
      resolvedShas.length !== expected.length ||
      resolvedShas.some((sha, index) => sha !== expected[index])
    ) {
      failures.push(
        `${page.url}: the live cascade has ${resolvedShas.length} existing entr(y/ies) but ` +
          `styleOrder has ${expected.length}; the served page no longer matches the capture`,
      );
      continue;
    }

    // The capture's own DOM must agree about which deferred links this page has.
    const fromDom = documentStyleElements(page.dom.html, page.url, baseUrl)
      .filter((element) => element.kind === "deferred")
      .map((element) => element.href ?? "")
      .sort();
    const fromLive = elements
      .filter((element) => element.kind === "deferred")
      .map((element) => element.href ?? "")
      .sort();
    if (fromDom.join("\u0000") !== fromLive.join("\u0000")) {
      failures.push(
        `${page.url}: deferred links in dom.html (${fromDom.length}) differ from the live page ` +
          `(${fromLive.length}); refusing to invent a position`,
      );
      continue;
    }

    const keys = elements.map((element) => element.key);
    for (const element of elements) {
      if (element.kind !== "deferred") continue;
      const href = element.href ?? "";
      references += 1;
      const existing = deferredByHref.get(href);
      if (existing === undefined) {
        deferredByHref.set(href, {
          href,
          hrefUrl: element.hrefUrl ?? href,
          pages: new Set([page.url]),
          ...(element.media === undefined ? {} : { media: element.media }),
        });
      } else {
        existing.pages.add(page.url);
      }
    }
    recoveredPages.push({ url: page.url, items: elements, keys });
    onProgress(
      `  ${page.url}: ${elements.length} style element(s), ` +
        `${elements.filter((element) => element.kind === "deferred").length} deferred`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`deferred-css capture refused:\n  ${failures.join("\n  ")}`);
  }

  // --- Fetch every deferred sheet, deduplicated by href, stored by sha256.
  const stored = new Map<string, { sha256: string; bytes: number }>();
  const measured = new Map<string, { sha256: string; bytes: number }>();
  let bytesUnique = 0;
  let bytesTotal = 0;

  for (const [href, record] of deferredByHref) {
    const response = await fetcher.fetchBytes(record.hrefUrl);
    if (response.status !== 200 || response.bytes.length === 0) {
      failures.push(`${href}: deferred stylesheet answered ${response.status}`);
      continue;
    }
    const sha256 = sha256Hex(response.bytes);
    const bytes = response.bytes.length;
    measured.set(href, { sha256, bytes });
    bytesTotal += bytes * record.pages.size;
    if (!stored.has(sha256)) {
      stored.set(sha256, { sha256, bytes });
      bytesUnique += bytes;
      const directory = join(assetsRoot, DEFERRED_STYLE_HOME);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${sha256}.css`), response.bytes);
    }
    onProgress(`  fetched ${href.slice(0, 72)} (${bytes} B, ${sha256.slice(0, 8)})`);
  }
  if (failures.length > 0) {
    throw new Error(`deferred-css capture refused:\n  ${failures.join("\n  ")}`);
  }

  // --- Merge the extended sequences into one site chain.
  const sequences = [
    // The existing chain is a sequence too: feeding it to the merge first is what
    // pins every existing entry's relative order and makes this a stable insertion
    // rather than a re-derivation.
    { page: "__chain__", keys: oldEntries.map(chainIdentity) },
    ...recoveredPages.map((page) => ({ page: page.url, keys: page.keys })),
  ];
  const merged = mergeStyleOrder(sequences);
  if (merged.length !== oldEntries.length + deferredByHref.size) {
    throw new Error(
      `deferred-css merge produced ${merged.length} entries, expected ` +
        `${oldEntries.length + deferredByHref.size}`,
    );
  }
  const positions = new Map(merged.map((key, index) => [key, index]));

  // Existing entries keep their relative order; only their index may shift.
  let previous = -1;
  let shiftedEntries = 0;
  for (const entry of oldEntries) {
    const index = positions.get(chainIdentity(entry));
    if (index === undefined) {
      throw new Error(`deferred-css merge dropped chain entry ${chainIdentity(entry)}`);
    }
    if (index < previous) {
      throw new Error(`deferred-css merge reordered existing entries at ${chainIdentity(entry)}`);
    }
    previous = index;
    if (index !== entry.order) shiftedEntries += 1;
  }

  // Every page's sequence must remain an increasing subsequence of the chain.
  for (const page of recoveredPages) {
    let cursor = -1;
    for (const key of page.keys) {
      const index = positions.get(key);
      if (index === undefined || index <= cursor) {
        throw new Error(`${page.url}: the merged chain does not preserve this page's cascade`);
      }
      cursor = index;
    }
  }

  const newEntries: ChainEntry[] = [];
  const deferredEntries: ChainEntry[] = [];
  for (const [index, key] of merged.entries()) {
    const existing = byIdentity.get(key);
    if (existing !== undefined) {
      newEntries.push({ ...existing, order: index });
      continue;
    }
    const href = key.slice("linked:".length, key.lastIndexOf("|"));
    const record = deferredByHref.get(href);
    const blob = measured.get(href);
    if (record === undefined || blob === undefined) {
      throw new Error(`deferred-css merge invented an unknown entry ${key}`);
    }
    const entry: ChainEntry = {
      order: index,
      origin: "linked",
      ...(record.media === undefined ? {} : { media: record.media }),
      href: record.href,
      sha256: blob.sha256,
      bytes: blob.bytes,
      capturePath: `${STYLE_ROOT}/${DEFERRED_OUTPUT_ROOT}/${blob.sha256}.css`,
      localPath: `${DEFERRED_OUTPUT_ROOT}/${blob.sha256}.css`,
      pages: [...record.pages].sort(),
    };
    newEntries.push(entry);
    deferredEntries.push(entry);
  }

  // Resolve a chain identity to the sha256 the page's cascade records.
  const shaFor = (key: string): string => {
    const existing = byIdentity.get(key);
    if (existing !== undefined) return existing.sha256;
    const blob = measured.get(key.slice("linked:".length, key.lastIndexOf("|")));
    if (blob === undefined) throw new Error(`deferred-css cannot resolve ${key}`);
    return blob.sha256;
  };

  const pages: DeferredPageReport[] = recoveredPages.map((page) => {
    const order = page.keys.map(shaFor);
    if (new Set(order).size !== order.length) {
      throw new Error(`${page.url}: two cascade entries share a sha256; its order is ambiguous`);
    }
    const added: DeferredPageEntry[] = [];
    page.items.forEach((element, position) => {
      if (element.kind !== "deferred") return;
      const href = element.href ?? "";
      const blob = measured.get(href);
      const order = positions.get(element.key);
      if (blob === undefined || order === undefined) {
        throw new Error(`${page.url}: deferred position for ${href} was lost`);
      }
      added.push({ href, position, order, sha256: blob.sha256, bytes: blob.bytes });
    });
    return { url: page.url, sequence: page.keys, added };
  });

  const generatedAt = new Date().toISOString();
  const chain: StyleChain = {
    ...chainFile,
    generatedAt,
    styleChain: newEntries,
    totals: {
      linked: newEntries.filter((entry) => entry.origin === "linked").length,
      inlineBlocks: chainFile.totals.inlineBlocks,
      inlineUnique: chainFile.totals.inlineUnique,
      inlineBytesTotal: chainFile.totals.inlineBytesTotal,
      inlineBytesUnique: chainFile.totals.inlineBytesUnique,
      deferredLinks: deferredEntries.length,
      deferredFiles: stored.size,
      deferredBytesTotal: bytesTotal,
      deferredBytesUnique: bytesUnique,
    },
    notes: [
      ...chainFile.notes.filter((note) => !note.startsWith("Deferred CSS")),
      `Deferred CSS (cl-site-convert-mzi): ${deferredEntries.length} Divi deferred sheets ` +
        `(${stored.size} distinct files after sha256 dedup) were captured under ` +
        `${STYLE_ROOT}/${DEFERRED_OUTPUT_ROOT}/ and inserted at the position each page's live ` +
        `document gave them. The chain was extended by a stable topological merge, so every ` +
        `existing entry kept its relative order and ${shiftedEntries} shifted index.`,
    ],
  };

  const nextMap: RewriteMap = {
    ...map,
    generatedAt,
    styles: chain.styleChain.map(mapStyle),
    rewrite: { ...map.rewrite },
    notes: [
      ...map.notes.filter((note) => !note.startsWith("Deferred CSS")),
      `Deferred CSS (cl-site-convert-mzi) is mirrored under ${DEFERRED_OUTPUT_ROOT}/<sha256>.css ` +
        `because it was captured after the chain was first built; the path is content-addressed, ` +
        `not a mirror of the source path, and the captured sheets carry no relative url() reference.`,
    ],
  };
  for (const entry of deferredEntries) {
    if (entry.href === undefined) continue;
    nextMap.rewrite[entry.href] = entry.localPath;
  }

  const report: DeferredCssReport = {
    generatedAt,
    baseUrl,
    tool: { minIntervalMs: fetcher.minIntervalMs, requests: fetcher.requestCount },
    pages,
    totals: {
      references,
      uniqueHrefs: deferredByHref.size,
      uniqueFiles: stored.size,
      bytesTotal,
      bytesUnique,
      savedBytes: bytesTotal - bytesUnique,
      pagesGained: pages.filter((page) => page.added.length > 0).length,
      chainEntries: chain.styleChain.length,
      shiftedEntries,
    },
    notes: [
      "`position` is the index in that page's resulting styleOrder, measured from live document order (linked, inline and deferred interleaved) — never appended to the end.",
      "The live page's existing cascade must equal the captured styleOrder exactly before a position is recorded; a drifted page fails the capture.",
      "Bytes are deduplicated by sha256: two hrefs serving identical CSS share one file and each keeps its own chain entry.",
    ],
  };

  const unchanged =
    chainFile.styleChain.length === chain.styleChain.length &&
    chainFile.styleChain.every(
      (entry, index) =>
        chain.styleChain[index]?.order === entry.order &&
        chain.styleChain[index]?.sha256 === entry.sha256,
    );

  if (options.write !== false) {
    await writeFile(chainPath, `${JSON.stringify(chain, null, 2)}\n`);
    await writeFile(mapPath, `${JSON.stringify(nextMap, null, 2)}\n`);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  return { chain, map: nextMap, report, unchanged };
}

/** Human-readable report for the CLI. */
export function formatDeferredReport(report: DeferredCssReport): string {
  const lines: string[] = [];
  lines.push(`deferred-css capture — ${report.baseUrl}`);
  lines.push(
    `  requests: ${report.tool.requests} (>= ${report.tool.minIntervalMs} ms apart), ` +
      `${report.totals.references} reference(s) across ${report.pages.length} page(s)`,
  );
  lines.push("");
  for (const page of report.pages) {
    lines.push(`  ${page.url}${page.added.length === 0 ? "  (none)" : ""}`);
    for (const entry of page.added) {
      lines.push(
        `    position ${String(entry.position).padStart(2)}  chain ${String(entry.order).padStart(2)}  ` +
          `${entry.sha256.slice(0, 12)}  ${String(entry.bytes).padStart(6)} B  ${entry.href}`,
      );
    }
  }
  lines.push("");
  lines.push(
    `  references ${report.totals.references} -> ${report.totals.uniqueHrefs} href(s) -> ` +
      `${report.totals.uniqueFiles} unique file(s) (sha256 dedup)`,
  );
  lines.push(
    `  bytes ${report.totals.bytesTotal} B total -> ${report.totals.bytesUnique} B unique ` +
      `(${report.totals.savedBytes} B saved)`,
  );
  lines.push(
    `  chain ${report.totals.chainEntries} entries; ${report.totals.shiftedEntries} existing ` +
      `entr(y/ies) shifted index to make room`,
  );
  lines.push(`  pages gained: ${report.totals.pagesGained} of ${report.pages.length}`);
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  "Usage: node dist/source/wp-rest/deferred-css.js [options]",
  "",
  "Capture Divi deferred stylesheets (rel=preload as=style), place them in each page's",
  "cascade at their measured document position, and extend capture/style-chain.json.",
  "Run scripts/project-style-chain.mjs afterwards to project the Site IR.",
  "",
  "Options:",
  `  --base-url <url>   site root (default: site.baseUrl from ${DEFAULT_IR_PATH})`,
  `  --ir <path>        Site IR (default ${DEFAULT_IR_PATH})`,
  `  --chain <path>     style chain (default ${DEFAULT_STYLE_CHAIN_PATH})`,
  `  --map <path>       asset rewrite map (default ${DEFAULT_REWRITE_MAP_PATH})`,
  "  --assets <dir>     capture assets root (default capture/assets)",
  `  --report <path>    capture report (default ${DEFAULT_DEFERRED_REPORT_PATH})`,
  "  --dry-run          measure and report without writing anything",
  "  -h, --help         show this help",
].join("\n");

interface CliArgs {
  baseUrl?: string;
  irPath: string;
  chainPath: string;
  rewriteMapPath: string;
  assetsRoot: string;
  reportOut: string;
  write: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs | null {
  const args: CliArgs = {
    irPath: DEFAULT_IR_PATH,
    chainPath: DEFAULT_STYLE_CHAIN_PATH,
    rewriteMapPath: DEFAULT_REWRITE_MAP_PATH,
    assetsRoot: "capture/assets",
    reportOut: DEFAULT_DEFERRED_REPORT_PATH,
    write: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--base-url" && value !== undefined) {
      args.baseUrl = value;
      index += 1;
    } else if (arg === "--ir" && value !== undefined) {
      args.irPath = value;
      index += 1;
    } else if (arg === "--chain" && value !== undefined) {
      args.chainPath = value;
      index += 1;
    } else if (arg === "--map" && value !== undefined) {
      args.rewriteMapPath = value;
      index += 1;
    } else if (arg === "--assets" && value !== undefined) {
      args.assetsRoot = value;
      index += 1;
    } else if (arg === "--report" && value !== undefined) {
      args.reportOut = value;
      index += 1;
    } else if (arg === "--dry-run") {
      args.write = false;
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
  const result = await captureDeferredCss({
    ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
    irPath: args.irPath,
    chainPath: args.chainPath,
    rewriteMapPath: args.rewriteMapPath,
    assetsRoot: args.assetsRoot,
    reportOut: args.reportOut,
    write: args.write,
    onProgress: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${formatDeferredReport(result.report)}\n`);
  if (args.write) {
    process.stdout.write(
      "\nwrote capture/style-chain.json and capture/asset-rewrite-map.json; " +
        "run `node scripts/project-style-chain.mjs` to project the Site IR\n",
    );
  }
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
