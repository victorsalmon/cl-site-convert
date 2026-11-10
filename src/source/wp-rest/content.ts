/**
 * Content + DOM skeleton capture: the adapter that produces the Site IR's
 * `pages[]` from a live WordPress site.
 *
 * Two authorities, deliberately unequal:
 *
 *  - **`/wp/v2/pages`** owns identity — `slug`, `title`, `status`, `template`,
 *    `wpId`, timestamps — and, critically, `link`. The route is *never* derived
 *    from `slug`: the front page's slug is `ush` while its route is `/`.
 *  - **The rendered page** owns the fidelity carrier: `dom.html`. It is fetched
 *    exactly as a visitor receives it and then normalised by `dom.ts`, which only
 *    deletes (scripts, styles, comments, admin bar, telemetry) and never rewrites.
 *
 * The manifest from route enumeration (`capture/routes.manifest.json`) supplies
 * the route list and the HTTP evidence for each route, so this adapter does not
 * re-decide what the site is.
 *
 * `styles[]` and `assets[]` are intentionally empty here: stylesheet and asset
 * capture is a separate pass (B1.3), and the schema requires a `sha256` of the
 * shipped bytes, which cannot be invented. `<link rel="stylesheet">` tags are
 * left inside `dom.html` so that pass has its input.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { IR_VERSION } from "../../schema/site-ir.js";
import type {
  Capabilities,
  JsonObject,
  Page,
  PageSeo,
  PageStatus,
  SiteIr,
  UnsupportedCapability,
} from "../../schema/site-ir.js";
import {
  decodeEntities,
  normaliseDocument,
  parseTagAttributes,
  summariseStripped,
  textFromHtml,
} from "./dom.js";
import type { NormalisedDocument, StrippedNode } from "./dom.js";
import { DEFAULT_MIN_INTERVAL_MS, PoliteFetcher, isPathAllowed } from "./http.js";
import type { RobotsRules } from "./http.js";
import { describeSkipped, parseRestCollection, parseRestRoot, pathFromUrl } from "./parse.js";

/** Files this adapter reads and writes. Paths are repo-relative, as the CLI runs from the root. */
export const DEFAULT_MANIFEST_PATH = "capture/routes.manifest.json";
export const DEFAULT_IR_PATH = "capture/site-ir.json";
export const DEFAULT_REPORT_PATH = "capture/site-ir.capture-report.json";

/** WP permalink structure this adapter assumes (v1 captures concrete paths only). */
const ASSUMED_PERMALINK_STRUCTURE = "/%postname%/";

/** Fields requested from `/wp/v2/pages`: identity only, never `content`. */
const PAGE_FIELDS = "id,slug,link,status,type,parent,modified,date,title,template";

const VALID_STATUSES: readonly PageStatus[] = ["publish", "draft", "private", "pending", "future"];

// ---------------------------------------------------------------------------
// Metadata extracted from the rendered document
// ---------------------------------------------------------------------------

/** What the rendered HTML says about itself, independent of REST. */
export interface PageSignals {
  /** `<title>` text, entities decoded. */
  documentTitle: string | null;
  /** `<html lang>`, e.g. `en-US`. */
  lang: string | null;
  description: string | null;
  robots: string | null;
  canonical: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  /** Parsed `application/ld+json` documents. Invalid blobs are counted, not invented. */
  jsonLd: JsonObject[];
  jsonLdInvalid: number;
  generator: string | null;
  /** `<link rel="stylesheet">` in document order — the input to stylesheet capture. */
  stylesheets: { href: string; media: string | null }[];
  bodyClasses: string[];
  /** True when the page carries Fluent Forms markup. */
  fluentForm: boolean;
  /** LiteSpeed's own cache stamp, when the page was served from its cache. */
  cacheStamp: { version: string; renderedAt: string } | null;
}

