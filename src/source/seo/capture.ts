/**
 * The SEO + redirect capture: the pass that turns a completed site capture into the
 * "same site" guarantees the emitter and the parity gate are held to.
 *
 * Division of labour, deliberately strict:
 *
 *  - **The captured DOM is the SEO authority.** `capture/site-ir.json` already holds
 *    every page's `<head>`, so the surface is re-derived offline from bytes we
 *    recorded. Re-crawling for a `<title>` would introduce a second, incompatible
 *    baseline of the same page.
 *  - **Live requests are used only for facts a capture cannot contain**: where a 301
 *    currently points, whether a redirect target still resolves, what `robots.txt`
 *    and the sitemap say today, and what `/?s=` does. Each is read-only and polite.
 *  - **The `Redirection` plugin's own store is not read.** Its data lives behind an
 *    admin surface and its export is a mutating-adjacent request; the proven 301s in
 *    the route manifest are the same facts obtained the way a client obtains them.
 *
 * Output is a **sidecar** (`capture/seo-and-redirects.json`), never an edit of the
 * IR. Another lane owns `capture/site-ir.json`, and folding this into `pages[].seo`
 * is a later bead's job — writing both would be two writers on one file.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_MIN_INTERVAL_MS, PoliteFetcher, USER_AGENT } from "../wp-rest/http.js";
import { pathFromUrl } from "../wp-rest/parse.js";
import { reconcileBrokenReferences, scanReferences } from "./links.js";
import type { BrokenReference, RawReference, RecordedStatus } from "./links.js";
import {
  analyseChain,
  buildRedirectMap,
  isExternal,
  sitePathOf,
  toCloudflareRedirects,
} from "./redirects.js";
import type { RedirectArrival, RedirectEntry, VerifiedRedirect } from "./redirects.js";
import {
  buildRobotsContract,
  buildSitemapCapture,
  buildSitemapContract,
  parseRobotsDirectives,
} from "./sitemap.js";
import type { RobotsCapture, SitemapCapture } from "./sitemap.js";
import { extractSeoSurface, summariseSeo } from "./surface.js";
import type { SeoField, SeoSurface } from "./surface.js";
import { buildUrlContract } from "./url-contract.js";
import type { UrlContract, UrlShapeProbe } from "./url-contract.js";

export const DEFAULT_MANIFEST_PATH = "capture/routes.manifest.json";
export const DEFAULT_IR_PATH = "capture/site-ir.json";
export const DEFAULT_ASSETS_REPORT_PATH = "capture/assets.capture-report.json";
export const DEFAULT_OUT_PATH = "capture/seo-and-redirects.json";

/** The sitemap path WordPress exposes and robots.txt advertises on this install. */
export const SITEMAP_PATH = "/wp-sitemap.xml";
/** WordPress's sitemap stylesheet, referenced from `xml-stylesheet` in every document. */
export const SITEMAP_XSL_PATH = "/wp-sitemap.xsl";

/** One page as this pass reports it. */
export interface PageSeoRecord {
  url: string;
  /** HTTP status the route manifest recorded for this route. */
  httpStatus: number | null;
  /** True when the captured canonical names this route (path + query). */
  canonicalMatchesRoute: boolean;
  surface: SeoSurface;
}

/** One `/?s=` probe result. */
export interface SearchProbe {
  url: string;
  status: number;
  contentType: string | null;
  documentTitle: string | null;
  canonical: string | null;
  robots: string | null;
  noResults: boolean;
  /** Occurrences of `post-<id>` class tokens — WordPress emits one per result wrapper. */
  resultMarkers: number;
  bodyClasses: string[];
  bytes: number;
}

export interface SearchCapture {
  /** `/?s=test` — the query the task pins. */
  probe: SearchProbe;
  /** A query that *does* match, proving search is live rather than empty. */
  matchingProbe: SearchProbe;
  /** What the live site does, in one sentence a reader can act on. */
  behaviour: string;
  /** What the static replacement must do instead. */
  newSite: {
    route: string;
    queryParam: string;
    rewrite: string;
    indexSource: string;
    note: string;
  };
}

export interface RedirectSurvey {
  /** Where the map came from. Never the plugin's store — see the module comment. */
  source: string;
  count: number;
  verified: number;
  chains: VerifiedRedirect[];
  loops: VerifiedRedirect[];
  entries: VerifiedRedirect[];
  /** `_redirects` lines for the cf-pages deployable, verified entries only. */
  cloudflareRedirects: string[];
}

