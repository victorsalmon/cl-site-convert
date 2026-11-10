/**
 * Route enumeration: the first thing the pipeline does, and the only thing that
 * decides *what the site is*.
 *
 * Three sources are unioned, in decreasing order of trust:
 *
 *  1. **WordPress REST** — `/wp-json/wp/v2/pages`, `/posts`, taxonomies. Knows
 *     status, parent, template, modified. Authoritative where it speaks.
 *  2. **Sitemaps** — `/sitemap.xml` -> `/sitemap_index.xml` -> `/wp-sitemap.xml`,
 *     following index children. The crawl contract, nothing more.
 *  3. **Link harvest** — internal `<a href>` targets seen while probing pages.
 *     Weakest, but it is the only source that can find a route the site forgot to
 *     advertise anywhere machine-readable. Reported as a *finding*, never promoted
 *     into `routes[]`: a link is not a page.
 *
 * The output is `capture/routes.manifest.json` plus a reconciliation report. The
 * report is the point: REST count vs sitemap count vs union, with the URLs that
 * appear in one source only named explicitly. Divergence is a finding about the
 * site, and folding it away would be dishonest.
 *
 * Failure is never empty-and-quiet. If REST is unreachable the manifest records
 * *why*, still emits whatever the sitemap gave, and the CLI exits non-zero. An
 * empty manifest with exit 0 would look like a site with no pages.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { PoliteFetcher, isPathAllowed, USER_AGENT, DEFAULT_MIN_INTERVAL_MS } from "./http.js";
import type { RobotsRules } from "./http.js";
import {
  describeSkipped,
  detectWpVersion,
  extractInternalLinks,
  mergeSources,
  normaliseRestItem,
  parsePaginationHeaders,
  parseRestCollection,
  parseRestRoot,
  parseSitemap,
  pathFromUrl,
  pluginNamespaces,
  routeKey,
} from "./parse.js";
import type {
  Reconciliation,
  RestRootInfo,
  RouteRecord,
  RouteSource,
  RouteType,
  SitemapDocument,
} from "./parse.js";

/** Manifest schema version. Bump only for a breaking change to the shape. */
export const ROUTE_MANIFEST_VERSION = "1";

/** Sitemap entry points, in the order a WP site is likely to answer them. */
export const SITEMAP_CANDIDATES = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/wp-sitemap.xml",
] as const;

/**
 * REST bases that are not site routes.
 *
 * These are WordPress/builder machinery: media attachments, menus, template parts,
 * global styles, fonts. They are enumerable over REST but they are not pages, and
 * treating them as routes would inflate a manifest with routes no visitor can
 * reach. Anything *not* in this list (a custom post type such as `project`) is
 * treated as real content and enumerated — a hardcoded pages+posts list silently
 * misses every CPT a site defines, which is exactly the kind of gap that only
 * shows up after cutover.
 */
const NON_ROUTE_REST_BASES = new Set([
  "media",
  "menu-items",
  "blocks",
  "templates",
  "template-parts",
  "global-styles",
  "navigation",
  "font-families",
  "font-faces",
]);

/** Hard caps so a hostile or broken site cannot make the capture run forever. */
const MAX_COLLECTION_PAGES = 50;
const MAX_SITEMAP_CHILDREN = 40;
const MAX_SITEMAP_DEPTH = 2;
/** Cap on unlisted-link probes, so a link-farm page cannot balloon the run. */
const MAX_LINK_PROBES = 60;

export interface RouteHttpCheck {
  /** HTTP status of a GET to the route. */
  status: number;
  /** `Location` when the route redirects. */
  location: string | null;
  /** Content type, which tells a real page from a machine endpoint. */
  contentType: string | null;
}

/** A manifest route: the pure record plus the evidence we got by asking for it. */
export interface ManifestRoute extends RouteRecord {
  http?: RouteHttpCheck;
}

