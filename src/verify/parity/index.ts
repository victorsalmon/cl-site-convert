/**
 * The fidelity gate — a **deterministic equivalence** proof, not a screenshot diff.
 *
 * `dist/site/` is built by replaying the captured DOM and the captured CSS bytes in
 * the captured cascade order. It deliberately does not re-implement layout. So if the
 * emitted DOM tree, the CSS bytes and the cascade order are all identical to the
 * capture, rendering is identical **by construction** — there is no layout engine in
 * the loop to disagree.
 *
 * That is the primary claim this module measures, per page, with the IR
 * (`capture/site-ir.json`, v1.1) as the authority:
 *
 * | Check | What it proves |
 * | :--- | :--- |
 * | `artefact-set` | the tree holds exactly the routes the IR declares |
 * | `document-shell` | doctype and `<html>` attributes are the captured ones (quirks mode cannot silently change) |
 * | `body-tree` | tags, attribute names **in order**, class lists and text nodes are identical, apart from the closed set of permitted reference rewrites |
 * | `head-tree` | the same, for the head outside the rebuilt cascade block |
 * | `cascade` | the style sequence equals `page.styleOrder` in count, order and origin, and the CSS bytes are the captured bytes outside `url()` |
 * | `assets` | every local file the page references exists, and matches its recorded `sha256` |
 * | `residuals` | the surviving absolute self-references equal the committed allowlist exactly |
 * | `scripts` | a page that mounts no island carries no `<script>` |
 * | `cross-page-leak` | no page carries content that belongs to a different page |
 *
 * What it cannot prove is stated in `docs/fidelity-gate.md`: font rasterisation,
 * externally hosted resources, browser bugs, and anything that needs JavaScript to
 * render (the Fluent Forms conversational mount is the live example).
 *
 * A pixel diff exists as a **documented, opt-in secondary stage** and is deliberately
 * not installed: a real-browser driver downloads a binary at install time, which this
 * repository forbids (`docs/01-DECISIONS.md`, 2026-11-11).
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_ASSETS_ROOT,
  DEFAULT_FORM_SINK,
  DEFAULT_IR_PATH,
  DEFAULT_OUT_DIR,
  DEFAULT_REWRITE_MAP_PATH,
  DEFAULT_ROUTES_PATH,
  NO_BUNDLES_MANIFEST,
} from "../../emit/static-html/index.js";
import { buildRewriteTable } from "../../emit/static-html/rewrite.js";
import type { RewriteTable } from "../../emit/static-html/rewrite.js";
import { MissingBundleError } from "../../islands/manifest.js";
import { bundlesForHtml, scanIslandMounts } from "../../islands/mounts.js";
import type { Page, SiteIr } from "../../schema/site-ir.js";
import { isSiteIr } from "../../schema/site-ir.js";
import { DEFAULT_ALLOWLIST_PATH, loadAllowlist, verifyResiduals } from "./allowlist.js";
import type { ResidualComposition } from "./allowlist.js";
import { verifyAssets } from "./assets.js";
import { verifyCascade } from "./cascade.js";
import {
  attributeOf,
  elementChildren,
  findElement,
  isDeferredStyleLink,
  isStylesheetLink,
  isStyleNode,
  parseDocument,
  type HtmlNode,
} from "./dom.js";
import { fingerprint, verifyCrossPageLeaks } from "./leak.js";
import { compareSiblingSequences, compareTrees } from "./tree.js";
import type { TreeRules } from "./tree.js";
import {
  CannotEvaluateError,
  CHECKS,
  emptyRewriteCounts,
  type PageParity,
  type ParityFailure,
  type ParityReport,
  type RewriteCounts,
} from "./types.js";

export const DEFAULT_PARITY_REPORT_PATH = join("dist", "parity-report.json");

/** Where the gate reads and writes. Every default mirrors `pnpm emit:static`. */
export interface VerifyOptions {
  readonly irPath?: string;
  readonly outDir?: string;
  readonly reportPath?: string;
  readonly assetsRoot?: string;
  readonly rewriteMapPath?: string;
  readonly routesPath?: string;
  readonly allowlistPath?: string;
  /** Canonical origin the artefact declares. Defaults to the captured origin. */
  readonly baseUrl?: string;
  /** Sink form actions point at. Defaults to the emitted default. */
  readonly formSink?: string;
}

