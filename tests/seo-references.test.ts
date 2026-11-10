import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  groupReferences,
  looksLikeSchemeLessHost,
  reconcileBrokenReferences,
  referencePath,
  resolveReference,
  scanReferences,
  severityFor,
} from "../src/source/seo/links.js";
import type { RawReference, RecordedStatus } from "../src/source/seo/links.js";

const BASE = "https://upscalehavens.ca";
const FIXTURES = join(import.meta.dirname, "fixtures", "seo");

interface ReferenceFixture {
  provenance: string;
  pages: { url: string; html: string }[];
}

const references = JSON.parse(
  readFileSync(join(FIXTURES, "pages.references.json"), "utf8"),
) as ReferenceFixture;

/** The statuses the two source passes recorded for the real capture. */
function recordedStatuses(): Map<string, RecordedStatus> {
  return new Map<string, RecordedStatus>([
    // Route enumeration probed these three paths and got 404.
    [`${BASE}/mlm/applym/chatgpt.com`, { status: 404, source: "live-probe" }],
    [`${BASE}/mlm/onboard-mlm/chatgpt.com`, { status: 404, source: "live-probe" }],
    [`${BASE}/tmh/onboard-tmh/chatgpt.com`, { status: 404, source: "live-probe" }],
    // Asset capture fetched these two and got 404.
    [
      `${BASE}/wp-content/uploads/2024/07/real-estate-09-1024x648-1-400x284.jpg`,
      { status: 404, source: "asset-capture" },
    ],
    [
      `${BASE}/wp-content/uploads/2024/07/real-estate-09-1024x648-1.jpg`,
      { status: 404, source: "asset-capture" },
    ],
    // A healthy reference, to prove the reconciler does not report everything it sees.
    [
      `${BASE}/wp-content/uploads/2024/07/real-estate-08-400x284.jpg`,
      { status: 200, source: "asset-capture" },
    ],
  ]);
}

describe("looksLikeSchemeLessHost", () => {
  it("recognises the real defect", () => {
    expect(looksLikeSchemeLessHost("chatgpt.com")).toBe(true);
    expect(looksLikeSchemeLessHost("example.co.uk/path")).toBe(true);
  });

  it("does not relabel a normalised URL, a site path or a fragment", () => {
    expect(looksLikeSchemeLessHost("https://chatgpt.com")).toBe(false);
    expect(looksLikeSchemeLessHost("/care/")).toBe(false);
    expect(looksLikeSchemeLessHost("#top")).toBe(false);
    expect(looksLikeSchemeLessHost("mailto:someone@example.test")).toBe(false);
  });

  it("does not relabel a single-segment relative path", () => {
    expect(looksLikeSchemeLessHost("apply")).toBe(false);
    expect(looksLikeSchemeLessHost("./apply")).toBe(false);
  });

  it("does not relabel a file reference, which a scheme-less host looks nothing like", () => {
    expect(looksLikeSchemeLessHost("Moving-Inspection-Worksheet-v5.2.pdf")).toBe(false);
    expect(looksLikeSchemeLessHost("photo.jpg")).toBe(false);
  });
});

describe("resolveReference — the browser's own resolution", () => {
  it("resolves a scheme-less host as a path relative to the page, which is the defect", () => {
    expect(resolveReference("chatgpt.com", "/mlm/applym/", BASE)).toBe(
      `${BASE}/mlm/applym/chatgpt.com`,
    );
  });

  it("resolves an absolute URL unchanged", () => {
    expect(resolveReference(`${BASE}/care/`, "/", BASE)).toBe(`${BASE}/care/`);
  });

  it("returns null for a non-fetchable scheme", () => {
    expect(resolveReference("mailto:x@example.test", "/", BASE)).toBeNull();
    expect(resolveReference("tel:+12505550100", "/", BASE)).toBeNull();
  });

  it("reduces an on-site absolute URL to a path and leaves an off-site one absolute", () => {
    expect(referencePath(`${BASE}/care/`, BASE)).toBe("/care/");
    expect(referencePath("https://drive.google.com/file/d/abc/view", BASE)).toBe(
      "https://drive.google.com/file/d/abc/view",
    );
  });
});

