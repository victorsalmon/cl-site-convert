/**
 * Emit-time URL rewriting — the **one sanctioned transform** of the static
 * emitter.
 *
 * Fidelity rules this module has to satisfy at once:
 *
 *  1. The capture is byte-identical. `capture/assets/**` is never touched, so the
 *     recorded `sha256` values stay true.
 *  2. Emitted HTML and CSS may only differ from the capture where a reference is
 *     re-pointed at a local file. That is what makes the CSS diff provable: every
 *     changed hunk is a `url(...)` substitution and nothing else
 *     (`docs/01-DECISIONS.md`, "Google Fonts: rewrite at emit, never at capture").
 *  3. The emitted tree is **relative**, so the same artifact works at a host root,
 *     under a preview subpath, or from `file://`. A rewritten reference is
 *     `"../".repeat(depth) + mappedPath`, where `depth` is the directory the
 *     reference resolves against: the page's own directory for HTML attributes and
 *     inline `<style>` blocks, the stylesheet's directory for a linked file.
 *
 * `capture/asset-rewrite-map.json` is the table. Its `rewrite` object maps a
 * captured reference to a path that mirrors the site's own absolute path
 * (`wp-content/uploads/x.jpg`, `external/fonts.gstatic.com/…`), which is exactly
 * what makes rule 3 a prefix rather than a lookup.
 *
 * Two derivations are applied on top of an exact key match, both deterministic and
 * both recorded in the report:
 *
 *  - **Protocol-relative references.** Divi's `@font-face` blocks point at
 *    `//upscalehavens.ca/…`, which the map recorded in its absolute form. The
 *    scheme comes from `baseUrl`; nothing is guessed.
 *  - **Query/fragment suffixes.** `modules.eot?#iefix` and the font files' `?ver=`
 *    tails are not part of the captured asset's identity, so the path is looked up
 *    without the suffix and the suffix is re-attached verbatim.
 *
 * Anything else is left exactly as captured. A reference the map does not know is
 * not rewritten, not normalised, and not dropped.
 */

/** One successful lookup: which map key matched, what it points at, and the suffix. */
export interface RewriteHit {
  /** The key that matched, e.g. `https://fonts.gstatic.com/s/arimo/…ttf`. */
  readonly key: string;
  /** Mapped path, without a leading slash, e.g. `external/fonts.gstatic.com/…`. */
  readonly path: string;
  /** The original `?query`/`#fragment` tail, or `""`. Re-attached after the path. */
  readonly suffix: string;
}

/** The validated rewrite table. Built once per emit run. */
export interface RewriteTable {
  /** Site the map was captured for. Cross-checked against `site.baseUrl`. */
  readonly baseUrl: string;
  /** Map version, for the report. */
  readonly version: number;
  /** Exact captured reference → emitted path. */
  readonly entries: ReadonlyMap<string, string>;
  /** Where the table came from, for error messages. */
  readonly source: string;
}

/** Thrown when the rewrite map cannot be used. Never silently ignored. */
export class RewriteMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RewriteMapError";
  }
}

/** Counts and the rewritten text, so a caller can report what changed. */
export interface RewriteResult {
  readonly text: string;
  /** Number of URL references substituted. */
  readonly count: number;
}

/** A mapped path must be a relative, traversal-free, non-empty path. */
function assertMappedPath(path: string, key: string, source: string): void {
  if (path.length === 0) {
    throw new RewriteMapError(`${source}: key ${JSON.stringify(key)} maps to an empty path`);
  }
  if (path.startsWith("/")) {
    throw new RewriteMapError(
      `${source}: key ${JSON.stringify(key)} maps to ${JSON.stringify(path)}; mapped paths must be relative`,
    );
  }
  if (path.split("/").includes("..")) {
    throw new RewriteMapError(
      `${source}: key ${JSON.stringify(key)} maps to ${JSON.stringify(path)}; traversal is not allowed`,
    );
  }
  if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(path)) {
    throw new RewriteMapError(
      `${source}: key ${JSON.stringify(key)} maps to ${JSON.stringify(path)}; not a URL path`,
    );
  }
}

/**
 * Validate a parsed `asset-rewrite-map.json` and index it.
 *
 * Every rejection here is a build failure rather than a skipped reference: an
 * emit that half-rewrites a page ships broken asset links and still looks green.
 */
