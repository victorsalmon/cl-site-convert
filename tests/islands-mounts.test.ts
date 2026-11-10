/**
 * Mount-slot scanning: what the emitter is allowed to conclude from a page.
 *
 * These tests are the data-layer half of "no islands ⇒ no wasm bytes". The
 * emitter will decide which bundles to ship by calling `bundlesForHtml`; if an
 * island-free page returned anything other than `[]`, the guarantee would be a
 * promise rather than a consequence. So the island-free case is tested against
 * real captured-shaped HTML, not an empty string in isolation.
 */

import { describe, expect, it } from "vitest";

import { parseIslandManifest } from "../src/islands/manifest.js";
import { MissingBundleError } from "../src/islands/manifest.js";
import type { IslandBundleManifest } from "../src/islands/manifest.js";
import { bundlesForHtml, scanIslandMounts } from "../src/islands/mounts.js";

const MANIFEST: IslandBundleManifest = parseIslandManifest({
  manifestVersion: 1,
  target: "wasm32-unknown-unknown",
  budgetBrotliBytes: 250 * 1024,
  components: Object.fromEntries(
    ["FluentForm", "SearchBox", "ConsentBanner"].map((component, index) => [
      component,
      {
        crate: component.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase(),
        wasmPath: `${component.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}.wasm`,
        rawBytes: 1000 + index,
        brotliBytes: 500 + index,
        sha256: "a".repeat(64),
      },
    ]),
  ),
});

/** A Divi-shaped page: deep nesting, no islands. */
const ISLAND_FREE_PAGE = `<!DOCTYPE html>
<html lang="en-CA">
  <head><style>.et_pb_section{display:block}</style></head>
  <body class="et_pb_pagebuilder_layout">
    <div id="page-container" class="et_pb_pagebuilder_layout">
      <div id="et-boc" class="et-boc">
        <div class="et_pb_section et_pb_section_0">
          <div class="et_pb_row"><div class="et_pb_column"><h1>Mill Lake Manor</h1></div></div>
        </div>
      </div>
    </div>
    <script>window.et_pb_custom = { "data-component": "NotAMount" };</script>
  </body>
</html>`;

describe("scanIslandMounts", () => {
  it("finds no mounts on an island-free page, and cites nothing", () => {
    const scan = scanIslandMounts(ISLAND_FREE_PAGE);

    expect(scan.mounts).toEqual([]);
    expect(scan.invalid).toEqual([]);
    expect(scan.components).toEqual([]);
  });

  it("finds mount slots and preserves the raw props string", () => {
    const scan = scanIslandMounts(`
      <div id="island-fluent-form" data-component="FluentForm" data-props='{"formId":3}'></div>
      <div data-props='{"term":"care"}' class="search" data-component="SearchBox"></div>
    `);

    expect(scan.mounts).toEqual([
      { index: 1, component: "FluentForm", props: '{"formId":3}' },
      { index: 2, component: "SearchBox", props: '{"term":"care"}' },
    ]);
    expect(scan.components).toEqual(["FluentForm", "SearchBox"]);
  });

  it("reports a repeated component once in `components` but every mount in `mounts`", () => {
    const scan = scanIslandMounts(`
      <div data-component="FluentForm" data-props='{"formId":3}'></div>
      <div data-component="FluentForm" data-props='{"formId":4}'></div>
    `);

    expect(scan.mounts.map((mount) => mount.index)).toEqual([1, 2]);
    expect(scan.components).toEqual(["FluentForm"]);
  });

  it("reports an invalid data-component value instead of dropping it", () => {
    const scan = scanIslandMounts(`<div data-component="fluent form"></div>`);

    expect(scan.mounts).toEqual([]);
    expect(scan.components).toEqual([]);
    expect(scan.invalid).toEqual([
      {
        index: 1,
        value: "fluent form",
        message: expect.stringContaining("not a valid component name"),
      },
    ]);
  });

  it("ignores data-component text that is not an element attribute", () => {
    const scan = scanIslandMounts(`
      <p>Set data-component="FluentForm" to mount a form.</p>
      <script>mount("data-component=\\"SearchBox\\"")</script>
    `);

    expect(scan.mounts).toEqual([]);
  });

  it("scans template content, which parse5 nests outside childNodes", () => {
    const scan = scanIslandMounts(
      `<template><div data-component="ConsentBanner"></div></template>`,
    );

    expect(scan.components).toEqual(["ConsentBanner"]);
  });
});

describe("bundlesForHtml", () => {
  it("returns no bundles for an island-free page", () => {
    expect(bundlesForHtml(ISLAND_FREE_PAGE, MANIFEST)).toEqual([]);
    expect(bundlesForHtml("", MANIFEST)).toEqual([]);
  });

  it("returns exactly the bundles the page mounts, in first-appearance order", () => {
    const html = `
      <div data-component="SearchBox"></div>
      <div data-component="FluentForm"></div>
      <div data-component="SearchBox"></div>
    `;

    expect(bundlesForHtml(html, MANIFEST).map((bundle) => bundle.wasmPath)).toEqual([
      "search-box.wasm",
      "fluent-form.wasm",
    ]);
  });

  it("refuses a page that mounts a component with no bundle", () => {
    const html = `<div data-component="FluentForm"></div><div data-component="ChatWidget"></div>`;

    expect(() => bundlesForHtml(html, MANIFEST)).toThrow(MissingBundleError);
    try {
      bundlesForHtml(html, MANIFEST);
    } catch (error) {
      expect(error).toBeInstanceOf(MissingBundleError);
      expect((error as MissingBundleError).missing.map((item) => item.component)).toEqual([
        "ChatWidget",
      ]);
    }
  });

  it("does not ship ConsentBanner for a page that does not mount it", () => {
    const html = `<div data-component="FluentForm"></div>`;
    const shipped = bundlesForHtml(html, MANIFEST).map((bundle) => bundle.crate);

    expect(shipped).toEqual(["fluent-form"]);
    expect(shipped).not.toContain("consent-banner");
  });
});
