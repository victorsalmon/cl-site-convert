/**
 * Pure parsing and normalisation for route enumeration.
 *
 * Nothing here performs I/O. Every function takes bytes the caller already has and
 * returns a value, which is what makes the whole route shape testable against
 * recorded fixtures instead of against the live site.
 *
 * The two inputs are deliberately unequal in trust:
 *
 *  - **WordPress REST** is authoritative. It knows `status`, `parent`, `template`
 *    and `modified`; it can also list things a sitemap never sees (drafts) and
 *    things a sitemap lists that are not routes (archives).
 *  - **The sitemap** is the crawl contract: what the site tells Google exists. It
 *    carries `lastmod` and nothing else useful.
 *
 * Reconciliation between them is the interesting output, so it is computed
 * rather than asserted: a URL present in one source only is named, never folded
 * away.
 */

import type { RobotsRules } from "./http.js";

/** Where a route was discovered. */
export type RouteSource = "wp-rest" | "sitemap" | "both";

/** The IR's own vocabulary, narrowed to what a route manifest can know. */
export type RouteType = "page" | "post" | "other";

export interface RouteRecord {
  /** Absolute URL as the site presents it. */
  url: string;
  /** Site-relative path with a leading slash; the IR's `page.url` form. */
  path: string;
  slug: string;
  /** WP post status (`publish`, `draft`, …) or `unknown` when only a sitemap knew it. */
  status: string;
  type: RouteType;
  /** Resolved parent route path, `null` at top level. */
  parent: string | null;
  /** Raw WP parent id; `0` means top level. */
  parentId: number | null;
  /** Last modified timestamp as reported, or `null`. */
  modified: string | null;
  /** Captured template id, `null` when the default template is in use. */
  template: string | null;
  source: RouteSource;
}

/** One page of a WP REST collection response. */
export interface RestCollection<T> {
  items: T[];
  total: number | null;
  totalPages: number | null;
  status: number;
  error: string | null;
}

export interface RestRootInfo {
  name: string | null;
  description: string | null;
  url: string | null;
  home: string | null;
  namespaces: string[];
  showOnFront: string | null;
  pageOnFront: number | null;
  gmtOffset: number | null;
  timezone: string | null;
}

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

export interface SitemapDocument {
  kind: "index" | "urlset" | "unknown";
  /** Sitemap documents this index points at (empty for a urlset). */
  children: string[];
  /** URLs in this document (empty for an index). */
  entries: SitemapEntry[];
}

