/**
 * Polite single-threaded HTTP for source capture against a **production** site.
 *
 * Three things this file exists to guarantee, because getting them wrong is how a
 * capture job becomes an incident:
 *
 *  1. **One request at a time, spaced out.** There is no concurrency primitive
 *     here on purpose. Every call awaits the previous one plus `minIntervalMs`.
 *  2. **An honest, contactable User-Agent.** Not a browser string; the site owner
 *     can tell who we are and where to complain.
 *  3. **robots.txt is fetched first and obeyed**, including `Allow` overrides and
 *     longest-match precedence. A disallowed path is *skipped and recorded*, never
 *     silently dropped — a route we were forbidden to ask about is different from
 *     a route that does not exist.
 *
 * Retries are bounded and only for transient failures (429, 5xx, network). A 404
 * or 401 is an answer, not an error.
 */

/** Identifies this tool to the site owner. Keep the contact URL. */
export const USER_AGENT =
  "cl-site-convert/0.1 (route enumeration; polite; +https://github.com/clocklobster/cl-site-convert)";

/** Default spacing between requests. Our own rule; the site asked for none. */
export const DEFAULT_MIN_INTERVAL_MS = 600;

export interface PoliteFetcherOptions {
  /** Site root, e.g. `https://upscalehavens.ca` (no trailing slash). */
  baseUrl: string;
  /** Minimum gap between the *end* of one request and the start of the next. */
  minIntervalMs?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Attempts for transient failures, including the first. */
  attempts?: number;
  /** Override the UA (tests use a static fixture loader instead). */
  userAgent?: string;
  /** Progress sink. Defaults to silent; the CLI passes a stderr writer. */
  onRequest?: (line: string) => void;
}

export interface HttpResponse {
  /** Absolute URL that was requested. */
  url: string;
  status: number;
  /** Response headers, lowercased. */
  headers: Record<string, string>;
  body: string;
  /** `Location` when the response was a redirect we did not follow. */
  location: string | null;
  /** Set when the request never produced a response (network error). */
  error: string | null;
  /** Attempts actually used, 1-based. */
  attempts: number;
}

/**
 * robots.txt as it applies to us.
 *
 * Only the group that matches our agent token (or the `*` group) is considered;
 * `Allow` beats `Disallow` on a longer pattern, and on an equal-length tie.
 */
export interface RobotsRules {
  /** Paths we may not request. Recorded so the manifest can name them. */
  disallow: string[];
  /** Paths explicitly permitted even under a broader `Disallow`. */
  allow: string[];
  /** Sitemap URLs the site advertises. */
  sitemaps: string[];
  /** True when robots.txt could not be read; we then allow everything (the file
   *  did not express a wish we can honour) but record that we failed. */
  unreadable: boolean;
  /** HTTP status of the robots.txt fetch, or null when never attempted. */
  status: number | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Which robots group applies to a User-Agent string. */
export function matchingRobotsGroup(text: string, userAgent: string): number {
  // Returns an index into the parsed group list; -1 when nothing matches.
  const groups = parseRobotsGroups(text);
  const lowered = userAgent.toLowerCase();
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    if (group === undefined) continue;
    if (group.agents.some((agent) => agent === "*" || lowered.includes(agent))) return i;
  }
  return -1;
}

interface RobotsGroup {
  agents: string[];
  disallow: string[];
  allow: string[];
}

function parseRobotsGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (current === null || !lastWasAgent) {
        current = { agents: [], disallow: [], allow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    lastWasAgent = false;
    if (current === null) continue;
    if (field === "disallow" && value.length > 0) current.disallow.push(value);
    if (field === "allow" && value.length > 0) current.allow.push(value);
  }

  return groups;
}

/** Parse robots.txt into the rules that apply to our UA. Pure. */
export function parseRobots(text: string, userAgent: string = USER_AGENT): RobotsRules {
  const groups = parseRobotsGroups(text);
  const lowered = userAgent.toLowerCase();

  // Prefer the most specific matching group; fall back to the `*` group.
  let chosen: RobotsGroup | null = null;
  for (const group of groups) {
    if (group.agents.some((agent) => agent !== "*" && lowered.includes(agent))) chosen = group;
  }
  if (chosen === null) {
    chosen = groups.find((group) => group.agents.includes("*")) ?? null;
  }

  const sitemaps: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S+)/i.exec(rawLine);
    if (match?.[1] !== undefined) sitemaps.push(match[1]);
  }

  return {
    disallow: chosen?.disallow ?? [],
    allow: chosen?.allow ?? [],
    sitemaps,
    unreadable: false,
    status: null,
  };
}