export interface RestSummary {
  available: boolean;
  /** HTTP status of `/wp-json/`, null when never requested. */
  rootStatus: number | null;
  siteName: string | null;
  description: string | null;
  namespaces: string[];
  /** Non-core namespaces: plugins announcing themselves publicly. */
  pluginNamespaces: string[];
  leaksPluginList: boolean;
  wpVersion: string | null;
  wpVersionSource: "generator-meta" | "unknown";
  showOnFront: string | null;
  pageOnFront: number | null;
  /** Status of `/wp-json/wp/v2/plugins` — 401 is the healthy answer. */
  pluginsEndpointStatus: number | null;
  /** `/wp-json/wp/v2/users` answered without auth: author enumeration is open. */
  usersEndpointOpen: boolean;
  userCount: number | null;
  collections: { name: string; total: number | null; fetched: number; pages: number }[];
  /** Why REST is unavailable, or why a collection was short. Never silent. */
  reasons: string[];
}

export interface SitemapSummary {
  /** Documents tried, with the status we got. A redirect is recorded, not followed silently. */
  attempts: {
    url: string;
    status: number;
    kind: SitemapDocument["kind"] | "redirect" | "http-error";
  }[];
  /** Documents that contributed URLs. */
  documents: { url: string; urls: number }[];
  /** Sitemap URLs advertised in robots.txt. */
  robotsDeclared: string[];
  urlCount: number;
  reasons: string[];
}

export interface TaxonomySummary {
  categories: {
    count: number | null;
    terms: { slug: string; name: string | null; count: number | null }[];
  };
  tags: {
    count: number | null;
    terms: { slug: string; name: string | null; count: number | null }[];
  };
  /** Post types WP exposes, with their REST base. */
  types: {
    slug: string;
    restBase: string | null;
    restNamespace: string | null;
    hierarchical: boolean | null;
  }[];
}

export interface LinkHarvest {
  pagesScanned: number;
  /** Distinct internal paths seen across those pages. */
  distinctInternalPaths: number;
  /** Internal paths that no route in the manifest covers — the interesting list. */
  notInManifest: string[];
  /** What those unlisted paths actually are when asked. A link is not a page. */
  probes: LinkProbe[];
}

export interface LinkProbe {
  path: string;
  status: number;
  /** Where it goes when it redirects; absolute, possibly off-host. */
  location: string | null;
  /** True when `location` leaves the site (Drive, YouTube, Signal, …). */
  external: boolean;
}

/** A redirect the site actually serves, discovered from a harvested link. */
export interface DiscoveredRedirect {
  from: string;
  to: string;
  code: 301 | 302 | 307 | 308;
}

export interface RouteManifest {
  manifestVersion: typeof ROUTE_MANIFEST_VERSION;
  generatedAt: string;
  baseUrl: string;
  tool: {
    name: string;
    version: string;
    userAgent: string;
    minIntervalMs: number;
    requests: number;
  };
  rest: RestSummary;
  sitemap: SitemapSummary;
  taxonomies: TaxonomySummary;
  reconciliation: Reconciliation;
  counts: {
    total: number;
    byType: Record<RouteType, number>;
    bySource: Record<RouteSource, number>;
    byStatus: Record<string, number>;
  };
  discovery: {
    robots: { status: number | null; unreadable: boolean; disallow: string[]; allow: string[] };
    linkHarvest: LinkHarvest;
    /** Redirects proven by asking for a harvested path. Feeds the SEO bead (B1.6). */
    redirects: DiscoveredRedirect[];
    /** Paths we were forbidden to ask about. Empty is the normal answer. */
    skipped: string[];
  };
  routes: ManifestRoute[];
  notes: string[];
}

export interface EnumerateOptions {
  baseUrl: string;
  /** Gap between requests. Never lowered below the polite floor by the CLI. */
  minIntervalMs?: number;
  /** Per-collection page size. 100 is the WP maximum. */
  perPage?: number;
  /** Ask each route for its HTTP status (and reuse the body for link harvest). */
  probe?: boolean;
  /** Harvest internal links from probed page bodies. Requires `probe`. */
  harvestLinks?: boolean;
  onProgress?: (line: string) => void;
}

export interface EnumerateResult {
  manifest: RouteManifest;
  /** Non-empty when the capture is incomplete. The CLI turns this into exit 1. */
  failures: string[];
}

function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/**
 * Which REST collections to walk for routes.
 *
 * Pages and posts are always included (a site can restrict `/types`, and its
 * primary content still exists). Every other plain `wp/v2` base that is not
 * builder machinery is added: a custom post type nobody enumerated is a route
 * nobody converts.
 */