describe("scanReferences over the captured excerpts", () => {
  const all = references.pages.flatMap((page) => {
    const scan = scanReferences(page.html, page.url, BASE);
    return [...scan.links, ...scan.images];
  });

  it("finds exactly three scheme-less chatgpt.com anchors, one per page", () => {
    const chatgpt = all.filter((reference) => reference.raw === "chatgpt.com");
    expect(chatgpt).toHaveLength(3);
    expect(chatgpt.map((reference) => reference.page).sort()).toEqual([
      "/mlm/applym/",
      "/mlm/onboard-mlm/",
      "/tmh/onboard-tmh/",
    ]);
    expect(chatgpt.every((reference) => reference.kind === "link")).toBe(true);
  });

  it("finds the gallery <a href> to the missing full-size image", () => {
    const hrefs = all.filter(
      (reference) =>
        reference.where === "href" && reference.resolved.includes("real-estate-09-1024x648-1.jpg"),
    );
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]?.page).toBe("/mlm/applym/");
  });

  it("finds both missing image URLs across src and srcset", () => {
    const images = all.filter(
      (reference) =>
        reference.kind === "image" && reference.resolved.includes("real-estate-09-1024x648-1"),
    );
    // The 400x284 file appears as `src` and as a `srcset` candidate; one URL is one
    // reference, so the duplicate candidate is folded rather than counted twice.
    expect(images.map((reference) => reference.where).sort()).toEqual(["src", "srcset"]);
  });

  it("de-duplicates one URL repeated inside a single page", () => {
    const duplicate = scanReferences('<a href="/care/">a</a><a href="/care/">b</a>', "/", BASE);
    expect(duplicate.links).toHaveLength(1);
  });

  it("keeps a reference reachable as both a link and an image as one grouped entry", () => {
    const grouped = groupReferences(all);
    const entry = grouped.get(`${BASE}/wp-content/uploads/2024/07/real-estate-09-1024x648-1.jpg`);
    expect(entry?.kinds.sort()).toEqual(["image", "link"]);
    expect(entry?.wheres.sort()).toEqual(["href", "srcset"]);
  });
});

describe("reconcileBrokenReferences — the one list both consumers read", () => {
  const referencesAll = references.pages.flatMap((page) => {
    const scan = scanReferences(page.html, page.url, BASE);
    return [...scan.links, ...scan.images] as RawReference[];
  });
  const findings = reconcileBrokenReferences({
    references: referencesAll,
    statuses: recordedStatuses(),
  });

  it("reports the five proven-broken references and nothing else", () => {
    expect(findings).toHaveLength(5);
    expect(findings.map((finding) => finding.resolved).sort()).toEqual(
      [
        `${BASE}/mlm/applym/chatgpt.com`,
        `${BASE}/mlm/onboard-mlm/chatgpt.com`,
        `${BASE}/tmh/onboard-tmh/chatgpt.com`,
        `${BASE}/wp-content/uploads/2024/07/real-estate-09-1024x648-1-400x284.jpg`,
        `${BASE}/wp-content/uploads/2024/07/real-estate-09-1024x648-1.jpg`,
      ].sort(),
    );
  });

  it("sorts high severity first, because a gallery link now outranks its image", () => {
    expect(findings.map((finding) => finding.severity)).toEqual([
      "high",
      "high",
      "high",
      "high",
      "medium",
    ]);
  });

  it("gives each finding a stable, unique id the defect bead can cite", () => {
    const ids = findings.map((finding) => finding.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The raw value is identical on all three pages, so the id carries the route too.
    expect(ids).toContain("scheme-less-chatgpt-com-link-mlm-applym-chatgpt-com");
    expect(ids.filter((id) => id.startsWith("scheme-less-chatgpt-com"))).toHaveLength(3);
  });

  it("records the status source, so a reader knows how it was proven", () => {
    const chatgpt = findings.find((finding) => finding.raw === "chatgpt.com");
    expect(chatgpt?.statusSource).toBe("live-probe");
    const image = findings.find((finding) => finding.severity === "medium");
    expect(image?.statusSource).toBe("asset-capture");
  });

  it("does not report a reference whose status was never recorded", () => {
    const unrecorded: RawReference[] = [
      {
        kind: "link",
        where: "href",
        raw: "/unprobed/",
        resolved: `${BASE}/unprobed/`,
        page: "/",
      },
    ];
    expect(reconcileBrokenReferences({ references: unrecorded, statuses: new Map() })).toEqual([]);
  });

  it("does not report a 2xx or a 3xx reference as broken", () => {
    const redirecting: RawReference[] = [
      { kind: "link", where: "href", raw: "/apply", resolved: `${BASE}/apply`, page: "/" },
    ];
    const statuses = new Map<string, RecordedStatus>([
      [`${BASE}/apply`, { status: 301, source: "live-probe" }],
    ]);
    expect(reconcileBrokenReferences({ references: redirecting, statuses })).toEqual([]);
  });
});

describe("severityFor", () => {
  it("calls a clickable link high, an image medium, a srcset-only candidate low", () => {
    expect(severityFor(["link"], ["href"])).toBe("high");
    expect(severityFor(["image"], ["src"])).toBe("medium");
    expect(severityFor(["image"], ["srcset"])).toBe("low");
  });

  it("judges a URL reachable both ways by its clickable form", () => {
    expect(severityFor(["image", "link"], ["srcset", "href"])).toBe("high");
    expect(severityFor(["image"], ["srcset", "src"])).toBe("medium");
  });
});