/** The obligations the replacement site inherits from the live one. */
export interface NewSiteContract {
  url: {
    htmlPaths: "one file per route" | "route/index.html";
    trailingSlash: string;
    canonicalForm: string;
    notes: string[];
  };
  seo: {
    /** Fields the emitter must emit because the live site emits them. */
    required: SeoField[];
    /** Fields the live site omits — emitting them is a content change, not parity. */
    absentOnLiveSite: SeoField[];
    notes: string[];
  };
  redirects: { file: string; lines: string[] };
  sitemap: { path: string; kind: string; urlCount: number; locs: string[]; mustEmit: string[] };
  robots: {
    path: string;
    body: string;
    rules: { disallow: string[]; allow: string[] };
    mustEmit: string[];
  };
  search: SearchCapture["newSite"];
}

export interface SeoAndRedirectsReport {
  seoVersion: "1";
  generatedAt: string;
  baseUrl: string;
  tool: {
    name: string;
    version: string;
    userAgent: string;
    minIntervalMs: number;
    requests: number;
  };
  provenance: {
    manifest: string;
    siteIr: string;
    assetsReport: string | null;
    /** Where each fact class came from, so no reader has to guess. */
    notes: string[];
  };
  summary: {
    pages: number;
    /** Fields absent on every captured page. */
    seoAbsentSiteWide: SeoField[];
    canonicalMismatches: number;
    redirects: number;
    redirectsVerified: number;
    redirectChains: number;
    redirectLoops: number;
    brokenReferences: number;
    trailingSlashPolicy: string;
    searchStatus: number;
  };
  pages: PageSeoRecord[];
  urlContract: UrlContract;
  redirects: RedirectSurvey;
  sitemap: SitemapCapture;
  robots: RobotsCapture;
  search: SearchCapture;
  brokenReferences: BrokenReference[];
  newSiteContract: NewSiteContract;
  notes: string[];
}

/** Manifest slices this pass consumes. */
interface ManifestRoute {
  url: string;
  path: string;
  http?: { status: number };
}

interface ManifestProbe {
  path: string;
  status: number;
  location: string | null;
}

interface LoadedManifest {
  baseUrl: string;
  routes: ManifestRoute[];
  redirects: RedirectEntry[];
  probes: ManifestProbe[];
  notes: string[];
}

interface LoadedIrPage {
  url: string;
  domHtml: string;
  canonical: string | null;
}

interface LoadedAssetsReport {
  /** `{ ref, where, pages, reason }` for every reference that did not resolve. */
  brokenReferences: { ref: string; where: string; pages: string[] }[];
}

/** Read the route manifest. A malformed manifest is a cannot-evaluate, never an empty survey. */
export async function readManifest(path: string): Promise<LoadedManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${path}: not an object`);
  const record = parsed as Record<string, unknown>;
  const baseUrl = typeof record["baseUrl"] === "string" ? record["baseUrl"] : "";
  const routes = Array.isArray(record["routes"]) ? record["routes"] : [];
  if (baseUrl.length === 0 || routes.length === 0) {
    throw new Error(`${path}: missing baseUrl or routes`);
  }

  const discovery =
    typeof record["discovery"] === "object" && record["discovery"] !== null
      ? (record["discovery"] as Record<string, unknown>)
      : {};
  const rawRedirects = Array.isArray(discovery["redirects"]) ? discovery["redirects"] : [];
  const linkHarvest =
    typeof discovery["linkHarvest"] === "object" && discovery["linkHarvest"] !== null
      ? (discovery["linkHarvest"] as Record<string, unknown>)
      : {};
  const rawProbes = Array.isArray(linkHarvest["probes"]) ? linkHarvest["probes"] : [];

  const redirects: RedirectEntry[] = [];
  for (const entry of rawRedirects) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const from = item["from"];
    const to = item["to"];
    const code = item["code"];
    if (typeof from !== "string" || typeof to !== "string" || typeof code !== "number") continue;
    redirects.push({ from, to, code });
  }

  const probes: ManifestProbe[] = [];
  for (const entry of rawProbes) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const probePath = item["path"];
    const status = item["status"];
    if (typeof probePath !== "string" || typeof status !== "number") continue;
    probes.push({
      path: probePath,
      status,
      location: typeof item["location"] === "string" ? item["location"] : null,
    });
  }

  const notes = Array.isArray(record["notes"])
    ? record["notes"].filter((note): note is string => typeof note === "string")
    : [];

  return {
    baseUrl,
    routes: routes as ManifestRoute[],
    redirects,
    probes,
    notes,
  };
}

/** Read the captured pages' URL, DOM and canonical from the Site IR. Read-only. */
export async function readIrPages(path: string): Promise<LoadedIrPage[]> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${path}: not an object`);
  const pages = (parsed as Record<string, unknown>)["pages"];
  if (!Array.isArray(pages)) throw new Error(`${path}: no pages[]`);

  const loaded: LoadedIrPage[] = [];
  for (const entry of pages) {
    if (typeof entry !== "object" || entry === null) continue;
    const page = entry as Record<string, unknown>;
    const url = page["url"];
    const dom = page["dom"];
    if (typeof url !== "string") continue;
    if (typeof dom !== "object" || dom === null) continue;
    const html = (dom as Record<string, unknown>)["html"];
    if (typeof html !== "string") continue;
    const seo =
      typeof page["seo"] === "object" && page["seo"] !== null
        ? (page["seo"] as Record<string, unknown>)
        : {};
    loaded.push({
      url,
      domHtml: html,
      canonical: typeof seo["canonical"] === "string" ? seo["canonical"] : null,
    });
  }
  if (loaded.length === 0) throw new Error(`${path}: pages[] held no usable page`);
  return loaded;
}

