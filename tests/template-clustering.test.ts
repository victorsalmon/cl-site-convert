/**
 * Template clustering (P2.2) — the measured template count.
 *
 * Three things are being protected here, in descending order of importance:
 *
 *  1. **The reported number.** `19 pages → 15 shapes` is the deliverable. A
 *     change that makes it 14 or 16 has to be a deliberate change to the metric,
 *     and this test makes that impossible to do by accident.
 *  2. **The threshold is data-chosen, not decorative.** The suite re-clusters
 *     across the whole measured plateau `(0.800, 0.875]` and asserts one
 *     partition, and it pins the two scores that bracket the plateau: the
 *     cheapest genuine match (0.875) and the highest false positive (0.800).
 *  3. **Content cannot leak into the signature.** Synthetic pages that differ
 *     only in text, image sources, links and Divi instance numbers must score
 *     exactly 1.0; site chrome must be excluded from the compared shape; and the
 *     WP `template` field must stay out of the similarity so the cross-check is
 *     not circular.
 *
 * Everything runs against the recorded capture on disk. No network, no browser.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CLUSTER_THRESHOLD,
  THRESHOLD_BAND,
  buildTemplateRegistry,
  clusterShapes,
  extractPageShape,
  formatRegistryTable,
  isInstanceClass,
  sectionSimilarity,
  shapeLabel,
  shapeSimilarity,
} from "../src/analysis/cluster.js";
import type { PageShape, TemplateCluster } from "../src/analysis/cluster.js";
import { pagesFromIr, runAnalyzeTemplates, serialiseRegistry } from "../src/analysis/cli.js";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const irBody = readFileSync(join(ROOT, "capture/site-ir.json"), "utf8");
const parsedIr = pagesFromIr(irBody);
if (!parsedIr.ok) throw new Error(parsedIr.reason);
const shapes: PageShape[] = parsedIr.pages;

const registry = buildTemplateRegistry({
  pages: shapes,
  irVersion: "1.1.0",
  capturedAt: "2026-11-10T06:03:49.699Z",
});

/** The measured partition. Deep-equal to this or the number changed. */
const MEASURED_TABLE: Readonly<Record<string, readonly string[]>> = {
  "tpl-01": ["/care/sweepy-admin/", "/care/ttlock-admin/"],
  "tpl-02": ["/mlm/", "/tmh/"],
  "tpl-03": ["/mlm/onboard-mlm/", "/tmh/onboard-tmh/"],
  "tpl-04": ["/ush/owner/", "/ush/privacy-policy/"],
  "tpl-05": ["/"],
  "tpl-06": ["/care/"],
  "tpl-07": ["/care/showings/"],
  "tpl-08": ["/care/signal-admin/"],
  "tpl-09": ["/mlm/applym/"],
  "tpl-10": ["/resources/"],
  "tpl-11": ["/resources/checklists/"],
  "tpl-12": ["/resources/sweepy/"],
  "tpl-13": ["/tmh/apply/"],
  "tpl-14": ["/tmh/offboard/"],
  "tpl-15": ["/ush/thanks/"],
};

function partition(clusters: readonly TemplateCluster[]): Record<string, readonly string[]> {
  return Object.fromEntries(clusters.map((cluster) => [cluster.id, cluster.memberRoutes]));
}

