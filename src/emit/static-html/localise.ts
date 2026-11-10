/**
 * Emit-time **self-reference localisation** — the transform that makes the emitted
 * tree self-contained.
 *
 * B2.1 rewrote *asset* references and left every other reference as captured, so the
 * delivered site was still a mirror that pointed home: 367 absolute
 * `https://upscalehavens.ca/…` references across the 19 pages. On a `*.pages.dev`
 * preview that means internal navigation jumps back to the live WordPress site,
 * forms post to production, and the artefact knows a host it should not know.
 *
 * The rules, and why each one is shaped the way it is:
 *
 *  1. **Every absolute reference to the capture's own origin becomes site-root
 *     relative.** Path, query and fragment bytes are preserved verbatim: the origin
 *     prefix is the only thing removed, so `…/care/?x=1#arrival` → `/care/?x=1#arrival`.
 *     Root-relative is what makes the tree portable across a host root, a preview
 *     subpath and a custom domain without rewriting anything.
 *  2. **Navigation to one of the captured routes is recorded separately** from other
 *     internal links. Both are root-relative; the difference is that a route target
 *     is known to exist in the emitted tree, while a `/feed/` or `/wp-json/` target
 *     only ever existed on WordPress (see rule 7).
 *  3. **Form actions never reach the old site.** Every `form[action]` pointing at the
 *     source origin is re-pointed at a configured sink endpoint. The default
 *     (`/api/submit`) does not exist yet — the forms-sink bead owns it — and that is
 *     reported loudly rather than hidden, because a form that silently posts nowhere
 *     is worse than one that fails visibly.
 *  4. **Canonical links stay absolute**, per SEO requirement, with the host taken from
 *     a per-target `--base-url`. A `*.pages.dev` preview and the apex are different
 *     deployments of the same artifact and must declare different canonicals; keeping
 *     the captured origin would tell search engines the new site is a duplicate of
 *     the old one.
 *  5. **`<meta content>` image references are localised through the asset map** when
 *     the capture holds the bytes, and left untouched *and reported* when it does not.
 *     `msapplication-TileImage` is the live case: its logo was captured, so it
 *     localises.
 *  6. **Deferred Divi CSS is not touched.** `<link rel="preload" as="style"
 *     onload="…">` points at CSS that was never captured (`cl-site-convert-mzi` owns
 *     that). Leaving it byte-identical and naming it in the allowlist keeps the
 *     verification test honest instead of weakening it.
 *  7. **Nothing is deleted and nothing is normalised.** A WordPress discovery link
 *     (`rel="alternate"` feeds, `wp-json`, `xmlrpc`, `shortlink`) becomes
 *     `/feed/`-shaped rather than being dropped: dropping a captured element is a
 *     fidelity change this bead does not own, and every byte outside the rewritten
 *     attribute value is still the captured byte.
 *  8. **External references are never touched.** `drive.google.com`,
 *     `signal.group`, `youtube.com`, `fonts.gstatic.com`, `mailto:` — anything not on
 *     the source origin passes through byte-identical. The detector in this module
 *     only ever matches the source origin, so a bare `upscalehavens.ca` inside a
 *     `mailto:` address is not a reference and is not touched.
 */

import type { RewriteTable } from "./rewrite.js";
import { lookupRewrite, relativePrefix } from "./rewrite.js";

/** What a rewritten reference became. Used for the report and for the allowlist test. */
export type SelfReferenceCategory =
  "navigation" | "internal-link" | "canonical" | "form-action" | "meta-asset";

/** An absolute self-reference that emission deliberately leaves absolute. */
export type ResidualCategory = "canonical" | "deferred-css" | "unlocalisable";

