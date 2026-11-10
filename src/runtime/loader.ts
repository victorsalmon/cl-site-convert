/**
 * Islands runtime loader — the browser half of the per-plugin bundle strategy.
 *
 * ## What this module is
 *
 * A **plain ES module with zero runtime imports**. `tsc` emits it verbatim; the
 * emitter copies the output to `dist/pkg/loader.js` and a page that has islands
 * imports it. There is no bundler step, no framework, and no generated glue to
 * keep in step. The only import below is `import type`, which TypeScript erases
 * completely, so the shipped file has no module graph of its own.
 *
 * ## The guarantee this module exists to keep
 *
 * **A page with no island mounts loads no Wasm bytes and makes no network
 * requests.** Not "loads a small bootloader", not "loads the manifest to check".
 * Zero. `startIslands` collects the mount nodes first and returns before it
 * resolves the manifest, so the island-free path cannot touch the network even
 * by accident — the early return is above every fetch in the function.
 *
 * ## What it loads
 *
 * Exactly one bundle per **distinct component present in the document**:
 *
 * ```
 * scan [data-component]  ->  unique components  ->  manifest lookup
 *                                                   ->  one load per component
 *                                                   ->  mount each node
 * ```
 *
 * A component that appears twice loads once and mounts twice. A component that
 * is absent is never mentioned to the network. A component that is present but
 * missing from the manifest is a loud `console.error` and an observable
 * `data-island-state="bundle-missing"` — never a silent skip, because a silent
 * skip looks exactly like "this island is a static decoration".
 *
 * ## Bundle entries
 *
 * The loader fetches `entry.wasmPath` and instantiates it with
 * `WebAssembly.instantiateStreaming`. A `cdylib` built without `wasm-bindgen`
 * produces a bare `.wasm` and no JS glue, so a dynamic `import()` of the module
 * would be a fetch of something that is not an ES module. When `wasm-bindgen`
 * lands, the emitter records `entry.modulePath`, and the same loader
 * `import()`s that glue instead — the manifest shape does not change.
 *
 * ## Mount ABI
 *
 * After loading, the loader:
 *
 *  1. probes `islands_core_abi_version()` when the bundle exports it and refuses
 *     a version that does not match `LOADER_ABI_VERSION` (`abi-mismatch`);
 *  2. calls `mount(node, props)` when the bundle (or its glue module) exports
 *     one, and marks the node `mounted`;
 *  3. otherwise marks the node `loaded`. That state is real and useful: before
 *     `wasm-bindgen` no bundle can touch the DOM, so "loaded but inert" is the
 *     honest outcome and it stays observable rather than being faked.
 *
 * ## Props
 *
 * `data-props` is a JSON **object** string. An absent attribute means `{}`. An
 * empty attribute, invalid JSON, or valid JSON that is not an object is a loud
 * error, and that node is not mounted *and* its bundle is not loaded — there is
 * no point spending bytes on a component that cannot be handed its props.
 */

import type { IslandBundleManifest } from "../islands/manifest.js";

/** Runtime ABI this loader speaks. Must match `crates/islands-core`'s ABI. */
export const LOADER_ABI_VERSION = 1;

/** Selector that identifies a mount slot. */
const COMPONENT_SELECTOR = "[data-component]";

/** Component names are identifiers because they are `data-component` values. */
const COMPONENT_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

