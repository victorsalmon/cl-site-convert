/**
 * B2.6 — the emitted site is **self-contained**.
 *
 * B2.1 made the tree portable in its asset references and left everything else as
 * captured, so the delivered artefact still carried 352 absolute
 * `https://upscalehavens.ca/…` references: internal navigation left the new site,
 * forms posted to the live WordPress install, and the tree knew a host it must not
 * know. This suite is the check that makes "self-contained" a measurement.
 *
 * The centre of it is one assertion: **the set of absolute self-references that
 * survive emission is exactly the documented allowlist**. The allowlist is a committed
 * fixture, and every entry in it is then justified independently:
 *
 *  - a `canonical` link, which must stay absolute and may only change host;
 *  - a Divi deferred-CSS asset, whose bytes were never captured;
 *  - a reference for which the capture holds no bytes at all (the live site 404s it).
 *
 * A fourth category cannot be added without failing the composition proof, and a new
 * absolute self-reference cannot appear without failing the set equality. Neither
 * assertion asks the emitter what the answer should be.
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  classifyResidual,
  findAbsoluteSelfReferences,
  isDeferredCssLink,
  LocalisationError,
} from "../src/emit/static-html/localise.js";
import type { AbsoluteSelfReference } from "../src/emit/static-html/localise.js";
import { emitStaticSite, routeLocation } from "../src/emit/static-html/index.js";
import type { EmitReport } from "../src/emit/static-html/index.js";
import { lookupRewrite } from "../src/emit/static-html/rewrite.js";
import type { RewriteTable } from "../src/emit/static-html/rewrite.js";
import { buildRewriteTable } from "../src/emit/static-html/rewrite.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CAPTURE = join(REPO_ROOT, "capture");
const FIXTURE = join(HERE, "fixtures", "self-contained", "allowlist.json");

const SOURCE_ORIGIN = "https://upscalehavens.ca";
const FORM_SINK = "/api/submit";
const PREVIEW_BASE_URL = "https://site.upscalehavens.ca";

interface CapturedPage {
  readonly url: string;
  readonly dom: { readonly html: string };
}

const IR = JSON.parse(readFileSync(join(CAPTURE, "site-ir.json"), "utf8")) as {
  pages: CapturedPage[];
};
const MAP = JSON.parse(readFileSync(join(CAPTURE, "asset-rewrite-map.json"), "utf8")) as unknown;
const TABLE: RewriteTable = buildRewriteTable(MAP, "capture/asset-rewrite-map.json");
const ROUTES: string[] = (
  JSON.parse(readFileSync(join(CAPTURE, "routes.manifest.json"), "utf8")) as {
    routes: { path: string }[];
  }
).routes.map((route) => route.path);

/** One allowlisted survivor: enough identity to prove it is the same reference. */
interface AllowlistEntry {
  readonly page: string;
  readonly tag: string;
  readonly attribute: string;
  readonly value: string;
}

interface AllowlistFixture {
  readonly note: string;
  readonly sourceOrigin: string;
  readonly entries: readonly AllowlistEntry[];
}

function fixtureKey(entry: AllowlistEntry): string {
  return `${entry.page}\u0000${entry.tag}\u0000${entry.attribute}\u0000${entry.value}`;
}

let workDir: string;
let outDir: string;
let report: EmitReport;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cl-site-convert-selfcontained-"));
  outDir = join(workDir, "site");
  report = await emitStaticSite({
    irPath: join(CAPTURE, "site-ir.json"),
    rewriteMapPath: join(CAPTURE, "asset-rewrite-map.json"),
    routesPath: join(CAPTURE, "routes.manifest.json"),
    assetsRoot: join(CAPTURE, "assets"),
    outDir,
    reportPath: join(workDir, "emit-report.json"),
  });
}, 180_000);

afterAll(async () => {
  if (workDir !== undefined) await rm(workDir, { recursive: true, force: true });
});

function emittedHtml(url: string): string {
  return readFileSync(join(outDir, routeLocation(url).outputPath), "utf8");
}

/**
 * The check, as one function: the residual set measured on disk must equal the
 * committed allowlist exactly — no more, no fewer.
 *
 * Exported to the mutation probe below, which proves the comparison can fail.
 */
