/**
 * The per-plugin bundle proof: which bundles a page actually requests.
 *
 * The bead's acceptance criterion is "a page with zero islands loads zero wasm
 * bytes, verified by network assertion". This file is that assertion, and it is
 * deliberately in **Node with a fake `fetch`**, not a browser:
 *
 *  - a browser would prove today's wiring, but could not prove the load *set* —
 *    "exactly these two, not the other three" is only observable when every call
 *    is recorded in order;
 *  - the loader's network surface is one injected function, so a fake is not a
 *    weaker substitute. It is the same code path with a countable boundary.
 *
 * The manifest below is a fixture, not the emitted one: it has four components so
 * "only the present ones are fetched" is a real claim rather than a tautology.
 * The emitted manifest is verified against the built crates by
 * `scripts/wasm-size.mjs`.
 */

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseIslandManifest } from "../src/islands/manifest.js";
import type { IslandBundleManifest } from "../src/islands/manifest.js";
import { parsePropsAttribute, startIslands } from "../src/runtime/loader.js";
import type {
  FetchResponseLike,
  IslandNodeLike,
  IslandRootLike,
  IslandsStartResult,
  WasmInstanceLike,
} from "../src/runtime/loader.js";

function entry(crate: string, brotliBytes: number) {
  return {
    crate,
    wasmPath: `${crate}.wasm`,
    rawBytes: brotliBytes + 29,
    brotliBytes,
    sha256: "0".repeat(64),
  };
}

/** Four components; most scenarios must leave three of them unfetched. */
const MANIFEST: IslandBundleManifest = parseIslandManifest({
  manifestVersion: 1,
  target: "wasm32-unknown-unknown",
  budgetBrotliBytes: 250 * 1024,
  components: {
    FluentForm: entry("fluent-form", 41231),
    SearchBox: entry("search-box", 9104),
    ConsentBanner: entry("consent-banner", 7712),
    IslandsCore: entry("islands-core", 100),
  },
});

const COMPONENT_BY_FILE = new Map(
  Object.entries(MANIFEST.components).flatMap(([component, bundle]) => [
    [bundle.wasmPath, component] as const,
    [`${bundle.crate}.js`, component] as const,
  ]),
);

// --- fake DOM ----------------------------------------------------------------

class FakeNode implements IslandNodeLike {
  private readonly attributes = new Map<string, string>();

  constructor(attributes: Record<string, string>) {
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  state(): string | null {
    return this.getAttribute("data-island-state");
  }
}

class FakeRoot implements IslandRootLike {
  readonly selectors: string[] = [];

  constructor(private readonly nodes: readonly FakeNode[]) {}