/** Read the asset capture report's broken references, if that pass has run. */
export async function readAssetsReport(path: string): Promise<LoadedAssetsReport | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const raw = (parsed as Record<string, unknown>)["brokenReferences"];
    if (!Array.isArray(raw)) return { brokenReferences: [] };
    const brokenReferences: LoadedAssetsReport["brokenReferences"] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const ref = item["ref"];
      if (typeof ref !== "string") continue;
      brokenReferences.push({
        ref,
        where: typeof item["where"] === "string" ? item["where"] : "unknown",
        pages: Array.isArray(item["pages"])
          ? item["pages"].filter((page): page is string => typeof page === "string")
          : [],
      });
    }
    return { brokenReferences };
  } catch {
    return null;
  }
}

/** Extract the probe facts from a `/?s=` response. Pure apart from being parse-only. */
export function parseSearchProbe(
  url: string,
  status: number,
  contentType: string | null,
  body: string,
): SearchProbe {
  const surface = extractSeoSurface(body);
  // Comments are stripped before the marker scan: Divi ships enough of them that a
  // phrase like "No Results" turns up in a comment on a page that has results, and a
  // heuristic a comment can satisfy is not a measurement.
  const visible = body.replace(/<!--[\s\S]*?-->/g, "");
  const bodyClassMatch = /<body\b[^>]*\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(visible);
  const bodyClasses = (bodyClassMatch?.[1] ?? bodyClassMatch?.[2] ?? "")
    .split(/\s+/)
    .filter((value) => value.length > 0);
  const resultMarkers = [...visible.matchAll(/\bpost-\d+\b/g)].length;
  return {
    url,
    status,
    contentType,
    documentTitle: surface.title,
    canonical: surface.canonical,
    robots: surface.robots,
    noResults: bodyClasses.includes("search-no-results"),
    resultMarkers,
    bodyClasses,
    bytes: body.length,
  };
}

interface CaptureInputs {
  baseUrl: string;
  manifest: LoadedManifest;
  pages: LoadedIrPage[];
  assets: LoadedAssetsReport | null;
  fetcher: PoliteFetcher;
  onProgress: (line: string) => void;
}

