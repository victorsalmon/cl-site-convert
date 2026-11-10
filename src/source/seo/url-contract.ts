/**
 * The URL contract: one canonical form per route, and the evidence for it.
 *
 * A static site gets URL shape wrong by accident far more easily than WordPress
 * does, because "one file per route" invites `/care.html`, `/care/index.html` and
 * `/care/` to coexist. The contract this module measures has three parts, and
 * each one is a real finding when it fails:
 *
 *  1. **Canonical = route.** Every captured page declares a canonical URL, and it
 *     must name the route the page was actually served at. A canonical pointing at
 *     a different path silently de-indexes the page it sits on.
 *  2. **Trailing-slash policy.** The site is either `/care/` or `/care`, never
 *     both. Mixed policies split link equity across two URLs per page.
 *  3. **No `index.html` style URLs.** `/care/index.html` must not be a live route.
 *
 * Nothing here fetches: the probes are the caller's job, and the recorded result is
 * passed in. That keeps the decision offline and diffable.
 */

export type CanonicalMismatchReason =
  | "absent"
  | "unparseable"
  | "off-origin"
  | "insecure-protocol"
  | "path-mismatch"
  | "query-mismatch";

/** One page's canonical assertion, and whether it agrees with the route. */
export interface CanonicalCheck {
  /** The captured route, site-relative (the IR's `page.url`). */
  route: string;
  /** The canonical exactly as the page declared it. */
  declared: string | null;
  /** `path` + `search` the canonical resolves to, or `null` when it cannot parse. */
  resolved: string | null;
  matches: boolean;
  /** `null` when it matches; otherwise why it does not. */
  reason: CanonicalMismatchReason | null;
  /** True when the declared form is already site-relative (no origin to drift). */
  relative: boolean;
}

export interface CanonicalAudit {
  pages: number;
  matches: number;
  mismatches: CanonicalCheck[];
  checks: CanonicalCheck[];
}

export type TrailingSlashPolicy = "always" | "never" | "mixed" | "root-only";

export interface TrailingSlashAudit {
  policy: TrailingSlashPolicy;
  /** Non-root routes ending in `/`. */
  withSlash: number;
  /** Non-root routes not ending in `/`. */
  withoutSlash: number;
  /** The routes that disagree with the majority, named. */
  outliers: string[];
  note: string;
}

/** A recorded HTTP probe of a URL shape the site may or may not accept. */
export interface UrlShapeProbe {
  /** What was requested (site-relative). */
  path: string;
  status: number;
  location: string | null;
  /** `status` 2xx. */
  resolves: boolean;
}

export interface IndexHtmlAudit {
  /** Captured routes whose last segment is `index.html` (expected: none). */
  routes: string[];
  /** Probe of the root `/index.html`, when the caller made one. */
  probe: UrlShapeProbe | null;
  finding: string | null;
}

export interface UrlContract {
  baseUrl: string;
  canonical: CanonicalAudit;
  trailingSlash: TrailingSlashAudit;
  /** Live probe of the slash-less form of one captured route, as evidence for the policy. */
  aliasProbe: UrlShapeProbe | null;
  indexHtml: IndexHtmlAudit;
}

/**
 * Resolve a declared canonical to the `path`+`search` it names.
 *
 * `null` means the value could not be read as a URL at all — distinct from a URL
 * that resolves somewhere unexpected, which is the more common and more serious
 * defect.
 */
export function resolveCanonical(
  declared: string,
  baseUrl: string,
): { resolved: string | null; offOrigin: boolean; insecure: boolean; relative: boolean } {
  const relative = !/^[a-z][a-z0-9+.-]*:/i.test(declared);
  let url: URL;
  try {
    url = new URL(declared, baseUrl);
  } catch {
    return { resolved: null, offOrigin: false, insecure: false, relative };
  }
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { resolved: null, offOrigin: false, insecure: false, relative };
  }
  return {
    resolved: `${url.pathname}${url.search}`,
    offOrigin: url.host !== base.host,
    insecure: url.protocol === "http:" && base.protocol === "https:",
    relative,
  };
}

/**
 * Compare every page's canonical to the route it was served at.
 *
 * A trailing-slash difference is a **path** mismatch, deliberately: `/care` and
 * `/care/` are two URLs, and treating them as equal here is how the emitter ships
 * a second one.
 */