export function routableCollections(
  types: readonly { restBase: string | null; restNamespace: string | null }[],
): string[] {
  const names = ["pages", "posts"];
  for (const type of types) {
    const base = type.restBase;
    if (base === null || base.length === 0) continue;
    if (type.restNamespace !== null && type.restNamespace !== "wp/v2") continue;
    // A templated REST base (`font-families/(?P<id>\d+)/font-faces`) is not a
    // collection; only plain tokens are listable.
    if (!/^[a-z0-9_-]+$/i.test(base)) continue;
    if (NON_ROUTE_REST_BASES.has(base)) continue;
    if (!names.includes(base)) names.push(base);
  }
  return names;
}

/** Fetch one REST collection, following `X-WP-TotalPages`. */
async function fetchCollection(
  fetcher: PoliteFetcher,
  rules: RobotsRules,
  collection: string,
  perPage: number,
  fields: string,
  onProgress: (line: string) => void,
): Promise<{
  items: unknown[];
  total: number | null;
  pages: number;
  reasons: string[];
  skipped: string[];
}> {
  const items: unknown[] = [];
  const reasons: string[] = [];
  const skipped: string[] = [];
  let total: number | null = null;
  let pages = 0;

  for (let page = 1; page <= MAX_COLLECTION_PAGES; page += 1) {
    const path = `/wp-json/wp/v2/${collection}?per_page=${perPage}&page=${page}&_fields=${fields}`;
    if (!isPathAllowed(path, rules)) {
      skipped.push(describeSkipped(path, rules));
      break;
    }

    const response = await fetcher.fetch(path);
    if (response.status !== 200) {
      const body = response.body.slice(0, 200).replace(/\s+/g, " ");
      reasons.push(
        `/wp-json/wp/v2/${collection} page ${page} returned ${response.status}` +
          `${response.error === null ? "" : ` (${response.error})`}` +
          `${body.length > 0 ? `: ${body}` : ""}`,
      );
      break;
    }

    const collection$ = parseRestCollection(response.body, response.status);
    if (collection$.error !== null) {
      reasons.push(`/wp-json/wp/v2/${collection} page ${page} unparseable: ${collection$.error}`);
      break;
    }

    const pagination = parsePaginationHeaders(response.headers);
    total = pagination.total ?? total;
    pages = page;
    items.push(...collection$.items);
    onProgress(
      `  ${collection} page ${page}: ${collection$.items.length} items` +
        `${pagination.total === null ? "" : ` (total ${pagination.total})`}`,
    );

    const totalPages = pagination.totalPages ?? 1;
    if (page >= totalPages || collection$.items.length === 0) break;
  }

  return { items, total, pages, reasons, skipped };
}

/** Fetch a small unpaginated REST collection (taxonomies, types). */
async function fetchTiny(
  fetcher: PoliteFetcher,
  rules: RobotsRules,
  path: string,
): Promise<unknown[] | null> {
  if (!isPathAllowed(path, rules)) return null;
  const response = await fetcher.fetch(path);
  if (response.status !== 200) return null;
  try {
    const parsed: unknown = JSON.parse(response.body);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === "object" && parsed !== null) {
      return Object.entries(parsed as Record<string, unknown>).map(([slug, value]) => ({
        __slug: slug,
        ...(typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}),
      }));
    }
    return null;
  } catch {
    return null;
  }
}

function termsFrom(items: unknown[] | null): TaxonomySummary["categories"] {
  const terms = (items ?? []).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as Record<string, unknown>;
    const slug = typeof record["slug"] === "string" ? record["slug"] : null;
    if (slug === null) return [];
    return [
      {
        slug,
        name: typeof record["name"] === "string" ? record["name"] : null,
        count: typeof record["count"] === "number" ? record["count"] : null,
      },
    ];
  });
  return { count: terms.length, terms };
}

/**
 * Discover and read sitemaps.
 *
 * Index children are followed one level down (`MAX_SITEMAP_DEPTH`), with a cycle
 * guard. Every attempt is recorded with its status — including the 301 that
 * `/sitemap.xml` usually is, because "the candidate redirected here" is the fact
 * that makes the discovery path reproducible.
 */
