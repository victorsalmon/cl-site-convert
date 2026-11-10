/**
 * The SEO surface of a captured page — what the document says about itself to
 * search engines and to link unfurlers.
 *
 * This module is **pure and offline**: it reads the HTML the capture already
 * holds and returns a value. Nothing here fetches, so the whole surface can be
 * re-derived and diffed from `capture/site-ir.json` without touching the live
 * site (which is what makes it a gate rather than a survey).
 *
 * The one thing it must never do is **invent** a tag. A page with no
 * `<meta name="description">` reports `null`, and the site-level summary then
 * names `description` as `absent` — a finding an emitter can be held to. An
 * extractor that defaulted, guessed or inherited from a sibling page would turn
 * a real absence into a false presence, and the parity gate would never see it.
 */

import { decodeEntities, parseTagAttributes, textFromHtml } from "../wp-rest/dom.js";

/** SEO facts a page can be missing. Reported per page and per site. */
export type SeoField =
  | "title"
  | "description"
  | "canonical"
  | "robots"
  | "hreflang"
  | "openGraph"
  | "twitter"
  | "jsonLd";

export const SEO_FIELDS: readonly SeoField[] = [
  "title",
  "description",
  "canonical",
  "robots",
  "hreflang",
  "openGraph",
  "twitter",
  "jsonLd",
];

/** One `<meta property="og:…">` style pair, in document order. */
export interface MetaPair {
  key: string;
  content: string;
}

/** One `<link rel="alternate" hreflang="…">`. */
export interface HreflangLink {
  hreflang: string;
  href: string;
}

/** JSON-LD presence, never its payload: the payload is content, not SEO contract. */
export interface JsonLdSummary {
  /** Number of valid `application/ld+json` documents found. */
  count: number;
  /** Flattened `@type` values, in document order. */
  types: string[];
  /** Blocks that were not JSON, or not an object. Counted, never dropped. */
  invalid: number;
}

/** Everything the document declares about its own SEO surface. */
export interface SeoSurface {
  /** `<title>` text with entities decoded. */
  title: string | null;
  /** `<meta name="description">`. */
  description: string | null;
  /** `<link rel="canonical" href>` **as written** — usually absolute. */
  canonical: string | null;
  /** `<meta name="robots">`. */
  robots: string | null;
  hreflang: HreflangLink[];
  openGraph: MetaPair[];
  twitter: MetaPair[];
  jsonLd: JsonLdSummary;
  /** Fields this page does not carry. Derived, so it cannot drift from the values. */
  absent: SeoField[];
}

/** Site-level aggregation. */
export interface SeoSummary {
  pages: number;
  /** Fields absent on **every** captured page — the site-wide omission. */
  absentSiteWide: SeoField[];
  /** Per-field count of pages that carry it, so a partial surface is visible. */
  presentOn: Record<SeoField, number>;
  /** Pages whose `<title>` is missing or empty. */
  pagesWithoutTitle: string[];
}

function trimmed(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const result = value.trim();
  return result.length === 0 ? null : result;
}

function metaTags(html: string): Record<string, string>[] {
  return [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => parseTagAttributes(match[0]));
}

function linkTags(html: string): Record<string, string>[] {
  return [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => parseTagAttributes(match[0]));
}

