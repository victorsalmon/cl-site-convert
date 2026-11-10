/**
 * The island bundle manifest — the one map from a mount slot to a bundle.
 *
 * `dist/pkg/manifest.json` is **generated** by `scripts/wasm-size.mjs` from the
 * crates themselves; it is never hand-edited. Its shape is the contract between
 * three consumers:
 *
 *  1. the **emitter**, which decides which bundles a page ships (`bundlesForHtml`);
 *  2. the **runtime loader** (`src/runtime/loader.ts`), which maps a present
 *     `data-component` to the URL it must load;
 *  3. the **deployer**, which copies `dist/pkg/` as one unit.
 *
 * The mapping is declared, not guessed. An island crate states the component it
 * provides in its own `Cargo.toml`:
 *
 * ```toml
 * [package.metadata.island]
 * component = "FluentForm"
 * ```
 *
 * A `cdylib` crate without that declaration is a build error, not a silent
 * omission: a bundle nothing can mount is dead weight, and a component the gate
 * cannot name is a component the emitter cannot place.
 *
 * Naming rules, enforced here and in the gate:
 *
 *  - **component** — `^[A-Z][A-Za-z0-9]*$`. It is the `data-component` value and
 *    the manifest key, so it must be a stable identifier, not prose.
 *  - **bundle file** — `<crate-name>.wasm` in `dist/pkg/`. The crate name is
 *    already kebab-case and URL-safe, so no second naming scheme is invented.
 */

/**
 * Version of the manifest document. Bumped when the shape changes in a way a
 * consumer must notice. Kept in step with `scripts/wasm-size.mjs`.
 */
export const MANIFEST_VERSION = 1;

/** File name of the manifest inside the emitted bundle directory. */
export const MANIFEST_FILENAME = "manifest.json";

/** Bundle directory, relative to the emitted site root (`dist/pkg/`). */
export const BUNDLE_DIR = "pkg";

/**
 * Per-bundle ceiling in brotli bytes. 250 KB = 250 * 1024.
 *
 * Duplicated deliberately from `scripts/wasm-size.mjs`: the gate is the
 * enforcement, this constant is what the emitter and docs cite.
 */
export const ISLAND_BUDGET_BROTLI_BYTES = 250 * 1024;

/** Component names are identifiers because they are `data-component` values. */
const COMPONENT_PATTERN = /^[A-Z][A-Za-z0-9]*$/;

/** A bare file name inside the bundle directory: no separators, no traversal. */
const BUNDLE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.wasm$/;
const MODULE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.m?js$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** One element of the `components` map: everything a page needs to load it. */
export interface IslandBundleEntry {
  /** Crate that produced the bundle, e.g. `fluent-form`. */
  readonly crate: string;
  /** Bundle file name inside `dist/pkg/`, e.g. `fluent-form.wasm`. */
  readonly wasmPath: string;
  /** Raw bytes on disk, measured after the build. */
  readonly rawBytes: number;
  /** Brotli bytes at quality 11 — the number the budget is enforced on. */
  readonly brotliBytes: number;
  /** SHA-256 of the exact bytes shipped, so a deploy can prove it matches. */
  readonly sha256: string;
  /**
   * Optional JS glue module, relative to `dist/pkg/`.
   *
   * Absent today: a `cdylib` built without `wasm-bindgen` has no glue, so the
   * loader fetches and instantiates the `.wasm` directly. When islands land with
   * `wasm-bindgen`, the emitted glue path goes here and the loader `import()`s it
   * instead — the manifest shape does not change.
   */
  readonly modulePath?: string;
}

/** The whole emitted manifest. */
export interface IslandBundleManifest {
  readonly manifestVersion: number;
  /** Cargo target the bundles were built for. */
  readonly target: string;
  /** Brotli budget each bundle was checked against. */
  readonly budgetBrotliBytes: number;
  /** `componentName -> bundle`. Keys are unique by construction of JSON. */
  readonly components: Readonly<Record<string, IslandBundleEntry>>;
}

/** One thing wrong with a manifest, addressed so a repair is obvious. */
export interface ManifestProblem {
  /** Dotted path into the document, e.g. `components.FluentForm.sha256`. */
  readonly path: string;
  readonly message: string;
}

/** Thrown by `parseIslandManifest`. Carries every problem, not just the first. */
export class IslandManifestError extends Error {
  readonly problems: readonly ManifestProblem[];