/** WP namespaces that ship with core. Anything else is a plugin introducing itself. */
const CORE_NAMESPACES = new Set([
  "oembed/1.0",
  "wp/v2",
  "wp-site-health/v1",
  "wp-block-editor/v1",
  "wp-abilities/v1",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `rendered` title/content objects and bare strings both occur in REST. */
export function renderedText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (isRecord(value)) return asString(value["rendered"]);
  return null;
}

/**
 * Compare keys for the union: the same route with and without a trailing slash is
 * one route. Everything else is left exactly as the site writes it.
 */
export function routeKey(path: string): string {
  if (path === "/" || path === "") return "/";
  const withoutTrailing = path.replace(/\/+$/, "");
  return withoutTrailing.length === 0 ? "/" : withoutTrailing;
}

/** Site-relative path of a URL, falling back to the input when it will not parse. */
export function pathFromUrl(url: string, baseUrl: string): string {
  try {
    const parsed = new URL(url);
    const base = new URL(baseUrl);
    if (parsed.host !== base.host) return `${parsed.pathname}${parsed.search}` || url;
    return `${parsed.pathname}${parsed.search}` || "/";
  } catch {
    return url;
  }
}

/** `""` from REST means "default template"; `null` is the honest spelling. */
function normaliseTemplate(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export interface NormaliseContext {
  baseUrl: string;
  /** WP parent id -> route path, from the same collection. */
  parentPaths?: ReadonlyMap<number, string>;
}

/** Normalise one `/wp/v2/{pages,posts}` item into a route record. Pure. */
export function normaliseRestItem(item: unknown, context: NormaliseContext): RouteRecord | null {
  if (!isRecord(item)) return null;
  const link = asString(item["link"]);
  const type = asString(item["type"]);
  const slug = asString(item["slug"]);
  const status = asString(item["status"]);
  if (link === null || type === null || slug === null || status === null) return null;

  const parentId = asNumber(item["parent"]);
  const parentPath =
    parentId !== null && parentId > 0 ? (context.parentPaths?.get(parentId) ?? null) : null;

  return {
    url: link,
    path: pathFromUrl(link, context.baseUrl),
    slug,
    status,
    type: type === "page" || type === "post" ? type : "other",
    parent: parentPath,
    parentId,
    modified: asString(item["modified"]),
    template: normaliseTemplate(item["template"]),
    source: "wp-rest",
  };
}

/** Parse a WP REST collection response. Never throws; reports failure in-band. */
export function parseRestCollection(body: string, status: number): RestCollection<unknown> {
  if (status !== 200) {
    return { items: [], total: null, totalPages: null, status, error: `HTTP ${status}` };
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) {
      return {
        items: [],
        total: null,
        totalPages: null,
        status,
        error: "response was not an array",
      };
    }
    return { items: parsed, total: null, totalPages: null, status, error: null };
  } catch (error) {
    return {
      items: [],
      total: null,
      totalPages: null,
      status,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Total / total-pages from the pagination headers WP always sends. */
export function parsePaginationHeaders(headers: Record<string, string>): {
  total: number | null;
  totalPages: number | null;
} {
  const total = Number.parseInt(headers["x-wp-total"] ?? "", 10);
  const totalPages = Number.parseInt(headers["x-wp-totalpages"] ?? "", 10);
  return {
    total: Number.isNaN(total) ? null : total,
    totalPages: Number.isNaN(totalPages) ? null : totalPages,
  };
}

/** Parse `/wp-json/` root: site identity plus the namespaces that exist. */
export function parseRestRoot(body: string): RestRootInfo {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed)) throw new Error("REST root was not an object");

  const namespaces = Array.isArray(parsed["namespaces"])
    ? parsed["namespaces"].filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    name: asString(parsed["name"]),
    description: asString(parsed["description"]),
    url: asString(parsed["url"]),
    home: asString(parsed["home"]),
    namespaces,
    showOnFront: asString(parsed["show_on_front"]),
    pageOnFront: asNumeric(parsed["page_on_front"]),
    gmtOffset: asNumeric(parsed["gmt_offset"]),
    timezone: asString(parsed["timezone_string"]),
  };
}

/**
 * Namespaces that are not WordPress core — i.e. plugins announcing themselves on a
 * public endpoint. This is the "does `/wp-json/` leak a plugin list?" answer.
 */
export function pluginNamespaces(namespaces: readonly string[]): string[] {
  return namespaces.filter((namespace) => !CORE_NAMESPACES.has(namespace));
}

/** `<meta name="generator" content="WordPress 7.1.4">` — the only public version tell. */
export function detectWpVersion(html: string): string | null {
  const match = /<meta\s+name=["']generator["']\s+content=["']WordPress\s+([\d.]+)["']/i.exec(html);
  return match?.[1] ?? null;
}

/**
 * Coerce a REST scalar to a number.
 *
 * WordPress is inconsistent here: `gmt_offset` comes back as the *string* `"-8"`
 * on some versions and a number on others. A parser that only accepts numbers
 * silently reports "unknown" for a value the site plainly supplied.
 */
function asNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const TAG = (name: string): RegExp =>
  new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i");

function firstTagText(block: string, name: string): string | null {
  const match = TAG(name).exec(block);
  const raw = match?.[1];
  if (raw === undefined) return null;
  const trimmed = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse a sitemap document without an XML dependency.
 *
 * Two shapes matter and nothing else: `<sitemapindex>` (children) and `<urlset>`
 * (entries). Anything else is reported as `unknown` rather than guessed at, and
 * the caller records that. Namespace prefixes are tolerated.
 */
export function parseSitemap(xml: string): SitemapDocument {
  const head = xml.slice(0, 2_000);
  const isIndex = /<(?:[\w-]+:)?sitemapindex\b/i.test(head);
  const isUrlset = /<(?:[\w-]+:)?urlset\b/i.test(head);

  const children: string[] = [];
  const entries: SitemapEntry[] = [];

  if (isIndex) {
    for (const block of xml.split(/<\/(?:[\w-]+:)?sitemap>/i).slice(0, -1)) {
      const loc = firstTagText(block, "loc");
      if (loc !== null) children.push(loc);
    }
    return { kind: "index", children, entries };
  }

  if (isUrlset) {
    for (const chunk of xml.split(/<\/(?:[\w-]+:)?url>/i)) {
      const loc = firstTagText(chunk, "loc");
      if (loc === null) continue;
      entries.push({ loc, lastmod: firstTagText(chunk, "lastmod") });
    }
    return { kind: "urlset", children, entries };
  }

  return { kind: "unknown", children, entries };
}

export interface Reconciliation {
  wpRest: number;
  sitemap: number;
  union: number;
  both: number;
  /** Paths WordPress knows about that the sitemap does not advertise. */
  restOnly: string[];
  /** Paths the sitemap advertises that WordPress did not return. */
  sitemapOnly: string[];
}

export interface MergeResult {
  routes: RouteRecord[];
  reconciliation: Reconciliation;
}

/**
 * Union the two sources into one manifest, keyed by `routeKey(path)`.
 *
 * REST wins field-by-field where both know a route; the sitemap fills in
 * `modified` when REST has nothing and can never invent a `status`.
 */
export function mergeSources(
  restRoutes: readonly RouteRecord[],
  sitemapEntries: readonly { loc: string; lastmod: string | null }[],
  baseUrl: string,
): MergeResult {
  const byKey = new Map<string, RouteRecord>();
  const restKeys = new Set<string>();
  const sitemapKeys = new Set<string>();

  for (const route of restRoutes) {
    const key = routeKey(route.path);
    restKeys.add(key);
    const existing = byKey.get(key);
    // A `page` outranks an `other` when both describe one path (a term archive
    // live at the same URL as a page would be a site bug, but do not lose it).
    if (existing === undefined || (existing.type === "other" && route.type !== "other")) {
      byKey.set(key, { ...route });
    }
  }

  for (const entry of sitemapEntries) {
    const path = pathFromUrl(entry.loc, baseUrl);
    const key = routeKey(path);
    sitemapKeys.add(key);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        url: entry.loc,
        path,
        slug: slugFromPath(path),
        status: "unknown",
        type: "other",
        parent: null,
        parentId: null,
        modified: entry.lastmod,
        template: null,
        source: "sitemap",
      });
      continue;
    }
    if (existing.modified === null && entry.lastmod !== null) existing.modified = entry.lastmod;
  }

  const routes = [...byKey.values()]
    .map((route) => ({
      ...route,
      source: (restKeys.has(routeKey(route.path)) && sitemapKeys.has(routeKey(route.path))
        ? "both"
        : restKeys.has(routeKey(route.path))
          ? "wp-rest"
          : "sitemap") as RouteSource,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const restOnly = [...restKeys].filter((key) => !sitemapKeys.has(key)).sort();
  const sitemapOnly = [...sitemapKeys].filter((key) => !restKeys.has(key)).sort();

  return {
    routes,
    reconciliation: {
      wpRest: restKeys.size,
      sitemap: sitemapKeys.size,
      union: routes.length,
      both: routes.filter((route) => route.source === "both").length,
      restOnly,
      sitemapOnly,
    },
  };
}

/** Last path segment, which is what WP calls a slug. `/` has no segment. */
export function slugFromPath(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? "";
}

/**
 * Every distinct on-site path linked from a page's HTML.
 *
 * This is the third, weakest evidence source: a link proves a URL is *reachable
 * from* a page, not that the URL is a page. It exists to surface routes that
 * neither REST nor the sitemap mention — an unlisted landing page or a form
 * thank-you URL is exactly the thing a route manifest must not miss, and exactly
 * the thing a union of the two "official" sources can still miss.
 *
 * Fragments, `mailto:`, `tel:` and off-host links are dropped. Query strings are
 * kept (they can be distinct routes) but tracked separately by the caller.
 *
 * `pagePath` matters: a bare `href="apply"` on `/tmh/` means `/tmh/apply`, so
 * relative hrefs must resolve against the page, never against the site root.
 */
export function extractInternalLinks(
  html: string,
  baseUrl: string,
  pagePath: string = "/",
): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }

  let pageBase: URL;
  try {
    pageBase = new URL(pagePath, base);
  } catch {
    pageBase = base;
  }

  const found = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const href = raw.trim();
    if (href.length === 0 || href.startsWith("#")) continue;
    if (/^(?:mailto|tel|javascript|data):/i.test(href)) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, pageBase);
    } catch {
      continue;
    }
    if (resolved.host !== base.host) continue;
    if (!/^https?:$/.test(resolved.protocol)) continue;

    const path = resolved.pathname;
    // Machine endpoints are not routes: feeds, REST, XML-RPC, asset files.
    if (/^\/(?:wp-json|wp-admin|wp-login\.php|xmlrpc\.php|feed|comments\/feed)/.test(path))
      continue;
    if (
      /\.(?:xml|json|txt|css|js|png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|woff2?|ttf|mp4)$/i.test(
        path,
      )
    )
      continue;

    const suffix = resolved.search.length > 0 ? resolved.search : "";
    found.add(`${path}${suffix}`);
  }
  return [...found].sort();
}

/** Human-readable notes for a disallowed fetch, so a skip is never mistaken for a 404. */
export function describeSkipped(path: string, rules: RobotsRules): string {
  const listing = [
    ...rules.allow.map((p) => `Allow: ${p}`),
    ...rules.disallow.map((p) => `Disallow: ${p}`),
  ];
  return `skipped ${path} — robots.txt forbids it (${listing.join(", ") || "rule set empty"})`;
}