function relValues(tag: Record<string, string>): string[] {
  return (tag["rel"] ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((value) => value.length > 0);
}

/** `og:`/`twitter:` keys in document order, entities decoded, empties dropped. */
function prefixedPairs(tags: readonly Record<string, string>[], prefix: string): MetaPair[] {
  const pairs: MetaPair[] = [];
  for (const tag of tags) {
    const key = trimmed(tag["property"] ?? tag["name"]);
    if (key === null) continue;
    if (!key.toLowerCase().startsWith(prefix)) continue;
    const content = trimmed(tag["content"]);
    if (content === null) continue;
    pairs.push({ key, content: decodeEntities(content) });
  }
  return pairs;
}

function parseJsonLd(html: string): JsonLdSummary {
  const types: string[] = [];
  let count = 0;
  let invalid = 0;

  /** `@graph` is how a theme ships several entities in one block; expand it. */
  const collect = (candidate: unknown): void => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      invalid += 1;
      return;
    }
    const record = candidate as Record<string, unknown>;
    const graph = record["@graph"];
    if (Array.isArray(graph)) {
      for (const node of graph) collect(node);
      return;
    }
    count += 1;
    const type = record["@type"];
    if (typeof type === "string") types.push(type);
    else if (Array.isArray(type)) {
      for (const entry of type) if (typeof entry === "string") types.push(entry);
    }
  };

  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    const payload = match[1] ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      invalid += 1;
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) collect(candidate);
  }

  return { count, types, invalid };
}

/** Extract the SEO surface from one page's HTML. Pure. */
export function extractSeoSurface(html: string): SeoSurface {
  const metas = metaTags(html);
  const links = linkTags(html);

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  const title = titleMatch?.[1] === undefined ? null : trimmed(textFromHtml(titleMatch[1]));

  let description: string | null = null;
  let robots: string | null = null;
  for (const tag of metas) {
    const name = (trimmed(tag["name"]) ?? "").toLowerCase();
    if (name === "description" && description === null) {
      const content = trimmed(tag["content"]);
      description = content === null ? null : decodeEntities(content);
    }
    if (name === "robots" && robots === null) {
      const content = trimmed(tag["content"]);
      robots = content === null ? null : decodeEntities(content);
    }
  }

  let canonical: string | null = null;
  const hreflang: HreflangLink[] = [];
  for (const tag of links) {
    const rels = relValues(tag);
    const href = trimmed(tag["href"]);
    if (rels.includes("canonical") && canonical === null && href !== null) canonical = href;
    const language = trimmed(tag["hreflang"]);
    if (language !== null && href !== null && rels.includes("alternate")) {
      hreflang.push({ hreflang: language.toLowerCase(), href });
    }
  }

  const openGraph = prefixedPairs(metas, "og:");
  const twitter = prefixedPairs(metas, "twitter:");
  const jsonLd = parseJsonLd(html);

  const surface: SeoSurface = {
    title,
    description,
    canonical,
    robots,
    hreflang,
    openGraph,
    twitter,
    jsonLd,
    absent: [],
  };
  surface.absent = absentFields(surface);
  return surface;
}

/** Which fields a surface does not carry. Derived from the values, never passed in. */
export function absentFields(surface: SeoSurface): SeoField[] {
  const absent: SeoField[] = [];
  if (surface.title === null) absent.push("title");
  if (surface.description === null) absent.push("description");
  if (surface.canonical === null) absent.push("canonical");
  if (surface.robots === null) absent.push("robots");
  if (surface.hreflang.length === 0) absent.push("hreflang");
  if (surface.openGraph.length === 0) absent.push("openGraph");
  if (surface.twitter.length === 0) absent.push("twitter");
  if (surface.jsonLd.count === 0) absent.push("jsonLd");
  return absent;
}

/** Aggregate the per-page surfaces into the site-level omission list. */
export function summariseSeo(pages: readonly { url: string; surface: SeoSurface }[]): SeoSummary {
  const presentOn = Object.fromEntries(SEO_FIELDS.map((field) => [field, 0])) as Record<
    SeoField,
    number
  >;
  const pagesWithoutTitle: string[] = [];

  for (const page of pages) {
    const absent = new Set(page.surface.absent);
    for (const field of SEO_FIELDS) {
      if (!absent.has(field)) presentOn[field] += 1;
    }
    if (page.surface.title === null) pagesWithoutTitle.push(page.url);
  }

  return {
    pages: pages.length,
    absentSiteWide: SEO_FIELDS.filter((field) => presentOn[field] === 0),
    presentOn,
    pagesWithoutTitle,
  };
}
