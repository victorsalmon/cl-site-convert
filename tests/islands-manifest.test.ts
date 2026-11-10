/**
 * Manifest contract tests.
 *
 * The manifest is the only thing standing between "a component is mounted" and
 * "the right bytes are loaded", so it fails closed on every field. Two kinds of
 * drift are covered here:
 *
 *  - a manifest that is structurally wrong (bad version, traversal in a path,
 *    a brotli size over budget) must be refused, never defaulted;
 *  - a page that mounts a component the manifest does not describe must throw,
 *    because shipping it would produce a dead mount slot with no explanation.
 */

import { describe, expect, it } from "vitest";

import {
  ISLAND_BUDGET_BROTLI_BYTES,
  IslandManifestError,
  MANIFEST_VERSION,
  MissingBundleError,
  findBundle,
  parseIslandManifest,
  parseIslandManifestJson,
  resolveBundles,
  validateIslandManifest,
} from "../src/islands/manifest.js";

function validDocument(): Record<string, unknown> {
  return {
    manifestVersion: MANIFEST_VERSION,
    target: "wasm32-unknown-unknown",
    budgetBrotliBytes: ISLAND_BUDGET_BROTLI_BYTES,
    components: {
      FluentForm: {
        crate: "fluent-form",
        wasmPath: "fluent-form.wasm",
        rawBytes: 41_260,
        brotliBytes: 41_231,
        sha256: "b".repeat(64),
      },
      SearchBox: {
        crate: "search-box",
        wasmPath: "search-box.wasm",
        rawBytes: 9_133,
        brotliBytes: 9_104,
        sha256: "c".repeat(64),
      },
    },
  };
}

describe("validateIslandManifest", () => {
  it("accepts the emitted shape", () => {
    expect(validateIslandManifest(validDocument())).toEqual([]);
  });

  it("refuses a manifest with no components", () => {
    const document = { ...validDocument(), components: {} };
    expect(validateIslandManifest(document).map((problem) => problem.path)).toContain("components");
  });

  it("refuses an unknown manifest version", () => {
    const document = { ...validDocument(), manifestVersion: 2 };
    expect(validateIslandManifest(document)).toContainEqual(
      expect.objectContaining({ path: "manifestVersion" }),
    );
  });

  it("refuses a component name that is not a data-component identifier", () => {
    const document = validDocument();
    const components = document["components"] as Record<string, unknown>;
    components["fluent form"] = components["FluentForm"];
    expect(validateIslandManifest(document)).toContainEqual(
      expect.objectContaining({ path: "components.fluent form" }),
    );
  });

  it("refuses a wasm path that escapes the bundle directory", () => {
    const document = validDocument();
    const components = document["components"] as Record<string, Record<string, unknown>>;
    components["FluentForm"]!["wasmPath"] = "../../etc/passwd.wasm";
    expect(validateIslandManifest(document)).toContainEqual(
      expect.objectContaining({ path: "components.FluentForm.wasmPath" }),
    );
  });

  it("refuses a non-hex sha256", () => {
    const document = validDocument();
    const components = document["components"] as Record<string, Record<string, unknown>>;
    components["FluentForm"]!["sha256"] = "not-a-hash";
    expect(validateIslandManifest(document)).toContainEqual(
      expect.objectContaining({ path: "components.FluentForm.sha256" }),
    );
  });

  it("refuses a bundle that exceeds the budget the manifest declares", () => {
    const document = validDocument();
    const components = document["components"] as Record<string, Record<string, unknown>>;
    components["FluentForm"]!["brotliBytes"] = ISLAND_BUDGET_BROTLI_BYTES;
    expect(validateIslandManifest(document)).toContainEqual(
      expect.objectContaining({ path: "components.FluentForm.brotliBytes" }),
    );
  });

  it("refuses a zero-byte measurement", () => {
    const document = validDocument();
    const components = document["components"] as Record<string, Record<string, unknown>>;
    components["SearchBox"]!["rawBytes"] = 0;
    expect(validateIslandManifest(document)).toContainEqual(
      expect.objectContaining({ path: "components.SearchBox.rawBytes" }),
    );
  });

  it("reports every problem at once rather than the first", () => {
    const document = validDocument();
    document["manifestVersion"] = 0;
    document["target"] = "";
    expect(validateIslandManifest(document).length).toBeGreaterThan(1);
  });
});

describe("parseIslandManifest", () => {
  it("returns the typed manifest", () => {
    const manifest = parseIslandManifest(validDocument());
    expect(Object.keys(manifest.components)).toEqual(["FluentForm", "SearchBox"]);
  });

  it("throws with every problem addressed", () => {
    expect(() => parseIslandManifest({ ...validDocument(), components: {} })).toThrow(
      IslandManifestError,
    );
  });

  it("reports invalid JSON as a manifest problem, not a crash", () => {
    expect(() => parseIslandManifestJson("{ not json")).toThrow(IslandManifestError);
    try {
      parseIslandManifestJson("{ not json");
    } catch (error) {
      expect((error as IslandManifestError).problems[0]?.message).toContain("not valid JSON");
    }
  });
});

describe("bundle resolution", () => {
  const manifest = parseIslandManifest(validDocument());

  it("resolves in first-appearance order and collapses duplicates", () => {
    const bundles = resolveBundles(["SearchBox", "FluentForm", "SearchBox"], manifest);
    expect(bundles.map((bundle) => bundle.crate)).toEqual(["search-box", "fluent-form"]);
  });

  it("returns nothing for an island-free page", () => {
    expect(resolveBundles([], manifest)).toEqual([]);
  });

  it("throws when a present component has no bundle", () => {
    expect(() => resolveBundles(["FluentForm", "ChatWidget"], manifest)).toThrow(
      MissingBundleError,
    );
  });

  it("does not resolve inherited object properties as components", () => {
    expect(findBundle("constructor", manifest)).toBeUndefined();
    expect(findBundle("toString", manifest)).toBeUndefined();
  });
});
