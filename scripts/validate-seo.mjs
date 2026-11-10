#!/usr/bin/env node
/**
 * SEO + redirect sidecar conformance validator.
 *
 *   node scripts/validate-seo.mjs                       # capture/seo-and-redirects.json
 *   node scripts/validate-seo.mjs <path> [<path>...]     # explicit sidecars
 *
 * `capture/seo-and-redirects.json` is a deliverable the emitter bead consumes, not a
 * report we happen to write, so it is validated inside the gate. The capture code
 * proves the derivations offline (tests/seo-*.test.ts); this proves the *committed
 * artifact* still agrees with the capture it was derived from.
 *
 * Everything here is re-derivable from `capture/routes.manifest.json` and
 * `capture/site-ir.json`, which are the only inputs. That matters: a sidecar edited
 * by hand, or one left behind after the IR moved on, is caught rather than trusted.
 *
 * Exit codes: 0 pass, 1 non-conforming, 2 cannot-evaluate (missing sidecar or input).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_SIDECARS = ["capture/seo-and-redirects.json"];
const MANIFEST = join(REPO_ROOT, "capture", "routes.manifest.json");
const SITE_IR = join(REPO_ROOT, "capture", "site-ir.json");

const SEO_FIELDS = [
  "title",
  "description",
  "canonical",
  "robots",
  "hreflang",
  "openGraph",
  "twitter",
  "jsonLd",
];
const SEVERITIES = new Set(["high", "medium", "low"]);
const PROBLEM_KINDS = new Set([
  "not-301",
  "self-redirect",
  "unverified",
  "arrival-mismatch",
  "chain",
  "loop",
  "target-error",
]);

function cannotEvaluate(message) {
  console.error(`cannot-evaluate: ${message}`);
  process.exit(2);
}

function readJson(path, label) {
  if (!existsSync(path)) cannotEvaluate(`${label} not found at ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    cannotEvaluate(`${label} at ${path} is not valid JSON: ${error.message}`);
  }
}

/** The fields absent on every page, re-derived from the per-page records. */
function deriveAbsentSiteWide(pages) {
  const present = new Map(SEO_FIELDS.map((field) => [field, 0]));
  for (const page of pages) {
    const absent = new Set(Array.isArray(page.absent) ? page.absent : []);
    for (const field of SEO_FIELDS)
      if (!absent.has(field)) present.set(field, present.get(field) + 1);
  }
  return SEO_FIELDS.filter((field) => present.get(field) === 0);
}