/** The output path a site-relative route is served from, WP-permalink shaped. */
export function artefactPathFor(url: string): string {
  if (!url.startsWith("/")) {
    throw new CannotEvaluateError(`route ${JSON.stringify(url)} is not site-relative`);
  }
  const segments = url.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return "index.html";
  return `${segments.join("/")}/index.html`;
}

/** Depth of a page inside the artefact: the number of `../` its references need. */
export function depthFor(url: string): number {
  return url.split("/").filter((segment) => segment.length > 0).length;
}

function countElementsIn(node: HtmlNode, name: string): number {
  let total = node.nodeName === name ? 1 : 0;
  for (const child of node.childNodes ?? []) total += countElementsIn(child, name);
  if (node.content !== undefined) total += countElementsIn(node.content, name);
  return total;
}

/** Every `index.html` under the artefact, as forward-slashed relative paths. */
async function listEmittedPages(outDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), relative);
      } else if (entry.isFile() && entry.name === "index.html") {
        found.push(relative);
      }
    }
  };
  await walk(outDir, "");
  return found.sort();
}

function addCounts(into: RewriteCounts, from: RewriteCounts): void {
  for (const key of Object.keys(into) as (keyof RewriteCounts)[]) into[key] += from[key];
}

function sumCounts(pages: readonly PageParity[]): RewriteCounts {
  const totals = emptyRewriteCounts();
  for (const page of pages) addCounts(totals, page.rewrites);
  return totals;
}

/** Compare the doctype and the `<html>` attributes — the document shell. */
function verifyDocumentShell(
  page: Page,
  emittedHtml: string,
  emittedDocument: HtmlNode,
): ParityFailure[] {
  const failures: ParityFailure[] = [];
  const doctype = page.dom.doctype;
  const head = emittedHtml.trimStart().slice(0, 20).toLowerCase();
  const hasDoctype = head.startsWith("<!doctype");

  if (doctype !== undefined) {
    if (!emittedHtml.trimStart().toLowerCase().startsWith(doctype.toLowerCase())) {
      failures.push({
        check: "document-shell",
        page: page.url,
        path: "",
        message: "the artefact does not start with the captured doctype",
        expected: doctype,
        actual: emittedHtml.slice(0, 40),
      });
    }
  } else if (hasDoctype) {
    failures.push({
      check: "document-shell",
      page: page.url,
      path: "",
      message: "the artefact declares a doctype the capture did not",
    });
  }

  const capturedHtmlElement = findElement(parseDocument(page.dom.html), "html");
  const emittedHtmlElement = findElement(emittedDocument, "html");
  if (capturedHtmlElement === null || emittedHtmlElement === null) {
    failures.push({
      check: "document-shell",
      page: page.url,
      path: "html",
      message: "the document has no <html> element",
    });
    return failures;
  }

  const capturedAttributes = (capturedHtmlElement.attrs ?? []).map((attribute) => attribute.name);
  const emittedAttributes = (emittedHtmlElement.attrs ?? []).map((attribute) => attribute.name);
  if (capturedAttributes.join(" ") !== emittedAttributes.join(" ")) {
    failures.push({
      check: "document-shell",
      page: page.url,
      path: "html",
      message: "the <html> attribute set or its order changed",
      expected: capturedAttributes.join(" "),
      actual: emittedAttributes.join(" "),
    });
    return failures;
  }
  for (const name of capturedAttributes) {
    const before = attributeOf(capturedHtmlElement, name);
    const after = attributeOf(emittedHtmlElement, name);
    if (before !== after) {
      failures.push({
        check: "document-shell",
        page: page.url,
        path: "html",
        message: `<html ${name}> changed`,
        expected: String(before),
        actual: String(after),
      });
    }
  }
  return failures;
}