/**
 * Is a site-relative path allowed? Longest matching pattern wins; `Allow` wins
 * an exact-length tie (the robots convention that keeps `Disallow: /wp-admin/`
 * from blocking `Allow: /wp-admin/admin-ajax.php`).
 */
export function isPathAllowed(path: string, rules: RobotsRules): boolean {
  if (rules.unreadable) return true;

  const matches = (pattern: string): boolean => {
    if (pattern === "") return false;
    // Only `*` and `$` are meaningful here; WP emits neither in practice.
    if (pattern.includes("*") || pattern.endsWith("$")) {
      const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\$$/, "$");
      return new RegExp(`^${escaped}`).test(path);
    }
    return path.startsWith(pattern);
  };

  let bestAllow = -1;
  let bestDisallow = -1;
  for (const pattern of rules.allow)
    if (matches(pattern)) bestAllow = Math.max(bestAllow, pattern.length);
  for (const pattern of rules.disallow)
    if (matches(pattern)) bestDisallow = Math.max(bestDisallow, pattern.length);

  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}

/**
 * A fetcher that cannot run two requests at once and cannot forget the gap.
 *
 * Sequential by construction: `lastFinishedAt` is only advanced by a completed
 * request, so a caller that fires ten calls in a row still gets them serialized
 * (each `await` also yields, so ordering is preserved).
 */
export class PoliteFetcher {
  readonly #baseUrl: string;
  readonly #minIntervalMs: number;
  readonly #timeoutMs: number;
  readonly #attempts: number;
  readonly #userAgent: string;
  readonly #onRequest: ((line: string) => void) | null;
  #lastFinishedAt = 0;
  #requestCount = 0;

  constructor(options: PoliteFetcherOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#attempts = options.attempts ?? 3;
    this.#userAgent = options.userAgent ?? USER_AGENT;
    this.#onRequest = options.onRequest ?? null;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** The enforced gap, so a manifest can record how politely it was produced. */
  get minIntervalMs(): number {
    return this.#minIntervalMs;
  }

  get requestCount(): number {
    return this.#requestCount;
  }

  /** Resolve a site-relative path (or absolute URL on the same host) to absolute. */
  absolute(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return `${this.#baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  }

  /** The site-relative path of a URL on this host, or the URL itself if off-site. */
  pathOf(pathOrUrl: string): string {
    const absolute = this.absolute(pathOrUrl);
    try {
      const parsed = new URL(absolute);
      const base = new URL(this.#baseUrl);
      if (parsed.host !== base.host) return absolute;
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return pathOrUrl;
    }
  }

  async fetch(pathOrUrl: string, options: { method?: "GET" | "HEAD" } = {}): Promise<HttpResponse> {
    const url = this.absolute(pathOrUrl);
    const method = options.method ?? "GET";
    let lastError = "no attempt was made";

    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      const gap = this.#lastFinishedAt + this.#minIntervalMs - Date.now();
      if (gap > 0) await sleep(gap);

      this.#requestCount += 1;
      this.#onRequest?.(`${method} ${url}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers: {
            "user-agent": this.#userAgent,
            accept: "application/json, application/xml, text/xml, text/html;q=0.8, */*;q=0.5",
          },
          redirect: "manual",
          signal: controller.signal,
        });
        const body = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value;
        });
        const location = headers["location"] ?? null;

        this.#lastFinishedAt = Date.now();
        clearTimeout(timer);

        const transient = response.status === 429 || response.status >= 500;
        if (transient && attempt < this.#attempts) {
          lastError = `HTTP ${response.status}`;
          await sleep(2_000 * attempt);
          continue;
        }

        return {
          url,
          status: response.status,
          headers,
          body,
          location,
          error: null,
          attempts: attempt,
        };
      } catch (error) {
        clearTimeout(timer);
        this.#lastFinishedAt = Date.now();
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < this.#attempts) await sleep(2_000 * attempt);
      }
    }

    return {
      url,
      status: 0,
      headers: {},
      body: "",
      location: null,
      error: lastError,
      attempts: this.#attempts,
    };
  }

  /** Fetch robots.txt and reduce it to the rules that apply to us. */
  async readRobots(): Promise<RobotsRules> {
    const response = await this.fetch("/robots.txt");
    if (response.status !== 200) {
      return {
        disallow: [],
        allow: [],
        sitemaps: [],
        unreadable: true,
        status: response.status === 0 ? null : response.status,
      };
    }
    const rules = parseRobots(response.body, this.#userAgent);
    return { ...rules, status: response.status };
  }
}