/** Fetch robots.txt, the sitemap tree and the search probes. Returns captures + failures. */
async function captureLiveSurfaces(input: CaptureInputs): Promise<{
  robots: RobotsCapture;
  sitemap: SitemapCapture;
  search: SearchCapture;
  failures: string[];
}> {
  const { fetcher, baseUrl, onProgress } = input;
  const failures: string[] = [];

  onProgress(`GET /robots.txt`);
  const robotsResponse = await fetcher.fetch("/robots.txt");
  const directives = parseRobotsDirectives(robotsResponse.body);
  const robots: RobotsCapture = {
    url: "/robots.txt",
    status: robotsResponse.status,
    contentType: robotsResponse.headers["content-type"] ?? null,
    body: robotsResponse.body,
    rules: { disallow: directives.disallow, allow: directives.allow },
    sitemaps: directives.sitemaps,
  };
  if (robotsResponse.status !== 200) {
    failures.push(
      `/robots.txt answered ${robotsResponse.status}; the crawl contract is unreadable`,
    );
  }

  onProgress(`GET ${SITEMAP_PATH}`);
  const sitemapResponse = await fetcher.fetch(SITEMAP_PATH);
  const rootXml = sitemapResponse.body;
  const childUrls = [...rootXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);

  const children: { url: string; status: number; body: string }[] = [];
  for (const childUrl of childUrls) {
    onProgress(`GET ${childUrl}`);
    const response = await fetcher.fetch(childUrl);
    children.push({ url: childUrl, status: response.status, body: response.body });
  }

  const sitemap = buildSitemapCapture({
    rootUrl: SITEMAP_PATH,
    root: { status: sitemapResponse.status, body: rootXml },
    children,
    robotsSitemaps: robots.sitemaps,
    capturedRoutes: input.pages.map((page) => page.url),
    toPath: (url) => pathFromUrl(url, baseUrl),
  });
  if (sitemapResponse.status !== 200) {
    failures.push(`${SITEMAP_PATH} answered ${sitemapResponse.status}; the sitemap is unreadable`);
  }
  if (sitemap.kind === "unknown") {
    failures.push(`${SITEMAP_PATH} was neither a sitemap index nor a urlset`);
  }

  onProgress("GET /?s=test");
  const searchResponse = await fetcher.fetch("/?s=test");
  const probe = parseSearchProbe(
    "/?s=test",
    searchResponse.status,
    searchResponse.headers["content-type"] ?? null,
    searchResponse.body,
  );
  // A probe that always returns "no results" cannot distinguish a live search from a
  // disabled one, so a second, deliberately matching query proves the capability.
  onProgress("GET /?s=room");
  const matchingResponse = await fetcher.fetch("/?s=room");
  const matchingProbe = parseSearchProbe(
    "/?s=room",
    matchingResponse.status,
    matchingResponse.headers["content-type"] ?? null,
    matchingResponse.body,
  );
  if (searchResponse.status !== 200) {
    failures.push(`/?s=test answered ${searchResponse.status}; the search surface is undefined`);
  }

  const robotsNote =
    probe.robots === null
      ? "It carries no robots meta, so every query URL is indexable and unbounded."
      : `It carries <meta name="robots" content="${probe.robots}">, so results pages are already excluded from ` +
        "the index while still passing link equity — reproduce that exact directive, do not invent one.";
  const canonicalNote =
    probe.canonical === null
      ? "It declares no canonical, so the query URL is its own canonical."
      : `It declares canonical ${probe.canonical}.`;

  const search: SearchCapture = {
    probe,
    matchingProbe,
    behaviour:
      `GET /?s=<q> answers ${searchResponse.status} with an HTML search-results page titled ` +
      `"${probe.documentTitle ?? "(no title)"}". ${canonicalNote} ${robotsNote} The matching probe ` +
      `(/?s=room) returned ${matchingProbe.resultMarkers} result marker(s), so search is a live feature ` +
      "returning real results, not a stub.",
    newSite: {
      route: "/search/",
      queryParam: "q",
      rewrite:
        "/?s=<q>  ->  /search/?q=<q>  (302, so the query string survives and the old URL stops being canonical)",
      indexSource: "a build-time index of the 19 captured pages (title, url, body text)",
      note:
        "Search is a real feature (the matching probe returns results), so dropping it is a capability loss, not a " +
        "clean cut. Bead P4.2 (Search plugin) owns the static implementation; until it lands, 302 /?s=* to /search/ " +
        "and have that route answer with a client-side search over the build index. The results page must keep " +
        "`noindex, follow` and no canonical, exactly as the live site does: that is the one place the current site " +
        "already gets duplicate-content handling right, and the parity gate would otherwise protect a regression.",
    },
  };

  return { robots, sitemap, search, failures };
}

/** Probe a URL shape and record the answer. Read-only; never follows. */
async function probeShape(
  fetcher: PoliteFetcher,
  path: string,
  method: "GET" | "HEAD" = "GET",
): Promise<UrlShapeProbe> {
  const response = await fetcher.fetch(path, { method });
  return {
    path,
    status: response.status,
    location: response.location,
    resolves: response.status >= 200 && response.status < 300,
  };
}