/** The `data-props` value must be a JSON object, not a bare scalar or array. */
export type PropsResult =
  | { readonly ok: true; readonly props: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/** Terminal states a mount can end in. Written to `data-island-state`. */
export type MountState =
  | "mounted"
  | "loaded"
  | "component-invalid"
  | "props-invalid"
  | "bundle-missing"
  | "load-failed"
  | "abi-mismatch"
  | "mount-failed";

/** Why the loader complained. Every code is a distinct repair. */
export type IslandErrorCode =
  | "manifest-unavailable"
  | "manifest-invalid"
  | "component-invalid"
  | "props-invalid"
  | "bundle-missing"
  | "load-failed"
  | "abi-mismatch"
  | "mount-failed";

/** A complaint, shaped so a test or a log sink can assert on it. */
export interface IslandRuntimeError {
  readonly code: IslandErrorCode;
  /** The component involved, or `"(manifest)"` for document-level problems. */
  readonly component: string;
  readonly message: string;
}

/** The structural DOM surface the loader needs. `Document` satisfies it. */
export interface IslandNodeLike {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/** The structural root surface the loader needs. `Document` satisfies it. */
export interface IslandRootLike {
  querySelectorAll(selector: string): ArrayLike<IslandNodeLike>;
}

/** Minimal `Response` shape: only the status matters to the loader. */
export interface FetchResponseLike {
  readonly ok?: boolean;
  readonly status?: number;
}

/** Minimal instantiated-Wasm shape. */
export interface WasmInstanceLike {
  readonly exports: Record<string, unknown>;
}

/** What a successful load produced. */
export interface LoadedBundle {
  /** The namespace resolved by `import()`, when the entry is a JS glue module. */
  readonly module?: unknown;
  /** The instantiated Wasm module, when the entry is a bare `.wasm`. */
  readonly instance?: WasmInstanceLike;
}

/** Injected seams. Every one has a browser default; tests replace them. */
export interface IslandLoaderDeps {
  /** Replace `globalThis.fetch`. */
  readonly fetch?: (url: string) => Promise<FetchResponseLike>;
  /** Replace `WebAssembly.instantiateStreaming`. */
  readonly instantiateStreaming?: (
    source: FetchResponseLike,
  ) => Promise<{ instance: WasmInstanceLike }>;
  /** Replace dynamic `import()`. */
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Replace `console.error`. */
  readonly onError?: (error: IslandRuntimeError) => void;
}

export interface StartIslandsOptions extends IslandLoaderDeps {
  /** Inline manifest. Preferred: it costs the page zero requests. */
  readonly manifest?: IslandBundleManifest;
  /** Manifest URL, used only when `manifest` is absent **and** mounts exist. */
  readonly manifestUrl?: string;
  /** Resolve a bundle-relative path to a URL. Defaults to identity. */
  readonly resolveUrl?: (path: string) => string;
}

/** Per-node outcome. `outcomes.length` equals the number of mount nodes. */
export interface IslandOutcome {
  readonly component: string;
  readonly state: MountState;
}

export interface IslandsStartResult {
  /**
   * `no-islands` means the document had no mount nodes and the loader did
   * nothing at all. `started` means at least one mount node existed.
   */
  readonly status: "no-islands" | "started";
  /** Distinct component names found, in document order. */
  readonly components: string[];
  /** Bundle URLs the loader asked the network for, in order. Empty on `no-islands`. */
  readonly requests: string[];
  /** One entry per mount node, in document order. */
  readonly outcomes: IslandOutcome[];
  readonly errors: IslandRuntimeError[];
}

// --- ambient browser globals -------------------------------------------------

interface BrowserGlobals {
  fetch?: (url: string) => Promise<FetchResponseLike>;
  WebAssembly?: {
    instantiateStreaming?: (source: unknown) => Promise<{ instance: WasmInstanceLike }>;
  };
  document?: unknown;
}

const GLOBALS = globalThis as unknown as BrowserGlobals;

// --- props -------------------------------------------------------------------

/**
 * Parse a `data-props` attribute.
 *
 * Absent → `{}`. Anything else must be a JSON object: an island receives named
 * values, so an array, a string or a number is a build bug the page should say
 * out loud rather than coerce into something surprising.
 */
export function parsePropsAttribute(raw: string | null): PropsResult {
  if (raw === null) return { ok: true, props: {} };

  if (raw.trim().length === 0) {
    return {
      ok: false,
      message: "data-props is empty; omit the attribute to mean {}",
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `data-props is not valid JSON: ${detail}` };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      message: `data-props must be a JSON object (found ${Array.isArray(value) ? "array" : typeof value})`,
    };
  }

  return { ok: true, props: value as Record<string, unknown> };
}

// --- loading -----------------------------------------------------------------

function defaultFetch(): ((url: string) => Promise<FetchResponseLike>) | undefined {
  return GLOBALS.fetch;
}

function defaultInstantiateStreaming():
  ((source: FetchResponseLike) => Promise<{ instance: WasmInstanceLike }>) | undefined {
  const webAssembly = GLOBALS.WebAssembly;
  const instantiate = webAssembly?.instantiateStreaming;
  if (webAssembly === undefined || instantiate === undefined) return undefined;
  return (source) => instantiate.call(webAssembly, source);
}

function defaultImportModule(): (url: string) => Promise<unknown> {
  return (url) => import(url) as Promise<unknown>;
}

async function loadBundle(
  entry: { readonly wasmPath: string; readonly modulePath?: string },
  url: string,
  deps: IslandLoaderDeps,
): Promise<LoadedBundle> {
  if (entry.modulePath !== undefined) {
    const importModule = deps.importModule ?? defaultImportModule();
    return { module: await importModule(url) };
  }

  const fetchImpl = deps.fetch ?? defaultFetch();
  if (fetchImpl === undefined) {
    throw new Error("no fetch implementation: pass `fetch` in the loader options");
  }

  const response = await fetchImpl(url);
  if (response.ok === false) {
    throw new Error(`fetch ${url} failed with HTTP ${response.status ?? "error"}`);
  }

  const instantiate = deps.instantiateStreaming ?? defaultInstantiateStreaming();
  if (instantiate === undefined) {
    throw new Error(
      "WebAssembly.instantiateStreaming is unavailable: pass `instantiateStreaming` in the loader options",
    );
  }

  const { instance } = await instantiate(response);
  return { instance };
}

function exportsOf(bundle: LoadedBundle): Record<string, unknown> | undefined {
  return bundle.instance?.exports;
}

function abiVersionOf(bundle: LoadedBundle): number | undefined {
  const probe = exportsOf(bundle)?.["islands_core_abi_version"];
  if (typeof probe !== "function") return undefined;
  const value = (probe as () => unknown)();
  return typeof value === "number" ? value : undefined;
}

type MountFunction = (node: IslandNodeLike, props: Record<string, unknown>) => unknown;

function mountFunctionOf(bundle: LoadedBundle): MountFunction | undefined {
  const fromModule = (bundle.module as { mount?: unknown } | undefined)?.mount;
  if (typeof fromModule === "function") return fromModule as MountFunction;

  const fromExports = exportsOf(bundle)?.["mount"];
  if (typeof fromExports === "function") return fromExports as MountFunction;

  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultOnError(error: IslandRuntimeError): void {
  // Loud on purpose. A skipped island that says nothing is indistinguishable
  // from an island that was never meant to be interactive.
  console.error(`[islands] ${error.component}: ${error.message}`);
}

// --- manifest ----------------------------------------------------------------

/**
 * Minimal usability check for a manifest fetched at runtime.
 *
 * Exhaustive validation is the build gate's job (`validateIslandManifest`); the
 * browser only has to decide whether it can map components to entries. Duplicating
 * the full validator here would give the repo two contracts to keep in step.
 */
function isUsableManifest(value: unknown): value is IslandBundleManifest {
  if (typeof value !== "object" || value === null) return false;
  const components = (value as { components?: unknown }).components;
  return typeof components === "object" && components !== null && !Array.isArray(components);
}

async function fetchManifest(url: string, deps: IslandLoaderDeps): Promise<IslandBundleManifest> {
  const fetchImpl = deps.fetch ?? defaultFetch();
  if (fetchImpl === undefined) {
    throw new Error("no fetch implementation: pass `fetch` in the loader options");
  }

  const response = await fetchImpl(url);
  if (response.ok === false) {
    throw new Error(`fetch ${url} failed with HTTP ${response.status ?? "error"}`);
  }

  const body = (response as { json?: () => Promise<unknown> }).json;
  if (typeof body !== "function") {
    throw new Error(`fetch ${url} returned a response with no json() method`);
  }

  const parsed = await body.call(response);
  if (!isUsableManifest(parsed)) {
    throw new Error(`${url} does not describe any components`);
  }
  return parsed;
}

// --- scanning ----------------------------------------------------------------

function collectMountNodes(root: IslandRootLike): IslandNodeLike[] {
  return Array.from(root.querySelectorAll(COMPONENT_SELECTOR));
}

function componentOf(node: IslandNodeLike): string | null {
  const value = node.getAttribute("data-component");
  if (value === null) return null;
  return COMPONENT_PATTERN.test(value) ? value : null;
}

// --- the loader --------------------------------------------------------------

/**
 * Load and mount every island present under `root`.
 *
 * Call this from the emitter's one-line bootstrap on island-bearing pages only;
 * calling it on an island-free page is harmless and costs nothing, which is what
 * makes the "no islands ⇒ no wasm bytes" guarantee checkable rather than trusted.
 */
export async function startIslands(
  root: IslandRootLike,
  options: StartIslandsOptions = {},
): Promise<IslandsStartResult> {
  const nodes = collectMountNodes(root);

  // ---------------------------------------------------------------------------
  // The zero-network exit. Deliberately above the manifest resolution and above
  // every `await` that could reach the network: an island-free page cannot make
  // a request through this function, whatever the options say.
  // ---------------------------------------------------------------------------
  if (nodes.length === 0) {
    return { status: "no-islands", components: [], requests: [], outcomes: [], errors: [] };
  }

  const report = options.onError ?? defaultOnError;
  const errors: IslandRuntimeError[] = [];
  const requests: string[] = [];
  const outcomes: IslandOutcome[] = [];
  const complain = (error: IslandRuntimeError): void => {
    errors.push(error);
    report(error);
  };

  // Distinct components, in document order (reported even if later unusable).
  const components: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const component = componentOf(node);
    if (component !== null && !seen.has(component)) {
      seen.add(component);
      components.push(component);
    }
  }

  // --- manifest ---------------------------------------------------------------
  let manifest = options.manifest;
  if (manifest === undefined) {
    const manifestUrl = options.manifestUrl ?? "manifest.json";
    requests.push(manifestUrl);
    try {
      manifest = await fetchManifest(manifestUrl, options);
    } catch (error) {
      complain({
        code: "manifest-unavailable",
        component: "(manifest)",
        message: `${messageOf(error)} — no island can mount without bundle metadata`,
      });
      for (const component of components) {
        outcomes.push({ component, state: "bundle-missing" });
      }
      return { status: "started", components, requests, outcomes, errors };
    }
  }

  // --- props, before any bytes are spent --------------------------------------
  // Parsing first is what lets a page with only malformed props load nothing:
  // a component whose every mount is unparseable has no reason to be fetched.
  interface PlannedMount {
    readonly node: IslandNodeLike;
    readonly component: string;
    readonly props: Record<string, unknown>;
  }

  const planned: PlannedMount[] = [];
  /** Per-node terminal state decided before loading: the node is not mounted. */
  const rejected = new Map<IslandNodeLike, MountState>();

  for (const node of nodes) {
    const raw = node.getAttribute("data-component");
    if (raw === null) continue; // the selector guarantees this cannot happen

    const component = componentOf(node);
    if (component === null) {
      complain({
        code: "component-invalid",
        component: raw,
        message: `data-component="${raw}" is not a component name (expected /^[A-Z][A-Za-z0-9]*$/)`,
      });
      node.setAttribute("data-island-state", "component-invalid");
      rejected.set(node, "component-invalid");
      continue;
    }

    const parsed = parsePropsAttribute(node.getAttribute("data-props"));
    if (!parsed.ok) {
      complain({
        code: "props-invalid",
        component,
        message: `${parsed.message} — node not mounted`,
      });
      node.setAttribute("data-island-state", "props-invalid");
      rejected.set(node, "props-invalid");
      continue;
    }

    planned.push({ node, component, props: parsed.props });
  }

  // --- missing bundles --------------------------------------------------------
  const bundlesNeeded: string[] = [];
  const seenNeeded = new Set<string>();
  for (const mount of planned) {
    if (seenNeeded.has(mount.component)) continue;
    seenNeeded.add(mount.component);
    bundlesNeeded.push(mount.component);
  }

  const missing = new Set<string>();
  for (const component of bundlesNeeded) {
    if (Object.hasOwn(manifest.components, component)) continue;
    missing.add(component);
    complain({
      code: "bundle-missing",
      component,
      message:
        `the page mounts this component but dist/pkg/manifest.json has no bundle for it ` +
        `(known: ${Object.keys(manifest.components).join(", ") || "(none)"}) — not skipping silently`,
    });
  }

  // --- load, one per distinct present component -------------------------------
  const resolveUrl = options.resolveUrl ?? ((path: string) => path);
  const loaded = new Map<string, LoadedBundle>();
  const loadFailures = new Set<string>();

  for (const component of bundlesNeeded) {
    if (missing.has(component)) continue;

    const entry = manifest.components[component];
    if (entry === undefined) continue; // guarded by `missing`, kept for types

    const url = resolveUrl(entry.modulePath ?? entry.wasmPath);
    requests.push(url);

    try {
      loaded.set(component, await loadBundle(entry, url, options));
    } catch (error) {
      loadFailures.add(component);
      complain({
        code: "load-failed",
        component,
        message: `${url} could not be loaded: ${messageOf(error)}`,
      });
    }
  }

  // --- mount ------------------------------------------------------------------
  const plannedByNode = new Map<IslandNodeLike, PlannedMount>();
  for (const mount of planned) plannedByNode.set(mount.node, mount);

  for (const node of nodes) {
    const state = rejected.get(node);
    if (state !== undefined) {
      outcomes.push({ component: node.getAttribute("data-component") ?? "", state });
      continue;
    }

    const mount = plannedByNode.get(node);
    if (mount === undefined) continue; // unreachable: every error-free node is planned

    if (missing.has(mount.component)) {
      node.setAttribute("data-island-state", "bundle-missing");
      outcomes.push({ component: mount.component, state: "bundle-missing" });
      continue;
    }

    if (loadFailures.has(mount.component)) {
      node.setAttribute("data-island-state", "load-failed");
      outcomes.push({ component: mount.component, state: "load-failed" });
      continue;
    }

    const bundle = loaded.get(mount.component);
    if (bundle === undefined) {
      node.setAttribute("data-island-state", "load-failed");
      outcomes.push({ component: mount.component, state: "load-failed" });
      continue;
    }

    const abi = abiVersionOf(bundle);
    if (abi !== undefined && abi !== LOADER_ABI_VERSION) {
      complain({
        code: "abi-mismatch",
        component: mount.component,
        message: `bundle speaks island ABI ${abi} but this loader speaks ${LOADER_ABI_VERSION} — refusing to mount`,
      });
      node.setAttribute("data-island-state", "abi-mismatch");
      outcomes.push({ component: mount.component, state: "abi-mismatch" });
      continue;
    }

    const mountFn = mountFunctionOf(bundle);
    if (mountFn === undefined) {
      // No DOM binding exists yet: a bare `cdylib` cannot reach the page. The
      // state says so instead of pretending the island is interactive.
      node.setAttribute("data-island-state", "loaded");
      outcomes.push({ component: mount.component, state: "loaded" });
      continue;
    }

    try {
      await Promise.resolve(mountFn(node, mount.props));
      node.setAttribute("data-island-state", "mounted");
      outcomes.push({ component: mount.component, state: "mounted" });
    } catch (error) {
      complain({
        code: "mount-failed",
        component: mount.component,
        message: `mount() threw: ${messageOf(error)}`,
      });
      node.setAttribute("data-island-state", "mount-failed");
      outcomes.push({ component: mount.component, state: "mount-failed" });
    }
  }

  return { status: "started", components, requests, outcomes, errors };
}

/**
 * One-line browser entry point.
 *
 * Returns `undefined` when there is no document (Node, a worker), so importing
 * this module somewhere unexpected is inert rather than a crash.
 */
export async function bootstrap(
  options: StartIslandsOptions = {},
): Promise<IslandsStartResult | undefined> {
  const document = GLOBALS.document;
  if (document === undefined) return undefined;
  return startIslands(document as IslandRootLike, options);
}