export function buildRewriteTable(document: unknown, source = "asset-rewrite-map"): RewriteTable {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new RewriteMapError(`${source}: must be a JSON object`);
  }
  const record = document as Record<string, unknown>;

  const baseUrl = record["baseUrl"];
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new RewriteMapError(`${source}: baseUrl must be a non-empty string`);
  }
  const version = record["version"];
  if (typeof version !== "number" || !Number.isFinite(version)) {
    throw new RewriteMapError(`${source}: version must be a number`);
  }

  const rewrite = record["rewrite"];
  if (typeof rewrite !== "object" || rewrite === null || Array.isArray(rewrite)) {
    throw new RewriteMapError(`${source}: rewrite must be an object`);
  }

  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(rewrite as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new RewriteMapError(`${source}: rewrite[${JSON.stringify(key)}] must be a string`);
    }
    assertMappedPath(value, key, source);
    entries.set(key, value);
  }
  if (entries.size === 0) {
    throw new RewriteMapError(`${source}: rewrite is empty; a capture with no assets cannot emit`);
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), version, entries, source };
}

/** Every key form a captured reference can legitimately appear as. */
function candidateKeys(table: RewriteTable, raw: string): string[] {
  const keys = [raw];
  if (raw.startsWith("//")) {
    // Protocol-relative: the map recorded the absolute form.
    keys.push(`${new URL(table.baseUrl).protocol}${raw}`);
  } else if (raw.startsWith("/") && !raw.startsWith("//")) {
    // Site-relative: the map recorded the absolute form.
    keys.push(`${table.baseUrl}${raw}`);
  }
  return keys;
}

