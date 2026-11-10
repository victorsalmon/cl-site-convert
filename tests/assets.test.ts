/**
 * Asset + style capture: the properties that make `styles[]` and `assets[]`
 * trustworthy.
 *
 * The unit tests pin the pure decisions (document order, path mirroring,
 * deduplication, reference extraction). The fixture test drives the whole pass
 * against **recorded** pages and stylesheets with a stubbed `fetch`, so the
 * behaviour is proved without a single live request. The committed-evidence test
 * lives in `asset-integrity.test.ts`.
 */

import { readFileSync, readdirSync, rmSync, statSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyRewriteMap,
  assetKind,
  assignPaths,
  captureAssets,
  cssAssetRefs,
  cssUrlRefs,
  mergeStyleOrder,
  pageAssetRefs,
  pageStyleRefs,
  resolveAssetUrl,
  sha256Hex,
  srcsetUrls,
  verifyFiles,
  MEDIA_ROOT,
  STYLE_ROOT,
} from "../src/source/wp-rest/assets.js";
import type { RewriteMap } from "../src/source/wp-rest/assets.js";
import { elementPayloads, normaliseDocument } from "../src/source/wp-rest/dom.js";
import { PoliteFetcher } from "../src/source/wp-rest/http.js";
import type { SiteIr } from "../src/schema/site-ir.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "assets");
const readFixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const readFixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(FIXTURES, name)));

const BASE_URL = "https://example.test";

const tempDirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cl-site-assets-"));
  tempDirs.push(dir);
  return dir;
}

/** Stub `fetch` from the recorded route table. No test here touches the network. */
function stubRecordedRoutes(): { requests: string[] } {
  const routes = JSON.parse(readFixture("routes.json")) as Record<
    string,
    { file?: string; contentType?: string; status?: number }
  >;
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    const route = routes[url];
    if (route === undefined) return new Response("no fixture for this url", { status: 599 });
    if (route.file === undefined) return new Response("", { status: route.status ?? 200 });
    const body = readFixtureBytes(route.file);
    return new Response(body, {
      status: route.status ?? 200,
      headers: {
        "content-type": route.contentType ?? "application/octet-stream",
        "x-litespeed-cache": "hit",
      },
    });
  });
  return { requests };
}

describe("pageStyleRefs", () => {
  it("interleaves linked and inline styles in document order", () => {
    const html = readFixture("page-home.html");
    const refs = pageStyleRefs(html, "/", BASE_URL);
    expect(refs.map((ref) => ref.origin)).toEqual(["inline", "linked", "inline"]);
    const linked = refs[1];
    expect(linked?.origin === "linked" ? linked.href : "").toContain("style.css?ver=1.2.3");
    expect(linked?.origin === "linked" ? linked.media : null).toBe("all");
  });

  it("hashes the whole <style> element and keeps the CSS between the tags verbatim", () => {
    const html = readFixture("page-home.html");
    const elements = elementPayloads(html, "style");
    const refs = pageStyleRefs(html, "/", BASE_URL).filter((ref) => ref.origin === "inline");
    expect(refs).toHaveLength(elements.length);
    for (const [index, ref] of refs.entries()) {
      const element = elements[index];
      if (element === undefined || ref.origin !== "inline") throw new Error("missing element");
      expect(ref.elementSha256).toBe(sha256Hex(element.element));
      // The inner slice is the CSS itself: no trimming, no re-serialisation.
      expect(ref.css).toBe(element.inner);
      expect(element.element.startsWith("<style")).toBe(true);
      expect(element.element.endsWith("</style>")).toBe(true);
    }
  });

  it("decodes the escaped ampersand in a Google Fonts href without altering the captured href", () => {
    const html = `<link rel="stylesheet" href="https://fonts.example/css?family=A&#038;subset=latin" />`;
    const ref = pageStyleRefs(html, "/", BASE_URL)[0];
    if (ref?.origin !== "linked") throw new Error("expected a linked style");
    expect(ref.href).toContain("&#038;");
    expect(ref.hrefUrl).toBe("https://fonts.example/css?family=A&subset=latin");
  });
});