function checkSidecar(sidecar, manifest, ir) {
  const problems = [];
  const note = (message) => problems.push(message);

  if (sidecar === null || typeof sidecar !== "object" || Array.isArray(sidecar)) {
    return ["sidecar is not a JSON object"];
  }
  if (sidecar.seoVersion !== "1")
    note(`seoVersion is ${JSON.stringify(sidecar.seoVersion)}, expected "1"`);
  if (typeof sidecar.baseUrl !== "string" || sidecar.baseUrl.length === 0) note("baseUrl missing");

  const pages = Array.isArray(sidecar.pages) ? sidecar.pages : [];
  const manifestRoutes = Array.isArray(manifest.routes) ? manifest.routes : [];
  if (pages.length === 0) note("pages[] is empty: a sidecar that describes no page proves nothing");
  if (pages.length !== manifestRoutes.length) {
    note(
      `pages[] holds ${pages.length} entries but the manifest holds ${manifestRoutes.length} routes`,
    );
  }

  // Every route in the manifest must be accounted for, and none invented.
  const pageUrls = new Set(pages.map((page) => page.url));
  for (const route of manifestRoutes) {
    if (!pageUrls.has(route.path)) note(`manifest route ${route.path} has no page entry`);
  }
  const manifestPaths = new Set(manifestRoutes.map((route) => route.path));
  for (const url of pageUrls) {
    if (!manifestPaths.has(url)) note(`page ${url} is not a manifest route`);
  }

  // The site capture must agree, or this sidecar describes a different site version.
  const irRoutes = new Set(
    (Array.isArray(ir.pages) ? ir.pages : []).flatMap((page) =>
      typeof page?.url === "string" ? [page.url] : [],
    ),
  );
  for (const url of pageUrls) {
    if (!irRoutes.has(url)) note(`page ${url} is not in capture/site-ir.json`);
  }

  // Per-page records.
  for (const page of pages) {
    if (page.httpStatus !== 200) {
      note(
        `${page.url}: httpStatus is ${JSON.stringify(page.httpStatus)}, not 200 (unreachable page)`,
      );
    }
    const surface = page.surface ?? {};
    const absent = Array.isArray(surface.absent) ? surface.absent : null;
    if (absent === null) {
      note(`${page.url}: surface.absent is missing, so the omission is unrecorded`);
      continue;
    }
    // `absent` must agree with the values, not be asserted alongside them.
    const expected = SEO_FIELDS.filter((field) => {
      if (field === "title") return surface.title === null || surface.title === undefined;
      if (field === "description")
        return surface.description === null || surface.description === undefined;
      if (field === "canonical")
        return surface.canonical === null || surface.canonical === undefined;
      if (field === "robots") return surface.robots === null || surface.robots === undefined;
      if (field === "hreflang") return (surface.hreflang ?? []).length === 0;
      if (field === "openGraph") return (surface.openGraph ?? []).length === 0;
      if (field === "twitter") return (surface.twitter ?? []).length === 0;
      return (surface.jsonLd?.count ?? 0) === 0;
    });
    const sortedAbsent = [...absent].sort().join(",");
    const sortedExpected = [...expected].sort().join(",");
    if (sortedAbsent !== sortedExpected) {
      note(
        `${page.url}: surface.absent (${sortedAbsent}) disagrees with the values (${sortedExpected})`,
      );
    }
  }

  // Summary must be a function of the pages, not a claim.
  const summary = sidecar.summary ?? {};
  if (summary.pages !== pages.length) {
    note(`summary.pages is ${summary.pages} but pages[] holds ${pages.length}`);
  }
  const derivedAbsent = deriveAbsentSiteWide(pages.map((page) => page.surface ?? {}));
  const claimedAbsent = Array.isArray(summary.seoAbsentSiteWide) ? summary.seoAbsentSiteWide : [];
  // Order is presentational; the set is the claim, so compare as a set.
  if ([...derivedAbsent].sort().join(",") !== [...claimedAbsent].sort().join(",")) {
    note(
      `summary.seoAbsentSiteWide (${claimedAbsent.join(",")}) disagrees with the pages (${derivedAbsent.join(",")})`,
    );
  }

  // URL contract: canonical is checked twice — per page and in the audit.
  const canonical = sidecar.urlContract?.canonical ?? {};
  const mismatches = Array.isArray(canonical.mismatches) ? canonical.mismatches : [];
  if (mismatches.length > 0) {
    for (const mismatch of mismatches) {
      note(
        `canonical/route mismatch on ${mismatch.route}: ${mismatch.declared ?? "(absent)"} (${mismatch.reason})`,
      );
    }
  }
  if (summary.canonicalMismatches !== mismatches.length) {
    note(
      `summary.canonicalMismatches is ${summary.canonicalMismatches} but the audit reports ${mismatches.length}`,
    );
  }
  const mismatchRoutes = new Set(mismatches.map((mismatch) => mismatch.route));
  for (const page of pages) {
    const expectedMatch = !mismatchRoutes.has(page.url);
    if (page.canonicalMatchesRoute !== expectedMatch) {
      note(
        `${page.url}: canonicalMatchesRoute=${page.canonicalMatchesRoute} contradicts the audit`,
      );
    }
  }
  if (canonical.pages !== pages.length) {
    note(`urlContract.canonical.pages is ${canonical.pages} but pages[] holds ${pages.length}`);
  }
  const trailing = sidecar.urlContract?.trailingSlash;
  if (trailing === undefined || typeof trailing.policy !== "string") {
    note("urlContract.trailingSlash.policy is missing");
  }
  if (sidecar.urlContract?.indexHtml === undefined) note("urlContract.indexHtml is missing");

  // Redirects: the manifest is the source, so a missing entry is a stale sidecar.
  const manifestRedirects = Array.isArray(manifest.discovery?.redirects)
    ? manifest.discovery.redirects
    : [];
  const redirects = Array.isArray(sidecar.redirects?.entries) ? sidecar.redirects.entries : [];
  if (redirects.length !== manifestRedirects.length) {
    note(
      `redirects.entries holds ${redirects.length} but the manifest records ${manifestRedirects.length}`,
    );
  }
  const redirectByFrom = new Map(redirects.map((redirect) => [redirect.from, redirect]));
  for (const entry of manifestRedirects) {
    const recorded = redirectByFrom.get(entry.from);
    if (recorded === undefined) {
      note(`manifest redirect ${entry.from} is missing from the sidecar`);
      continue;
    }
    if (recorded.to !== entry.to)
      note(`${entry.from}: recorded destination differs from the manifest`);
    if (recorded.code !== entry.code)
      note(`${entry.from}: recorded code differs from the manifest`);
    if (recorded.hops > 1) note(`${entry.from}: redirect chain of ${recorded.hops} hops`);
    const problemsListed = Array.isArray(recorded.problems) ? recorded.problems : [];
    for (const problem of problemsListed) {
      if (!PROBLEM_KINDS.has(problem)) note(`${entry.from}: unknown problem kind ${problem}`);
    }
    if (problemsListed.length > 0) note(`${entry.from}: ${problemsListed.join(", ")}`);
    if (recorded.verified !== (problemsListed.length === 0)) {
      note(
        `${entry.from}: verified=${recorded.verified} disagrees with problems (${problemsListed.join(",")})`,
      );
    }
  }
  const verifiedCount = redirects.filter((redirect) => redirect.verified === true).length;
  if (summary.redirects !== redirects.length) {
    note(`summary.redirects is ${summary.redirects} but entries holds ${redirects.length}`);
  }
  if (summary.redirectsVerified !== verifiedCount) {
    note(
      `summary.redirectsVerified is ${summary.redirectsVerified} but ${verifiedCount} are verified`,
    );
  }
  if (summary.redirectChains !== undefined && summary.redirectChains !== 0) {
    note(`summary.redirectChains is ${summary.redirectChains}; a chain is a defect`);
  }
  if (summary.redirectLoops !== undefined && summary.redirectLoops !== 0) {
    note(`summary.redirectLoops is ${summary.redirectLoops}; a loop is a defect`);
  }

  // The `_redirects` lines must be exactly the verified entries.
  const cfLines = Array.isArray(sidecar.newSiteContract?.redirects?.lines)
    ? sidecar.newSiteContract.redirects.lines
    : null;
  if (cfLines === null) {
    note("newSiteContract.redirects.lines is missing");
  } else {
    const expectedLines = redirects
      .filter((redirect) => redirect.verified === true)
      .map((redirect) => `${redirect.from} ${redirect.to} ${redirect.code}`);
    if (cfLines.join("\n") !== expectedLines.join("\n")) {
      note("newSiteContract.redirects.lines is not the verified redirect set");
    }
  }

  // Sitemap and robots.
  const sitemap = sidecar.sitemap ?? {};
  const locs = Array.isArray(sitemap.locs) ? sitemap.locs : [];
  if (sitemap.urlCount !== locs.length) {
    note(`sitemap.urlCount is ${sitemap.urlCount} but locs holds ${locs.length}`);
  }
  if (locs.length !== pages.length) {
    note(`sitemap advertises ${locs.length} URLs but the capture holds ${pages.length} pages`);
  }
  if (sitemap.status !== 200) note(`sitemap status is ${sitemap.status}, not 200`);
  const robots = sidecar.robots ?? {};
  if (typeof robots.body !== "string" || robots.body.length === 0) {
    note("robots.body is empty: the crawl contract was not captured");
  }
  if (
    !Array.isArray(sidecar.newSiteContract?.robots?.mustEmit) ||
    sidecar.newSiteContract.robots.mustEmit.length === 0
  ) {
    note("newSiteContract.robots.mustEmit is empty");
  }
  if (
    !Array.isArray(sidecar.newSiteContract?.sitemap?.mustEmit) ||
    sidecar.newSiteContract.sitemap.mustEmit.length === 0
  ) {
    note("newSiteContract.sitemap.mustEmit is empty");
  }

  // Search behaviour must be defined, not left open.
  const search = sidecar.search ?? {};
  if (typeof search.behaviour !== "string" || search.behaviour.length === 0) {
    note("search.behaviour is empty: the /?s= replacement is undefined");
  }
  if (typeof search.newSite?.rewrite !== "string" || search.newSite.rewrite.length === 0) {
    note("search.newSite.rewrite is empty");
  }
  if (search.probe?.status !== 200) note(`/?s= search probe status is ${search.probe?.status}`);
  if (search.probe?.noResults === undefined) {
    note("search.probe.noResults is unrecorded, so 'no results' cannot be told from 'disabled'");
  }

  // Broken references: ids unique, severities valid, statuses really are failures.
  const broken = Array.isArray(sidecar.brokenReferences) ? sidecar.brokenReferences : [];
  const ids = new Set();
  for (const entry of broken) {
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      note("a broken reference has no id");
      continue;
    }
    if (ids.has(entry.id)) note(`duplicate broken-reference id ${entry.id}`);
    ids.add(entry.id);
    if (!SEVERITIES.has(entry.severity)) note(`${entry.id}: unknown severity ${entry.severity}`);
    if (typeof entry.status !== "number" || entry.status < 400) {
      note(`${entry.id}: recorded status ${entry.status} is not a failure`);
    }
    if (!Array.isArray(entry.pages) || entry.pages.length === 0) {
      note(`${entry.id}: no page named, so the finding is not auditable`);
    }
  }
  if (summary.brokenReferences !== broken.length) {
    note(`summary.brokenReferences is ${summary.brokenReferences} but ${broken.length} are listed`);
  }

  return problems;
}

function main() {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const paths = requested.length > 0 ? requested : DEFAULT_SIDECARS;
  const manifest = readJson(MANIFEST, "route manifest");
  const ir = readJson(SITE_IR, "Site IR");

  let failures = 0;
  for (const path of paths) {
    const absolute = resolve(process.cwd(), path);
    const sidecar = readJson(absolute, "SEO sidecar");
    const problems = checkSidecar(sidecar, manifest, ir);
    if (problems.length === 0) {
      console.log(`PASS  ${path}`);
      continue;
    }
    failures += 1;
    console.log(`FAIL  ${path}`);
    for (const problem of problems) console.log(`        ${problem}`);
  }

  console.log("");
  console.log(`${paths.length - failures}/${paths.length} SEO sidecar(s) conformed`);
  if (failures > 0) {
    console.error(`${failures} SEO sidecar(s) failed`);
    process.exit(1);
  }
}

main();