/** Body of a Divi-ish page. Structure is the only thing the analysis may read. */
function pageHtml(options: {
  bodyClasses: readonly string[];
  sections: readonly (readonly number[])[];
  footer?: boolean;
  text?: string;
  imageSrc?: string;
  href?: string;
  instance?: number;
}): string {
  const instance = options.instance ?? 0;
  const sections = options.sections
    .map((rows, sectionIndex) => {
      const rowsHtml = rows
        .map((columns) => {
          const columnsHtml = Array.from({ length: columns }, () =>
            [
              `<div class="et_pb_column et_pb_column_1_3 et_pb_column_0">`,
              `<div class="et_pb_module et_pb_text et_pb_text_${instance}">`,
              `<div class="et_pb_text_inner"><p>${options.text ?? "copy"}</p></div>`,
              "</div>",
              "</div>",
            ].join(""),
          ).join("");
          return `<div class="et_pb_row et_pb_row_${sectionIndex}">${columnsHtml}</div>`;
        })
        .join("");
      return `<div class="et_pb_section et_pb_section_${sectionIndex} et_section_regular">${rowsHtml}</div>`;
    })
    .join("");

  const footer =
    options.footer === true
      ? [
          `<div id="footer" class="et_pb_section et_pb_section_1_tb_footer et_pb_with_background et_section_regular">`,
          `<div class="et_pb_row et_pb_row_0_tb_footer"><div class="et_pb_column et_pb_column_4_4 et_pb_column_4_tb_footer">`,
          `<div class="et_pb_module et_pb_heading et_pb_heading_0_tb_footer">`,
          `<div class="et_pb_heading_container"><h4>Footer</h4></div>`,
          "</div></div></div>",
          `<div class="et_pb_row et_pb_row_1_tb_footer"><div class="et_pb_column et_pb_column_4_4 et_pb_column_5_tb_footer">`,
          `<div class="et_pb_module et_pb_text et_pb_text_0_tb_footer">`,
          `<div class="et_pb_text_inner"><p>Footer text</p></div>`,
          "</div></div></div>",
          "</div>",
        ].join("")
      : "";

  return [
    "<!DOCTYPE html><html><head><title>fixture</title></head>",
    `<body class="${options.bodyClasses.join(" ")}">`,
    `<header id="main-header"><div class="container"><a href="${options.href ?? "/"}">Home</a></div></header>`,
    `<div id="main-content"><article class="et-l et-l--post"><div class="et_builder_inner_content">${sections}</div></article></div>`,
    `<img class="wp-image-662" src="${options.imageSrc ?? "/a.jpg"}" alt="x">`,
    `<a href="${options.href ?? "/contact"}">link</a>`,
    footer,
    "</body></html>",
  ].join("");
}

function measure(route: string, template: string, html: string): PageShape {
  return extractPageShape({ url: route, template, html });
}