/** Everything the localisation pass needs. Built once per emit run. */
export interface LocalisationConfig {
  /** The capture's own origin, e.g. `https://upscalehavens.ca`. Only this is "self". */
  readonly sourceOrigin: string;
  /** This target's canonical origin, e.g. `https://site.upscalehavens.ca`. */
  readonly baseUrl: string;
  /** Where form submissions go: a site-root-relative path or an absolute URL. */
  readonly formSink: string;
  /** Route paths the emitted tree serves, e.g. `/care/`. */
  readonly routes: ReadonlySet<string>;
  /** Page directory depth, for the `../` prefix an asset reference needs. */
  readonly dirDepth: number;
  /** Captured reference → emitted path, for `<meta content>` image URLs. */
  readonly table: RewriteTable;
}

/** One reference that was rewritten. */
export interface SelfReferenceRewrite {
  readonly tag: string;
  readonly attribute: string;
  readonly from: string;
  readonly to: string;
  readonly category: SelfReferenceCategory;
  /** The captured route the reference targeted, when it targeted one. */
  readonly route?: string;
}

/** A reference the capture cannot localise: the bytes were never captured. */
export interface UnlocalisableReference {
  readonly tag: string;
  readonly attribute: string;
  readonly value: string;
  readonly reason: string;
}

/** The rewritten document plus the evidence a report and a test can assert on. */
export interface LocalisationResult {
  readonly text: string;
  readonly rewrites: readonly SelfReferenceRewrite[];
  readonly unlocalisable: readonly UnlocalisableReference[];
  /** Rewrites per category, for the report. */
  readonly counts: Readonly<Record<SelfReferenceCategory, number>>;
}

/** Thrown when the localisation configuration cannot be used. */
export class LocalisationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalisationError";
  }
}

// ---------------------------------------------------------------------------
// Origin handling
// ---------------------------------------------------------------------------

/** Normalise an origin: absolute http(s), no trailing slash, no path. */
export function normaliseOrigin(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LocalisationError(`${what} ${JSON.stringify(value)} is not an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LocalisationError(`${what} ${JSON.stringify(value)} must be http or https`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new LocalisationError(
      `${what} ${JSON.stringify(value)} must be a bare origin (no path, query or fragment)`,
    );
  }
  return url.origin;
}

/** Accept either a site-root-relative path or an absolute http(s) URL as the sink. */
export function normaliseFormSink(value: string): string {
  const sink = value.trim();
  if (sink.length === 0) throw new LocalisationError("form sink must not be empty");
  if (sink.startsWith("/") && !sink.startsWith("//")) return sink;
  if (/^https?:\/\//i.test(sink)) return sink;
  throw new LocalisationError(
    `form sink ${JSON.stringify(value)} must start with / or be an absolute http(s) URL`,
  );
}

/**
 * Is this value an *absolute reference* to the source origin?
 *
 * Only the three absolute spellings count: `https://host…`, `http://host…` and the
 * protocol-relative `//host…`. A `mailto:` address that happens to contain the host
 * (`mill.lake@upscalehavens.ca`) is not a reference, and an absolute self-reference
 * embedded inside a query string (`?url=https%3A%2F%2F…`) is data, not a reference.
 */
export function isAbsoluteSelfReference(value: string, sourceOrigin: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const host = sourceOrigin.replace(/^https?:/i, "");
  return (
    trimmed.toLowerCase().startsWith(`${sourceOrigin.toLowerCase()}/`) ||
    trimmed.toLowerCase() === sourceOrigin.toLowerCase() ||
    trimmed.toLowerCase().startsWith(`${host.toLowerCase()}/`) ||
    trimmed.toLowerCase() === host.toLowerCase()
  );
}

/** Every absolute spelling of the source origin, longest first, for prefix stripping. */
function originPrefixes(sourceOrigin: string): string[] {
  const host = sourceOrigin.replace(/^https?:/i, "");
  return [`${sourceOrigin}/`, `${host}/`, sourceOrigin, host];
}

/**
 * Strip the source origin from an absolute self-reference, keeping every other byte.
 *
 * No `URL` round-trip: the capture contains `&#038;` entities and other
 * byte-level oddities inside query strings, and a parse-and-re-serialise would
 * rewrite them. The prefix is matched case-insensitively and removed; the remainder
 * — path, query, fragment, entities and all — is copied exactly.
 */
export function toSiteRootRelative(value: string, sourceOrigin: string): string | null {
  const trimmed = value.trim();
  const leading = value.slice(0, value.length - value.trimStart().length);
  for (const prefix of originPrefixes(sourceOrigin)) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      const remainder = trimmed.slice(prefix.length);
      return `${leading}/${remainder}`;
    }
  }
  if (trimmed.toLowerCase() === sourceOrigin.toLowerCase()) return `${leading}/`;
  return null;
}