/** The head comparison, with the rebuilt cascade block excluded from both sides. */
function compareHead(
  page: Page,
  capturedDocument: HtmlNode,
  emittedDocument: HtmlNode,
  rules: Parameters<typeof compareTrees>[2],
): ReturnType<typeof compareTrees> {
  const capturedHead = findElement(capturedDocument, "head");
  const emittedHead = findElement(emittedDocument, "head");
  if (capturedHead === null || emittedHead === null) {
    return {
      nodesCompared: 0,
      difference: {
        check: "head-tree",
        page: page.url,
        path: "html",
        message: "the document has no <head> element",
      },
      rewrites: emptyRewriteCounts(),
    };
  }

  // The cascade block is rebuilt from `page.styleOrder`, so it is excluded from the
  // head-tree comparison on BOTH sides and owned by the cascade check instead. That
  // block is three things, not one: captured `<link rel="stylesheet">`, captured
  // `<style>` blocks, and — since deferred Divi CSS was captured — captured
  // `<link rel="preload" as="style">` nodes, which the emitter replaces 1:1 with
  // cascade stylesheet links. Excluding only the first two would report every
  // converted deferred link as a missing node.
  const isCascadeNode = (node: Parameters<typeof isStylesheetLink>[0]): boolean =>
    isStylesheetLink(node) || isStyleNode(node) || isDeferredStyleLink(node);
  const capturedChildren = elementChildren(capturedHead).filter((node) => !isCascadeNode(node));
  const emittedChildren = elementChildren(emittedHead).filter((node) => !isCascadeNode(node));
  return compareSiblingSequences(capturedChildren, emittedChildren, rules);
}

/** The island/script check, reusing the emitter's own bundle decision. */
function verifyScripts(
  page: Page,
  html: string,
  emittedDocument: HtmlNode,
): { failures: ParityFailure[]; scriptTags: number; mounts: number } {
  const failures: ParityFailure[] = [];
  const scriptTags = countElementsIn(emittedDocument, "script");
  const scan = scanIslandMounts(html);
  const declared = page.islands?.length ?? 0;

  if (declared === 0 && scan.mounts.length > 0) {
    failures.push({
      check: "scripts",
      page: page.url,
      path: "",
      message: `the page declares no island but carries ${String(scan.mounts.length)} mount slot(s)`,
    });
  }

  let bundles = 0;
  try {
    bundles = bundlesForHtml(html, NO_BUNDLES_MANIFEST).length;
  } catch (error) {
    if (error instanceof MissingBundleError) {
      failures.push({
        check: "scripts",
        page: page.url,
        path: "",
        message: `the page mounts ${error.missing
          .map((entry) => entry.component)
          .join(", ")}, which the bundle decision cannot serve`,
      });
    } else {
      throw error;
    }
  }

  if (declared === 0 && scriptTags > 0) {
    failures.push({
      check: "scripts",
      page: page.url,
      path: "",
      message: `the page mounts no island but carries ${String(scriptTags)} <script> element(s)`,
    });
  }
  if (declared === 0 && bundles > 0) {
    failures.push({
      check: "scripts",
      page: page.url,
      path: "",
      message: `the bundle decision asks for ${String(bundles)} bundle(s) on an island-free page`,
    });
  }

  return { failures, scriptTags, mounts: scan.mounts.length };
}

