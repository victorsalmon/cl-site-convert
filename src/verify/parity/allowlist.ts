/**
 * Residual absolute self-references — equality against the committed allowlist.
 *
 * This check does not invent its own list. `tests/fixtures/self-contained/allowlist.json`
 * is the single source of truth (the emitter's own acceptance suite asserts against the
 * same file), and the gate reuses the *classification* it stands for via
 * `classifyResidual`-class rules rather than trusting a copy:
 *
 * | Category | Why it may survive |
 * | :--- | :--- |
 * | `canonical` | SEO requires an absolute URL; it names its own route on `--base-url` |
 * | `deferred-css` | Divi deferred CSS was never captured; owned by `cl-site-convert-mzi` |
 * | `unlocalisable` | the capture holds no bytes, so there is nothing to point at |
 *
 * Every entry is justified **independently**: the captured document must contain the
 * value verbatim, a canonical must name its own route, and anything else may only
 * survive because the asset map has no entry for it. A fourth category cannot appear
 * without failing; a new absolute self-reference cannot appear without failing either.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { findAbsoluteSelfReferences, isDeferredCssLink } from "../../emit/static-html/localise.js";
import { lookupRewrite } from "../../emit/static-html/rewrite.js";
import type { RewriteTable } from "../../emit/static-html/rewrite.js";
import type { ParityFailure } from "./types.js";

/** One reference, identified the way the fixture identifies it. */
export interface AllowlistEntry {
  readonly page: string;
  readonly tag: string;
  readonly attribute: string;
  readonly value: string;
}

/** The committed fixture. */
export interface AllowlistFixture {
  readonly note: string;
  readonly sourceOrigin: string;
  readonly entries: readonly AllowlistEntry[];
}

/** The composition of the allowlist, re-derived entry by entry. */
export interface ResidualComposition {
  readonly canonical: number;
  readonly "deferred-css": number;
  readonly unlocalisable: number;
}

export interface ResidualResult {
  /** What the artefact actually carries. */
  readonly measured: readonly AllowlistEntry[];
  /** Allowlisted references the artefact no longer carries. */
  readonly missing: readonly AllowlistEntry[];
  /** References the artefact carries that no rule justifies. */
  readonly unexpected: readonly AllowlistEntry[];
  /** Residual count per page, for the per-page table. */
  readonly perPage: ReadonlyMap<string, number>;
  readonly composition: ResidualComposition;
  readonly failures: readonly ParityFailure[];
}

/** Stable identity for an entry, so set equality is exact. */
export function allowlistKey(entry: AllowlistEntry): string {
  return `${entry.page}\u0000${entry.tag}\u0000${entry.attribute}\u0000${entry.value}`;
}

/** Load the committed fixture. A missing file is a cannot-evaluate, not a pass. */
export function loadAllowlist(path: string): AllowlistFixture {
  const document = JSON.parse(readFileSync(path, "utf8")) as AllowlistFixture;
  if (typeof document.sourceOrigin !== "string" || !Array.isArray(document.entries)) {
    throw new Error(`${path} is not a self-containment allowlist`);
  }
  return document;
}

/** Measure the residual absolute self-references in the emitted tree. */
export function measureResiduals(
  pages: readonly { readonly url: string; readonly html: string }[],
  sourceOrigin: string,
): AllowlistEntry[] {
  const measured: AllowlistEntry[] = [];
  for (const page of pages) {
    for (const reference of findAbsoluteSelfReferences(page.html, sourceOrigin)) {
      measured.push({
        page: page.url,
        tag: reference.tag,
        attribute: reference.attribute,
        value: reference.value,
      });
    }
  }
  return measured;
}

