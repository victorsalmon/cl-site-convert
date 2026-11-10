/**
 * Broken references, reconciled into one list the SEO emitter and the defect bead
 * can both read.
 *
 * Two independent source passes found the same class of defect from different
 * angles, which is exactly why the findings have to be merged rather than reported
 * twice:
 *
 *  - **Route enumeration (B1.1)** followed `<a href>` targets and found three
 *    scheme-less `href="chatgpt.com"` links that 404. A browser resolves
 *    `chatgpt.com` *relative to the page*, so the failing URL is
 *    `/mlm/applym/chatgpt.com` — not `https://chatgpt.com`. That distinction is the
 *    whole defect: the author meant an external site and wrote a relative path.
 *  - **Asset capture (B1.3)** fetched every `<img>`/`srcset` reference and found two
 *    404 images on one page.
 *
 * Neither list alone is the answer the emitter needs, because the emitter must
 * **not reproduce** the bad reference and must **not silently repair** it either:
 * repairing `chatgpt.com` into `https://chatgpt.com` changes what the page links
 * to, which is a content decision. So each finding carries a severity, and the
 * severity says whether fidelity or correctness wins.
 */

export type ReferenceKind = "link" | "image";

/** The attribute the reference came from. `srcset` is a candidate, not the main image. */
export type ReferenceWhere = "href" | "src" | "srcset";

/** Severity vocabulary, used verbatim in the sidecar and the defect bead. */
export type ReferenceSeverity = "high" | "medium" | "low";

/** One raw reference found in a captured page. */
export interface RawReference {
  kind: ReferenceKind;
  /** Which attribute carried it. */
  where: ReferenceWhere;
  /** Exactly as the attribute carries it — the fidelity record. */
  raw: string;
  /** Absolute URL a browser would request, after relative resolution. */
  resolved: string;
  /** Captured page the reference appears on. */
  page: string;
}

/** A broken reference, with every page that carries it and the recorded status. */
export interface BrokenReference {
  /** Stable slug, e.g. `scheme-less-chatgpt-com-link`. */
  id: string;
  /** The worst way this URL is referenced: a clickable link outranks an image. */
  kind: ReferenceKind;
  /** Every attribute that carries it. A gallery link + `srcset` candidate is both. */
  attributes: ReferenceWhere[];
  raw: string;
  resolved: string;
  pages: string[];
  /** Live status recorded for `resolved`, or `null` when it was never requested. */
  status: number | null;
  severity: ReferenceSeverity;
  /** Where the status came from, so a reader can judge it. */
  statusSource: "live-probe" | "asset-capture" | "none";
  finding: string;
}

/**
 * Does this `href` look like a hostname with the scheme left off?
 *
 * The test is deliberately narrow. `chatgpt.com` qualifies; `apply` does not, and a
 * relative file reference (`Moving-Inspection-Worksheet-v5.2.pdf`, `photo.jpg`) is
 * excluded by extension because a browser serving a file is not a missing scheme.
 * A false positive here would relabel a legitimate relative link as a scheme-less
 * host, which is worse than missing one — the page's own resolution is recorded
 * either way, so only the human explanation changes.
 */
export function looksLikeSchemeLessHost(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false; // has a scheme
  if (value.startsWith("/") || value.startsWith("#") || value.startsWith("?")) return false;

  const withoutSuffix = value.split(/[/?#]/)[0] ?? "";
  const extension = /\.([a-z0-9]{1,5})$/i.exec(withoutSuffix)?.[1]?.toLowerCase();
  if (extension !== undefined && FILE_EXTENSIONS.has(extension)) return false;

  return /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(withoutSuffix);
}

/** Extensions that mean "a file", never "a top-level domain". */
const FILE_EXTENSIONS = new Set([
  "pdf",
  "html",
  "htm",
  "php",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "svg",
  "webp",
  "avif",
  "ico",
  "css",
  "js",
  "xml",
  "txt",
  "zip",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "mp4",
  "mp3",
  "woff",
  "woff2",
  "ttf",
  "json",
]);

/** Absolute URL a browser would request for a reference on `pagePath`. */
export function resolveReference(raw: string, pagePath: string, baseUrl: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (/^(?:mailto|tel|javascript|data):/i.test(value)) return null;
  try {
    return new URL(value, new URL(pagePath, baseUrl)).toString();
  } catch {
    return null;
  }
}

/** Site-relative `path`+`search`+`hash` of an absolute URL. */
export function referencePath(resolved: string, baseUrl: string): string {
  try {
    const url = new URL(resolved);
    const base = new URL(baseUrl);
    if (url.host !== base.host) return resolved;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return resolved;
  }
}

/** Every `<a href>` and `<img src>`/`srcset` candidate on one page. */
export function scanReferences(
  html: string,
  page: string,
  baseUrl: string,
): { links: RawReference[]; images: RawReference[] } {
  const links: RawReference[] = [];
  const images: RawReference[] = [];
  const seen = new Set<string>();

  const push = (kind: ReferenceKind, where: ReferenceWhere, raw: string): void => {
    const value = raw.trim();
    if (value.length === 0) return;
    const key = `${kind}|${value}`;
    if (seen.has(key)) return;
    const resolved = resolveReference(value, page, baseUrl);
    if (resolved === null) return;
    seen.add(key);
    const reference: RawReference = { kind, where, raw: value, resolved, page };
    if (kind === "link") links.push(reference);
    else images.push(reference);
  };

  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    push("link", "href", match[1] ?? match[2] ?? "");
  }
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    push("image", "src", match[1] ?? match[2] ?? "");
  }
  for (const match of html.matchAll(/<img\b[^>]*?\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = match[1] ?? match[2] ?? "";
    for (const candidate of value.split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url !== undefined) push("image", "srcset", url);
    }
  }

  return { links, images };
}