/** Run the whole equivalence gate. Throws {@link CannotEvaluateError} to exit 2. */
export async function verifyParity(options: VerifyOptions = {}): Promise<ParityReport> {
  const irPath = options.irPath ?? DEFAULT_IR_PATH;
  const outDir = resolve(options.outDir ?? DEFAULT_OUT_DIR);
  const reportPath = options.reportPath ?? DEFAULT_PARITY_REPORT_PATH;
  const assetsRoot = options.assetsRoot ?? DEFAULT_ASSETS_ROOT;
  const rewriteMapPath = options.rewriteMapPath ?? DEFAULT_REWRITE_MAP_PATH;
  const routesPath = options.routesPath ?? DEFAULT_ROUTES_PATH;
  const allowlistPath = options.allowlistPath ?? DEFAULT_ALLOWLIST_PATH;

  if (!existsSync(irPath)) {
    throw new CannotEvaluateError(`cannot evaluate: the authority ${irPath} does not exist`);
  }
  if (!existsSync(outDir)) {
    throw new CannotEvaluateError(
      `cannot evaluate: the artefact ${outDir} does not exist — run \`pnpm emit:static\` first`,
    );
  }
  if (!existsSync(rewriteMapPath)) {
    throw new CannotEvaluateError(
      `cannot evaluate: the asset rewrite map ${rewriteMapPath} does not exist`,
    );
  }
  if (!existsSync(allowlistPath)) {
    throw new CannotEvaluateError(`cannot evaluate: the allowlist ${allowlistPath} does not exist`);
  }

  const parsedIr: unknown = JSON.parse(await readFile(irPath, "utf8"));
  if (!isSiteIr(parsedIr)) {
    throw new CannotEvaluateError(`cannot evaluate: ${irPath} is not a Site IR this gate can read`);
  }
  const ir: SiteIr = parsedIr;

  const table: RewriteTable = buildRewriteTable(
    JSON.parse(await readFile(rewriteMapPath, "utf8")),
    rewriteMapPath,
  );
  const routes: ReadonlySet<string> = new Set(
    (JSON.parse(await readFile(routesPath, "utf8")) as { routes: { path: string }[] }).routes.map(
      (route) => route.path,
    ),
  );

  const sourceOrigin = ir.site.baseUrl.replace(/\/+$/, "");
  const baseUrl = (options.baseUrl ?? sourceOrigin).replace(/\/+$/, "");
  const formSink = options.formSink ?? DEFAULT_FORM_SINK;
  const fixture = loadAllowlist(allowlistPath);

  const failures: ParityFailure[] = [];
  const pages: PageParity[] = [];
  const emittedHtmlByPage = new Map<string, string>();

  // --- artefact set: exactly the declared routes, no more, no fewer -----------
  const declared = new Map(ir.pages.map((page) => [artefactPathFor(page.url), page.url]));
  const emittedPaths = await listEmittedPages(outDir);
  for (const path of emittedPaths) {
    if (declared.has(path)) continue;
    failures.push({
      check: "artefact-set",
      page: path,
      path: "",
      message: "the artefact serves a route the IR does not declare",
    });
  }
  for (const [path, url] of declared) {
    if (emittedPaths.includes(path)) continue;
    failures.push({
      check: "artefact-set",
      page: url,
      path,
      message: "the IR declares a route the artefact does not serve",
    });
  }

  // --- per page ---------------------------------------------------------------
  for (const page of ir.pages) {
    const outputPath = artefactPathFor(page.url);
    const emittedPagePath = join(outDir, outputPath);
    const pageFailures: ParityFailure[] = [];
    const rewrites = emptyRewriteCounts();
    let nodesCompared = 0;
    let headNodesCompared = 0;
    let stylesCompared = 0;
    let inlineCssRewrites = 0;
    let linkedCssRewrites = 0;
    let linkedFilesVerified = 0;
    let assetsVerified = 0;
    let assetsHashed = 0;
    let scriptTags = 0;
    let mounts = 0;

    if (!existsSync(emittedPagePath)) {
      pageFailures.push({
        check: "artefact-set",
        page: page.url,
        path: outputPath,
        message: "the artefact has no file for this route",
      });
      pages.push({
        url: page.url,
        outputPath,
        verdict: "fail",
        nodesCompared: 0,
        headNodesCompared: 0,
        stylesCompared: 0,
        inlineCssRewrites: 0,
        linkedCssRewrites: 0,
        linkedFilesVerified: 0,
        assetsVerified: 0,
        assetsHashed: 0,
        rewrites,
        residualRefs: 0,
        scriptTags: 0,
        mounts: 0,
        failures: pageFailures,
      });
      continue;
    }

    const html = await readFile(emittedPagePath, "utf8");
    emittedHtmlByPage.set(page.url, html);
    const emittedDocument = parseDocument(html);
    const capturedDocument = parseDocument(page.dom.html);
    const rules: TreeRules = {
      page: page.url,
      check: "body-tree",
      dirDepth: depthFor(page.url),
      sourceOrigin,
      baseUrl,
      formSink,
      routes,
      table,
    };

    pageFailures.push(...verifyDocumentShell(page, html, emittedDocument));

    const capturedBody = findElement(capturedDocument, "body");
    const emittedBody = findElement(emittedDocument, "body");
    if (capturedBody === null || emittedBody === null) {
      pageFailures.push({
        check: "body-tree",
        page: page.url,
        path: "html",
        message: "the document has no <body> element",
      });
    } else {
      const body = compareTrees(capturedBody, emittedBody, rules);
      nodesCompared = body.nodesCompared;
      addCounts(rewrites, body.rewrites);
      if (body.difference !== null) pageFailures.push(body.difference);
    }

    const head = compareHead(page, capturedDocument, emittedDocument, rules);
    headNodesCompared = head.nodesCompared;
    addCounts(rewrites, head.rewrites);
    if (head.difference !== null) pageFailures.push(head.difference);

    const cascade = verifyCascade({
      page,
      ir,
      emittedDocument,
      assetsRoot,
      outDir,
      emittedPagePath,
      table,
      dirDepth: depthFor(page.url),
    });
    stylesCompared = cascade.stylesCompared;
    inlineCssRewrites = cascade.inlineCssRewrites;
    linkedCssRewrites = cascade.linkedCssRewrites;
    linkedFilesVerified = cascade.linkedFilesVerified;
    pageFailures.push(...cascade.failures);

    const assets = verifyAssets({
      page: page.url,
      document: emittedDocument,
      outDir,
      emittedPagePath,
      ir,
    });
    assetsVerified = assets.assetsVerified;
    assetsHashed = assets.assetsHashed;
    pageFailures.push(...assets.failures);

    const scripts = verifyScripts(page, html, emittedDocument);
    scriptTags = scripts.scriptTags;
    mounts = scripts.mounts;
    pageFailures.push(...scripts.failures);

    pages.push({
      url: page.url,
      outputPath,
      verdict: pageFailures.length === 0 ? "pass" : "fail",
      nodesCompared,
      headNodesCompared,
      stylesCompared,
      inlineCssRewrites,
      linkedCssRewrites,
      linkedFilesVerified,
      assetsVerified,
      assetsHashed,
      rewrites,
      residualRefs: 0,
      scriptTags,
      mounts,
      failures: pageFailures,
    });
  }

  // --- residuals: equality against the committed allowlist -------------------
  const emittedPagesForResiduals = ir.pages
    .filter((page) => emittedHtmlByPage.has(page.url))
    .map((page) => ({ url: page.url, html: emittedHtmlByPage.get(page.url) as string }));
  const residual = verifyResiduals({
    pages: emittedPagesForResiduals,
    captureByPage: new Map(ir.pages.map((page) => [page.url, page.dom.html])),
    fixture,
    table,
    sourceOrigin,
  });
  failures.push(...residual.failures);

  // --- cross-page leak -------------------------------------------------------
  const capturedFingerprints = ir.pages.map((page) => fingerprint(page.url, page.dom.html));
  const emittedFingerprints = ir.pages
    .filter((page) => emittedHtmlByPage.has(page.url))
    .map((page) => fingerprint(page.url, emittedHtmlByPage.get(page.url) as string));
  failures.push(...verifyCrossPageLeaks(capturedFingerprints, emittedFingerprints));

  // Attribute the residual count and every cross-page leak to the page they belong to,
  // then decide each page's verdict from its own complete failure list.
  const finalPages = pages.map((page) => {
    const own = dedupeFailures([
      ...page.failures,
      ...failures.filter((failure) => failure.page === page.url),
    ]);
    return {
      ...page,
      residualRefs: residual.perPage.get(page.url) ?? 0,
      verdict: own.length === 0 ? ("pass" as const) : ("fail" as const),
      failures: own,
    };
  });

  // A failure about a path that is not an IR page (an extra emitted route) has no page
  // to attach to and stays in the site-wide list.
  const knownUrls = new Set(ir.pages.map((page) => page.url));
  const uniqueFailures = dedupeFailures([
    ...finalPages.flatMap((page) => page.failures),
    ...failures.filter((failure) => !knownUrls.has(failure.page)),
  ]);

  const report: ParityReport = {
    generatedAt: new Date().toISOString(),
    gate: "equivalence",
    authority: irPath,
    artefact: outDir,
    irVersion: ir.irVersion,
    baseUrl,
    formSink,
    verdict: uniqueFailures.length === 0 ? "pass" : "fail",
    checks: CHECKS,
    pages: finalPages,
    totals: {
      pages: finalPages.length,
      pagesPassed: finalPages.filter((page) => page.verdict === "pass").length,
      nodesCompared: finalPages.reduce((total, page) => total + page.nodesCompared, 0),
      stylesCompared: finalPages.reduce((total, page) => total + page.stylesCompared, 0),
      inlineCssRewrites: finalPages.reduce((total, page) => total + page.inlineCssRewrites, 0),
      linkedCssRewrites: finalPages.reduce((total, page) => total + page.linkedCssRewrites, 0),
      assetsVerified: finalPages.reduce((total, page) => total + page.assetsVerified, 0),
      assetsHashed: finalPages.reduce((total, page) => total + page.assetsHashed, 0),
      rewrites: sumCounts(finalPages),
      residualRefs: finalPages.reduce((total, page) => total + page.residualRefs, 0),
      scriptTags: finalPages.reduce((total, page) => total + page.scriptTags, 0),
      failures: uniqueFailures.length,
      residualComposition: residual.composition satisfies ResidualComposition,
    },
    failures: uniqueFailures,
    pixelDiff: {
      status: "not-run",
      stage: "secondary",
      reason:
        "opt-in secondary check; not installed because a real-browser driver downloads a binary at install time. See docs/fidelity-gate.md.",
    },
    notes: [
      "The authority is the IR; the artefact is dist/site. Equivalence is checked per page, not against a screenshot.",
      "A permitted rewrite is one the verifier re-derives from the captured value: asset paths from the rewrite map, navigation to a captured route, internal paths on the source host, the form sink, the canonical base URL, and meta images.",
      "Font rasterisation, externally hosted resources, browser bugs and anything that needs JavaScript to render are outside this claim.",
      `Residual composition: ${String(residual.composition.canonical)} canonical, ${String(residual.composition["deferred-css"])} deferred CSS, ${String(residual.composition.unlocalisable)} unlocalisable — every entry justified independently.`,
    ],
  };

  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return report;
}