/** All `<meta>` tags as attribute maps. */
function metaTags(html: string): Record<string, string>[] {
  return [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
}

/** All `<link>` tags as attribute maps. */
function linkTags(html: string): Record<string, string>[] {
  return [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => parseAttributes(match[0]));
}

// Re-exported shape of the shared attribute parser, kept local so this module has
// one import path for DOM helpers.
function parseAttributes(tag: string): Record<string, string> {
  return parseTagAttributes(tag);
}

function trimmed(value: string | undefined): string | null {
  if (value === undefined) return null;
  const result = value.trim();
  return result.length === 0 ? null : result;
}

/** First `<meta name|property="…">` content value, decoded. */
function metaContent(tags: readonly Record<string, string>[], key: string): string | null {
  for (const tag of tags) {
    const name = tag["name"] ?? tag["property"];
    if (name !== undefined && name.toLowerCase() === key.toLowerCase()) {
      const content = trimmed(tag["content"]);
      return content === null ? null : decodeEntities(content);
    }
  }
  return null;
}

/** Read everything `dom.html` will not carry once scripts and styles are removed. */
export function extractPageSignals(html: string): PageSignals {
  const metas = metaTags(html);
  const links = linkTags(html);

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  const bodyTag = /<body\b[^>]*>/i.exec(html);

  const canonical =
    links
      .filter((tag) => (tag["rel"] ?? "").toLowerCase().split(/\s+/).includes("canonical"))
      .map((tag) => trimmed(tag["href"]))
      .find((href) => href !== null) ?? null;

  const stylesheets = links.flatMap((tag) => {
    const rels = (tag["rel"] ?? "").toLowerCase().split(/\s+/);
    if (!rels.includes("stylesheet")) return [];
    const href = trimmed(tag["href"]);
    if (href === null) return [];
    return [{ href, media: trimmed(tag["media"]) }];
  });

  const jsonLd: JsonObject[] = [];
  let jsonLdInvalid = 0;
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    const payload = match[1] ?? "";
    try {
      const parsed: unknown = JSON.parse(payload);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        if (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)) {
          jsonLd.push(candidate as JsonObject);
        } else {
          jsonLdInvalid += 1;
        }
      }
    } catch {
      jsonLdInvalid += 1;
    }
  }

  const stampMatch = /Page cached by LiteSpeed Cache ([\d.]+) on ([\d-]+ [\d:]+)/i.exec(html);

  return {
    documentTitle: titleMatch?.[1] === undefined ? null : textFromHtml(titleMatch[1]),
    lang: htmlTag === null ? null : trimmed(parseAttributes(htmlTag[0])["lang"]),
    description: metaContent(metas, "description"),
    robots: metaContent(metas, "robots"),
    canonical,
    ogTitle: metaContent(metas, "og:title"),
    ogDescription: metaContent(metas, "og:description"),
    ogImage: metaContent(metas, "og:image"),
    jsonLd,
    jsonLdInvalid,
    generator: metaContent(metas, "generator"),
    stylesheets,
    bodyClasses:
      bodyTag === null
        ? []
        : (trimmed(parseAttributes(bodyTag[0])["class"]) ?? "").split(/\s+/).filter(Boolean),
    fluentForm: /\bfluentform\b|\bfluent_form\b/i.test(html),
    cacheStamp:
      stampMatch?.[1] !== undefined && stampMatch[2] !== undefined
        ? { version: stampMatch[1], renderedAt: stampMatch[2] }
        : null,
  };
}

// ---------------------------------------------------------------------------
// REST identity
// ---------------------------------------------------------------------------