  querySelectorAll(selector: string): ArrayLike<IslandNodeLike> {
    this.selectors.push(selector);
    // The loader must ask for mount nodes and nothing else.
    return selector === "[data-component]" ? this.nodes : [];
  }
}

function mount(component: string, props?: string): FakeNode {
  const attributes: Record<string, string> = { "data-component": component };
  if (props !== undefined) attributes["data-props"] = props;
  return new FakeNode(attributes);
}

// --- harness -----------------------------------------------------------------

interface RunOptions {
  /** Entries that ship JS glue instead of a bare `.wasm`. */
  readonly glueFor?: readonly string[];
  /** ABI version reported by loaded bundles. Defaults to the loader's. */
  readonly abi?: number;
  /** Components whose bundle exposes a DOM `mount()` export. */
  readonly mountable?: readonly string[];
  /** Components whose load throws. */
  readonly failLoad?: readonly string[];
  /** Components whose `mount()` throws. */
  readonly failMount?: readonly string[];
  /** Fetch the manifest instead of inlining it. */
  readonly manifestUrl?: string;
}

interface Run {
  readonly result: IslandsStartResult;
  readonly fetchCalls: string[];
  readonly imported: string[];
  readonly mountedWith: Array<{ component: string; props: Record<string, unknown> }>;
  readonly consoleErrors: string[];
  readonly root: FakeRoot;
}

const consoleSpies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

/** Build a manifest for a run, optionally turning some entries into glue modules. */
function manifestFor(glueFor: readonly string[]): IslandBundleManifest {
  const components = Object.fromEntries(
    Object.entries(MANIFEST.components).map(([component, bundle]) => [
      component,
      glueFor.includes(component) ? { ...bundle, modulePath: `${bundle.crate}.js` } : bundle,
    ]),
  );
  return { ...MANIFEST, components };
}

async function runLoader(nodes: readonly FakeNode[], options: RunOptions = {}): Promise<Run> {
  const manifest = manifestFor(options.glueFor ?? []);
  const fetchCalls: string[] = [];
  const imported: string[] = [];
  const mountedWith: Array<{ component: string; props: Record<string, unknown> }> = [];
  const consoleErrors: string[] = [];

  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map((value) => String(value)).join(" "));
  });
  consoleSpies.push(spy);

  const mountable = new Set(options.mountable ?? []);
  const failLoad = new Set(options.failLoad ?? []);
  const failMount = new Set(options.failMount ?? []);

  /** The URL the fake `instantiateStreaming` is currently satisfying. */
  let inFlight = "";

  const fetchImpl = async (url: string): Promise<FetchResponseLike> => {
    fetchCalls.push(url);
    inFlight = url;
    if (url.endsWith("manifest.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => manifest,
      } as FetchResponseLike;
    }
    return { ok: true, status: 200 };
  };

  const instantiateStreaming = async (
    source: FetchResponseLike,
  ): Promise<{ instance: WasmInstanceLike }> => {
    void source;
    const file = inFlight.split("/").pop() ?? "";
    const component = COMPONENT_BY_FILE.get(file) ?? file;
    if (failLoad.has(component)) throw new Error("instantiation exploded");

    const exports: Record<string, unknown> = {
      islands_core_abi_version: () => options.abi ?? 1,
    };
    if (mountable.has(component)) {
      exports["mount"] = (_node: IslandNodeLike, props: Record<string, unknown>) => {
        if (failMount.has(component)) throw new Error("mount exploded");
        mountedWith.push({ component, props });
      };
    }
    return { instance: { exports } };
  };

  const importModule = async (url: string): Promise<unknown> => {
    imported.push(url);
    const file = url.split("/").pop() ?? "";
    const component = COMPONENT_BY_FILE.get(file);
    if (component === undefined) throw new Error(`no fixture component for ${url}`);
    return {
      mount: (_node: IslandNodeLike, props: Record<string, unknown>) => {
        mountedWith.push({ component, props });
      },
    };
  };

  const root = new FakeRoot(nodes);

  const result = await startIslands(root, {
    manifest,
    fetch: fetchImpl,
    instantiateStreaming,
    importModule,
    ...(options.manifestUrl !== undefined ? { manifestUrl: options.manifestUrl } : {}),
  });

  spy.mockRestore();

  return { result, fetchCalls, imported, mountedWith, consoleErrors, root };
}

// --- the proof ---------------------------------------------------------------