function dedupeFailures(failures: readonly ParityFailure[]): ParityFailure[] {
  const seen = new Set<string>();
  const unique: ParityFailure[] = [];
  for (const failure of failures) {
    const key = `${failure.check}\u0000${failure.page}\u0000${failure.path}\u0000${failure.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(failure);
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** The summary table the gate prints. */
export function formatParityReport(report: ParityReport): string {
  const lines: string[] = [];
  lines.push(`fidelity gate — equivalence of ${report.artefact} against ${report.authority}`);
  lines.push(`  IR ${report.irVersion} · canonical ${report.baseUrl} · forms → ${report.formSink}`);
  lines.push("");

  const width = Math.max("route".length, ...report.pages.map((page) => page.url.length));
  const columns = [
    ["nodes", 8],
    ["styles", 6],
    ["css", 5],
    ["assets", 6],
    ["refs", 5],
    ["resid", 5],
    ["script", 6],
    ["verdict", 7],
  ] as const;
  lines.push(
    `  ${pad("route", width)}  ${columns.map(([label, size]) => padStart(label, size)).join("  ")}`,
  );
  lines.push(
    `  ${"-".repeat(width + 2 + columns.reduce((total, [, size]) => total + size + 2, 0))}`,
  );
  for (const page of report.pages) {
    const refs =
      page.rewrites.asset +
      page.rewrites.navigation +
      page.rewrites["internal-path"] +
      page.rewrites["form-sink"] +
      page.rewrites.canonical +
      page.rewrites["meta-asset"];
    lines.push(
      `  ${pad(page.url, width)}  ${padStart(String(page.nodesCompared + page.headNodesCompared), 8)}  ` +
        `${padStart(String(page.stylesCompared), 6)}  ` +
        `${padStart(String(page.inlineCssRewrites + page.linkedCssRewrites), 5)}  ` +
        `${padStart(String(page.assetsVerified), 6)}  ` +
        `${padStart(String(refs), 5)}  ` +
        `${padStart(String(page.residualRefs), 5)}  ` +
        `${padStart(String(page.scriptTags), 6)}  ` +
        `${padStart(page.verdict, 7)}`,
    );
  }
  lines.push(
    `  ${"-".repeat(width + 2 + columns.reduce((total, [, size]) => total + size + 2, 0))}`,
  );
  lines.push(
    `  ${pad(`${String(report.totals.pages)} page(s)`, width)}  ` +
      `${padStart(String(report.totals.nodesCompared), 8)}  ` +
      `${padStart(String(report.totals.stylesCompared), 6)}  ` +
      `${padStart(String(report.totals.inlineCssRewrites + report.totals.linkedCssRewrites), 5)}  ` +
      `${padStart(String(report.totals.assetsVerified), 6)}  ` +
      `${padStart(String(Object.values(report.totals.rewrites).reduce((a, b) => a + b, 0)), 5)}  ` +
      `${padStart(String(report.totals.residualRefs), 5)}  ` +
      `${padStart(String(report.totals.scriptTags), 6)}  ` +
      `${padStart(report.verdict, 7)}`,
  );

  lines.push("");
  lines.push("  permitted rewrites, by category:");
  for (const [category, count] of Object.entries(report.totals.rewrites)) {
    lines.push(`    ${pad(category, 14)} ${padStart(String(count), 6)}`);
  }
  lines.push(
    `  assets hashed against the IR: ${String(report.totals.assetsHashed)} of ${String(report.totals.assetsVerified)} referenced file(s)`,
  );
  lines.push(
    `  residual absolute self-references: ${String(report.totals.residualRefs)} ` +
      `(${String(report.totals.residualComposition.canonical)} canonical, ` +
      `${String(report.totals.residualComposition["deferred-css"])} deferred CSS, ` +
      `${String(report.totals.residualComposition.unlocalisable)} unlocalisable)`,
  );
  lines.push(`  <script> elements: ${String(report.totals.scriptTags)}`);
  lines.push(`  checks: ${report.checks.join(", ")}`);

  if (report.failures.length > 0) {
    lines.push("");
    lines.push(`  FAILURES (${String(report.failures.length)}):`);
    for (const failure of report.failures.slice(0, 40)) {
      lines.push(
        `    [${failure.check}] ${failure.page}${failure.path === "" ? "" : ` @ ${failure.path}`}`,
      );
      lines.push(`      ${failure.message}`);
      if (failure.expected !== undefined || failure.actual !== undefined) {
        lines.push(`      expected: ${failure.expected ?? ""}`);
        lines.push(`      actual  : ${failure.actual ?? ""}`);
      }
    }
    if (report.failures.length > 40) {
      lines.push(`    … ${String(report.failures.length - 40)} more in the report file`);
    }
  } else {
    lines.push("");
    lines.push(
      `  VERDICT: PASS — ${String(report.totals.pagesPassed)}/${String(report.totals.pages)} page(s) equivalent`,
    );
  }
  lines.push("");
  lines.push(
    `  pixel diff: ${report.pixelDiff.status} (${report.pixelDiff.stage}) — ${report.pixelDiff.reason}`,
  );
  return lines.join("\n");
}

/** Re-exported so tests and the CLI share one entry point. */
export { CHECKS };
export type { PageParity, ParityFailure, ParityReport };