  constructor(problems: readonly ManifestProblem[], source = "island bundle manifest") {
    const detail = problems.map((problem) => `  ${problem.path}: ${problem.message}`).join("\n");
    super(`${source} is invalid:\n${detail}`);
    this.name = "IslandManifestError";
    this.problems = problems;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validate a parsed manifest document.
 *
 * Returns every problem found, so a caller can report all of them at once.
 * An empty array means the document is usable. Nothing is defaulted: a missing
 * required field is a problem, never an assumed value.
 */
export function validateIslandManifest(value: unknown): ManifestProblem[] {
  const problems: ManifestProblem[] = [];

  if (!isPlainObject(value)) {
    return [{ path: "(root)", message: "must be an object" }];
  }

  if (value["manifestVersion"] !== MANIFEST_VERSION) {
    problems.push({
      path: "manifestVersion",
      message: `must be ${MANIFEST_VERSION} (found ${JSON.stringify(value["manifestVersion"])})`,
    });
  }

  if (typeof value["target"] !== "string" || value["target"].length === 0) {
    problems.push({ path: "target", message: "must be a non-empty string" });
  }

  if (!isNonNegativeInteger(value["budgetBrotliBytes"]) || value["budgetBrotliBytes"] === 0) {
    problems.push({ path: "budgetBrotliBytes", message: "must be a positive integer" });
  }

  const components = value["components"];
  if (!isPlainObject(components)) {
    problems.push({ path: "components", message: "must be an object" });
    return problems;
  }

  const names = Object.keys(components);
  if (names.length === 0) {
    // An empty manifest cannot legitimately be produced: the gate refuses to
    // measure zero island crates in the first place (ADR 0012).
    problems.push({ path: "components", message: "must not be empty" });
  }

  for (const name of names) {
    const entryPath = `components.${name}`;
    if (!COMPONENT_PATTERN.test(name)) {
      problems.push({
        path: entryPath,
        message: "component name must match /^[A-Z][A-Za-z0-9]*$/ (it is a data-component value)",
      });
    }

    const entry = components[name];
    if (!isPlainObject(entry)) {
      problems.push({ path: entryPath, message: "must be an object" });
      continue;
    }

    if (typeof entry["crate"] !== "string" || entry["crate"].length === 0) {
      problems.push({ path: `${entryPath}.crate`, message: "must be a non-empty string" });
    }

    const wasmPath = entry["wasmPath"];
    if (typeof wasmPath !== "string" || !BUNDLE_FILE_PATTERN.test(wasmPath)) {
      problems.push({
        path: `${entryPath}.wasmPath`,
        message: "must be a bare .wasm file name inside the bundle directory",
      });
    }

    if (!isNonNegativeInteger(entry["rawBytes"]) || entry["rawBytes"] === 0) {
      problems.push({ path: `${entryPath}.rawBytes`, message: "must be a positive integer" });
    }

    if (!isNonNegativeInteger(entry["brotliBytes"]) || entry["brotliBytes"] === 0) {
      problems.push({ path: `${entryPath}.brotliBytes`, message: "must be a positive integer" });
    } else if (
      isNonNegativeInteger(value["budgetBrotliBytes"]) &&
      entry["brotliBytes"] >= value["budgetBrotliBytes"]
    ) {
      problems.push({
        path: `${entryPath}.brotliBytes`,
        message: `must be under budgetBrotliBytes (found ${entry["brotliBytes"]}, budget ${String(
          value["budgetBrotliBytes"],
        )})`,
      });
    }

    if (typeof entry["sha256"] !== "string" || !SHA256_PATTERN.test(entry["sha256"])) {
      problems.push({ path: `${entryPath}.sha256`, message: "must be a lowercase hex SHA-256" });
    }

    if (entry["modulePath"] !== undefined) {
      const modulePath = entry["modulePath"];
      if (typeof modulePath !== "string" || !MODULE_FILE_PATTERN.test(modulePath)) {
        problems.push({
          path: `${entryPath}.modulePath`,
          message: "must be a bare .js/.mjs file name inside the bundle directory",
        });
      }
    }
  }

  return problems;
}

/** Validate and return a typed manifest. Throws `IslandManifestError` on any problem. */
export function parseIslandManifest(value: unknown, source?: string): IslandBundleManifest {
  const problems = validateIslandManifest(value);
  if (problems.length > 0) {
    throw new IslandManifestError(problems, source);
  }
  return value as IslandBundleManifest;
}

/** Parse manifest JSON text. */
export function parseIslandManifestJson(text: string, source?: string): IslandBundleManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new IslandManifestError(
      [{ path: "(root)", message: `is not valid JSON: ${detail}` }],
      source,
    );
  }
  return parseIslandManifest(value, source);
}

/** What went wrong when an emitter asked for the bundles a page needs. */
export interface MissingBundle {
  readonly component: string;
  readonly message: string;
}

/** Thrown by `resolveBundles` — a present mount with no bundle is a build bug. */
export class MissingBundleError extends Error {
  readonly missing: readonly MissingBundle[];

  constructor(missing: readonly MissingBundle[]) {
    super(
      `no island bundle for ${missing.length} component(s) present in the page:\n` +
        missing.map((item) => `  ${item.component}: ${item.message}`).join("\n"),
    );
    this.name = "MissingBundleError";
    this.missing = missing;
  }
}

/** Look one component up, or `undefined` when the manifest has no bundle for it. */
export function findBundle(
  component: string,
  manifest: IslandBundleManifest,
): IslandBundleEntry | undefined {
  // `Object.prototype` lookups must not masquerade as components.
  if (!Object.hasOwn(manifest.components, component)) return undefined;
  return manifest.components[component];
}

/**
 * Map present components to the bundles that must ship with the page.
 *
 * Order is first-appearance order and duplicates collapse: a page with two
 * `FluentForm` mounts still ships one bundle. An empty input (an island-free
 * page) returns an empty array, which is how "no islands ⇒ no wasm bytes" is
 * expressed at the data layer.
 *
 * A component with no bundle throws: shipping a page whose island can never
 * mount is a build bug to fix, not a runtime condition to tolerate.
 */
export function resolveBundles(
  components: readonly string[],
  manifest: IslandBundleManifest,
): IslandBundleEntry[] {
  const seen = new Set<string>();
  const bundles: IslandBundleEntry[] = [];
  const missing: MissingBundle[] = [];

  for (const component of components) {
    if (seen.has(component)) continue;
    seen.add(component);

    const bundle = findBundle(component, manifest);
    if (bundle === undefined) {
      missing.push({
        component,
        message: `component is mounted by the page but no crate declares it (known: ${
          Object.keys(manifest.components).join(", ") || "(none)"
        })`,
      });
      continue;
    }
    bundles.push(bundle);
  }

  if (missing.length > 0) {
    throw new MissingBundleError(missing);
  }

  return bundles;
}