/** Split `…#iefix` / `…?ver=1` into path and suffix. */
function splitSuffix(raw: string): { path: string; suffix: string } {
  const index = raw.search(/[?#]/);
  if (index <= 0) return { path: raw, suffix: "" };
  return { path: raw.slice(0, index), suffix: raw.slice(index) };
}

/**
 * Resolve one captured reference against the table.
 *
 * Returns `null` when the map does not know the reference — the caller must leave
 * it byte-identical.
 */
export function lookupRewrite(table: RewriteTable, raw: string): RewriteHit | null {
  const reference = raw.trim();
  if (reference.length === 0) return null;

  for (const key of candidateKeys(table, reference)) {
    const path = table.entries.get(key);
    if (path !== undefined) return { key, path, suffix: "" };
  }

  const { path: bare, suffix } = splitSuffix(reference);
  if (suffix.length === 0) return null;
  for (const key of candidateKeys(table, bare)) {
    const path = table.entries.get(key);
    if (path !== undefined) return { key, path, suffix };
  }
  return null;
}

/** `"../".repeat(depth)` — the only thing that turns a mapped path into a URL. */
export function relativePrefix(dirDepth: number): string {
  if (!Number.isInteger(dirDepth) || dirDepth < 0) {
    throw new RewriteMapError(
      `dirDepth must be a non-negative integer (found ${String(dirDepth)})`,
    );
  }
  return "../".repeat(dirDepth);
}

/**
 * The emitted reference for a captured one, or `null` when the map has no entry.
 *
 * `dirDepth` is the number of path segments in the directory the reference
 * resolves against: `0` for `/index.html`, `1` for `/care/index.html`, and the
 * stylesheet's own directory depth for `url(...)` inside a linked file.
 */
export function relativeRewrite(
  table: RewriteTable,
  raw: string,
  dirDepth: number,
): { value: string; hit: RewriteHit } | null {
  const hit = lookupRewrite(table, raw);
  if (hit === null) return null;
  return { value: `${relativePrefix(dirDepth)}${hit.path}${hit.suffix}`, hit };
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/**
 * Matches one `url(...)` token and captures the url in whichever quoting style it
 * used. `url()` is CSS's only reference syntax that matters here; `@import
 * "x.css"` would be a second, and the capture has none (asserted in the tests).
 */
const CSS_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g;

/**
 * Rewrite `url(...)` targets inside CSS text.
 *
 * Only the url characters are replaced; the `url(`, the quoting and any inner
 * whitespace are copied from the captured bytes. That is what makes the proof
 * cheap — a diff between captured and emitted CSS can only ever show a url body.
 *
 * Relative `url()` values that the map does not know are left alone on purpose:
 * they resolved against the stylesheet's captured absolute path, and linked
 * stylesheets are emitted at that same path, so they still resolve.
 */
export function rewriteCssUrls(css: string, table: RewriteTable, dirDepth: number): RewriteResult {
  let count = 0;
  const text = css.replace(CSS_URL_PATTERN, (token, doubleQuoted, singleQuoted, bare) => {
    const url: string = (doubleQuoted ?? singleQuoted ?? bare) as string;
    const hit = relativeRewrite(table, url, dirDepth);
    if (hit === null) return token;
    count += 1;

    const offset = token.indexOf(url, "url(".length);
    if (offset < 0) return token;
    return `${token.slice(0, offset)}${hit.value}${token.slice(offset + url.length)}`;
  });
  return { text, count };
}

// ---------------------------------------------------------------------------
// HTML attributes
// ---------------------------------------------------------------------------

/**
 * Regions that are not markup and must be copied byte-for-byte: comments, and the
 * raw-text elements whose content can legitimately contain `<img src=…>` as text.
 */
const HTML_OPAQUE_PATTERN = /<!--[\s\S]*?-->|<(style|script|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** An opening tag, with its attribute text captured and quote-aware. */
const HTML_TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/** An attribute inside a tag's attribute text. */
const HTML_ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/g;

/** Which attributes are asset references, per element. Anything else is untouched. */
const REWRITTEN_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  img: ["src", "srcset"],
  source: ["srcset"],
  link: ["href"],
};

function unquote(value: string): { value: string; quote: string } {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    return { value: value.slice(1, -1), quote: value[0] ?? '"' };
  }
  return { value, quote: "" };
}

function quoteValue(value: string, quote: string): string {
  return quote === "" ? value : `${quote}${value}${quote}`;
}

/** Rewrite one `srcset` value, preserving descriptors and candidate spacing. */
function rewriteSrcset(
  value: string,
  table: RewriteTable,
  dirDepth: number,
): { value: string; count: number } {
  // A `data:` candidate carries commas of its own, so a comma split would corrupt
  // it. Leaving the attribute verbatim is the only safe choice.
  if (value.includes("data:")) return { value, count: 0 };

  let count = 0;
  const rewritten = value
    .split(",")
    .map((candidate) => {
      const leading = /^\s*/.exec(candidate)?.[0] ?? "";
      const rest = candidate.slice(leading.length);
      const trailing = /\s*$/.exec(rest)?.[0] ?? "";
      const body = rest.slice(0, rest.length - trailing.length);
      const separator = /\s+/.exec(body);
      const url = separator === null ? body : body.slice(0, separator.index);
      const descriptor = separator === null ? "" : body.slice(separator.index);

      const hit = relativeRewrite(table, url, dirDepth);
      if (hit === null) return candidate;
      count += 1;
      return `${leading}${hit.value}${descriptor}${trailing}`;
    })
    .join(",");

  return { value: rewritten, count };
}

/**
 * Rewrite asset references in HTML **by string surgery**, never by parse and
 * re-serialise.
 *
 * A tree round-trip rewrites attribute quoting, entity spelling and void-element
 * syntax; the capture proved that any of those is visual drift
 * (`docs/01-DECISIONS.md`, 2026-11-11). So the document is scanned for opening tags,
 * only the four asset-bearing attribute kinds are considered, and every other byte
 * is copied.
 */
export function rewriteHtmlUrls(
  html: string,
  table: RewriteTable,
  dirDepth: number,
): RewriteResult {
  let count = 0;

  const rewriteSegment = (segment: string): string =>
    segment.replace(HTML_TAG_PATTERN, (tag, rawName, rawAttributes) => {
      const name = String(rawName).toLowerCase();
      const allowed = REWRITTEN_ATTRIBUTES[name];
      if (allowed === undefined) return tag;

      const attributes = String(rawAttributes);
      const rewritten = attributes.replace(
        HTML_ATTRIBUTE_PATTERN,
        (attribute, rawAttributeName, separator, rawValue) => {
          const attributeName = String(rawAttributeName).toLowerCase();
          if (!allowed.includes(attributeName)) return attribute;

          const { value, quote } = unquote(String(rawValue));
          if (attributeName === "srcset") {
            const result = rewriteSrcset(value, table, dirDepth);
            if (result.count === 0) return attribute;
            count += result.count;
            return `${rawAttributeName}${separator}${quoteValue(result.value, quote)}`;
          }

          const hit = relativeRewrite(table, value, dirDepth);
          if (hit === null) return attribute;
          count += 1;
          return `${rawAttributeName}${separator}${quoteValue(hit.value, quote)}`;
        },
      );

      return rewritten === attributes ? tag : `<${rawName}${rewritten}>`;
    });

  // Comments and raw-text elements are copied verbatim; only markup segments are
  // scanned for asset attributes.
  let text = "";
  let cursor = 0;
  for (const match of html.matchAll(HTML_OPAQUE_PATTERN)) {
    text += rewriteSegment(html.slice(cursor, match.index));
    text += match[0];
    cursor = match.index + match[0].length;
  }
  text += rewriteSegment(html.slice(cursor));

  return { text, count };
}