describe("zero-island and minimal-load proof", () => {
  it("island-free page: zero bundle fetches, zero manifest fetches, zero requests", async () => {
    const run = await runLoader([], {
      manifestUrl: "/pkg/manifest.json",
      glueFor: ["FluentForm", "SearchBox"],
    });

    expect(run.result.status).toBe("no-islands");
    expect(run.result.components).toEqual([]);
    expect(run.result.requests).toEqual([]);
    expect(run.result.outcomes).toEqual([]);
    expect(run.result.errors).toEqual([]);
    // The manifest URL existed and was still never requested.
    expect(run.fetchCalls).toEqual([]);
    expect(run.root.selectors).toEqual(["[data-component]"]);
  });

  it("two mounts fetch exactly those two bundles, never the other components", async () => {
    const run = await runLoader([mount("FluentForm", '{"formId":3}'), mount("SearchBox")]);

    expect(run.result.status).toBe("started");
    expect(run.result.components).toEqual(["FluentForm", "SearchBox"]);
    expect(run.result.requests).toEqual(["fluent-form.wasm", "search-box.wasm"]);
    expect(run.fetchCalls).toEqual(["fluent-form.wasm", "search-box.wasm"]);

    for (const absent of ["consent-banner.wasm", "islands-core.wasm"]) {
      expect(run.fetchCalls).not.toContain(absent);
    }
  });

  it("one bundle per component: a repeated mount loads once and mounts twice", async () => {
    const run = await runLoader(
      [mount("FluentForm", '{"formId":3}'), mount("FluentForm", '{"formId":4}')],
      {
        mountable: ["FluentForm"],
      },
    );

    expect(run.fetchCalls).toEqual(["fluent-form.wasm"]);
    expect(run.result.outcomes).toEqual([
      { component: "FluentForm", state: "mounted" },
      { component: "FluentForm", state: "mounted" },
    ]);
    expect(run.mountedWith.map((call) => call.props)).toEqual([{ formId: 3 }, { formId: 4 }]);
  });

  it("an inlined manifest costs the page zero extra requests", async () => {
    const run = await runLoader([mount("ConsentBanner")]);
    expect(run.fetchCalls).toEqual(["consent-banner.wasm"]);
  });

  it("prints the load set as reportable evidence", async () => {
    const scenarios: Array<{ name: string; nodes: FakeNode[] }> = [
      { name: "island-free", nodes: [] },
      { name: "two-mount", nodes: [mount("FluentForm", '{"formId":3}'), mount("SearchBox")] },
      { name: "repeated-mount", nodes: [mount("FluentForm"), mount("FluentForm")] },
    ];

    console.log("islands bundle load proof (fixture manifest: 4 components)");
    console.log("  page             mounts  bundle fetches  which");
    for (const scenario of scenarios) {
      const run = await runLoader(scenario.nodes);
      console.log(
        `  ${scenario.name.padEnd(16)} ${String(scenario.nodes.length).padStart(6)}  ` +
          `${String(run.fetchCalls.length).padStart(14)}  ` +
          `${run.fetchCalls.join(", ") || "(none)"}`,
      );
      // The load set is exactly the distinct present components.
      expect(run.fetchCalls.length).toBe(new Set(run.result.components).size);
    }
  });
});

// --- failures are loud -------------------------------------------------------

