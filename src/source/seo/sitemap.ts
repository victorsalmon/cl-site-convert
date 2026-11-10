/**
 * Sitemap and robots: what the live site publishes, and what the static site must
 * publish to stay equivalent.
 *
 * Both files are part of the crawl contract rather than of any page, which is why
 * they are captured verbatim and then *re-stated as an obligation*: a static site
 * that drops `/robots.txt` loses its sitemap pointer, and one that drops
 * `/wp-sitemap.xml` loses the index WordPress built for it. Neither loss shows up
 * in a page diff.
 *
 * `robots.txt` is stored byte-for-byte. It is small, it is the site owner's explicit
 * instruction to crawlers, and paraphrasing it would turn a policy into a summary.
 */

import { parseSitemap } from "../wp-rest/parse.js";
import type { SitemapDocument } from "../wp-rest/parse.js";

/** One sitemap document as fetched. */
export interface SitemapDocumentCapture {
  url: string;
  status: number;
  kind: SitemapDocument["kind"];
  /** Number of `<url>` entries (0 for an index). */
  urls: number;
  /** Every `<loc>` this document carries — children when an index, pages when a urlset. */
  locs: string[];
}

/** Raised when a directory listed in robots.txt is not vetted here. */
export interface SitemapCapture {
  root: string;
  status: number;
  kind: SitemapDocument["kind"];
  children: SitemapDocumentCapture[];
  /** Distinct page URLs across every urlset document. */
  urlCount: number;
  /** Every advertised page URL, sorted. */
  locs: string[];
  /** Sitemap URLs robots.txt declares (the discovery pointer). */
  declaredInRobots: string[];
  /** Captured routes the sitemap does **not** advertise. */
  notInSitemap: string[];
  /** Advertised URLs that are not captured routes. */
  notCaptured: string[];
}

/** What the new site must serve in `/robots.txt`. */
export interface RobotsContract {
  /** Path the deployable must own. */
  path: string;
  /** The captured body, verbatim — the emitter's starting point, never a rewrite. */
  body: string;
  /** Crawler directives the body expresses, restated so a replacement can be checked. */
  rules: { disallow: string[]; allow: string[] };
  sitemaps: string[];
  mustEmit: string[];
}

export interface RobotsCapture {
  url: string;
  status: number;
  contentType: string | null;
  /** Verbatim body. Empty when the fetch failed; `status` then says why. */
  body: string;
  rules: { disallow: string[]; allow: string[] };
  sitemaps: string[];
}

/**
 * Reduce a robots.txt body to the directives that matter for equivalence.
 *
 * Only `Disallow`/`Allow`/`Sitemap` are read, and only their values: this is not a
 * crawler, and a full parser here would invite the impression that it enforces.
 */
export function parseRobotsDirectives(body: string): {
  disallow: string[];
  allow: string[];
  sitemaps: string[];
} {
  const disallow: string[] = [];
  const allow: string[] = [];
  const sitemaps: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (value.length === 0) continue;
    if (field === "disallow") disallow.push(value);
    if (field === "allow") allow.push(value);
    if (field === "sitemap") sitemaps.push(value);
  }
  return { disallow, allow, sitemaps };
}

/**
 * Assemble the sitemap capture from a fetched root and its fetched children.
 *
 * A child that fails is recorded with its status and contributes no URLs, so a
 * half-read sitemap cannot look complete.
 */
