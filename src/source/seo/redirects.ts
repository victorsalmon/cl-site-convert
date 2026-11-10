/**
 * The redirect map: what the old site 301s, and what the new site must reproduce.
 *
 * The `Redirection` plugin is installed on the source site, but its data is only
 * reachable through its admin surface (`/?redirection=…`, REST writes, exports).
 * Reading it would mean authenticated, mutating-adjacent requests against
 * production, so this module takes the honest alternative: the 301s **proven by
 * requesting each old path and reading `Location`**, which is the same evidence the
 * plugin would report, collected the way any client would.
 *
 * Three things are checked per redirect, and all three matter:
 *
 *  1. **The arrival agrees with the map.** A recorded 301 whose live `Location`
 *     changed is a stale map, and a stale map silently breaks the cutover.
 *  2. **The chain is one hop.** A 301 into another 301 doubles the round trip and
 *     halves the link equity that arrives.
 *  3. **The target resolves.** A 301 to a 404 is worse than no redirect, because it
 *     teaches search engines the page is gone *and* wastes the visit.
 *
 * Nothing here fetches. Chain analysis is a pure function over the recorded map;
 * arrival and target facts are recorded observations passed in.
 */

import { pathFromUrl } from "../wp-rest/parse.js";

/** A redirect as recorded by route enumeration (`capture/routes.manifest.json`). */
export interface RedirectEntry {
  /** Site-relative path, e.g. `/apply`. */
  from: string;
  /** Absolute URL or site-relative path. */
  to: string;
  /** `301`, `302`, `307` or `308`. */
  code: number;
}

export type RedirectProblem =
  | "not-301"
  | "self-redirect"
  | "unverified"
  | "arrival-mismatch"
  | "chain"
  | "loop"
  | "target-error";

/** What a polite request to `from` actually returned. */
export interface RedirectArrival {
  status: number;
  location: string | null;
}

/** One redirect, fully described and proven. */
export interface VerifiedRedirect {
  from: string;
  to: string;
  code: number;
  /** `true` when the destination is off-site (Drive, YouTube, Signal, …). */
  external: boolean;
  /** HTTP redirects followed from `from` to a terminal URL. `1` is healthy. */
  hops: number;
  /** `from`, then each site-internal hop target. External destinations terminate it. */
  chain: string[];
  /** Where following the map actually lands (`null` when unprobed). */
  finalUrl: string | null;
  /** Status of the terminal URL (`null` when unprobed or unreachable). */
  finalStatus: number | null;
  /** `true` only when the arrival matched, the chain was one hop, and the target is 2xx. */
  verified: boolean;
  problems: RedirectProblem[];
}

export interface RedirectMap {
  count: number;
  /** Redirects that arrive in a single hop at a 2xx destination. */
  verified: number;
  /** Redirects whose destination is itself a redirect (multi-hop). */
  chains: VerifiedRedirect[];
  loops: VerifiedRedirect[];
  /** Every redirect with at least one problem, in manifest order. */
  broken: VerifiedRedirect[];
  redirects: VerifiedRedirect[];
}

/** Is this destination on another origin? */
export function isExternal(to: string, baseUrl: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(to)) return false;
  try {
    return new URL(to).host !== new URL(baseUrl).host;
  } catch {
    return true;
  }
}

/** Site-relative path of a destination, or `null` when it is off-site. */
export function sitePathOf(to: string, baseUrl: string): string | null {
  if (isExternal(to, baseUrl)) return null;
  return pathFromUrl(to, baseUrl);
}

export interface ChainAnalysis {
  /** `from`, then each site-internal hop target. */
  chain: string[];
  hops: number;
  loop: boolean;
  /** The site-internal destination the chain leaves the map at, if any. */
  terminal: string | null;
}

/**
 * Follow a redirect through the recorded map, internal edges only.
 *
 * `hops` counts redirects, so an entry that points straight at a real page is `1`.
 * A cycle is reported as a loop rather than followed forever, and a destination
 * that is not a redirect key terminates the chain — whether it is a page or a 404
 * is the target probe's question, not this one's.
 */
export function analyseChain(
  entry: RedirectEntry,
  map: ReadonlyMap<string, RedirectEntry>,
  baseUrl: string,
  maxHops = 10,
): ChainAnalysis {
  const chain: string[] = [entry.from];
  const seen = new Set<string>([entry.from]);
  let current = entry;
  let hops = 0;

  while (hops < maxHops) {
    const next = sitePathOf(current.to, baseUrl);
    if (next === null) {
      // Off-site destination: the chain ends at the external URL.
      chain.push(current.to);
      return { chain, hops: hops + 1, loop: false, terminal: null };
    }
    chain.push(next);
    hops += 1;
    if (seen.has(next)) return { chain, hops, loop: true, terminal: next };
    seen.add(next);
    const following = map.get(next);
    if (following === undefined) return { chain, hops, loop: false, terminal: next };
    current = following;
  }

  return { chain, hops, loop: false, terminal: chain.at(-1) ?? null };
}