/** The identity fields this adapter needs from `/wp/v2/pages`. */
export interface RestPageMeta {
  id: number | null;
  slug: string | null;
  link: string | null;
  status: string | null;
  title: string | null;
  template: string | null;
  date: string | null;
  modified: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Normalise one `/wp/v2/pages` item. Returns null only when it cannot identify a page. */
export function normaliseRestPage(item: unknown): RestPageMeta | null {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;
  const link = asString(record["link"]);
  if (link === null) return null;

  const titleValue = record["title"];
  const title =
    typeof titleValue === "string"
      ? titleValue
      : typeof titleValue === "object" && titleValue !== null
        ? asString((titleValue as Record<string, unknown>)["rendered"])
        : null;

  const template = asString(record["template"]);
  return {
    id: asNumber(record["id"]),
    slug: asString(record["slug"]),
    link,
    status: asString(record["status"]),
    title: title === null ? null : textFromHtml(title),
    template: template === null || template.trim().length === 0 ? null : template.trim(),
    date: asString(record["date"]),
    modified: asString(record["modified"]),
  };
}

/** Parse a `/wp/v2/pages` collection response into identity records. */
export function parseRestPages(body: string, status: number): RestPageMeta[] {
  const collection = parseRestCollection(body, status);
  return collection.items.flatMap((item) => {
    const page = normaliseRestPage(item);
    return page === null ? [] : [page];
  });
}

// ---------------------------------------------------------------------------
// Page records
// ---------------------------------------------------------------------------

/** One captured page as the adapter saw it. */
export interface CapturedPage {
  /** Site-relative path, from `link`. */
  url: string;
  /** Absolute URL actually requested. */
  requestedUrl: string;
  status: number;
  raw: string;
  normalised: NormalisedDocument;
  signals: PageSignals;
  headers: Record<string, string>;
  rest: RestPageMeta | null;
}

function pageStatus(value: string | null): PageStatus {
  const match = VALID_STATUSES.find((candidate) => candidate === value);
  return match ?? "publish";
}

/** Build the IR page record. `url` comes from `link`, never from `slug`. */
export function buildPageRecord(captured: CapturedPage): Page {
  const rest = captured.rest;
  const signals = captured.signals;

  const page: Page = {
    url: captured.url,
    slug: rest?.slug ?? captured.url.split("/").filter(Boolean).at(-1) ?? "",
    status: pageStatus(rest?.status ?? null),
    template: rest?.template ?? "",
    dom:
      captured.normalised.doctype === undefined
        ? { html: captured.normalised.html }
        : { html: captured.normalised.html, doctype: captured.normalised.doctype },
  };

  const title = rest?.title ?? signals.documentTitle;
  if (title !== null) page.title = title;

  const meta: NonNullable<Page["meta"]> = {};
  if (signals.description !== null) meta.description = signals.description;
  if (rest?.id !== null && rest?.id !== undefined) meta.wpId = rest.id;
  if (rest?.date !== null && rest?.date !== undefined) meta.publishedAt = rest.date;
  if (rest?.modified !== null && rest?.modified !== undefined) meta.updatedAt = rest.modified;
  if (Object.keys(meta).length > 0) page.meta = meta;

  const seo: PageSeo = {};
  if (signals.canonical !== null) seo.canonical = signals.canonical;
  if (signals.robots !== null) seo.robots = signals.robots;
  if (signals.ogTitle !== null) seo.ogTitle = signals.ogTitle;
  if (signals.ogDescription !== null) seo.ogDescription = signals.ogDescription;
  if (signals.ogImage !== null) seo.ogImage = signals.ogImage;
  if (signals.jsonLd.length > 0) seo.jsonLd = signals.jsonLd;
  if (Object.keys(seo).length > 0) page.seo = seo;

  return page;
}

/**
 * What the capture could and could not represent.
 *
 * The `unsupported` list is the honest part: inline `<style>` blocks are where
 * Divi keeps per-page critical CSS, and v1's `styles[]` has no way to express
 * CSS that has no `href`. That is a blocking fidelity gap, not a detail.
 */
export function buildCapabilities(
  pages: readonly Page[],
  captured: readonly CapturedPage[],
): Capabilities {
  const inlineStylePages = captured
    .filter((page) => page.normalised.stripped.some((node) => node.kind === "style"))
    .map((page) => page.url);
  const formPages = captured.filter((page) => page.signals.fluentForm).map((page) => page.url);
  const cachedPages = captured.filter((page) => page.signals.cacheStamp !== null).length;

  const unsupported: UnsupportedCapability[] = [
    {
      capability: "php-runtime",
      detail:
        "WordPress PHP never runs on static hosting. Any server-side behaviour (forms, AJAX, redirects issued by PHP) must be replaced by a static equivalent before cutover.",
      blocking: true,
    },
  ];

  if (inlineStylePages.length > 0) {
    unsupported.push({
      capability: "inline-style-blocks",
      detail:
        `Divi inlines per-page critical CSS in <style> elements (${inlineStylePages.length} of ${pages.length} pages). ` +
        "v1 styles[] requires an href and cannot express inline CSS, so DOM normalisation removes these blocks and " +
        "their bytes are recorded by sha256 in capture/site-ir.capture-report.json. Until B1.3 materialises them as ordered " +
        "stylesheet files (or the schema gains a v1.1 field), emitted pages will render without their critical CSS.",
      blocking: true,
      where: inlineStylePages,
    });
  }

  if (formPages.length > 0) {
    unsupported.push({
      capability: "fluent-forms",
      detail:
        "Fluent Forms markup is captured in the DOM skeleton, but submission is PHP. The form must be replaced by an island posting to a sink (B4.1) before those pages are functional.",
      blocking: true,
      where: formPages,
    });
  }

  unsupported.push({
    capability: "litespeed-cache",
    detail:
      `Pages were served from LiteSpeed Cache (${cachedPages} of ${captured.length}). A client cannot force a cache bypass: ` +
      "`Cache-Control: no-cache` was observed to be ignored and still returned x-litespeed-cache: hit. Freshness is " +
      "evidenced per page instead, by comparing LiteSpeed's embedded cache stamp with the REST `modified` timestamp.",
    blocking: false,
  });

  unsupported.push({
    capability: "client-side-scripts",
    detail:
      "Every <script> element is removed from the DOM skeleton, including Divi's menu/animation behaviour. Interactions " +
      "that depended on them are absent until an island replaces them (P3).",
    blocking: true,
  });

  return {
    supported: [
      "wp-rest",
      "rendered-html",
      "divi-page-builder",
      "wordpress-menus",
      "structured-data-json-ld",
    ],
    unsupported,
  };
}

// ---------------------------------------------------------------------------
// Capture report (the "stripped[]" record the schema has no field for)
// ---------------------------------------------------------------------------

export interface CaptureReportPage {
  url: string;
  status: number;
  bytes: number;
  domBytes: number;
  stripped: StrippedNode[];
  strippedSummary: string;
  /** Cache evidence, so a stale baseline would be visible rather than assumed. */
  cache: {
    litespeed: string | null;
    age: string | null;
    etag: string | null;
    cacheControl: string | null;
    stamp: { version: string; renderedAt: string } | null;
    freshness: "cache-newer-than-content" | "cache-older-than-content" | "unknown";
  };
  restModified: string | null;
  stylesheetRefs: { href: string; media: string | null }[];
  notes: string[];
}

export interface CaptureReport {
  generatedAt: string;
  baseUrl: string;
  tool: { name: string; version: string; minIntervalMs: number; requests: number };
  totals: {
    pages: number;
    requested: number;
    failed: number;
    inputBytes: number;
    domBytes: number;
    strippedBytes: number;
  };
  cache: {
    hits: number;
    misses: number;
    bypassAttempted: boolean;
    bypassNote: string;
  };
  pages: CaptureReportPage[];
  /** Stylesheet chain seen across the capture, for B1.3. Never sha256'd here. */
  stylesheets: { href: string; media: string | null; pages: number }[];
  /**
   * Contact details found in the captured HTML. Public marketing pages legitimately
   * carry business email addresses and phone links; this list exists so a human can
   * confirm that before the IR is committed, and so nothing personal is committed
   * without being noticed.
   */
  contactScan: { emails: string[]; telLinks: string[]; note: string };
  notes: string[];
}

/**
 * LiteSpeed's stamp and WordPress's `modified` are both naive site-local
 * timestamps, so a lexical comparison is meaningful. The assumption is recorded
 * rather than hidden.
 */
function cacheFreshness(
  stamp: string | null,
  modified: string | null,
): CaptureReportPage["cache"]["freshness"] {
  if (stamp === null || modified === null) return "unknown";
  const normalisedStamp = stamp.replace(" ", "T");
  const normalisedModified = modified.replace(" ", "T").slice(0, 19);
  if (normalisedStamp >= normalisedModified) return "cache-newer-than-content";
  return "cache-older-than-content";
}

/** The `stripped[]` summary line, kept here so the report never re-derives it. */
const strippedSummary = summariseStripped;

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** A route as the manifest recorded it. Only the fields this adapter consumes. */
export interface ManifestRouteInput {
  url: string;
  path: string;
  status: string;
  template: string | null;
  http?: { status: number };
}

export interface CaptureOptions {
  baseUrl: string;
  manifestPath?: string;
  minIntervalMs?: number;
  /** Injectable fetcher for tests; the default is a polite one for the live site. */
  fetcher?: PoliteFetcher;
  onProgress?: (line: string) => void;
}

export interface CaptureResult {
  ir: SiteIr;
  report: CaptureReport;
  /** Non-empty when a page could not be captured. The CLI turns this into exit 1. */
  failures: string[];
}

interface LoadedManifest {
  baseUrl: string;
  routes: ManifestRouteInput[];
}

/** Read the route manifest. A missing or empty manifest is a failure, never an empty capture. */
export async function readManifest(path: string): Promise<LoadedManifest> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${path}: not an object`);
  const record = parsed as Record<string, unknown>;
  const routes = Array.isArray(record["routes"]) ? record["routes"] : [];
  const baseUrl = typeof record["baseUrl"] === "string" ? record["baseUrl"] : "";
  if (routes.length === 0) throw new Error(`${path}: no routes in the manifest`);
  return { baseUrl, routes: routes as ManifestRouteInput[] };
}

/** Fetch and normalise every routable page. Sequential: the fetcher enforces the gap. */
export async function capturePages(options: CaptureOptions): Promise<{
  captured: CapturedPage[];
  identity: SiteIdentity;
  failures: string[];
  notes: string[];
  fetcher: PoliteFetcher;
}> {
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const onProgress = options.onProgress ?? ((): void => {});
  const manifest = await readManifest(manifestPath);
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (manifest.baseUrl !== baseUrl) {
    throw new Error(
      `${manifestPath} was captured for ${manifest.baseUrl}, not ${baseUrl}; refusing to mix captures`,
    );
  }

  const fetcher =
    options.fetcher ??
    new PoliteFetcher({
      baseUrl,
      minIntervalMs: Math.max(
        DEFAULT_MIN_INTERVAL_MS,
        options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      ),
      onRequest: (line) => onProgress(line),
    });

  const rules: RobotsRules = await fetcher.readRobots();
  const failures: string[] = [];
  const notes: string[] = [];
  if (rules.unreadable) {
    notes.push(
      `robots.txt unreadable (status ${rules.status ?? "no response"}); proceeding as permitted`,
    );
  }

  // Site identity first: `/wp-json/` owns the site name and description, and a page
  // title is not a substitute for either.
  let identity: SiteIdentity = {
    title: new URL(baseUrl).host,
    description: null,
    homeUrl: baseUrl,
    siteUrl: baseUrl,
  };
  if (isPathAllowed("/wp-json/", rules)) {
    const response = await fetcher.fetch("/wp-json/");
    if (response.status !== 200) {
      failures.push(`/wp-json/ returned ${response.status}; site identity is unavailable`);
    } else {
      try {
        const root = parseRestRoot(response.body);
        identity = {
          title: root.name ?? identity.title,
          description: root.description,
          homeUrl: root.home,
          siteUrl: root.url,
        };
      } catch (error) {
        failures.push(
          `/wp-json/ unparseable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } else {
    failures.push(describeSkipped("/wp-json/", rules));
  }

  // REST identity first: one request gives title/status/template/wpId for every page.
  const restPages = new Map<string, RestPageMeta>();
  if (isPathAllowed("/wp-json/wp/v2/pages", rules)) {
    const response = await fetcher.fetch(
      `/wp-json/wp/v2/pages?per_page=100&_fields=${PAGE_FIELDS}`,
    );
    if (response.status !== 200) {
      failures.push(
        `/wp-json/wp/v2/pages returned ${response.status}; page identity is unavailable`,
      );
    } else {
      for (const page of parseRestPages(response.body, response.status)) {
        if (page.link !== null) restPages.set(pathFromUrl(page.link, baseUrl), page);
      }
    }
  } else {
    failures.push(describeSkipped("/wp-json/wp/v2/pages", rules));
  }

  const captured: CapturedPage[] = [];
  const routable = manifest.routes
    .filter((route) => (route.http?.status ?? 200) === 200)
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const route of routable) {
    if (!isPathAllowed(route.path, rules)) {
      failures.push(describeSkipped(route.path, rules));
      continue;
    }
    const response = await fetcher.fetch(route.path);
    if (response.status !== 200) {
      failures.push(`${route.path} answered ${response.status}; page not captured`);
      continue;
    }
    if (!(response.headers["content-type"] ?? "").includes("text/html")) {
      failures.push(
        `${route.path} served ${response.headers["content-type"] ?? "no content-type"}; not a page`,
      );
      continue;
    }

    const normalised = normaliseDocument(response.body);
    const signals = extractPageSignals(response.body);
    captured.push({
      url: pathFromUrl(route.url, baseUrl),
      requestedUrl: response.url,
      status: response.status,
      raw: response.body,
      normalised,
      signals,
      headers: response.headers,
      rest: restPages.get(route.path) ?? null,
    });
    if (normalised.notes.length > 0) {
      for (const note of normalised.notes) notes.push(`${route.path}: ${note}`);
    }
    onProgress(
      `  ${route.path}: ${response.body.length} B -> ${normalised.html.length} B DOM, ${strippedSummary(normalised.stripped)}`,
    );
  }

  // Every manifest route must have produced identity, or the IR would silently
  // carry a page whose slug/status is guessed rather than captured.
  for (const page of captured) {
    if (page.rest === null)
      failures.push(`${page.url}: no REST identity record; slug/title are unreliable`);
  }

  return { captured, identity, failures, notes, fetcher };
}