/** Verify every redirect: the arrival, then the terminal destination. */
async function captureRedirects(input: CaptureInputs): Promise<{
  survey: RedirectSurvey;
  failures: string[];
}> {
  const { fetcher, baseUrl, manifest, onProgress } = input;
  const failures: string[] = [];
  const map = new Map(manifest.redirects.map((entry) => [entry.from, entry]));
  const arrivals = new Map<string, RedirectArrival>();
  const finalStatuses = new Map<string, number | null>();

  for (const entry of manifest.redirects) {
    onProgress(`GET ${entry.from}`);
    const arrival = await fetcher.fetch(entry.from, { method: "GET" });
    arrivals.set(entry.from, { status: arrival.status, location: arrival.location });

    const analysis = analyseChain(entry, map, baseUrl);
    if (analysis.loop) {
      failures.push(`${entry.from}: redirect loop (${analysis.chain.join(" -> ")})`);
      finalStatuses.set(entry.from, null);
      continue;
    }
    if (analysis.hops > 1) {
      failures.push(
        `${entry.from}: redirect chain of ${analysis.hops} hops (${analysis.chain.join(" -> ")})`,
      );
    }

    const external = isExternal(entry.to, baseUrl);
    const target = external
      ? entry.to
      : (analysis.terminal ?? sitePathOf(entry.to, baseUrl) ?? entry.to);
    onProgress(`HEAD ${target}`);
    const targetResponse = await fetcher.fetch(target, { method: "HEAD" });
    finalStatuses.set(entry.from, targetResponse.status);
    if (targetResponse.status >= 400 || targetResponse.status === 0) {
      failures.push(`${entry.from}: destination ${target} answered ${targetResponse.status}`);
    }
  }

  const redirected = buildRedirectMap({
    baseUrl,
    entries: manifest.redirects,
    arrivals,
    finalStatuses,
  });
  for (const redirect of redirected.redirects) {
    if (redirect.problems.includes("arrival-mismatch")) {
      failures.push(
        `${redirect.from}: live Location does not match the recorded map (expected ${redirect.to}, got ${arrivals.get(redirect.from)?.location ?? "none"})`,
      );
    }
  }

  const survey: RedirectSurvey = {
    source:
      "capture/routes.manifest.json discovery.redirects — 301s proven by requesting each old path. " +
      "The Redirection plugin's own store was NOT read: its data is behind an admin/export surface and reading it would " +
      "mean authenticated or mutating requests against production.",
    count: redirected.count,
    verified: redirected.verified,
    chains: redirected.chains,
    loops: redirected.loops,
    entries: redirected.redirects,
    cloudflareRedirects: toCloudflareRedirects(redirected),
  };
  return { survey, failures };
}

/** Reconcile every captured reference against recorded statuses. Pure. */
export function reconcileReferences(input: {
  pages: readonly LoadedIrPage[];
  baseUrl: string;
  manifestProbes: readonly ManifestProbe[];
  assets: LoadedAssetsReport | null;
}): BrokenReference[] {
  const references: RawReference[] = [];
  for (const page of input.pages) {
    const scan = scanReferences(page.domHtml, page.url, input.baseUrl);
    references.push(...scan.links, ...scan.images);
  }

  const statuses = new Map<string, RecordedStatus>();
  for (const probe of input.manifestProbes) {
    statuses.set(new URL(probe.path, input.baseUrl).toString(), {
      status: probe.status,
      source: "live-probe",
    });
  }
  for (const broken of input.assets?.brokenReferences ?? []) {
    statuses.set(broken.ref, { status: 404, source: "asset-capture" });
  }

  return reconcileBrokenReferences({ references, statuses });
}