/** Compare a recorded `Location` with the map's `to`, tolerant of origin spelling only. */
export function locationMatches(to: string, location: string | null, baseUrl: string): boolean {
  if (location === null) return false;
  const normalise = (value: string): string => {
    try {
      const url = new URL(value, baseUrl);
      return `${url.host}${url.pathname}${url.search}${url.hash}`;
    } catch {
      return value.trim();
    }
  };
  return normalise(to) === normalise(location);
}

/** Assemble one verified redirect from the recorded map entry and observations. */
export function buildVerifiedRedirect(input: {
  entry: RedirectEntry;
  map: ReadonlyMap<string, RedirectEntry>;
  baseUrl: string;
  /** What requesting `from` returned. `null` when never probed. */
  arrival: RedirectArrival | null;
  /** Status of the destination (`to`), or of the terminal URL when `to` redirects. */
  finalStatus: number | null;
}): VerifiedRedirect {
  const { entry, map, baseUrl, arrival, finalStatus } = input;
  const analysis = analyseChain(entry, map, baseUrl);
  const external = isExternal(entry.to, baseUrl);

  const finalUrl =
    analysis.terminal ?? (external ? entry.to : (sitePathOf(entry.to, baseUrl) ?? entry.to));

  const problems: RedirectProblem[] = [];
  if (entry.code !== 301) problems.push("not-301");
  if (entry.from === sitePathOf(entry.to, baseUrl)) problems.push("self-redirect");
  if (analysis.loop) problems.push("loop");
  // A loop already explains why the hop count is wrong; reporting both would make one
  // defect look like two in the summary.
  else if (analysis.hops > 1) problems.push("chain");

  if (arrival === null) {
    problems.push("unverified");
  } else if (arrival.status < 300 || arrival.status >= 400) {
    problems.push("unverified");
  } else if (!locationMatches(entry.to, arrival.location, baseUrl)) {
    // The map said one thing and the server did another: a stale map, which is worse
    // than an unprobed one because it looks authoritative.
    problems.push("arrival-mismatch");
  }

  if (finalStatus === null) {
    if (!problems.includes("unverified")) problems.push("unverified");
  } else if (finalStatus >= 400) {
    problems.push("target-error");
  }

  return {
    from: entry.from,
    to: entry.to,
    code: entry.code,
    external,
    hops: analysis.hops,
    chain: analysis.chain,
    finalUrl,
    finalStatus,
    verified: problems.length === 0,
    problems,
  };
}

/** Build the whole map. Entries missing an arrival are recorded as unverified, never dropped. */
export function buildRedirectMap(input: {
  baseUrl: string;
  entries: readonly RedirectEntry[];
  /** Arrival per `from` path; a missing path means "not probed". */
  arrivals?: ReadonlyMap<string, RedirectArrival>;
  /** Destination status per `from` path (the terminal URL's status). */
  finalStatuses?: ReadonlyMap<string, number | null>;
}): RedirectMap {
  const map = new Map<string, RedirectEntry>();
  for (const entry of input.entries) map.set(entry.from, entry);

  const redirects = input.entries.map((entry) =>
    buildVerifiedRedirect({
      entry,
      map,
      baseUrl: input.baseUrl,
      arrival: input.arrivals?.get(entry.from) ?? null,
      finalStatus: input.finalStatuses?.get(entry.from) ?? null,
    }),
  );

  return {
    count: redirects.length,
    verified: redirects.filter((redirect) => redirect.verified).length,
    chains: redirects.filter((redirect) => redirect.problems.includes("chain")),
    loops: redirects.filter((redirect) => redirect.problems.includes("loop")),
    broken: redirects.filter((redirect) => redirect.problems.length > 0),
    redirects,
  };
}

/**
 * `_redirects` lines for a Cloudflare Pages deployable.
 *
 * Only verified redirects are emitted, and each keeps its status code, because a
 * deploy file that carries an unverified hop is how a one-hop redirect becomes a
 * two-hop one. External destinations stay absolute — Pages accepts them, and
 * rewriting them to a path would be a different redirect.
 */
export function toCloudflareRedirects(map: RedirectMap): string[] {
  return map.redirects
    .filter((redirect) => redirect.verified)
    .map((redirect) => `${redirect.from} ${redirect.to} ${redirect.code}`);
}