/** Site identity from the REST root, so `site.title` is the site's name, not a page title. */
export interface SiteIdentity {
  title: string;
  description: string | null;
  homeUrl: string | null;
  siteUrl: string | null;
}

/** Assemble the Site IR plus the capture report from captured pages. */
export function assembleSiteIr(
  baseUrl: string,
  captured: readonly CapturedPage[],
  identity: SiteIdentity,
  options: { toolVersion: string; minIntervalMs: number; requests: number; notes?: string[] },
): { ir: SiteIr; report: CaptureReport } {
  const pages = captured.map((page) => buildPageRecord(page));

  // WP locale is not exposed on `/wp-json/`; the document's `lang` is.
  const lang = captured.find((page) => page.signals.lang !== null)?.signals.lang ?? "en_US";
  const locale = lang.replace("-", "_");

  const stylesheetCounts = new Map<string, { href: string; media: string | null; pages: number }>();
  for (const page of captured) {
    for (const sheet of page.signals.stylesheets) {
      const key = `${sheet.href}|${sheet.media ?? ""}`;
      const existing = stylesheetCounts.get(key);
      if (existing === undefined) {
        stylesheetCounts.set(key, { href: sheet.href, media: sheet.media, pages: 1 });
      } else {
        existing.pages += 1;
      }
    }
  }

  const captureNotes = [
    'styles[] and assets[] are empty by design in this pass: stylesheet and asset capture is B1.3, and a style entry requires the sha256 of shipped bytes. <link rel="stylesheet"> tags are preserved in every dom.html.',
    "Redirects (optional field) are owned by B1.6; the route manifest already records 11 proven 301s discovered during enumeration.",
    "site.locale is derived from the document lang attribute because /wp-json/ does not expose the WP locale.",
    ...(options.notes ?? []),
  ];

  const site: SiteIr["site"] = {
    baseUrl,
    title: identity.title,
    locale,
    permalinks: {
      structure: ASSUMED_PERMALINK_STRUCTURE,
      homeUrl: identity.homeUrl ?? baseUrl,
      siteUrl: identity.siteUrl ?? baseUrl,
    },
  };
  if (identity.description !== null) site.description = identity.description;

  const ir: SiteIr = {
    irVersion: IR_VERSION,
    site,
    pages,
    assets: [],
    styles: [],
    capabilities: buildCapabilities(pages, captured),
    capture: {
      sourceAdapter: "wp-rest",
      capturedAt: new Date().toISOString(),
      toolVersion: options.toolVersion,
      notes: captureNotes.join(" "),
    },
  };

  const reportPages: CaptureReportPage[] = captured.map((page) => {
    const stamp = page.signals.cacheStamp;
    const cache: CaptureReportPage["cache"] = {
      litespeed: page.headers["x-litespeed-cache"] ?? null,
      age: page.headers["age"] ?? null,
      etag: page.headers["etag"] ?? null,
      cacheControl: page.headers["cache-control"] ?? null,
      stamp,
      freshness: cacheFreshness(stamp?.renderedAt ?? null, page.rest?.modified ?? null),
    };
    return {
      url: page.url,
      status: page.status,
      bytes: page.raw.length,
      domBytes: page.normalised.html.length,
      stripped: page.normalised.stripped,
      strippedSummary: strippedSummary(page.normalised.stripped),
      cache,
      restModified: page.rest?.modified ?? null,
      stylesheetRefs: page.signals.stylesheets,
      notes: page.normalised.notes,
    };
  });

  const hits = captured.filter(
    (page) => (page.headers["x-litespeed-cache"] ?? "") === "hit",
  ).length;
  const stale = reportPages.filter((page) => page.cache.freshness === "cache-older-than-content");
  const unknown = reportPages.filter((page) => page.cache.freshness === "unknown");
  const reportNotes = [
    "Cache bypass could not be forced: sending `Cache-Control: no-cache` to /care/ returned byte-identical HTML with x-litespeed-cache: hit.",
    "Freshness is therefore evidenced per page by comparing LiteSpeed's embedded cache stamp with the REST `modified` timestamp; both are naive site-local times.",
  ];
  if (stale.length > 0) {
    reportNotes.push(
      `cache stamp older than content modified on ${stale.length} page(s): ${stale.map((page) => page.url).join(", ")}`,
    );
  }
  if (unknown.length > 0) {
    reportNotes.push(
      `freshness unknown on ${unknown.length} page(s) (no cache stamp or no REST modified): ${unknown.map((page) => page.url).join(", ")}`,
    );
  }

  const contactEmails = new Set<string>();
  const contactTels = new Set<string>();
  for (const page of captured) {
    const scan = scanContactDetails(page.raw);
    for (const email of scan.emails) contactEmails.add(email);
    for (const tel of scan.telLinks) contactTels.add(tel);
  }

  const report: CaptureReport = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    tool: {
      name: "cl-site-convert",
      version: options.toolVersion,
      minIntervalMs: options.minIntervalMs,
      requests: options.requests,
    },
    totals: {
      pages: captured.length,
      requested: options.requests,
      failed: 0,
      inputBytes: captured.reduce((total, page) => total + page.raw.length, 0),
      domBytes: captured.reduce((total, page) => total + page.normalised.html.length, 0),
      strippedBytes: captured.reduce(
        (total, page) =>
          total + page.normalised.stripped.reduce((sum, node) => sum + node.bytes, 0),
        0,
      ),
    },
    cache: {
      hits,
      misses: captured.length - hits,
      bypassAttempted: true,
      bypassNote:
        "Cache-Control: no-cache did not bypass LiteSpeed Cache; the served bytes are the site's own cache output.",
    },
    pages: reportPages,
    stylesheets: [...stylesheetCounts.values()],
    contactScan: {
      emails: [...contactEmails].sort(),
      telLinks: [...contactTels].sort(),
      note: "Extracted from the rendered HTML before normalisation. Every entry must be a published business contact before capture/site-ir.json is committed; anything personal is a finding, not a fixture.",
    },
    notes: reportNotes,
  };

  return { ir, report };
}