/** The route path a relative reference targets, without its query or fragment. */
export function routeOf(value: string): string {
  const cut = value.search(/[?#]/);
  return cut < 0 ? value : value.slice(0, cut);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** One absolute self-reference found in a document. */
export interface AbsoluteSelfReference {
  readonly tag: string;
  readonly attribute: string;
  /** The value as it appears, unquoted. For `srcset`, one entry per candidate URL. */
  readonly value: string;
  /** `rel` tokens lowercased, when the element has one (`link`). */
  readonly rel: readonly string[];
  /** `name` for a `meta`, `method` for a `form`; otherwise `null`. */
  readonly hint: string | null;
  /** True when the value is a `srcset` candidate rather than the whole attribute. */
  readonly srcset: boolean;
}

/** An absolute self-reference that emission deliberately leaves alone. */
export interface ResidualReference extends AbsoluteSelfReference {
  readonly category: ResidualCategory;
  readonly reason: string;
}

/**
 * Is this `link` a Deferred-CSS asset?
 *
 * Divi emits `<link rel="preload" as="style" … onload="this.rel='stylesheet'">` for
 * per-page dynamic CSS, and the capture never fetched those files — so their href is
 * an absolute self-reference that emission must preserve verbatim. Both evidence
 * forms are accepted: the preload/onload shape, and the `et-cache` path shape.
 */
export function isDeferredCssLink(rel: readonly string[], href: string): boolean {
  const isPreload = rel.includes("preload");
  const looksDeferred =
    /\/wp-content\/et-cache\/.*(?:deferred|et-core-unified|et-divi-dynamic)/i.test(href);
  return (isPreload && rel.includes("style")) || looksDeferred;
}

/** Reason text for a residual category, so every allowlisted entry says why. */
export const RESIDUAL_REASONS: Readonly<Record<ResidualCategory, string>> = {
  canonical:
    "SEO: a canonical URL must be absolute; it is rewritten at emit to the per-target --base-url, never relativised",
  "deferred-css":
    'Divi deferred CSS (<link rel="preload" as="style" onload="…">) was never captured by B1.3, so its bytes do not exist to localise; owned by cl-site-convert-mzi',
  unlocalisable:
    "the capture holds no bytes for this reference (the live site 404s it), so it cannot be re-pointed; reported, not silently dropped",
};

// ---------------------------------------------------------------------------
// Tag scanning
// ---------------------------------------------------------------------------

/** Regions that are not markup: comments and raw-text elements. */
const OPAQUE_PATTERN = /<!--[\s\S]*?-->|<(style|script|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** An opening tag with quote-aware boundary detection. */
const TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/** An attribute inside a tag's attribute text. */
const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/g;

/** Attributes that can carry a self-reference, per element. Any other is untouched. */
const REFERENCE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href"],
  link: ["href"],
  form: ["action"],
  meta: ["content"],
  img: ["src", "srcset"],
  source: ["srcset"],
};

interface ScannedAttribute {
  readonly name: string;
  readonly value: string;
  /** Offset of the value, quotes included, inside the tag. */
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

interface ScannedTag {
  readonly name: string;
  readonly text: string;
  readonly attributes: readonly ScannedAttribute[];
}

function unquote(raw: string): { value: string; quote: string } {
  if (raw.length >= 2 && (raw.startsWith('"') || raw.startsWith("'"))) {
    return { value: raw.slice(1, -1), quote: raw[0] ?? '"' };
  }
  return { value: raw, quote: "" };
}

function scanTag(text: string, name: string): ScannedTag {
  const attributes: ScannedAttribute[] = [];
  for (const match of text.matchAll(ATTRIBUTE_PATTERN)) {
    const attributeName = (match[1] ?? "").toLowerCase();
    const separator = match[2] ?? "";
    const raw = match[3] ?? "";
    const { value, quote } = unquote(raw);
    const start = (match.index ?? 0) + attributeName.length + separator.length;
    attributes.push({ name: attributeName, value, start, end: start + raw.length, quote });
  }
  return { name: name.toLowerCase(), text, attributes };
}

function attributeOf(tag: ScannedTag, name: string): ScannedAttribute | null {
  return tag.attributes.find((attribute) => attribute.name === name) ?? null;
}

/**
 * Split a `srcset` value into its candidate URLs, keeping offsets so a rewrite can be
 * spliced back without touching descriptors or spacing.
 */
function srcsetCandidates(value: string): { url: string; start: number; end: number }[] {
  // A `data:` candidate carries commas of its own, so it is never split (the asset
  // pass makes the same call).
  if (value.includes("data:")) return [];
  const candidates: { url: string; start: number; end: number }[] = [];
  let cursor = 0;
  for (const part of value.split(",")) {
    const leading = /^\s*/.exec(part)?.[0]?.length ?? 0;
    const body = part.slice(leading);
    const url = body.split(/\s+/)[0] ?? "";
    if (url.length > 0) {
      const start = cursor + leading;
      candidates.push({ url, start, end: start + url.length });
    }
    cursor += part.length + 1;
  }
  return candidates;
}

/** Every absolute self-reference in a document, in document order. */
export function findAbsoluteSelfReferences(
  html: string,
  sourceOrigin: string,
): AbsoluteSelfReference[] {
  const found: AbsoluteSelfReference[] = [];
  const scan = (segment: string): void => {
    for (const match of segment.matchAll(TAG_PATTERN)) {
      const name = (match[1] ?? "").toLowerCase();
      const allowed = REFERENCE_ATTRIBUTES[name];
      if (allowed === undefined) continue;
      const tag = scanTag(match[0], name);
      const rel = (attributeOf(tag, "rel")?.value ?? "").toLowerCase().split(/\s+/).filter(Boolean);

      for (const attributeName of allowed) {
        const attribute = attributeOf(tag, attributeName);
        if (attribute === null) continue;
        const hint =
          name === "meta"
            ? (attributeOf(tag, "name")?.value ?? null)
            : name === "form"
              ? (attributeOf(tag, "method")?.value ?? null)
              : null;

        if (attributeName === "srcset") {
          for (const candidate of srcsetCandidates(attribute.value)) {
            if (!isAbsoluteSelfReference(candidate.url, sourceOrigin)) continue;
            found.push({
              tag: name,
              attribute: attributeName,
              value: candidate.url,
              rel,
              hint,
              srcset: true,
            });
          }
          continue;
        }

        if (!isAbsoluteSelfReference(attribute.value, sourceOrigin)) continue;
        found.push({
          tag: name,
          attribute: attributeName,
          value: attribute.value,
          rel,
          hint,
          srcset: false,
        });
      }
    }
  };

  let cursor = 0;
  for (const match of html.matchAll(OPAQUE_PATTERN)) {
    scan(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;
  }
  scan(html.slice(cursor));
  return found;
}

/**
 * Classify one residual reference.
 *
 * This is the allowlist's policy expressed as code: a surviving absolute
 * self-reference is legitimate only as a canonical URL, a deferred-CSS asset, or a
 * reference whose bytes the capture never held.
 */
export function classifyResidual(
  reference: AbsoluteSelfReference,
  options: { readonly resolvable: (value: string) => boolean },
): { category: ResidualCategory; reason: string } {
  if (reference.tag === "link" && reference.rel.includes("canonical")) {
    return { category: "canonical", reason: RESIDUAL_REASONS.canonical };
  }
  if (reference.tag === "link" && isDeferredCssLink(reference.rel, reference.value)) {
    return { category: "deferred-css", reason: RESIDUAL_REASONS["deferred-css"] };
  }
  // Only an element whose *only* localisation path is the asset map may be excused for
  // having no bytes. Anything else that survived emission is a localisation defect.
  if (
    (reference.tag === "img" || reference.tag === "source" || reference.tag === "meta") &&
    !options.resolvable(reference.value)
  ) {
    return { category: "unlocalisable", reason: RESIDUAL_REASONS.unlocalisable };
  }
  throw new LocalisationError(
    `absolute self-reference <${reference.tag} ${reference.attribute}="${reference.value}"> ` +
      `is not a canonical URL, a deferred-CSS asset, or an unlocalisable asset — it is a ` +
      `localisation defect, not an allowlist entry`,
  );
}

// ---------------------------------------------------------------------------
// Captured-document classification (the "before" table)
// ---------------------------------------------------------------------------

/**
 * The report's full taxonomy for a captured absolute self-reference.
 *
 * Three buckets are handled by passes that run **before** this one, and naming them
 * separately is what makes the before/after table honest: `stylesheet` links are
 * removed and rebuilt by the cascade transform, and `asset` references are localised
 * by the asset pass. This module neither sees them nor claims credit for them.
 */
export type CapturedCategory = SelfReferenceCategory | "stylesheet" | "asset" | ResidualCategory;

/**
 * Classify one absolute self-reference **as captured**, i.e. which emit step will
 * localise it (or why none can).
 */
export function classifyCapturedReference(
  reference: AbsoluteSelfReference,
  config: Pick<LocalisationConfig, "table" | "routes" | "sourceOrigin">,
): CapturedCategory {
  const resolvable = lookupRewrite(config.table, reference.value) !== null;

  if (reference.tag === "link" && reference.rel.includes("stylesheet")) return "stylesheet";
  if (reference.tag === "link" && reference.rel.includes("canonical")) return "canonical";
  if (reference.tag === "link" && isDeferredCssLink(reference.rel, reference.value)) {
    return "deferred-css";
  }
  if (reference.tag === "form") return "form-action";

  if (reference.tag === "meta") return resolvable ? "meta-asset" : "unlocalisable";

  if (reference.tag === "img" || reference.tag === "source") {
    return resolvable ? "asset" : "unlocalisable";
  }
  // `link[href]` that is not a stylesheet: the asset pass claimed every value the map
  // knows, so a survivor here is an internal link (`/feed/`, `/wp-json/`, …).
  if (reference.tag === "link" && resolvable) return "asset";

  const relative = toSiteRootRelative(reference.value, config.sourceOrigin);
  const route = relative === null ? null : routeOf(relative);
  return route !== null && config.routes.has(route) ? "navigation" : "internal-link";
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

function emptyCounts(): Record<SelfReferenceCategory, number> {
  return { navigation: 0, "internal-link": 0, canonical: 0, "form-action": 0, "meta-asset": 0 };
}

/** Render a new attribute value, preserving the tag's quoting. */
function withValue(attribute: ScannedAttribute, value: string): string {
  return attribute.quote === "" ? value : `${attribute.quote}${value}${attribute.quote}`;
}

/** One attribute substitution inside a tag, applied right-to-left so offsets hold. */
interface AttributeEdit {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

function applyEdits(tagText: string, edits: readonly AttributeEdit[]): string {
  let text = tagText;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    text = `${text.slice(0, edit.start)}${edit.value}${text.slice(edit.end)}`;
  }
  return text;
}

/**
 * Rewrite the self-references in one document.
 *
 * String surgery again, never parse-and-re-serialise: the capture's attribute
 * quoting, entity spelling and void-element syntax are part of the fidelity carrier,
 * and only the characters inside the rewritten value are allowed to move.
 */
export function rewriteSelfReferences(
  html: string,
  config: LocalisationConfig,
): LocalisationResult {
  const rewrites: SelfReferenceRewrite[] = [];
  const unlocalisable: UnlocalisableReference[] = [];
  const counts = emptyCounts();

  const rewriteSegment = (segment: string): string =>
    segment.replace(TAG_PATTERN, (tagText, rawName) => {
      const name = String(rawName).toLowerCase();
      const allowed = REFERENCE_ATTRIBUTES[name];
      if (allowed === undefined) return tagText;

      const tag = scanTag(tagText, name);
      const rel = (attributeOf(tag, "rel")?.value ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const edits: AttributeEdit[] = [];

      for (const attributeName of allowed) {
        const attribute = attributeOf(tag, attributeName);
        if (attribute === null) continue;

        if (attributeName === "srcset") {
          for (const candidate of srcsetCandidates(attribute.value)) {
            if (!isAbsoluteSelfReference(candidate.url, config.sourceOrigin)) continue;
            // A `srcset` the asset pass already rewrote is no longer absolute; a survivor
            // means the capture has no bytes for that candidate.
            if (lookupRewrite(config.table, candidate.url) !== null) continue;
            unlocalisable.push({
              tag: name,
              attribute: attributeName,
              value: candidate.url,
              reason: RESIDUAL_REASONS.unlocalisable,
            });
          }
          continue;
        }

        const value = attribute.value;
        if (!isAbsoluteSelfReference(value, config.sourceOrigin)) continue;

        const next = localiseValue(name, rel, value, config);
        if (next === null) {
          unlocalisable.push({
            tag: name,
            attribute: attributeName,
            value,
            reason: RESIDUAL_REASONS.unlocalisable,
          });
          continue;
        }
        if (next.value === value) continue;

        edits.push({
          start: attribute.start,
          end: attribute.end,
          value: withValue(attribute, next.value),
        });
        rewrites.push({
          tag: name,
          attribute: attributeName,
          from: value,
          to: next.value,
          category: next.category,
          ...(next.route === undefined ? {} : { route: next.route }),
        });
        counts[next.category] += 1;
      }

      return edits.length === 0 ? tagText : applyEdits(tagText, edits);
    });

  let text = "";
  let cursor = 0;
  for (const match of html.matchAll(OPAQUE_PATTERN)) {
    text += rewriteSegment(html.slice(cursor, match.index));
    text += match[0];
    cursor = match.index + match[0].length;
  }
  text += rewriteSegment(html.slice(cursor));

  return { text, rewrites, unlocalisable, counts };
}

/** The rewritten value for one absolute self-reference, or `null` when it cannot be. */
function localiseValue(
  tag: string,
  rel: readonly string[],
  value: string,
  config: LocalisationConfig,
): { value: string; category: SelfReferenceCategory; route?: string } | null {
  // Canonical stays absolute, on this target's host. This is the SEO exception.
  if (tag === "link" && rel.includes("canonical")) {
    const relative = toSiteRootRelative(value, config.sourceOrigin);
    if (relative === null) return null;
    return { value: `${config.baseUrl}${relative}`, category: "canonical" };
  }

  // Deferred CSS was never captured; it is preserved byte-identically and allowlisted.
  if (tag === "link" && isDeferredCssLink(rel, value)) return { value, category: "internal-link" };

  // A form action never reaches the old site: it points at the configured sink.
  if (tag === "form") return { value: config.formSink, category: "form-action" };

  // A `<meta content>` image localises through the asset map when the bytes exist.
  if (tag === "meta") {
    const hit = lookupRewrite(config.table, value);
    if (hit === null) return null;
    return {
      value: `${relativePrefix(config.dirDepth)}${hit.path}${hit.suffix}`,
      category: "meta-asset",
    };
  }

  // `img`/`source` are the asset pass's business; a survivor is unlocalisable.
  if (tag === "img" || tag === "source") return null;

  const relative = toSiteRootRelative(value, config.sourceOrigin);
  if (relative === null) return null;
  const route = routeOf(relative);
  return config.routes.has(route)
    ? { value: relative, category: "navigation", route }
    : { value: relative, category: "internal-link" };
}