/** The `href` of every `<a>` in a document, in order, quote-style agnostic. */
function anchorHrefs(html: string): string[] {
  const hrefs: string[] = [];
  for (const tag of html.matchAll(/<a\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi)) {
    const href = /\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/i.exec(tag[0])?.[1];
    if (href === undefined) continue;
    hrefs.push(href.replace(/^["']|["']$/g, ""));
  }
  return hrefs;
}

/** The `rel` token list of the captured `<link>` that carries this href. */
function capturedLinkRel(html: string, href: string): string[] {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = new RegExp(`<link\\b[^>]*href="${escaped}"[^>]*>`, "i").exec(html)?.[0];
  if (tag === undefined) return [];
  const rel = /rel=['"]?([^'">]*)['"]?/i.exec(tag)?.[1] ?? "";
  return rel.toLowerCase().split(/\s+/).filter(Boolean);
}

function compareResidualToAllowlist(
  measured: readonly AllowlistEntry[],
  allowlisted: readonly AllowlistEntry[],
): { missing: AllowlistEntry[]; unexpected: AllowlistEntry[] } {
  const expected = new Map(allowlisted.map((entry) => [fixtureKey(entry), entry]));
  const actual = new Map(measured.map((entry) => [fixtureKey(entry), entry]));
  return {
    missing: [...expected].filter(([key]) => !actual.has(key)).map(([, entry]) => entry),
    unexpected: [...actual].filter(([key]) => !expected.has(key)).map(([, entry]) => entry),
  };
}

function measureResidual(): AllowlistEntry[] {
  const measured: AllowlistEntry[] = [];
  for (const page of IR.pages) {
    for (const reference of findAbsoluteSelfReferences(emittedHtml(page.url), SOURCE_ORIGIN)) {
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

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

describe("residual absolute self-references", () => {
  it("equals the documented allowlist exactly", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as AllowlistFixture;
    expect(fixture.sourceOrigin).toBe(SOURCE_ORIGIN);

    const { missing, unexpected } = compareResidualToAllowlist(measureResidual(), fixture.entries);
    expect(missing, "allowlisted references that are no longer emitted").toEqual([]);
    expect(unexpected, "absolute self-references that no rule justifies").toEqual([]);
  });

  it("justifies every allowlisted entry by its own rule, not by the emitter's opinion", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as AllowlistFixture;
    const capturedByPage = new Map(IR.pages.map((page) => [page.url, page.dom.html]));

    let canonical = 0;
    let deferredCss = 0;
    let unlocalisable = 0;

    for (const entry of fixture.entries) {
      const captured = capturedByPage.get(entry.page);
      expect(captured, `${entry.page} is a captured page`).toBeTypeOf("string");

      // The capture must contain the reference verbatim: the allowlist cannot invent one.
      expect(captured as string, `${entry.page}: ${entry.value} is not in the capture`).toContain(
        entry.value,
      );

      const rel = capturedLinkRel(captured as string, entry.value);

      if (entry.tag === "link" && entry.attribute === "href") {
        if (rel.includes("canonical")) {
          expect(entry.value, `${entry.page}: a canonical must name its own route`).toBe(
            `${SOURCE_ORIGIN}${entry.page}`,
          );
          canonical += 1;
          continue;
        }
        if (isDeferredCssLink(rel, entry.value) || /\/wp-content\/et-cache\//.test(entry.value)) {
          deferredCss += 1;
          continue;
        }
      }

      // Anything else may only survive because the capture has no bytes for it.
      expect(
        lookupRewrite(TABLE, entry.value),
        `${entry.page}: ${entry.value} is in the asset map, so it was localisable`,
      ).toBeNull();
      unlocalisable += 1;
    }

    // The measured composition of the allowlist: 19 canonicals, 18 deferred assets,
    // and the live site's own broken media.
    expect({ canonical, deferredCss, unlocalisable }).toEqual({
      canonical: 19,
      deferredCss: 18,
      unlocalisable: 3,
    });
    expect(fixture.entries.length).toBe(40);
  });

  it("refuses an absolute self-reference that no rule justifies", () => {
    // The emitter's own guard, driven directly: a plain anchor that survived emission
    // is a defect, not an allowlist entry.
    const stray: AbsoluteSelfReference = {
      tag: "a",
      attribute: "href",
      value: "https://upscalehavens.ca/care/",
      rel: [],
      hint: null,
      srcset: false,
    };
    expect(() => classifyResidual(stray, { resolvable: () => false })).toThrow(LocalisationError);
  });

  it("proves the check fails when an absolute self-reference is re-injected (mutation)", () => {
    // Mutation probe: put one reference back the way B2.1 shipped it and confirm both
    // halves of the guard notice. This is the executable form of the manual mutation
    // recorded in the bead report.
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as AllowlistFixture;
    const html = emittedHtml("/care/");
    expect(html).toContain('href="/tmh/"');

    const mutated = html.replace('href="/tmh/"', 'href="https://upscalehavens.ca/tmh/"');
    expect(mutated).not.toBe(html);

    const injected = findAbsoluteSelfReferences(mutated, SOURCE_ORIGIN).filter(
      (reference) => reference.value === "https://upscalehavens.ca/tmh/",
    );
    expect(injected, "the detector sees the injected reference").toHaveLength(1);

    const measured = [
      ...measureResidual().filter((entry) => entry.page !== "/care/"),
      ...findAbsoluteSelfReferences(mutated, SOURCE_ORIGIN).map((reference) => ({
        page: "/care/",
        tag: reference.tag,
        attribute: reference.attribute,
        value: reference.value,
      })),
    ];
    const { unexpected } = compareResidualToAllowlist(measured, fixture.entries);
    expect(unexpected.map((entry) => entry.value)).toEqual(["https://upscalehavens.ca/tmh/"]);
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe("internal navigation", () => {
  it("turns every captured-route anchor into a site-root-relative path that exists", () => {
    let checked = 0;
    for (const page of IR.pages) {
      const capturedRouteHrefs = anchorHrefs(page.dom.html).filter((href) => {
        if (!href.startsWith(`${SOURCE_ORIGIN}/`) && href !== SOURCE_ORIGIN) return false;
        return ROUTES.includes(href.slice(SOURCE_ORIGIN.length).split(/[?#]/)[0] ?? "");
      });
      const emittedHrefs = anchorHrefs(emittedHtml(page.url));
      const count = (values: readonly string[], needle: string): number =>
        values.filter((value) => value === needle).length;

      for (const captured of capturedRouteHrefs) {
        const relative = captured.slice(SOURCE_ORIGIN.length) || "/";
        expect(count(emittedHrefs, captured), `${page.url}: ${captured} still points home`).toBe(0);
        expect(
          count(emittedHrefs, relative),
          `${page.url}: ${captured} was not localised to ${relative}`,
        ).toBeGreaterThanOrEqual(1);
        expect(
          existsSync(join(outDir, routeLocation(relative.split(/[?#]/)[0] ?? "/").outputPath)),
          `${page.url}: ${relative} has no emitted page`,
        ).toBe(true);
        checked += 1;
      }
    }
    // 80 anchors target a captured route; the 19 shortlinks (`?p=` → `/`) are the other
    // route-targeted references, which is how the report's `navigation: 99` is made up.
    expect(checked).toBe(80);
    const routeLinks = IR.pages.reduce((total, page) => {
      return (
        total +
        [...page.dom.html.matchAll(/<link\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi)].filter((match) => {
          const tag = match[0];
          const rel = /\brel\s*=\s*("[^"]*"|'[^']*')/i.exec(tag)?.[1] ?? "";
          if (rel.replace(/^["']|["']$/g, "").includes("canonical")) return false;
          const href = /\bhref\s*=\s*("[^"]*"|'[^']*')/i.exec(tag)?.[1] ?? "";
          if (!href.includes(SOURCE_ORIGIN)) return false;
          const path = href.replace(/^["']|["']$/g, "").slice(SOURCE_ORIGIN.length);
          return ROUTES.includes(path.split(/[?#]/)[0] ?? "");
        }).length
      );
    }, 0);
    expect(routeLinks).toBe(19);
    expect(report.selfReferences.before["navigation"]).toBe(checked + routeLinks);
  });

  it("preserves the query string and fragment of a localised link", () => {
    const emitted = IR.pages.map((page) => emittedHtml(page.url)).join("\n");
    // `/tmh/onboard/#arrival` is the capture's one fragment-bearing internal route.
    expect(emitted).toContain('href="/tmh/onboard/#arrival"');
  });

  it("localises WordPress discovery links instead of leaving them pointing home", () => {
    const emitted = IR.pages.map((page) => emittedHtml(page.url)).join("\n");
    for (const path of [
      "/feed/",
      "/comments/feed/",
      "/wp-json/",
      "/xmlrpc.php",
      "/xmlrpc.php?rsd",
    ]) {
      expect(emitted, `${path} should be site-root relative`).toContain(`href="${path}"`);
    }
    // The shortlink for the front page is the site root.
    expect(emitted).toContain("href='/'");
  });
});

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

describe("form actions", () => {
  it("points every form at the configured sink and never at the source host", () => {
    let forms = 0;
    for (const page of IR.pages) {
      const html = emittedHtml(page.url);
      for (const match of html.matchAll(/<form\b[^>]*\baction="([^"]*)"/g)) {
        expect(match[1], `${page.url}: a form still posts to the old site`).toBe(FORM_SINK);
        forms += 1;
      }
      expect(html).not.toMatch(/<form\b[^>]*\baction="https:\/\/upscalehavens\.ca/);
    }
    expect(forms).toBe(18);
    expect(report.selfReferences.formSinkIsDefault).toBe(true);
    expect(report.selfReferences.formSink).toBe(FORM_SINK);
  });

  it("honours a configured sink and marks the default as unimplemented when it is not set", async () => {
    const sinkDir = join(workDir, "site-sink");
    const custom = await emitStaticSite({
      irPath: join(CAPTURE, "site-ir.json"),
      rewriteMapPath: join(CAPTURE, "asset-rewrite-map.json"),
      routesPath: join(CAPTURE, "routes.manifest.json"),
      assetsRoot: join(CAPTURE, "assets"),
      outDir: sinkDir,
      reportPath: join(workDir, "emit-report-sink.json"),
      formSink: "https://forms.example.test/submit",
      copyAssets: false,
    });
    expect(custom.selfReferences.formSinkIsDefault).toBe(false);

    const html = await readFile(join(sinkDir, routeLocation("/care/").outputPath), "utf8");
    expect(html).toContain('action="https://forms.example.test/submit"');
    expect(custom.notes.join("\n")).not.toContain("DOES NOT EXIST YET");
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Canonical links
// ---------------------------------------------------------------------------

describe("canonical links", () => {
  it("stay absolute and declare the target's own origin", () => {
    let canonicals = 0;
    for (const page of IR.pages) {
      const html = emittedHtml(page.url);
      const match = /<link rel="canonical" href="([^"]*)" \/>/.exec(html);
      expect(match, `${page.url} keeps its canonical`).not.toBeNull();
      expect(match?.[1]).toBe(`${SOURCE_ORIGIN}${page.url}`);
      canonicals += 1;
    }
    expect(canonicals).toBe(19);
    expect(report.selfReferences.baseUrl).toBe(SOURCE_ORIGIN);
  });

  it("sources the host from --base-url so a preview and the apex differ", async () => {
    const previewDir = join(workDir, "site-preview");
    const preview = await emitStaticSite({
      irPath: join(CAPTURE, "site-ir.json"),
      rewriteMapPath: join(CAPTURE, "asset-rewrite-map.json"),
      routesPath: join(CAPTURE, "routes.manifest.json"),
      assetsRoot: join(CAPTURE, "assets"),
      outDir: previewDir,
      reportPath: join(workDir, "emit-report-preview.json"),
      baseUrl: PREVIEW_BASE_URL,
      copyAssets: false,
    });
    expect(preview.selfReferences.baseUrl).toBe(PREVIEW_BASE_URL);

    for (const page of IR.pages) {
      const emitted = await readFile(join(previewDir, routeLocation(page.url).outputPath), "utf8");
      expect(emitted).toContain(`<link rel="canonical" href="${PREVIEW_BASE_URL}${page.url}" />`);
      // Only the canonical host moved: nothing else may differ from the default emit.
      const defaultHtml = emittedHtml(page.url);
      const strip = (html: string): string =>
        html.replace(/<link rel="canonical" href="[^"]*" \/>/g, "<canonical />");
      expect(strip(emitted), `${page.url} changed beyond its canonical`).toBe(strip(defaultHtml));
    }
  }, 180_000);

  it("rejects a base URL that is not a bare origin", async () => {
    await expect(
      emitStaticSite({
        irPath: join(CAPTURE, "site-ir.json"),
        rewriteMapPath: join(CAPTURE, "asset-rewrite-map.json"),
        routesPath: join(CAPTURE, "routes.manifest.json"),
        assetsRoot: join(CAPTURE, "assets"),
        outDir: join(workDir, "site-bad-base"),
        reportPath: join(workDir, "emit-report-bad-base.json"),
        baseUrl: "https://site.upscalehavens.ca/preview/",
        copyAssets: false,
      }),
    ).rejects.toThrow(/bare origin/);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Meta images, deferred CSS, externals
// ---------------------------------------------------------------------------

describe("meta image references", () => {
  it("localises msapplication-TileImage through the asset map and reports no leftovers", () => {
    let localised = 0;
    for (const page of IR.pages) {
      const html = emittedHtml(page.url);
      const match = /<meta name="msapplication-TileImage" content="([^"]*)" \/>/.exec(html);
      expect(match, `${page.url} keeps its TileImage meta`).not.toBeNull();
      const value = match?.[1] ?? "";
      expect(value.startsWith(SOURCE_ORIGIN), `${page.url}: still absolute`).toBe(false);
      expect(
        existsSync(resolve(dirname(join(outDir, routeLocation(page.url).outputPath)), value)),
      ).toBe(true);
      localised += 1;
    }
    expect(localised).toBe(19);
    expect(report.selfReferences.before["meta-asset"]).toBe(19);
    expect(report.selfReferences.after["meta-asset"]).toBeUndefined();
  });

  it("reports the live site's broken media instead of inventing a rewrite for it", () => {
    const broken = report.selfReferences.unlocalisable.filter((entry) => entry.tag === "img");
    expect(broken.length).toBeGreaterThan(0);
    for (const entry of broken) {
      expect(entry.page).toBe("/mlm/applym/");
      expect(entry.reason).toMatch(/no bytes/);
      // It is reported, and it is still exactly what the capture held.
      expect(entry.value).toContain("real-estate-09-1024x648-1");
    }
  });
});

describe("deferred CSS", () => {
  it("leaves Divi's deferred stylesheets byte-identical and allowlisted", () => {
    let deferred = 0;
    for (const page of IR.pages) {
      for (const match of page.dom.html.matchAll(/<link\b[^>]*>/g)) {
        const tag = match[0];
        if (!/rel=["']?preload/.test(tag) || !/as=["']?style/.test(tag)) continue;
        const href = /href=["']([^"']*)["']/.exec(tag)?.[1] ?? "";
        if (!href.startsWith(SOURCE_ORIGIN)) continue;
        // The captured tag survives verbatim: an un-captured asset cannot be localised.
        expect(emittedHtml(page.url), `${page.url}: ${href}`).toContain(tag);
        deferred += 1;
      }
    }
    // 11 `et-core-unified`/`et-divi-dynamic` sheets' worth of tags across the pages that
    // carry them; the report counts the same 18 references.
    expect(deferred).toBe(18);
    expect(report.selfReferences.after["deferred-css"]).toBe(18);
  });
});

describe("external references", () => {
  it("never rewrites a reference that does not point at the captured origin", () => {
    const externalValues = (html: string): string[] => {
      const values: string[] = [];
      for (const match of html.matchAll(/\b(?:href|src|action)=["']([^"']*)["']/g)) {
        const value = match[1] as string;
        if (!/^(?:https?:)?\/\//i.test(value)) continue;
        if (value === SOURCE_ORIGIN || value.startsWith(`${SOURCE_ORIGIN}/`)) continue;
        values.push(value);
      }
      return values;
    };

    const captured = new Map<string, number>();
    for (const page of IR.pages) {
      for (const value of externalValues(page.dom.html)) {
        captured.set(value, (captured.get(value) ?? 0) + 1);
      }
    }
    const emitted = new Map<string, number>();
    for (const page of IR.pages) {
      for (const value of externalValues(emittedHtml(page.url))) {
        emitted.set(value, (emitted.get(value) ?? 0) + 1);
      }
    }

    // Nothing new may appear, and every surviving value must be a captured one.
    for (const value of emitted.keys()) {
      expect([...captured.keys()], `${value} is not a captured external reference`).toContain(
        value,
      );
    }

    // Third-party destinations survive unchanged, occurrence for occurrence.
    const hostOf = (value: string): string =>
      new URL(value.startsWith("//") ? `https:${value}` : value).host;
    const sorted = (entries: [string, number][]): [string, number][] =>
      [...entries].sort(([left], [right]) => left.localeCompare(right));

    let checked = 0;
    for (const host of ["signal.org", "www.youtube.com", "sweepy.com", "support.hp.com"]) {
      const before = sorted([...captured].filter(([value]) => hostOf(value) === host));
      const after = sorted([...emitted].filter(([value]) => hostOf(value) === host));
      expect(before.length, `${host} is not in the capture`).toBeGreaterThan(0);
      expect(after, `${host} references changed`).toEqual(before);
      checked += before.reduce((total, [, occurrences]) => total + occurrences, 0);
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("does not touch a mailto: address that happens to contain the source host", () => {
    const emitted = IR.pages.map((page) => emittedHtml(page.url)).join("\n");
    expect(emitted).toContain("mailto:mill.lake@upscalehavens.ca");
  });
});