/** The `rel` tokens of the captured `<link>` that carries this href. */
function capturedLinkRel(html: string, href: string): string[] {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = new RegExp(`<link\\b[^>]*href=["']${escaped}["'][^>]*>`, "i").exec(html)?.[0];
  if (tag === undefined) return [];
  const rel = /rel=['"]?([^'">]*)['"]?/i.exec(tag)?.[1] ?? "";
  return rel.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Justify every allowlisted entry by its own rule.
 *
 * Returns the composition and the entries that could not be justified — an entry the
 * capture does not contain, a canonical that does not name its own route, or a
 * survivor the asset map could have localised.
 */
export function justifyAllowlist(
  entries: readonly AllowlistEntry[],
  captureByPage: ReadonlyMap<string, string>,
  table: RewriteTable,
  sourceOrigin: string,
): { composition: ResidualComposition; unjustified: { entry: AllowlistEntry; reason: string }[] } {
  let canonical = 0;
  let deferredCss = 0;
  let unlocalisable = 0;
  const unjustified: { entry: AllowlistEntry; reason: string }[] = [];

  for (const entry of entries) {
    const captured = captureByPage.get(entry.page);
    if (captured === undefined) {
      unjustified.push({ entry, reason: `${entry.page} is not a captured page` });
      continue;
    }
    if (!captured.includes(entry.value)) {
      unjustified.push({
        entry,
        reason: `${entry.value} is not in the capture of ${entry.page}: an allowlist entry cannot be invented`,
      });
      continue;
    }

    if (entry.tag === "link" && entry.attribute === "href") {
      const rel = capturedLinkRel(captured, entry.value);
      if (rel.includes("canonical")) {
        const expected = `${sourceOrigin}${entry.page}`;
        if (entry.value !== expected) {
          unjustified.push({
            entry,
            reason: `a canonical must name its own route (${expected}), not ${entry.value}`,
          });
          continue;
        }
        canonical += 1;
        continue;
      }
      if (isDeferredCssLink(rel, entry.value) || /\/wp-content\/et-cache\//.test(entry.value)) {
        deferredCss += 1;
        continue;
      }
    }

    if (lookupRewrite(table, entry.value) !== null) {
      unjustified.push({
        entry,
        reason: `${entry.value} is in the asset rewrite map, so it was localisable`,
      });
      continue;
    }
    unlocalisable += 1;
  }

  return { composition: { canonical, "deferred-css": deferredCss, unlocalisable }, unjustified };
}

/**
 * The check: measured residuals equal the committed allowlist exactly, and every
 * allowlisted entry is independently justified.
 */
export function verifyResiduals(options: {
  readonly pages: readonly { readonly url: string; readonly html: string }[];
  readonly captureByPage: ReadonlyMap<string, string>;
  readonly fixture: AllowlistFixture;
  readonly table: RewriteTable;
  readonly sourceOrigin: string;
}): ResidualResult {
  const measured = measureResiduals(options.pages, options.sourceOrigin);
  const expected = new Map(options.fixture.entries.map((entry) => [allowlistKey(entry), entry]));
  const actual = new Map(measured.map((entry) => [allowlistKey(entry), entry]));

  const missing = [...expected].filter(([key]) => !actual.has(key)).map(([, entry]) => entry);
  const unexpected = [...actual].filter(([key]) => !expected.has(key)).map(([, entry]) => entry);

  const perPage = new Map<string, number>();
  for (const entry of measured) perPage.set(entry.page, (perPage.get(entry.page) ?? 0) + 1);

  const { composition, unjustified } = justifyAllowlist(
    options.fixture.entries,
    options.captureByPage,
    options.table,
    options.sourceOrigin,
  );

  const failures: ParityFailure[] = [];
  for (const entry of unexpected) {
    failures.push({
      check: "residuals",
      page: entry.page,
      path: "",
      message: `<${entry.tag} ${entry.attribute}> is still absolute and no rule justifies it`,
      actual: entry.value,
    });
  }
  for (const entry of missing) {
    failures.push({
      check: "residuals",
      page: entry.page,
      path: "",
      message: `<${entry.tag} ${entry.attribute}> is allowlisted but the artefact no longer carries it`,
      expected: entry.value,
    });
  }
  for (const problem of unjustified) {
    failures.push({
      check: "residuals",
      page: problem.entry.page,
      path: "",
      message: `allowlist entry is not justified: ${problem.reason}`,
      actual: problem.entry.value,
    });
  }

  return { measured, missing, unexpected, perPage, composition, failures };
}

/** Where the allowlist fixture lives, relative to the repository root. */
export const DEFAULT_ALLOWLIST_PATH = join("tests", "fixtures", "self-contained", "allowlist.json");