async function readSitemaps(
  fetcher: PoliteFetcher,
  rules: RobotsRules,
  onProgress: (line: string) => void,
): Promise<{ summary: SitemapSummary; entries: { loc: string; lastmod: string | null }[] }> {
  const attempts: SitemapSummary["attempts"] = [];
  const documents: SitemapSummary["documents"] = [];
  const reasons: string[] = [];
  const entries: { loc: string; lastmod: string | null }[] = [];
  const seen = new Set<string>();

  const candidates = [
    ...new Set([...rules.sitemaps, ...SITEMAP_CANDIDATES.map((c) => fetcher.absolute(c))]),
  ];

  const readOne = async (url: string, depth: number): Promise<void> => {
    const path = fetcher.pathOf(url);
    if (seen.has(routeKey(path))) return;
    seen.add(routeKey(path));

    if (!isPathAllowed(path, rules)) {
      attempts.push({ url, status: 0, kind: "http-error" });
      reasons.push(describeSkipped(path, rules));
      return;
    }

    const response = await fetcher.fetch(path);
    if (response.status >= 300 && response.status < 400) {
      attempts.push({ url, status: response.status, kind: "redirect" });
      onProgress(`  ${path} -> ${response.status} ${response.location ?? ""}`.trimEnd());
      if (response.location !== null && depth < MAX_SITEMAP_DEPTH)
        await readOne(response.location, depth + 1);
      return;
    }
    if (response.status !== 200) {
      attempts.push({ url, status: response.status, kind: "http-error" });
      onProgress(`  ${path} -> ${response.status}`);
      return;
    }

    const document = parseSitemap(response.body);
    attempts.push({ url, status: response.status, kind: document.kind });

    if (document.kind === "urlset") {
      entries.push(...document.entries);
      documents.push({ url, urls: document.entries.length });
      onProgress(`  ${path}: urlset with ${document.entries.length} urls`);
      return;
    }
    if (document.kind === "index") {
      onProgress(`  ${path}: index with ${document.children.length} children`);
      if (depth >= MAX_SITEMAP_DEPTH) {
        reasons.push(
          `${path}: sitemap index nested deeper than ${MAX_SITEMAP_DEPTH}; children not followed`,
        );
        return;
      }
      for (const child of document.children.slice(0, MAX_SITEMAP_CHILDREN)) {
        await readOne(child, depth + 1);
      }
      return;
    }

    reasons.push(`${path}: not a sitemap (no <urlset> or <sitemapindex>)`);
  };

  for (const candidate of candidates) {
    await readOne(candidate, 0);
  }

  const unique = new Map<string, { loc: string; lastmod: string | null }>();
  for (const entry of entries) {
    const key = routeKey(pathFromUrl(entry.loc, fetcher.baseUrl));
    const existing = unique.get(key);
    if (existing === undefined || (existing.lastmod === null && entry.lastmod !== null)) {
      unique.set(key, entry);
    }
  }

  if (unique.size === 0 && reasons.length === 0) {
    reasons.push("no sitemap candidate answered 200 with a <urlset>");
  }

  return {
    summary: {
      attempts,
      documents,
      robotsDeclared: rules.sitemaps,
      urlCount: unique.size,
      reasons,
    },
    entries: [...unique.values()],
  };
}

/**
 * Enumerate every route the site will admit to.
 *
 * Sequential throughout: the fetcher enforces the gap, and this function never
 * races it. One capture run against `upscalehavens.ca` is roughly 25 requests.
 */