/** Full capture: fetch pages, assemble the IR, write both artifacts. */
export async function captureContent(options: {
  baseUrl: string;
  out?: string;
  reportOut?: string;
  manifestPath?: string;
  minIntervalMs?: number;
  onProgress?: (line: string) => void;
}): Promise<CaptureResult> {
  const out = options.out ?? DEFAULT_IR_PATH;
  const reportOut = options.reportOut ?? DEFAULT_REPORT_PATH;
  const onProgress = options.onProgress ?? ((): void => {});

  const { captured, identity, failures, notes, fetcher } = await capturePages({
    baseUrl: options.baseUrl,
    ...(options.manifestPath === undefined ? {} : { manifestPath: options.manifestPath }),
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    onProgress,
  });

  const { ir, report } = assembleSiteIr(options.baseUrl.replace(/\/+$/, ""), captured, identity, {
    toolVersion: "0.1.0",
    minIntervalMs: fetcher.minIntervalMs,
    requests: fetcher.requestCount,
    notes,
  });
  report.totals.failed = failures.length;

  if (captured.length === 0) failures.push("no page was captured; refusing to write an empty IR");

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(ir, null, 2)}\n`, "utf8");
  await mkdir(dirname(reportOut), { recursive: true });
  await writeFile(reportOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return { ir, report, failures };
}

/** Contact details in a page, for the pre-commit PII check. Public pages only. */
export function scanContactDetails(html: string): { emails: string[]; telLinks: string[] } {
  const emails = new Set<string>();
  for (const match of html.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    emails.add(match[0].toLowerCase());
  }
  const telLinks = new Set<string>();
  for (const match of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    const value = match[1];
    if (value !== undefined) telLinks.add(value);
  }
  return { emails: [...emails].sort(), telLinks: [...telLinks].sort() };
}

/** Console report. The numbers here are the deliverable's evidence. */
export function formatCaptureReport(report: CaptureReport, ir: SiteIr): string {
  const lines: string[] = [];
  lines.push(`Site IR capture — ${report.baseUrl} (${report.generatedAt})`);
  lines.push("");
  lines.push(`  pages captured : ${report.totals.pages}`);
  lines.push(
    `  requests       : ${report.tool.requests} (>= ${report.tool.minIntervalMs} ms apart)`,
  );
  lines.push(`  raw HTML       : ${report.totals.inputBytes} B`);
  lines.push(`  dom.html total : ${report.totals.domBytes} B`);
  lines.push(`  stripped       : ${report.totals.strippedBytes} B`);
  lines.push(`  IR pages[]     : ${ir.pages.length}`);
  lines.push(
    `  inline jsonLd   : ${ir.pages.filter((page) => page.seo?.jsonLd !== undefined).length} pages`,
  );
  lines.push(
    `  fluent forms   : ${ir.capabilities.unsupported.find((entry) => entry.capability === "fluent-forms")?.where?.length ?? 0} pages`,
  );
  lines.push("");
  lines.push(`  litespeed      : ${report.cache.hits} hit / ${report.cache.misses} miss`);
  lines.push(`  cache bypass   : ${report.cache.bypassNote}`);
  lines.push("");
  lines.push(
    `  stylesheets observed (B1.3 input, not captured here): ${report.stylesheets.length}`,
  );
  for (const sheet of report.stylesheets) {
    lines.push(
      `    ${sheet.href}${sheet.media === null ? "" : ` (${sheet.media})`} — ${sheet.pages} page(s)`,
    );
  }

  lines.push("");
  lines.push(
    `  contact details found (must all be published business contacts): ${report.contactScan.emails.length} email(s), ${report.contactScan.telLinks.length} tel link(s)`,
  );
  for (const email of report.contactScan.emails) lines.push(`    email: ${email}`);
  for (const tel of report.contactScan.telLinks) lines.push(`    tel: ${tel}`);

  const stripped = report.pages
    .map((page) => ({ url: page.url, summary: page.strippedSummary }))
    .filter((entry) => entry.summary !== "nothing");
  lines.push("");
  lines.push(`  normalisation (per page):`);
  for (const entry of stripped) lines.push(`    ${entry.url}  ${entry.summary}`);
  if (stripped.length === 0) lines.push("    (nothing was removed)");

  const stale = report.pages.filter((page) => page.cache.freshness !== "cache-newer-than-content");
  if (stale.length > 0) {
    lines.push("");
    lines.push(`  cache freshness not proven (${stale.length}):`);
    for (const page of stale) lines.push(`    ${page.url}: ${page.cache.freshness}`);
  }

  lines.push("");
  lines.push(`  capabilities unsupported (${ir.capabilities.unsupported.length}):`);
  for (const entry of ir.capabilities.unsupported) {
    lines.push(
      `    ${entry.capability}${entry.blocking === true ? " [blocking]" : ""}${entry.where === undefined ? "" : ` (${entry.where.length} pages)`}`,
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

const DEFAULT_BASE_URL = "https://upscalehavens.ca";

interface CliArgs {
  baseUrl: string;
  manifestPath: string;
  out: string;
  reportOut: string;
}

function parseArgs(argv: readonly string[]): CliArgs | null {
  const args: CliArgs = {
    baseUrl: DEFAULT_BASE_URL,
    manifestPath: DEFAULT_MANIFEST_PATH,
    out: DEFAULT_IR_PATH,
    reportOut: DEFAULT_REPORT_PATH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--base-url" && value !== undefined) {
      args.baseUrl = value;
      i += 1;
    } else if (arg === "--manifest" && value !== undefined) {
      args.manifestPath = value;
      i += 1;
    } else if (arg === "--out" && value !== undefined) {
      args.out = value;
      i += 1;
    } else if (arg === "--report" && value !== undefined) {
      args.reportOut = value;
      i += 1;
    } else {
      return null;
    }
  }
  return args;
}

const USAGE = [
  "Usage: node dist/source/wp-rest/content.js [options]",
  "",
  `Capture every routable page's normalized DOM skeleton into ${DEFAULT_IR_PATH}`,
  `and the normalisation/cache evidence into ${DEFAULT_REPORT_PATH}.`,
  "",
  "Options:",
  `  --base-url <url>   target site (default ${DEFAULT_BASE_URL})`,
  `  --manifest <path>  route manifest (default ${DEFAULT_MANIFEST_PATH})`,
  `  --out <path>       IR path (default ${DEFAULT_IR_PATH})`,
  `  --report <path>    capture report path (default ${DEFAULT_REPORT_PATH})`,
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

  const { ir, report, failures } = await captureContent({
    baseUrl: args.baseUrl,
    manifestPath: args.manifestPath,
    out: args.out,
    reportOut: args.reportOut,
    onProgress: progress,
  });

  process.stdout.write(`${formatCaptureReport(report, ir)}\n`);
  process.stdout.write(`\nwrote ${args.out} and ${args.reportOut}\n`);

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