describe("measured template count on the recorded capture", () => {
  it("reads 19 pages from the committed Site IR", () => {
    expect(shapes).toHaveLength(19);
    expect(shapes.map((shape) => shape.route)).toContain("/ush/thanks/");
  });

  it("measures 15 shape templates for 19 pages", () => {
    expect(registry.status).toBe("computed");
    expect(registry.pageCount).toBe(19);
    expect(registry.templateCount).toBe(15);
    expect(registry.summary.clustersWithMultiplePages).toBe(4);
    expect(registry.summary.clustersWithOnePage).toBe(11);
    expect(registry.summary.pagesInSharedTemplates).toBe(8);
    expect(registry.summary.largestClusterSize).toBe(2);
  });

  it("pins the cluster table exactly", () => {
    expect(partition(registry.clusters)).toEqual(MEASURED_TABLE);
  });

  it("partitions every route exactly once", () => {
    const routes = registry.clusters.flatMap((cluster) => cluster.memberRoutes);
    expect(new Set(routes).size).toBe(routes.length);
    expect(new Set(routes)).toEqual(new Set(shapes.map((shape) => shape.route)));
    expect(new Set(registry.clusters.map((cluster) => cluster.id)).size).toBe(15);
  });

  it("reports each cluster's own section count and signature", () => {
    for (const cluster of registry.clusters) {
      expect(cluster.sectionCount).toBe(cluster.signature.sections.length);
      expect(cluster.signature.sectionCount).toBe(cluster.sectionCount);
      expect(cluster.signature.rowCount).toBe(
        cluster.signature.sections.reduce((total, rows) => total + rows.length, 0),
      );
      expect(cluster.shapeVariants).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("the threshold is chosen from the data", () => {
  it("records the two scores that bracket the plateau", () => {
    // Cheapest genuine template match: one row's column count differs.
    expect(registry.summary.withinClusterSimilarity.min).toBeCloseTo(0.875, 10);
    // Highest false positive: 2 rows vs 3 rows, sharing only a prefix.
    expect(registry.summary.highestBetweenClusterSimilarity).toBeCloseTo(0.8, 10);
    expect(CLUSTER_THRESHOLD).toBeGreaterThan(THRESHOLD_BAND.above);
    expect(CLUSTER_THRESHOLD).toBeLessThanOrEqual(THRESHOLD_BAND.atMost);
  });

  it("gives one partition for every threshold in the measured band", () => {
    for (const threshold of [0.801, 0.82, 0.85, 0.86, 0.875]) {
      const clusters = clusterShapes(shapes, threshold);
      expect(clusters, `threshold ${threshold}`).toHaveLength(15);
      expect(partition(clusters), `threshold ${threshold}`).toEqual(MEASURED_TABLE);
    }
  });

  it("merges a false positive below the band and splits a real match above it", () => {
    const below = clusterShapes(shapes, 0.8);
    expect(below).toHaveLength(14);
    const merged = below.find((cluster) => cluster.memberRoutes.includes("/resources/sweepy/"));
    // At 0.800 the two-row /care/showings/ page joins the three-row /resources/sweepy/ page.
    expect(merged?.memberRoutes).toEqual(["/care/showings/", "/resources/sweepy/"]);

    const above = clusterShapes(shapes, 0.876);
    expect(above).toHaveLength(16);
  });

  it("scores identical shapes 1, and a missing section strictly less than 1", () => {
    const rowsA = measure("a", "", pageHtml({ bodyClasses: [], sections: [[1, 3]] }));
    const rowsB = measure(
      "b",
      "",
      pageHtml({ bodyClasses: [], sections: [[1, 3]], text: "different words" }),
    );
    const rowsC = measure("c", "", pageHtml({ bodyClasses: [], sections: [[1, 3], [3]] }));

    expect(shapeSimilarity(rowsA, rowsB)).toBe(1);
    expect(shapeSimilarity(rowsA, rowsC)).toBeLessThan(1);
    expect(sectionSimilarity([1, 3], [1, 3])).toBe(1);
    expect(sectionSimilarity([1, 3], [1])).toBeCloseTo(2 / 3, 10);
    expect(sectionSimilarity([], [])).toBe(1);
    expect(sectionSimilarity([], [1])).toBe(0);
  });
});

describe("content never leaks into the signature", () => {
  it("ignores text, image sources, links and Divi instance numbers", () => {
    const first = measure(
      "a",
      "",
      pageHtml({
        bodyClasses: ["page-template-default", "page-id-539", "windows"],
        sections: [[2], [3]],
        text: "Turtle Mountain Home",
        imageSrc: "/one.jpg",
        href: "/tmh/apply/",
        instance: 7,
      }),
    );
    const second = measure(
      "b",
      "",
      pageHtml({
        bodyClasses: ["page-template-default", "page-id-557", "osx"],
        sections: [[2], [3]],
        text: "Mill Lake Manor",
        imageSrc: "/two.png",
        href: "/mlm/applym/",
        instance: 2,
      }),
    );

    expect(first.sections).toEqual([[2], [3]]);
    expect(second.sections).toEqual([[2], [3]]);
    expect(shapeSimilarity(first, second)).toBe(1);
    expect(first.templateClasses).toEqual(["page-template-default"]);
    // `page-id-*` and instance classes are not template identity or CSS layout.
    expect(first.contentClasses).not.toContain("page-id-539");
    expect(first.contentClasses.some((token) => token.endsWith("_7"))).toBe(false);
  });

  it("classifies instance classes without touching layout fractions", () => {
    for (const token of [
      "et_pb_section_3",
      "et_pb_heading_12",
      "et_pb_column_3",
      "et_pb_button_0_wrapper",
      "et_pb_text_2_tb_footer",
      "page-id-557",
      "menu-item-529",
      "wp-image-662",
    ]) {
      expect(isInstanceClass(token), token).toBe(true);
    }
    for (const token of [
      "et_pb_column_1_3",
      "et_pb_column_4_4",
      "et_pb_gutters3",
      "et_pb_row",
      "et_section_regular",
    ]) {
      expect(isInstanceClass(token), token).toBe(false);
    }
  });

  it("keeps sharedCssClasses an intersection with no instance class in it", () => {
    const cluster = registry.clusters.find(
      (candidate) => candidate.id === "tpl-02",
    ) as TemplateCluster;
    expect(cluster.sharedCssClasses.length).toBeGreaterThan(0);
    for (const token of cluster.sharedCssClasses) {
      expect(isInstanceClass(token), token).toBe(false);
      for (const member of cluster.members) {
        const shape = shapes.find((page) => page.route === member.route) as PageShape;
        expect(shape.contentClasses).toContain(token);
      }
    }
  });
});

describe("site chrome is recorded, not compared", () => {
  it("excludes the Divi theme-builder footer from the page shape", () => {
    const withFooter = measure(
      "a",
      "",
      pageHtml({ bodyClasses: ["page-template-default"], sections: [[1]], footer: true }),
    );
    const withoutFooter = measure(
      "b",
      "",
      pageHtml({
        bodyClasses: ["page-template-page-template-blank-php"],
        sections: [[1]],
        footer: false,
      }),
    );

    expect(withFooter.sections).toEqual([[1]]);
    expect(withFooter.siteChrome).toEqual([[1, 1]]);
    expect(withoutFooter.siteChrome).toEqual([]);
    // Same content shape, different shell: the *shape* comparison is unaffected.
    expect(shapeSimilarity(withFooter, withoutFooter)).toBe(1);
  });

  it("names the two pages whose whole body is site chrome", () => {
    expect(registry.summary.chromeOnlyRoutes).toEqual(["/ush/owner/", "/ush/privacy-policy/"]);
    const chromeOnly = registry.clusters.find((cluster) => cluster.id === "tpl-04");
    expect(chromeOnly?.sectionCount).toBe(0);
    expect(chromeOnly?.label).toBe(shapeLabel([]));
  });
});

describe("WP template cross-check", () => {
  it("reports both partitions instead of reconciling them", () => {
    const groups = registry.wpTemplateCrossCheck.groups;
    const defaults = groups.find((group) => group.template === "");
    const blank = groups.find((group) => group.template === "page-template-blank.php");

    expect(defaults?.pageCount).toBe(16);
    expect(defaults?.clusterCount).toBe(12);
    expect(blank?.pageCount).toBe(3);
    expect(blank?.clusterCount).toBe(3);
    expect(blank?.routes).toEqual(["/mlm/applym/", "/tmh/apply/", "/ush/thanks/"]);
    expect(blank?.similarity.min).toBeCloseTo(0.333, 3);
    expect(blank?.similarity.max).toBeCloseTo(0.569, 3);
  });

  it("states that the template field predicts the shell but not the layout", () => {
    const kinds = registry.wpTemplateCrossCheck.findings.map((finding) => finding.kind);
    expect(kinds).toContain("same-template-different-shapes");
    expect(kinds).toContain("template-does-not-predict-shape");
    expect(kinds.filter((kind) => kind === "template-predicts-site-chrome")).toHaveLength(2);

    for (const group of registry.wpTemplateCrossCheck.groups) {
      expect(group.chromeProfiles).toHaveLength(1);
    }
    // The three blank-template pages legitimately disagree with each other's shape,
    // so no cluster mixes WP templates on this capture.
    expect(registry.wpTemplateCrossCheck.clustersMixingWpTemplates).toEqual([]);
  });

  it("flags a cluster that mixes WP templates rather than hiding it", () => {
    const sameShape = [[2]];
    const defaultShell = measure(
      "/a/",
      "",
      pageHtml({ bodyClasses: ["page-template-default"], sections: sameShape }),
    );
    const blankShell = measure(
      "/b/",
      "page-template-blank.php",
      pageHtml({
        bodyClasses: ["page-template-page-template-blank", "page-template-page-template-blank-php"],
        sections: sameShape,
      }),
    );

    const mixed = buildTemplateRegistry({ pages: [defaultShell, blankShell] });
    expect(mixed.templateCount).toBe(1);
    expect(mixed.clusters[0]?.wpTemplates).toEqual(["", "page-template-blank.php"]);
    expect(mixed.wpTemplateCrossCheck.clustersMixingWpTemplates).toEqual(["tpl-01"]);
    expect(mixed.wpTemplateCrossCheck.findings.map((finding) => finding.kind)).toContain(
      "cluster-mixes-wp-templates",
    );
  });
});

describe("determinism and staleness", () => {
  it("produces the committed registry byte for byte", () => {
    const committed = readFileSync(join(ROOT, "capture/template-registry.json"), "utf8");
    expect(serialiseRegistry(registry)).toBe(committed);
  });

  it("does not depend on page order", () => {
    const reversed = buildTemplateRegistry({
      pages: [...shapes].reverse(),
      irVersion: "1.1.0",
      capturedAt: "2026-11-10T06:03:49.699Z",
    });
    expect(serialiseRegistry(reversed)).toBe(serialiseRegistry(registry));
  });

  it("is cannot-evaluate with no pages, never '0 templates'", () => {
    const empty = buildTemplateRegistry({ pages: [] });
    expect(empty.status).toBe("cannot-evaluate");
    expect(empty.reasons.length).toBeGreaterThan(0);
    expect(empty.clusters).toEqual([]);
  });

  it("rejects an unreadable IR instead of measuring nothing", () => {
    const parsed = pagesFromIr("{ not json");
    expect(parsed.ok).toBe(false);
    const noPages = pagesFromIr('{"irVersion":"1.1.0"}');
    expect(noPages.ok).toBe(false);
  });
});

describe("the analyze:templates command", () => {
  it("prints the cluster table and the measured count", () => {
    const table = formatRegistryTable(registry);
    for (const cluster of registry.clusters) {
      expect(table).toContain(cluster.id);
      expect(table).toContain(cluster.exemplarRoute);
    }
    expect(table).toContain("19 page(s) → 15 shape template(s)");
    expect(table).toContain("threshold 0.85");
    expect(table).toContain("page-template-blank.php");
    expect(table).toContain("status: computed");
  });

  it("writes the registry, then reports the committed one as up to date", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cl-site-convert-templates-"));
    const outPath = join(directory, "template-registry.json");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    };

    const code = await runAnalyzeTemplates([], {
      cwd: ROOT,
      io,
    });
    expect(code).toBe(0);
    expect(stderr).toEqual([]);

    const written = join(ROOT, "capture/template-registry.json");
    const fromDisk = await readFile(written, "utf8");
    await writeFile(outPath, fromDisk, "utf8");

    const checkCode = await runAnalyzeTemplates(["--out", outPath, "--check"], {
      cwd: ROOT,
      io,
    });
    expect(checkCode).toBe(0);
    expect(stdout.join("\n")).toContain("is up to date");
    expect(await readFile(outPath, "utf8")).toBe(fromDisk);

    await writeFile(outPath, "{}\n", "utf8");
    const staleCode = await runAnalyzeTemplates(["--out", outPath, "--check"], {
      cwd: ROOT,
      io,
    });
    expect(staleCode).toBe(1);
    expect(stderr.join("\n")).toContain("is stale");
  });

  it("cannot evaluate an IR with no pages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cl-site-convert-empty-"));
    const irPath = join(directory, "site-ir.json");
    await writeFile(irPath, '{"irVersion":"1.1.0","pages":[]}\n', "utf8");
    const io = { stdout: () => undefined, stderr: () => undefined };
    expect(await runAnalyzeTemplates(["--ir", irPath], { cwd: directory, io })).toBe(2);
  });

  it("fails loudly on an unreadable IR", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cl-site-convert-broken-"));
    const irPath = join(directory, "site-ir.json");
    await writeFile(irPath, "{ not json", "utf8");
    const io = { stdout: () => undefined, stderr: () => undefined };
    expect(await runAnalyzeTemplates(["--ir", irPath], { cwd: directory, io })).toBe(1);
  });
});