/** Group references by their resolved URL, keeping every page and attribute that carries one. */
export function groupReferences(references: readonly RawReference[]): Map<
  string,
  {
    kinds: ReferenceKind[];
    wheres: ReferenceWhere[];
    raw: string;
    pages: string[];
  }
> {
  const grouped = new Map<
    string,
    { kinds: ReferenceKind[]; wheres: ReferenceWhere[]; raw: string; pages: string[] }
  >();
  for (const reference of references) {
    const existing = grouped.get(reference.resolved);
    if (existing === undefined) {
      grouped.set(reference.resolved, {
        kinds: [reference.kind],
        wheres: [reference.where],
        raw: reference.raw,
        pages: [reference.page],
      });
      continue;
    }
    if (!existing.pages.includes(reference.page)) existing.pages.push(reference.page);
    if (!existing.kinds.includes(reference.kind)) existing.kinds.push(reference.kind);
    if (!existing.wheres.includes(reference.where)) existing.wheres.push(reference.where);
  }
  for (const entry of grouped.values()) entry.pages.sort();
  return grouped;
}

/** A recorded status for a reference, from whichever pass fetched it. */
export interface RecordedStatus {
  status: number;
  source: "live-probe" | "asset-capture";
}

/**
 * Severity, stated once so both consumers inherit the same rule.
 *
 *  - **high** — a reference a visitor can click that 404s. That includes a scheme-less
 *    `href` that resolves to a path (a dead navigation target) *and* a gallery
 *    `<a href>` pointing at a missing image: both are a click that ends in a 404.
 *  - **medium** — an `<img src>` that 404s. Visually wrong but parity-neutral: the old
 *    page is equally broken, so copying it preserves fidelity; it still gets fixed.
 *  - **low** — a `srcset` candidate the browser only picks on a particular viewport.
 */
export function severityFor(
  kinds: readonly ReferenceKind[],
  wheres: readonly ReferenceWhere[],
): ReferenceSeverity {
  if (kinds.includes("link") || wheres.includes("href")) return "high";
  if (wheres.includes("srcset") && !wheres.includes("src")) return "low";
  return "medium";
}

/**
 * Reconcile the scanned references against the statuses the two capture passes
 * recorded. Only references that are **proven** broken are returned: a reference
 * with no recorded status is not a finding, it is an un-asked question, and saying
 * otherwise would put noise in the defect list.
 */
export function reconcileBrokenReferences(input: {
  references: readonly RawReference[];
  /** Keyed by resolved absolute URL. */
  statuses: ReadonlyMap<string, RecordedStatus>;
}): BrokenReference[] {
  const grouped = groupReferences(input.references);
  const findings: BrokenReference[] = [];

  for (const [resolved, entry] of grouped) {
    const recorded = input.statuses.get(resolved);
    if (recorded === undefined) continue;
    if (recorded.status < 400) continue;

    // A clickable link outranks an image reference for the primary label.
    const kind: ReferenceKind = entry.kinds.includes("link") ? "link" : "image";
    const severity = severityFor(entry.kinds, entry.wheres);
    findings.push({
      id: slugFor(resolved, entry.raw, kind),
      kind,
      attributes: entry.wheres,
      raw: entry.raw,
      resolved,
      pages: entry.pages,
      status: recorded.status,
      severity,
      statusSource: recorded.source,
      finding: describeFinding({
        kinds: entry.kinds,
        wheres: entry.wheres,
        raw: entry.raw,
        resolved,
        status: recorded.status,
      }),
    });
  }

  const order: Record<ReferenceSeverity, number> = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
}

function slugFor(resolved: string, raw: string, kind: ReferenceKind): string {
  const pathSlug = slugify(safePathOf(resolved) ?? resolved);
  if (kind === "link" && looksLikeSchemeLessHost(raw)) {
    // The raw value is identical on every page that carries the mistake, so the id
    // must include where it resolves to — otherwise three distinct findings share one
    // id and a bead cannot cite them individually.
    return `scheme-less-${slugify(raw)}-link-${pathSlug}`;
  }
  return `${kind}-${pathSlug}`;
}

function safePathOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return null;
  }
}

function slugify(value: string): string {
  return value
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function describeFinding(input: {
  kinds: readonly ReferenceKind[];
  wheres: readonly ReferenceWhere[];
  raw: string;
  resolved: string;
  status: number;
}): string {
  const where = input.wheres.join(" + ");
  if (input.wheres.includes("href") && looksLikeSchemeLessHost(input.raw)) {
    return (
      `The href is \`${input.raw}\` with no scheme, so the browser resolves it as a path relative to the page ` +
      `and requests \`${input.resolved}\`, which answers ${input.status}. The author meant an external site. ` +
      "Fidelity says copy it; correctness says fix it. That is a content decision, so it is recorded, not silently repaired."
    );
  }
  if (input.wheres.includes("href")) {
    return (
      `A clickable \`href\` (${where}) points at \`${input.resolved}\`, which answers ${input.status} on the live ` +
      "site too. Copying it keeps parity; the fix is one source-file repair upstream."
    );
  }
  if (input.kinds.includes("image")) {
    return (
      `The ${where} reference \`${input.raw}\` answers ${input.status} on the live site too, so the old page ` +
      "renders the same missing image. Copying it keeps parity; the two entries are one fix (re-upload the source image)."
    );
  }
  return `\`${input.raw}\` resolves to \`${input.resolved}\`, which answers ${input.status}.`;
}