describe("mergeStyleOrder", () => {
  it("refuses a contradictory cascade instead of silently reordering a page", () => {
    // b before a (page /c/) and a before b (page /a/) cannot both hold.
    expect(() =>
      mergeStyleOrder([
        { page: "/a/", keys: ["a", "b", "c"] },
        { page: "/b/", keys: ["a", "c"] },
        { page: "/c/", keys: ["b", "a"] },
      ]),
    ).toThrow(/contradictory/);
  });

  it("merges compatible sequences deterministically and stably", () => {
    const sequences = [
      { page: "/a/", keys: ["x", "y", "z"] },
      { page: "/b/", keys: ["x", "z"] },
      { page: "/c/", keys: ["y", "w"] },
    ];
    const first = mergeStyleOrder(sequences);
    expect(new Set(first)).toEqual(new Set(["x", "y", "z", "w"]));
    // x precedes y precedes z; w only has to follow y.
    expect(first.indexOf("x")).toBeLessThan(first.indexOf("y"));
    expect(first.indexOf("y")).toBeLessThan(first.indexOf("z"));
    expect(first.indexOf("y")).toBeLessThan(first.indexOf("w"));
    expect(mergeStyleOrder(sequences)).toEqual(first);
  });
});

describe("assignPaths", () => {
  it("mirrors same-host paths and namespaces other hosts", () => {
    const [same, external] = assignPaths(
      [
        "https://example.test/wp-content/themes/t/style.css?ver=1",
        "https://fonts.example/css?family=Inter",
      ],
      STYLE_ROOT,
      "example.test",
    );
    expect(same?.outputPath).toBe("wp-content/themes/t/style.css");
    expect(same?.capturePath).toBe(`${STYLE_ROOT}/wp-content/themes/t/style.css`);
    expect(external?.outputPath).toBe("external/fonts.example/css");
  });

  it("disambiguates two URLs that share a pathname, and does so deterministically", () => {
    const urls = ["https://fonts.example/css?family=A", "https://fonts.example/css?family=B"];
    const first = assignPaths(urls, STYLE_ROOT, "example.test");
    const second = assignPaths(urls, STYLE_ROOT, "example.test");
    expect(first[0]?.outputPath).not.toBe(first[1]?.outputPath);
    expect(first).toEqual(second);
    // A suffix must not collide with the untouched path of a third URL.
    expect(first[0]?.outputPath).toMatch(/^external\/fonts\.example\/css-[0-9a-f]{8}$/);
  });

  it("keeps a relative url() in CSS resolvable at the emitted path", () => {
    // The whole point of mirroring: this is the rule the emitter relies on.
    const cssUrl = "https://example.test/wp-content/themes/t/style.css";
    const mediaUrl = resolveAssetUrl("../uploads/bg.png", cssUrl);
    expect(mediaUrl).toBe("https://example.test/wp-content/themes/uploads/bg.png");
    const [css] = assignPaths([cssUrl], STYLE_ROOT, "example.test");
    const [media] = assignPaths([mediaUrl ?? ""], MEDIA_ROOT, "example.test");
    if (css === undefined || media === undefined) throw new Error("planning failed");
    // Relative to the CSS file's emitted location, the media lands exactly there.
    const cssDir = css.outputPath.split("/").slice(0, -1).join("/");
    const resolved = new URL(
      `../uploads/${media.outputPath.split("/").at(-1)}`,
      `https://x/${cssDir}/`,
    );
    expect(resolved.pathname.replace(/^\//, "")).toBe(media.outputPath);
  });
});

describe("kind and reference extraction", () => {
  it("classifies by extension, then by content type", () => {
    expect(assetKind("https://x/y/photo.JPG")).toBe("image");
    expect(assetKind("https://x/f.woff2")).toBe("font");
    expect(assetKind("https://x/a.woff2?dcdb1ef8")).toBe("font");
    expect(assetKind("https://x/clip.mp4")).toBe("media");
    expect(assetKind("https://x/doc.pdf")).toBe("document");
    expect(assetKind("https://x/app.min.js")).toBe("script");
    expect(assetKind("https://x/no-extension", "image/webp")).toBe("image");
    expect(assetKind("https://x/no-extension", "text/plain")).toBe("other");
  });

  it("resolves references without inventing URLs", () => {
    expect(resolveAssetUrl("//cdn.example/a.png", BASE_URL)).toBe("https://cdn.example/a.png");
    expect(resolveAssetUrl("/a/b.png", BASE_URL)).toBe("https://example.test/a/b.png");
    expect(resolveAssetUrl("data:image/svg+xml;base64,AAAA", BASE_URL)).toBeNull();
    expect(resolveAssetUrl("mailto:hi@example.test", BASE_URL)).toBeNull();
    expect(resolveAssetUrl("#top", BASE_URL)).toBeNull();
  });

  it("reads srcset descriptors and CSS url()/ @import targets", () => {
    expect(srcsetUrls("/a.png 1x, /b.png 2x")).toEqual(["/a.png", "/b.png"]);
    expect(cssUrlRefs(`a{background:url( "../img/bg.png" )} b{src:url(f.woff2)}`)).toEqual([
      "../img/bg.png",
      "f.woff2",
    ]);
    expect(cssUrlRefs(`@import "print.css";`)).toEqual(["print.css"]);
  });

  it("collects images, icons, style attributes and CSS references", () => {
    const refs = pageAssetRefs(readFixture("page-home.html"), "/", BASE_URL);
    const urls = refs.map((ref) => ref.url);
    expect(urls).toContain("https://example.test/wp-content/uploads/logo.png");
    expect(urls).toContain("https://example.test/wp-content/uploads/logo-300x300.png");
    expect(urls).toContain("https://example.test/wp-content/uploads/bg.png");
    expect(refs.every((ref) => ref.url.startsWith("https://"))).toBe(true);
    const fromCss = cssAssetRefs(
      readFixture("styles/app.css"),
      "https://example.test/wp-content/themes/t/app.css",
    );
    expect(fromCss.map((ref) => ref.url)).toEqual([
      "https://example.test/wp-content/themes/t/fonts/inter.woff2?dcdb1ef8",
    ]);
  });
});

describe("verifyFiles", () => {
  it("reports a mismatch and a missing file as problems, never as a pass", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ok.css"), "body{color:#000}");
    const record = { capturePath: "ok.css", sha256: sha256Hex("body{color:#000}") };
    expect(await verifyFiles([record], dir)).toEqual([]);

    writeFileSync(join(dir, "bad.css"), "body{color:#001}");
    const problems = await verifyFiles(
      [
        record,
        { capturePath: "bad.css", sha256: sha256Hex("body{color:#000}") },
        { capturePath: "gone.css", sha256: record.sha256 },
      ],
      dir,
    );
    expect(problems.map((problem) => problem.capturePath).sort()).toEqual(["bad.css", "gone.css"]);
    expect(problems.find((p) => p.capturePath === "gone.css")?.actual).toBeNull();
  });
});

describe("applyRewriteMap", () => {
  it("converts recorded absolute and root-relative references to emitted paths", () => {
    const map: Pick<RewriteMap, "rewrite"> = {
      rewrite: {
        "https://example.test/wp-content/uploads/logo.png": "wp-content/uploads/logo.png",
        "/wp-content/uploads/logo.png": "wp-content/uploads/logo.png",
      },
    };
    const html = `<img src="https://example.test/wp-content/uploads/logo.png"><img src="/wp-content/uploads/logo.png">`;
    expect(applyRewriteMap(html, map)).toBe(
      `<img src="/wp-content/uploads/logo.png"><img src="/wp-content/uploads/logo.png">`,
    );
  });
});

// ---------------------------------------------------------------------------
// The whole pass, against recorded fixtures
// ---------------------------------------------------------------------------

function buildFixtureIr(): SiteIr {
  const pages = [
    { url: "/", slug: "home", file: "page-home.html", template: "" },
    { url: "/care/", slug: "care", file: "page-care.html", template: "" },
    { url: "/broken/", slug: "broken", file: "page-broken.html", template: "" },
  ].map((entry) => ({
    url: entry.url,
    slug: entry.slug,
    status: "publish" as const,
    template: entry.template,
    dom: ((): { html: string } => {
      const normalised = normaliseDocument(readFixture(entry.file));
      return { html: normalised.html };
    })(),
  }));
  return {
    irVersion: "1.0.0",
    site: {
      baseUrl: BASE_URL,
      title: "Fixture",
      locale: "en_CA",
      permalinks: { structure: "/%postname%/" },
    },
    pages,
    assets: [],
    styles: [],
    capabilities: {
      supported: ["wp-rest"],
      unsupported: [
        {
          capability: "inline-style-blocks",
          detail: "placeholder the asset pass must rewrite",
          blocking: true,
          where: ["/", "/care/", "/broken/"],
        },
      ],
    },
    capture: { sourceAdapter: "wp-rest", capturedAt: "2026-11-10T00:00:00.000Z" },
  };
}

async function runFixtureCapture(): Promise<{
  ir: SiteIr;
  map: RewriteMap;
  chain: unknown;
  report: Awaited<ReturnType<typeof captureAssets>>["report"];
  failures: string[];
  root: string;
  requests: string[];
}> {
  const root = tempDir();
  const irPath = join(root, "site-ir.json");
  writeFileSync(irPath, `${JSON.stringify(buildFixtureIr(), null, 2)}\n`);
  const { requests } = stubRecordedRoutes();
  const fetcher = new PoliteFetcher({ baseUrl: BASE_URL, minIntervalMs: 0, attempts: 1 });
  const result = await captureAssets({
    baseUrl: BASE_URL,
    irPath,
    captureReportPath: join(FIXTURES, "capture-report.json"),
    rootDir: root,
    fetcher,
  });
  return { ...result, root, requests };
}

describe("captureAssets (recorded fixtures)", () => {
  it("captures linked styles in document order and leaves gaps where inline blocks sit", async () => {
    const { ir, report, failures } = await runFixtureCapture();
    expect(failures).toEqual([]);
    expect(report.totals.stylesLinked).toBe(2);
    // theme.css and app.css are the only linked sheets; their `order` is their
    // position in the interleaved chain, so the numbers are not contiguous.
    expect(ir.styles.map((style) => style.order)).toEqual([1, 3]);
    expect(ir.styles[0]?.href).toContain("style.css?ver=1.2.3");
    expect(ir.styles[0]?.localPath).toBe("wp-content/themes/t/style.css");
    expect(report.verification.ok).toBe(true);
  });

  it("deduplicates repeated inline blocks by sha256 and reports the saving", async () => {
    const { report, chain, root } = await runFixtureCapture();
    // 5 blocks across 3 pages; the shared WP global-styles block collapses.
    expect(report.totals.inlineBlocksTotal).toBe(5);
    expect(report.totals.inlineBlocksUnique).toBe(4);
    expect(report.totals.inlineBytesSaved).toBeGreaterThan(0);
    expect(report.totals.inlineBytesUnique).toBeLessThan(report.totals.inlineBytesTotal);

    const chainEntries = (chain as { styleChain: { origin: string; sha256: string }[] }).styleChain;
    const inlineFiles = readdirSync(join(root, "capture/assets/styles/inline"));
    expect(inlineFiles).toHaveLength(4);
    expect(inlineFiles.every((name) => /^[0-9a-f]{64}\.css$/.test(name))).toBe(true);
    // Every materialised file name is the hash of its own bytes.
    for (const name of inlineFiles) {
      const bytes = readFileSync(join(root, "capture/assets/styles/inline", name));
      expect(sha256Hex(new Uint8Array(bytes))).toBe(name.replace(/\.css$/, ""));
    }
    expect(chainEntries.filter((entry) => entry.origin === "inline").length).toBeGreaterThan(0);
  });

  it("writes CSS byte-identically, including relative url() targets", async () => {
    const { map, root, report } = await runFixtureCapture();
    const written = readFileSync(join(root, "capture/assets/styles/wp-content/themes/t/style.css"));
    expect(new Uint8Array(written)).toEqual(readFixtureBytes("styles/theme.css"));

    const theme = map.styles.find((style) => style.localPath === "wp-content/themes/t/style.css");
    expect(theme?.sha256).toBe(sha256Hex(readFixtureBytes("styles/theme.css")));

    // theme.css asks for `../uploads/bg.png`; that has to be captured, and the
    // emitted path has to stay the CSS file's sibling.
    const sibling = map.assets.find(
      (asset) => asset.sourceUrl === "https://example.test/wp-content/themes/uploads/bg.png",
    );
    expect(sibling?.localPath).toBe("wp-content/themes/uploads/bg.png");
    expect(report.verification.ok).toBe(true);
  });

  it("records media with kind, hash, bytes and the pages that referenced it", async () => {
    const { ir } = await runFixtureCapture();
    const logo = ir.assets.find((asset) => asset.sourceUrl.endsWith("/uploads/logo.png"));
    expect(logo?.kind).toBe("image");
    expect(logo?.localPath).toBe("wp-content/uploads/logo.png");
    expect(logo?.sha256).toBe(sha256Hex(readFixtureBytes("media/logo.png")));
    expect(logo?.referencedBy).toContain("/");
    const font = ir.assets.find((asset) => asset.sourceUrl.includes("inter.woff2"));
    expect(font?.kind).toBe("font");
    expect(ir.assets.every((asset) => asset.sourceUrl.startsWith("https://"))).toBe(true);
  });

  it("treats a 404 asset as a recorded site defect, not a capture failure", async () => {
    const { report, failures, ir } = await runFixtureCapture();
    expect(failures).toEqual([]);
    expect(report.brokenReferences.map((entry) => entry.ref)).toEqual([
      "https://example.test/wp-content/uploads/missing.png",
    ]);
    expect(report.brokenReferences[0]?.pages).toEqual(["/broken/"]);
    const capability = ir.capabilities.unsupported.find(
      (entry) => entry.capability === "broken-asset-reference",
    );
    expect(capability?.blocking).toBe(false);
    expect(capability?.where).toEqual(["/broken/"]);
    // The capture itself is complete: everything it could fetch was verified.
    expect(report.verification.ok).toBe(true);
  });

  it("rewrites every captured reference to a local path through the map", async () => {
    const { ir, map, root } = await runFixtureCapture();
    const home = ir.pages.find((page) => page.url === "/");
    if (home === undefined) throw new Error("missing page");
    const rewritten = applyRewriteMap(home.dom.html, map);
    expect(rewritten).not.toContain("https://example.test/wp-content");
    expect(rewritten).toContain("/wp-content/uploads/logo.png");

    // Every file the map promises exists, and every byte count matches the disk.
    for (const asset of map.assets) {
      const bytes = statSync(join(root, asset.capturePath)).size;
      expect(bytes).toBe(asset.bytes);
    }
  });

  it("keeps styles[] free of inline entries, because v1 requires an href", async () => {
    const { ir, chain } = await runFixtureCapture();
    const chainEntries = (chain as { styleChain: { origin: string; localPath: string }[] })
      .styleChain;
    expect(chainEntries.some((entry) => entry.origin === "inline")).toBe(true);
    expect(ir.styles.every((style) => style.href.length > 0)).toBe(true);
    expect(ir.styles.some((style) => style.localPath.startsWith("assets/inline/"))).toBe(false);
  });
});