/** Assemble the whole sidecar. Pure given the live captures. */
export function buildReport(input: {
  baseUrl: string;
  manifest: LoadedManifest;
  pages: readonly LoadedIrPage[];
  assets: LoadedAssetsReport | null;
  robots: RobotsCapture;
  sitemap: SitemapCapture;
  search: SearchCapture;
  redirects: RedirectSurvey;
  indexProbe: UrlShapeProbe | null;
  aliasProbe: UrlShapeProbe | null;
  requests: number;
  minIntervalMs: number;
  manifestPath: string;
  irPath: string;
  assetsPath: string | null;
  generatedAt?: string;
}): SeoAndRedirectsReport {
  const { baseUrl, manifest, pages } = input;

  const surfaces = pages.map((page) => ({
    url: page.url,
    surface: extractSeoSurface(page.domHtml),
  }));
  const seoSummary = summariseSeo(surfaces);
  const urlContract = buildUrlContract({
    baseUrl,
    pages: pages.map((page) => ({ url: page.url, canonical: page.canonical })),
    indexProbe: input.indexProbe,
    aliasProbe: input.aliasProbe,
  });

  const httpStatusByRoute = new Map<string, number>();
  for (const route of manifest.routes) {
    httpStatusByRoute.set(route.path, route.http?.status ?? 0);
  }
  const mismatchRoutes = new Set(urlContract.canonical.mismatches.map((check) => check.route));

  const pageRecords: PageSeoRecord[] = surfaces.map(({ url, surface }) => ({
    url,
    httpStatus: httpStatusByRoute.get(url) ?? null,
    canonicalMatchesRoute: !mismatchRoutes.has(url),
    surface,
  }));

  const brokenReferences = reconcileReferences({
    pages,
    baseUrl,
    manifestProbes: manifest.probes,
    assets: input.assets,
  });

  const robotsContract = buildRobotsContract(input.robots, input.sitemap, {
    sitemapPath: SITEMAP_PATH,
  });
  const sitemapContract = buildSitemapContract(input.sitemap, {
    sitemapPath: SITEMAP_PATH,
    xslPath: SITEMAP_XSL_PATH,
  });

  const required = (["title", "canonical", "robots"] as const).filter(
    (field) => seoSummary.presentOn[field] > 0,
  );

  const newSiteContract: NewSiteContract = {
    url: {
      htmlPaths: "one file per route",
      trailingSlash: urlContract.trailingSlash.policy,
      canonicalForm:
        "absolute URL on the serving origin, with the same trailing-slash form the route uses",
      notes: [
        `The live site's policy is "${urlContract.trailingSlash.policy}" (${urlContract.trailingSlash.withSlash} with, ${urlContract.trailingSlash.withoutSlash} without).`,
        input.aliasProbe === null
          ? "No slash-less alias was probed."
          : `Slash-less ${input.aliasProbe.path} answers ${input.aliasProbe.status}${input.aliasProbe.location === null ? "" : ` -> ${input.aliasProbe.location}`}; the new host must reproduce that 301, not serve both forms.`,
        input.indexProbe === null
          ? "No /index.html probe was made."
          : `/index.html answers ${input.indexProbe.status}; the emitter must not create it.`,
      ],
    },
    seo: {
      required: [...required],
      absentOnLiveSite: seoSummary.absentSiteWide,
      notes: [
        "Emit exactly the fields the live site emits. Adding a meta description, OpenGraph, Twitter cards or JSON-LD " +
          "is a content improvement, not parity — it belongs to a decision, not to the emitter's defaults.",
        "Every absent tag is recorded as absent rather than defaulted: an emitter that invented a description or a " +
          "canonical would make the SEO parity gate compare two different surfaces and call it green.",
      ],
    },
    redirects: {
      file: "/_redirects",
      lines: input.redirects.cloudflareRedirects,
    },
    sitemap: sitemapContract,
    robots: {
      path: robotsContract.path,
      body: robotsContract.body,
      rules: robotsContract.rules,
      mustEmit: robotsContract.mustEmit,
    },
    search: input.search.newSite,
  };

  const notes = [
    "The SEO surface is derived from capture/site-ir.json's captured dom.html — no page was re-fetched for it. " +
      "Live requests covered only facts a capture cannot hold: redirect arrivals and destinations, robots.txt, the " +
      "sitemap tree, /index.html, one slash-less alias, and two search probes.",
    "This file is a SIDECAR. It does not modify capture/site-ir.json; folding pages[].seo into the IR is a later bead.",
    ...manifest.notes
      .filter((note) => note.startsWith("broken link"))
      .map((note) => `route manifest: ${note}`),
  ];

  return {
    seoVersion: "1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    baseUrl,
    tool: {
      name: "cl-site-convert",
      version: "0.1.0",
      userAgent: USER_AGENT,
      minIntervalMs: input.minIntervalMs,
      requests: input.requests,
    },
    provenance: {
      manifest: input.manifestPath,
      siteIr: input.irPath,
      assetsReport: input.assetsPath,
      notes: [
        "SEO surface: captured dom.html (offline).",
        "Redirect arrivals and destinations: live read-only requests.",
        "robots.txt and sitemap: live read-only requests, body stored verbatim.",
        "Broken references: captured dom.html scanned, statuses taken from the route manifest's own probes and the asset capture report.",
      ],
    },
    summary: {
      pages: pages.length,
      seoAbsentSiteWide: seoSummary.absentSiteWide,
      canonicalMismatches: urlContract.canonical.mismatches.length,
      redirects: input.redirects.count,
      redirectsVerified: input.redirects.verified,
      redirectChains: input.redirects.chains.length,
      redirectLoops: input.redirects.loops.length,
      brokenReferences: brokenReferences.length,
      trailingSlashPolicy: urlContract.trailingSlash.policy,
      searchStatus: input.search.probe.status,
    },
    pages: pageRecords,
    urlContract,
    redirects: input.redirects,
    sitemap: input.sitemap,
    robots: input.robots,
    search: input.search,
    brokenReferences,
    newSiteContract,
    notes,
  };
}