export async function enumerateRoutes(options: EnumerateOptions): Promise<EnumerateResult> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const perPage = options.perPage ?? 100;
  const probe = options.probe ?? true;
  const harvestLinks = options.harvestLinks ?? probe;
  const onProgress = options.onProgress ?? ((): void => {});
  const failures: string[] = [];
  const notes: string[] = [];
  const skipped: string[] = [];

  const fetcher = new PoliteFetcher({
    baseUrl,
    minIntervalMs: Math.max(
      DEFAULT_MIN_INTERVAL_MS,
      options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    ),
    onRequest: (line) => onProgress(line),
  });

  // ---- robots.txt first: it decides what we are allowed to ask --------------
  onProgress("robots.txt");
  const rules = await fetcher.readRobots();
  if (rules.unreadable) {
    notes.push(
      `robots.txt unreadable (status ${rules.status ?? "no response"}); proceeding as permitted`,
    );
  } else {
    onProgress(
      `robots.txt: ${rules.disallow.length} disallow, ${rules.allow.length} allow, ${rules.sitemaps.length} sitemap(s)`,
    );
  }

  // ---- REST ----------------------------------------------------------------
  const restReasons: string[] = [];
  let restRoot: RestRootInfo | null = null;
  let rootStatus: number | null = null;

  onProgress("REST root /wp-json/");
  if (!isPathAllowed("/wp-json/", rules)) {
    skipped.push(describeSkipped("/wp-json/", rules));
    restReasons.push("robots.txt disallows /wp-json/; REST enumeration skipped");
  } else {
    const response = await fetcher.fetch("/wp-json/");
    rootStatus = response.status === 0 ? null : response.status;
    if (response.status !== 200) {
      restReasons.push(
        `/wp-json/ returned ${response.status}` +
          `${response.error === null ? "" : ` (${response.error})`}` +
          `${response.body.length > 0 ? `: ${response.body.slice(0, 200).replace(/\s+/g, " ")}` : ""}`,
      );
    } else {
      try {
        restRoot = parseRestRoot(response.body);
      } catch (error) {
        restReasons.push(
          `/wp-json/ unparseable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // ---- post types drive the collection list -------------------------------
  // Read `/types` first: the set of routable collections is a property of the
  // site, not something this tool may assume. Pages and posts are always included
  // so a site whose `/types` is restricted still enumerates its primary content.
  const types = restRoot === null ? null : await fetchTiny(fetcher, rules, "/wp-json/wp/v2/types");

  const taxonomies: TaxonomySummary = {
    categories: { count: 0, terms: [] },
    tags: { count: 0, terms: [] },
    types: (types ?? []).flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      const slug = typeof record["__slug"] === "string" ? record["__slug"] : null;
      if (slug === null) return [];
      return [
        {
          slug,
          restBase: typeof record["rest_base"] === "string" ? record["rest_base"] : null,
          restNamespace:
            typeof record["rest_namespace"] === "string" ? record["rest_namespace"] : null,
          hierarchical: typeof record["hierarchical"] === "boolean" ? record["hierarchical"] : null,
        },
      ];
    }),
  };

  const collectionNames = routableCollections(taxonomies.types);

  const fields = "id,slug,link,status,type,parent,modified,template,date";
  const restRoutes: RouteRecord[] = [];
  const collections: RestSummary["collections"] = [];

  if (restRoot !== null) {
    onProgress(`REST collections: ${collectionNames.join(", ")}`);
    for (const collection of collectionNames) {
      const result = await fetchCollection(fetcher, rules, collection, perPage, fields, onProgress);
      restReasons.push(...result.reasons);
      skipped.push(...result.skipped);
      collections.push({
        name: collection,
        total: result.total,
        fetched: result.items.length,
        pages: result.pages,
      });
      if (result.total !== null && result.total !== result.items.length) {
        restReasons.push(
          `/wp-json/wp/v2/${collection}: X-WP-Total said ${result.total} but ${result.items.length} items were fetched`,
        );
      }

      // Parent paths need the whole set first, so resolve in a second pass.
      const parentPaths = new Map<number, string>();
      for (const item of result.items) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        const id = record["id"];
        const link = record["link"];
        if (typeof id === "number" && typeof link === "string") {
          parentPaths.set(id, pathFromUrl(link, baseUrl));
        }
      }
      for (const item of result.items) {
        const route = normaliseRestItem(item, { baseUrl, parentPaths });
        if (route === null) {
          restReasons.push(
            `/wp-json/wp/v2/${collection}: an item lacked link/type/slug/status and was dropped`,
          );
          continue;
        }
        restRoutes.push(route);
      }
    }
  } else {
    failures.push(`REST unavailable: ${restReasons.join("; ")}`);
  }

  // ---- taxonomies (context, not routes) ------------------------------------
  const categories =
    restRoot === null
      ? null
      : await fetchTiny(fetcher, rules, "/wp-json/wp/v2/categories?per_page=100");
  const tags =
    restRoot === null ? null : await fetchTiny(fetcher, rules, "/wp-json/wp/v2/tags?per_page=100");
  taxonomies.categories = termsFrom(categories);
  taxonomies.tags = termsFrom(tags);

  // Term archives are only routes when a term actually has content. A category
  // with `count: 0` has no archive worth capturing, so it is recorded as
  // taxonomy context and deliberately not promoted to a route.
  for (const term of taxonomies.categories.terms) {
    if ((term.count ?? 0) > 0) {
      notes.push(
        `category "${term.slug}" has posts; its archive is a route but not enumerated in v1`,
      );
    }
  }

  // ---- price of a plugin list leak -----------------------------------------
  let pluginsEndpointStatus: number | null = null;
  let usersEndpointOpen = false;
  let userCount: number | null = null;
  if (restRoot !== null) {
    const plugins = await fetcher.fetch("/wp-json/wp/v2/plugins");
    pluginsEndpointStatus = plugins.status === 0 ? null : plugins.status;
    const users = await fetcher.fetch("/wp-json/wp/v2/users?per_page=1");
    if (users.status === 200) {
      usersEndpointOpen = true;
      userCount = parsePaginationHeaders(users.headers).total;
    }
  }

  // ---- sitemaps ------------------------------------------------------------
  onProgress("sitemaps");
  const { summary: sitemapSummary, entries: sitemapEntries } = await readSitemaps(
    fetcher,
    rules,
    onProgress,
  );
  if (sitemapEntries.length === 0) {
    failures.push(
      `sitemap produced no URLs: ${sitemapSummary.reasons.join("; ") || "no sitemap answered"}`,
    );
  }

  // ---- union ---------------------------------------------------------------
  const merged = mergeSources(restRoutes, sitemapEntries, baseUrl);

  // ---- probe + link harvest ------------------------------------------------
  let harvestPages = 0;
  const internalPaths = new Set<string>();
  const routes: ManifestRoute[] = [];

  for (const route of merged.routes) {
    if (!probe) {
      routes.push(route);
      continue;
    }
    const path = fetcher.pathOf(route.url);
    if (!isPathAllowed(path, rules)) {
      skipped.push(describeSkipped(path, rules));
      routes.push(route);
      continue;
    }

    const response = await fetcher.fetch(path);
    const check: RouteHttpCheck = {
      status: response.status,
      location: response.location,
      contentType: response.headers["content-type"] ?? null,
    };
    routes.push({ ...route, http: check });

    if (
      response.status === 200 &&
      (check.contentType ?? "").includes("text/html") &&
      harvestLinks
    ) {
      harvestPages += 1;
      for (const link of extractInternalLinks(response.body, baseUrl, route.path)) {
        internalPaths.add(link);
      }
    }
    if (response.status >= 400) {
      notes.push(`${path} answered ${response.status}: listed by ${route.source} but not served`);
    }
    if (response.status >= 300 && response.status < 400) {
      notes.push(
        `${path} redirects to ${response.location ?? "(no location)"} (listed by ${route.source})`,
      );
    }
  }

  const knownKeys = new Set(merged.routes.map((route) => routeKey(route.path)));
  const notInManifest = [...internalPaths]
    .filter((path) => path.includes("?") || !knownKeys.has(routeKey(path)))
    .sort();

  // ---- what are those unlisted links, really? ------------------------------
  // A link to a path proves nothing about the path. Asking does: usually it is a
  // redirect the site serves (and then it belongs in the redirect map), sometimes
  // it is a 404 (a broken link in the content), occasionally a real page nobody
  // listed. All three are findings worth carrying forward.
  const probes: LinkProbe[] = [];
  const redirects: DiscoveredRedirect[] = [];
  if (probe) {
    for (const path of notInManifest.slice(0, MAX_LINK_PROBES)) {
      if (path.includes("?")) continue;
      if (!isPathAllowed(path, rules)) {
        skipped.push(describeSkipped(path, rules));
        continue;
      }
      const response = await fetcher.fetch(path, { method: "HEAD" });
      const location = response.location;
      const external = location !== null && !location.startsWith(baseUrl);
      probes.push({ path, status: response.status, location, external });

      if (response.status >= 300 && response.status < 400 && location !== null) {
        const code = response.status as DiscoveredRedirect["code"];
        redirects.push({ from: path, to: location, code });
        notes.push(`redirect ${path} -> ${code === 301 ? "301" : String(code)} ${location}`);
      } else if (response.status === 404) {
        notes.push(`broken link: ${path} 404s (linked from the site, in no source)`);
      } else if (response.status === 200) {
        notes.push(
          `unlisted page: ${path} answers 200 but appears in neither REST nor the sitemap`,
        );
      }
    }
    if (notInManifest.length > MAX_LINK_PROBES) {
      notes.push(
        `link harvest found ${notInManifest.length} unlisted paths; only the first ${MAX_LINK_PROBES} were probed`,
      );
    }
  }

  // ---- assemble ------------------------------------------------------------
  const namespaces = restRoot?.namespaces ?? [];
  const pluginNs = pluginNamespaces(namespaces);

  const manifest: RouteManifest = {
    manifestVersion: ROUTE_MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    baseUrl,
    tool: {
      name: "cl-site-convert",
      version: "0.1.0",
      userAgent: USER_AGENT,
      minIntervalMs: fetcher.minIntervalMs,
      requests: fetcher.requestCount,
    },
    rest: {
      available: restRoot !== null,
      rootStatus,
      siteName: restRoot?.name ?? null,
      description: restRoot?.description ?? null,
      namespaces,
      pluginNamespaces: pluginNs,
      leaksPluginList: pluginNs.length > 0,
      wpVersion: null,
      wpVersionSource: "unknown",
      showOnFront: restRoot?.showOnFront ?? null,
      pageOnFront: restRoot?.pageOnFront ?? null,
      pluginsEndpointStatus,
      usersEndpointOpen,
      userCount,
      collections,
      reasons: restReasons,
    },
    sitemap: sitemapSummary,
    taxonomies,
    reconciliation: merged.reconciliation,
    counts: {
      total: routes.length,
      byType: countBy(routes.map((route) => route.type)),
      bySource: countBy(routes.map((route) => route.source)),
      byStatus: countBy(routes.map((route) => route.status)),
    },
    discovery: {
      robots: {
        status: rules.status,
        unreadable: rules.unreadable,
        disallow: rules.disallow,
        allow: rules.allow,
      },
      linkHarvest: {
        pagesScanned: harvestPages,
        distinctInternalPaths: internalPaths.size,
        notInManifest,
        probes,
      },
      redirects,
      skipped,
    },
    routes,
    notes,
  };

  // Missing types would make `byType` silently partial.
  for (const type of ["page", "post", "other"] as const) manifest.counts.byType[type] ??= 0;
  for (const source of ["wp-rest", "sitemap", "both"] as const)
    manifest.counts.bySource[source] ??= 0;

  return { manifest, failures };
}

/** WP version is only visible in rendered HTML, so it is detected separately. */
export async function detectWpVersionFor(
  baseUrl: string,
  onProgress?: (line: string) => void,
): Promise<string | null> {
  const fetcher = new PoliteFetcher({
    baseUrl,
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    onRequest: (line) => onProgress?.(line),
  });
  const response = await fetcher.fetch("/");
  if (response.status !== 200) return null;
  return detectWpVersion(response.body);
}

/** Render the reconciliation report. Console output is part of the deliverable. */
export function formatReconciliation(manifest: RouteManifest): string {
  const { reconciliation } = manifest;
  const lines: string[] = [];
  lines.push(`Route manifest — ${manifest.baseUrl} (generated ${manifest.generatedAt})`);
  lines.push("");
  lines.push(`  wp-rest routes : ${reconciliation.wpRest}`);
  lines.push(`  sitemap urls   : ${reconciliation.sitemap}`);
  lines.push(`  union          : ${reconciliation.union}`);
  lines.push(`  in both        : ${reconciliation.both}`);
  lines.push(`  rest only      : ${reconciliation.restOnly.length}`);
  lines.push(`  sitemap only   : ${reconciliation.sitemapOnly.length}`);
  lines.push("");
  lines.push(`  by type   : ${JSON.stringify(manifest.counts.byType)}`);
  lines.push(`  by source : ${JSON.stringify(manifest.counts.bySource)}`);
  lines.push(`  by status : ${JSON.stringify(manifest.counts.byStatus)}`);
  lines.push("");
  lines.push(
    `  REST open      : ${manifest.rest.available ? "yes" : "no"} (root ${manifest.rest.rootStatus ?? "-"})`,
  );
  lines.push(`  WP version     : ${manifest.rest.wpVersion ?? "unknown"}`);
  lines.push(`  plugin namespaces: ${manifest.rest.pluginNamespaces.join(", ") || "(none)"}`);
  lines.push(
    `  users endpoint : ${manifest.rest.usersEndpointOpen ? `open (${manifest.rest.userCount ?? "?"} users)` : "closed"}`,
  );
  lines.push(
    `  link harvest   : ${manifest.discovery.linkHarvest.pagesScanned} pages, ${manifest.discovery.linkHarvest.distinctInternalPaths} internal paths, ${manifest.discovery.linkHarvest.notInManifest.length} not in manifest`,
  );
  lines.push(
    `  http errors    : ${manifest.routes.filter((route) => (route.http?.status ?? 200) >= 400).length}`,
  );
  lines.push(`  redirects      : ${manifest.discovery.redirects.length} (from harvested links)`);

  const section = (title: string, urls: readonly string[]): void => {
    lines.push("");
    lines.push(`  ${title} (${urls.length}):`);
    if (urls.length === 0) lines.push("    (none — the two sources agree)");
    for (const url of urls) lines.push(`    ${url}`);
  };
  section("rest only", reconciliation.restOnly);
  section("sitemap only", reconciliation.sitemapOnly);
  section("linked but not in manifest", manifest.discovery.linkHarvest.notInManifest);

  if (manifest.discovery.redirects.length > 0) {
    lines.push("");
    lines.push(`  redirect map from unlisted links (${manifest.discovery.redirects.length}):`);
    for (const redirect of manifest.discovery.redirects) {
      lines.push(`    ${redirect.code} ${redirect.from} -> ${redirect.to}`);
    }
  }

  const broken = manifest.discovery.linkHarvest.probes.filter((probe) => probe.status === 404);
  if (broken.length > 0) {
    lines.push("");
    lines.push(`  broken links (${broken.length}):`);
    for (const probe of broken) lines.push(`    404 ${probe.path}`);
  }

  const redirectsInRoutes = manifest.routes.filter((route) => {
    const status = route.http?.status ?? 0;
    return status >= 300 && status < 400;
  });
  if (redirectsInRoutes.length > 0) {
    lines.push("");
    lines.push(`  manifest routes that redirect (${redirectsInRoutes.length}):`);
    for (const route of redirectsInRoutes) {
      lines.push(`    ${route.http?.status} ${route.path} -> ${route.http?.location ?? "?"}`);
    }
  }

  return lines.join("\n");
}

// ---- CLI ------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://upscalehavens.ca";
const DEFAULT_OUT = "capture/routes.manifest.json";

interface CliArgs {
  baseUrl: string;
  out: string;
  probe: boolean;
  harvestLinks: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs | null {
  const args: CliArgs = {
    baseUrl: DEFAULT_BASE_URL,
    out: DEFAULT_OUT,
    probe: true,
    harvestLinks: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") {
      const value = argv[i + 1];
      if (value === undefined) return null;
      args.baseUrl = value;
      i += 1;
    } else if (arg === "--out") {
      const value = argv[i + 1];
      if (value === undefined) return null;
      args.out = value;
      i += 1;
    } else if (arg === "--no-probe") {
      args.probe = false;
      args.harvestLinks = false;
    } else if (arg === "--no-harvest-links") {
      args.harvestLinks = false;
    } else if (arg === "--help" || arg === "-h") {
      return null;
    } else {
      return null;
    }
  }
  return args;
}

const USAGE = [
  "Usage: node dist/source/wp-rest/routes.js [options]",
  "",
  "Enumerate every route the target WordPress site admits to and write",
  `${DEFAULT_OUT}.`,
  "",
  "Options:",
  `  --base-url <url>      target site (default ${DEFAULT_BASE_URL})`,
  `  --out <path>          manifest path (default ${DEFAULT_OUT})`,
  "  --no-probe            do not request each route (manifest only, no HTTP status)",
  "  --no-harvest-links    skip the internal-link harvest (implies probe still runs)",
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

  const { manifest, failures } = await enumerateRoutes({
    baseUrl: args.baseUrl,
    probe: args.probe,
    harvestLinks: args.harvestLinks,
    onProgress: progress,
  });

  const version = await detectWpVersionFor(args.baseUrl, progress);
  manifest.rest.wpVersion = version;
  manifest.rest.wpVersionSource = version === null ? "unknown" : "generator-meta";

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  process.stdout.write(`${formatReconciliation(manifest)}\n`);
  process.stdout.write(`\nwrote ${args.out}\n`);

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