describe("loud failures", () => {
  it("a mounted component with no bundle is a console error, not a skip", async () => {
    const run = await runLoader([mount("GhostIsland")]);

    expect(run.fetchCalls).toEqual([]);
    expect(run.result.errors.map((error) => error.code)).toEqual(["bundle-missing"]);
    expect(run.consoleErrors.join("\n")).toContain("GhostIsland");
    expect(run.consoleErrors.join("\n")).toContain("no bundle");
    expect(run.result.outcomes).toEqual([{ component: "GhostIsland", state: "bundle-missing" }]);
  });

  it("malformed data-props fails loudly and neither loads nor mounts", async () => {
    const run = await runLoader([mount("FluentForm", '{"formId":')], {
      mountable: ["FluentForm"],
    });

    expect(run.fetchCalls).toEqual([]);
    expect(run.result.errors.map((error) => error.code)).toEqual(["props-invalid"]);
    expect(run.consoleErrors.join("\n")).toContain("data-props is not valid JSON");
    expect(run.result.outcomes).toEqual([{ component: "FluentForm", state: "props-invalid" }]);
    expect(run.mountedWith).toEqual([]);
  });

  it("props that parse but are not an object are rejected", async () => {
    const run = await runLoader([mount("ConsentBanner", "[1,2,3]")]);

    expect(run.fetchCalls).toEqual([]);
    expect(run.result.errors.map((error) => error.code)).toEqual(["props-invalid"]);
    expect(run.consoleErrors.join("\n")).toContain("must be a JSON object");
  });

  it("an invalid data-component value is reported, not coerced", async () => {
    const run = await runLoader([mount("fluent form")]);

    expect(run.fetchCalls).toEqual([]);
    expect(run.result.errors.map((error) => error.code)).toEqual(["component-invalid"]);
    expect(run.result.outcomes).toEqual([{ component: "fluent form", state: "component-invalid" }]);
  });

  it("a bundle from a different ABI is refused before mount", async () => {
    const run = await runLoader([mount("FluentForm")], { abi: 99, mountable: ["FluentForm"] });

    expect(run.result.errors.map((error) => error.code)).toEqual(["abi-mismatch"]);
    expect(run.result.outcomes).toEqual([{ component: "FluentForm", state: "abi-mismatch" }]);
    expect(run.mountedWith).toEqual([]);
  });

  it("a failed load is reported per component and the rest still mount", async () => {
    const run = await runLoader([mount("FluentForm"), mount("SearchBox")], {
      mountable: ["SearchBox"],
      failLoad: ["FluentForm"],
    });

    expect(run.result.errors.map((error) => error.code)).toEqual(["load-failed"]);
    expect(run.result.outcomes).toEqual([
      { component: "FluentForm", state: "load-failed" },
      { component: "SearchBox", state: "mounted" },
    ]);
  });

  it("a throwing mount() is reported, not swallowed", async () => {
    const run = await runLoader([mount("FluentForm")], {
      mountable: ["FluentForm"],
      failMount: ["FluentForm"],
    });

    expect(run.result.errors.map((error) => error.code)).toEqual(["mount-failed"]);
    expect(run.result.outcomes).toEqual([{ component: "FluentForm", state: "mount-failed" }]);
  });

  it("an unreadable manifest is reported and nothing mounts", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    consoleSpies.push(spy);

    const result = await startIslands(new FakeRoot([mount("FluentForm")]), {
      manifestUrl: "/pkg/manifest.json",
      fetch: async () => ({ ok: false, status: 503 }),
    });

    spy.mockRestore();
    expect(result.errors.map((error) => error.code)).toEqual(["manifest-unavailable"]);
    expect(result.outcomes).toEqual([{ component: "FluentForm", state: "bundle-missing" }]);
  });
});

// --- JS glue path ------------------------------------------------------------

describe("module entries (the wasm-bindgen path)", () => {
  it("import()s only the present component's glue module", async () => {
    const run = await runLoader([mount("SearchBox")], {
      glueFor: ["SearchBox", "ConsentBanner"],
    });

    expect(run.imported).toEqual(["search-box.js"]);
    expect(run.imported).not.toContain("consent-banner.js");
    expect(run.fetchCalls).toEqual([]);
    expect(run.result.requests).toEqual(["search-box.js"]);
    expect(run.result.outcomes).toEqual([{ component: "SearchBox", state: "mounted" }]);
  });
});

// --- the shipped module's shape ----------------------------------------------

describe("shipped loader shape", () => {
  it("has no runtime imports, so it can be copied into dist/pkg and loaded directly", () => {
    const source = readFileSync(new URL("../src/runtime/loader.ts", import.meta.url), "utf8");
    const importLines = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import ") || line.startsWith("export * from"));

    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      // `import type` is erased by tsc; anything else would add a second file to
      // ship and a bundler/resolution assumption to the browser contract.
      expect(line.startsWith("import type ")).toBe(true);
    }
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

// --- props parsing, directly -------------------------------------------------

describe("parsePropsAttribute", () => {
  it("treats an absent attribute as an empty props object", () => {
    expect(parsePropsAttribute(null)).toEqual({ ok: true, props: {} });
  });

  it("parses a JSON object", () => {
    expect(parsePropsAttribute('{"a":1,"b":["c"]}')).toEqual({
      ok: true,
      props: { a: 1, b: ["c"] },
    });
  });

  it("rejects empty, invalid and non-object values", () => {
    for (const raw of ["", "   ", "{", "null", "42", '"text"', "[]"]) {
      expect(parsePropsAttribute(raw).ok).toBe(false);
    }
  });
});