export function buildSitemapCapture(input: {
  rootUrl: string;
  root: { status: number; body: string } | null;
  children: readonly { url: string; status: number; body: string }[];
  robotsSitemaps: readonly string[];
  capturedRoutes: readonly string[];
  /** Strip a url's origin to a site-relative path. */
  toPath: (url: string) => string;
}): SitemapCapture {
  const rootDoc =
    input.root === null
      ? { kind: "unknown" as const, children: [], entries: [] }
      : parseSitemap(input.root.body);

  const childCaptures: SitemapDocumentCapture[] = input.children.map((child) => {
    const doc = parseSitemap(child.body);
    return {
      url: child.url,
      status: child.status,
      kind: doc.kind,
      urls: doc.entries.length,
      locs: doc.kind === "index" ? doc.children : doc.entries.map((entry) => entry.loc),
    };
  });

  const locs: string[] = [];
  for (const child of childCaptures) {
    if (child.kind !== "urlset") continue;
    for (const loc of child.locs) if (!locs.includes(loc)) locs.push(loc);
  }
  // A root that is itself a urlset (no index) is legitimate; read it too.
  if (rootDoc.kind === "urlset") {
    for (const entry of rootDoc.entries) if (!locs.includes(entry.loc)) locs.push(entry.loc);
  }

  const advertised = new Set(locs.map((loc) => input.toPath(loc)));
  const captured = new Set(input.capturedRoutes);
  const notInSitemap = [...captured].filter((route) => !advertised.has(route)).sort();
  const notCaptured = [...advertised].filter((route) => !captured.has(route)).sort();

  return {
    root: input.rootUrl,
    status: input.root?.status ?? 0,
    kind: rootDoc.kind,
    children: childCaptures,
    urlCount: locs.length,
    locs: [...locs].sort(),
    declaredInRobots: [...input.robotsSitemaps],
    notInSitemap,
    notCaptured,
  };
}

/**
 * The obligation the replacement site inherits.
 *
 * Deliberately phrased as instructions, not observations: the emitter bead reads
 * this list, and a bullet it cannot satisfy is a conversation, not a silent gap.
 */
export function buildRobotsContract(
  capture: RobotsCapture,
  sitemap: SitemapCapture,
  options: { sitemapPath: string },
): RobotsContract {
  const mustEmit = [
    `serve /robots.txt byte-identical to the captured body (${capture.status === 200 ? "captured" : `NOT captured, status ${capture.status}`})`,
    `keep the "Sitemap:" pointer pointing at ${options.sitemapPath}, which the new site must serve`,
    `keep Disallow: ${capture.rules.disallow.join(", ") || "(none)"} — these are the site owner's crawler instructions`,
  ];
  if (capture.rules.allow.length > 0) {
    mustEmit.push(`keep the Allow: ${capture.rules.allow.join(", ")} override`);
  }
  if (sitemap.declaredInRobots.length > 0) {
    mustEmit.push(
      `robots.txt declares ${sitemap.declaredInRobots.join(", ")}; the replacement must answer that exact URL`,
    );
  }
  mustEmit.push(
    "keep the /wp-admin/ rule as it stands for parity, while noting that the path does not exist on the static site — " +
      "so the rule is inert rather than wrong. Dropping it is a deliberate decision, not a tidy-up, because a stale " +
      "rule is the only remaining trace of the old admin surface.",
  );

  return {
    path: "/robots.txt",
    body: capture.body,
    rules: capture.rules,
    sitemaps: capture.sitemaps,
    mustEmit,
  };
}

/** The sitemap the replacement must serve, derived from the captured URL set. */
export function buildSitemapContract(
  sitemap: SitemapCapture,
  options: { sitemapPath: string; xslPath: string | null },
): {
  path: string;
  kind: "urlset";
  urlCount: number;
  locs: string[];
  mustEmit: string[];
} {
  const mustEmit = [
    `serve ${options.sitemapPath} as a single <urlset> with ${sitemap.urlCount} <loc> entries — one per captured page`,
    "absolute URLs on the new origin: a sitemap that lists the old host is a sitemap that points at the site being retired",
    "no lastmod the capture cannot prove: copy the captured lastmod only where the IR already holds it",
  ];
  if (options.xslPath !== null) {
    mustEmit.push(
      `serve ${options.xslPath} or drop the xml-stylesheet reference — a dangling stylesheet is a 404 on every sitemap fetch`,
    );
  }
  if (sitemap.notInSitemap.length > 0) {
    mustEmit.push(
      `decide explicitly whether the ${sitemap.notInSitemap.length} captured route(s) absent from the old sitemap join the new one`,
    );
  }
  return {
    path: options.sitemapPath,
    kind: "urlset",
    urlCount: sitemap.urlCount,
    locs: sitemap.locs,
    mustEmit,
  };
}