export interface SeoCaptureOptions {
  baseUrl?: string;
  manifestPath?: string;
  irPath?: string;
  assetsReportPath?: string;
  out?: string;
  minIntervalMs?: number;
  /** Injectable fetcher, so tests never touch the network. */
  fetcher?: PoliteFetcher;
  onProgress?: (line: string) => void;
}

export interface SeoCaptureResult {
  /** `null` only when the pass could not evaluate (exit 2). */
  report: SeoAndRedirectsReport | null;
  /** Non-empty means exit 1. */
  failures: string[];
  /** Non-empty means exit 2 (cannot evaluate). */
  cannotEvaluate: string[];
  outputPath: string;
}

/**
 * Run the pass end to end and write the sidecar.
 *
 * The artifact is written **even when failures exist**: a survey that reports what is
 * wrong is more useful than a missing file, and the exit code carries the verdict.
 */
export async function captureSeo(options: SeoCaptureOptions = {}): Promise<SeoCaptureResult> {
  const onProgress = options.onProgress ?? ((): void => {});
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
  const irPath = options.irPath ?? DEFAULT_IR_PATH;
  const out = options.out ?? DEFAULT_OUT_PATH;
  const assetsPath = options.assetsReportPath ?? DEFAULT_ASSETS_REPORT_PATH;

  const cannotEvaluate: string[] = [];
  let manifest: LoadedManifest;
  let pages: LoadedIrPage[];
  try {
    manifest = await readManifest(manifestPath);
  } catch (error) {
    return {
      report: null,
      failures: [],
      cannotEvaluate: [
        `${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ],
      outputPath: out,
    };
  }
  try {
    pages = await readIrPages(irPath);
  } catch (error) {
    return {
      report: null,
      failures: [],
      cannotEvaluate: [`${irPath}: ${error instanceof Error ? error.message : String(error)}`],
      outputPath: out,
    };
  }
  const assets = await readAssetsReport(assetsPath);

  const baseUrl = (options.baseUrl ?? manifest.baseUrl).replace(/\/+$/, "");
  if (baseUrl !== manifest.baseUrl) {
    cannotEvaluate.push(
      `--base-url ${baseUrl} disagrees with ${manifestPath} (${manifest.baseUrl}); refusing to mix captures`,
    );
    return { report: null, failures: [], cannotEvaluate, outputPath: out };
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

  const inputs: CaptureInputs = { baseUrl, manifest, pages, assets, fetcher, onProgress };

  const { robots, sitemap, search, failures: surfaceFailures } = await captureLiveSurfaces(inputs);
  const { survey, failures: redirectFailures } = await captureRedirects(inputs);

  onProgress("GET /index.html");
  const indexProbe = await probeShape(fetcher, "/index.html");
  const aliasSource = pages.find((page) => page.url !== "/" && page.url.endsWith("/"));
  const aliasProbe =
    aliasSource === undefined
      ? null
      : await probeShape(fetcher, aliasSource.url.replace(/\/+$/, ""));

  const report = buildReport({
    baseUrl,
    manifest,
    pages,
    assets,
    robots,
    sitemap,
    search,
    redirects: survey,
    indexProbe,
    aliasProbe,
    requests: fetcher.requestCount,
    minIntervalMs: fetcher.minIntervalMs,
    manifestPath,
    irPath,
    assetsPath: assets === null ? null : assetsPath,
  });

  const failures: string[] = [...surfaceFailures, ...redirectFailures];

  for (const route of manifest.routes) {
    const status = route.http?.status ?? 0;
    if (status !== 200) {
      failures.push(
        `${route.path}: route manifest recorded HTTP ${status}; the page is unreachable`,
      );
    }
  }
  for (const mismatch of report.urlContract.canonical.mismatches) {
    failures.push(
      `${mismatch.route}: canonical ${mismatch.declared ?? "(absent)"} does not equal the route (${mismatch.reason})`,
    );
  }
  if (report.urlContract.indexHtml.finding !== null) {
    failures.push(`index.html URL shape: ${report.urlContract.indexHtml.finding}`);
  }
  if (pages.length !== manifest.routes.length) {
    failures.push(
      `${irPath} holds ${pages.length} pages but ${manifestPath} holds ${manifest.routes.length} routes`,
    );
  }

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, failures, cannotEvaluate, outputPath: out };
}

/** Console summary. The numbers printed here are the deliverable's evidence. */
export function formatSeoReport(report: SeoAndRedirectsReport): string {
  const lines: string[] = [];
  lines.push(`SEO surface + redirects — ${report.baseUrl} (${report.generatedAt})`);
  lines.push("");
  lines.push(`  pages                : ${report.summary.pages}`);
  lines.push(
    `  requests             : ${report.tool.requests} (>= ${report.tool.minIntervalMs} ms apart)`,
  );
  lines.push(`  seo absent site-wide : ${report.summary.seoAbsentSiteWide.join(", ") || "(none)"}`);
  lines.push(`  canonical mismatches : ${report.summary.canonicalMismatches}`);
  lines.push(`  trailing-slash policy: ${report.summary.trailingSlashPolicy}`);
  lines.push("");
  lines.push(
    `  redirects  : ${report.summary.redirects} (${report.summary.redirectsVerified} verified)`,
  );
  lines.push(`  chains     : ${report.summary.redirectChains}`);
  lines.push(`  loops      : ${report.summary.redirectLoops}`);
  for (const redirect of report.redirects.entries) {
    lines.push(
      `    ${redirect.verified ? "OK  " : "FAIL"} ${redirect.from} -> ${redirect.to} ${redirect.code}` +
        ` [${redirect.hops} hop${redirect.hops === 1 ? "" : "s"}, final ${redirect.finalStatus ?? "?"}]` +
        (redirect.problems.length > 0 ? ` ${redirect.problems.join(",")}` : ""),
    );
  }
  lines.push("");
  lines.push(
    `  sitemap    : ${report.sitemap.root} ${report.sitemap.kind} ${report.sitemap.urlCount} URLs (${report.sitemap.children.length} child doc(s))`,
  );
  lines.push(
    `  robots.txt : ${report.robots.status} (${report.robots.rules.disallow.join(", ") || "no disallow"})`,
  );
  lines.push(
    `  /?s=test   : ${report.search.probe.status} "${report.search.probe.documentTitle ?? "(no title)"}" noResults=${report.search.probe.noResults}`,
  );
  lines.push(
    `  /?s=room   : ${report.search.matchingProbe.status} ${report.search.matchingProbe.resultMarkers} result marker(s)`,
  );
  lines.push("");
  lines.push(`  broken references (${report.brokenReferences.length}):`);
  for (const broken of report.brokenReferences) {
    lines.push(
      `    [${broken.severity}] ${broken.kind} (${broken.attributes.join("+")}) ${broken.raw} -> ${broken.resolved} ${broken.status} on ${broken.pages.join(", ")}`,
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
  irPath: string;
  out: string;
}

function parseArgs(argv: readonly string[]): CliArgs | null {
  const args: CliArgs = {
    baseUrl: DEFAULT_BASE_URL,
    manifestPath: DEFAULT_MANIFEST_PATH,
    irPath: DEFAULT_IR_PATH,
    out: DEFAULT_OUT_PATH,
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
    } else if (arg === "--ir" && value !== undefined) {
      args.irPath = value;
      i += 1;
    } else if (arg === "--out" && value !== undefined) {
      args.out = value;
      i += 1;
    } else {
      return null;
    }
  }
  return args;
}

const USAGE = [
  "Usage: node dist/source/seo/capture.js [options]",
  "",
  `Capture the SEO surface, 301 map, URL contract, sitemap/robots and search behaviour into ${DEFAULT_OUT_PATH}.`,
  "",
  "Options:",
  `  --base-url <url>   target site (default ${DEFAULT_BASE_URL})`,
  `  --manifest <path>  route manifest (default ${DEFAULT_MANIFEST_PATH})`,
  `  --ir <path>        Site IR to read SEO surface from (default ${DEFAULT_IR_PATH})`,
  `  --out <path>       sidecar path (default ${DEFAULT_OUT_PATH})`,
  "",
  "Exit codes: 0 clean, 1 defects (unreachable page, canonical mismatch, redirect defect), 2 cannot evaluate.",
].join("\n");

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args === null) {
    process.stdout.write(`${USAGE}\n`);
    return argv.includes("--help") || argv.includes("-h") ? 0 : 2;
  }

  const result = await captureSeo({
    baseUrl: args.baseUrl,
    manifestPath: args.manifestPath,
    irPath: args.irPath,
    out: args.out,
    onProgress: (line) => process.stderr.write(`${line}\n`),
  });

  if (result.cannotEvaluate.length > 0 || result.report === null) {
    for (const reason of result.cannotEvaluate)
      process.stderr.write(`CANNOT EVALUATE: ${reason}\n`);
    return 2;
  }

  process.stdout.write(`${formatSeoReport(result.report)}\n`);
  process.stdout.write(`\nwrote ${result.outputPath}\n`);

  if (result.failures.length > 0) {
    for (const failure of result.failures) process.stderr.write(`FAILURE: ${failure}\n`);
    return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