export function auditCanonicals(
  baseUrl: string,
  pages: readonly { url: string; canonical: string | null }[],
): CanonicalAudit {
  const checks: CanonicalCheck[] = pages.map((page) => {
    if (page.canonical === null) {
      return {
        route: page.url,
        declared: null,
        resolved: null,
        matches: false,
        reason: "absent",
        relative: false,
      };
    }
    const resolved = resolveCanonical(page.canonical, baseUrl);
    const base = { route: page.url, declared: page.canonical, relative: resolved.relative };
    if (resolved.resolved === null) {
      return { ...base, resolved: null, matches: false, reason: "unparseable" };
    }
    if (resolved.offOrigin) {
      return { ...base, resolved: resolved.resolved, matches: false, reason: "off-origin" };
    }
    if (resolved.insecure) {
      return { ...base, resolved: resolved.resolved, matches: false, reason: "insecure-protocol" };
    }
    if (resolved.resolved === page.url) {
      return { ...base, resolved: resolved.resolved, matches: true, reason: null };
    }
    const samePath = resolved.resolved.split("?")[0] === page.url.split("?")[0];
    return {
      ...base,
      resolved: resolved.resolved,
      matches: false,
      reason: samePath ? "query-mismatch" : "path-mismatch",
    };
  });

  const mismatches = checks.filter((check) => !check.matches);
  return { pages: checks.length, matches: checks.length - mismatches.length, mismatches, checks };
}

/**
 * Decide the trailing-slash policy from the routes actually captured.
 *
 * Root (`/`) is excluded from the vote: it carries a slash by definition and would
 * otherwise make any site look `always` on a single-page capture.
 */
export function auditTrailingSlash(routes: readonly string[]): TrailingSlashAudit {
  const nonRoot = routes.filter((route) => route !== "/");
  const slashed = nonRoot.filter((route) => route.endsWith("/"));
  const unslashed = nonRoot.filter((route) => !route.endsWith("/"));

  if (nonRoot.length === 0) {
    return {
      policy: "root-only",
      withSlash: 0,
      withoutSlash: 0,
      outliers: [],
      note: "Only the root route was captured, so no policy is observable.",
    };
  }
  if (unslashed.length === 0) {
    return {
      policy: "always",
      withSlash: slashed.length,
      withoutSlash: 0,
      outliers: [],
      note: `Every one of ${nonRoot.length} non-root routes ends in "/" (WordPress permalink structure).`,
    };
  }
  if (slashed.length === 0) {
    return {
      policy: "never",
      withSlash: 0,
      withoutSlash: unslashed.length,
      outliers: [],
      note: `No non-root route ends in "/" (${nonRoot.length} captured).`,
    };
  }
  return {
    policy: "mixed",
    withSlash: slashed.length,
    withoutSlash: unslashed.length,
    outliers: [...unslashed].sort(),
    note:
      "Both forms occur among captured routes. The emitter must not reproduce that: pick the majority " +
      "form and 301 the other.",
  };
}

/** Audit `index.html` style URLs: captured routes plus the caller's root probe. */
export function auditIndexHtml(
  routes: readonly string[],
  probe: UrlShapeProbe | null,
): IndexHtmlAudit {
  const indexRoutes = routes.filter((route) => /(?:^|\/)index\.html?$/i.test(route));
  const findings: string[] = [];
  if (indexRoutes.length > 0) {
    findings.push(`${indexRoutes.length} captured route(s) end in index.html`);
  }
  if (probe !== null && probe.resolves) {
    findings.push(
      `${probe.path} answers ${probe.status}; a static host would serve it alongside /`,
    );
  }
  return {
    routes: indexRoutes,
    probe,
    finding: findings.length === 0 ? null : findings.join("; "),
  };
}

/** The whole contract in one call, from captured routes + recorded probes. */
export function buildUrlContract(input: {
  baseUrl: string;
  pages: readonly { url: string; canonical: string | null }[];
  indexProbe?: UrlShapeProbe | null;
  aliasProbe?: UrlShapeProbe | null;
}): UrlContract {
  const routes = input.pages.map((page) => page.url);
  return {
    baseUrl: input.baseUrl,
    canonical: auditCanonicals(input.baseUrl, input.pages),
    trailingSlash: auditTrailingSlash(routes),
    aliasProbe: input.aliasProbe ?? null,
    indexHtml: auditIndexHtml(routes, input.indexProbe ?? null),
  };
}
