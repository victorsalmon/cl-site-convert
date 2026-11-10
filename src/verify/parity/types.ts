/**
 * The parity gate's vocabulary.
 *
 * The gate proves a **deterministic equivalence** rather than a visual similarity:
 * the emitter replays the captured DOM and the captured CSS bytes in the captured
 * cascade order, so identical tree + identical bytes + identical order means
 * identical rendering by construction. Everything here exists to make that claim
 * measurable per page, and to name *which* check caught a drift.
 */

/**
 * The checks, as stable ids.
 *
 * The id is the report's answer to "what broke?" — a mutation test asserts on these
 * ids, so renaming one is a contract change, not a tidy-up.
 */
export type CheckId =
  /** (a) Body tree equality: tags, attribute order, class lists, text nodes. */
  | "body-tree"
  /** (a′) The same comparison for the head, with the cascade block excluded. */
  | "head-tree"
  /** (b) Cascade equality: count, order, origin, and CSS bytes modulo `url()`. */
  | "cascade"
  /** (c) Asset integrity: every referenced local file exists and hashes as recorded. */
  | "assets"
  /** (d) Residual absolute self-references equal the committed allowlist exactly. */
  | "residuals"
  /** (e) No `<script>` on a page that mounts no island. */
  | "scripts"
  /** (f) No page carries text or an `id` that is unique to another page's capture. */
  | "cross-page-leak"
  /** The doctype and `<html>` attributes: quirks mode and the root element. */
  | "document-shell"
  /** The emitted tree holds exactly the routes the IR declares — no more, no fewer. */
  | "artefact-set";

/** Every check this gate runs, in report order. */
export const CHECKS: readonly CheckId[] = [
  "artefact-set",
  "document-shell",
  "body-tree",
  "head-tree",
  "cascade",
  "assets",
  "residuals",
  "scripts",
  "cross-page-leak",
] as const;

/**
 * Why an attribute value is allowed to differ from the capture.
 *
 * Each category names a *rule*, not a location: the verifier re-derives the expected
 * value from the captured value and the capture's own data, so a wrong rewrite cannot
 * agree with a wrong expectation.
 */
export type RewriteCategory =
  /** An asset reference re-pointed through `capture/asset-rewrite-map.json`. */
  | "asset"
  /** Navigation to a route the emitted tree actually serves. */
  | "navigation"
  /** A WordPress path on the source host that the static host does not serve (`/feed/`). */
  | "internal-path"
  /** A form action pointed at the configured sink. */
  | "form-sink"
  /** A canonical URL kept absolute on the per-target base URL. */
  | "canonical"
  /** A `<meta>` image localised through the asset map. */
  | "meta-asset";

/** Per-category rewrite counts, so the report can say what moved and why. */
export type RewriteCounts = Record<RewriteCategory, number>;

/** One reason a page failed a check. */
export interface ParityFailure {
  readonly check: CheckId;
  readonly page: string;
  /**
   * Where in the document, as a readable path — `html > body > div#et-boc > …`.
   * Empty for whole-page checks (assets on a page, residuals, scripts).
   */
  readonly path: string;
  readonly message: string;
  readonly expected?: string;
  readonly actual?: string;
}

/** One page's verdict and the measurements behind it. */
export interface PageParity {
  readonly url: string;
  /** Path inside the artefact, e.g. `care/index.html`. */
  readonly outputPath: string;
  readonly verdict: "pass" | "fail";
  /** Element and text nodes compared in the body. */
  readonly nodesCompared: number;
  /** Element and text nodes compared in the head (cascade block excluded). */
  readonly headNodesCompared: number;
  /** Cascade positions compared against `page.styleOrder`. */
  readonly stylesCompared: number;
  /** `url()` bodies rewritten inside this page's inline `<style>` blocks. */
  readonly inlineCssRewrites: number;
  /** `url()` bodies rewritten inside this page's linked stylesheets. */
  readonly linkedCssRewrites: number;
  /** Linked stylesheets this page ships, each verified byte-for-byte outside `url()`. */
  readonly linkedFilesVerified: number;
  /** Distinct local asset files referenced by this page (directly or through CSS). */
  readonly assetsVerified: number;
  /** Of those, how many matched an IR `assets[]` record's `sha256`. */
  readonly assetsHashed: number;
  readonly rewrites: RewriteCounts;
  /** Absolute self-references this page still carries (all allowlisted). */
  readonly residualRefs: number;
  readonly scriptTags: number;
  /** `data-component` mount slots found in the emitted page. */
  readonly mounts: number;
  readonly failures: readonly ParityFailure[];
}

/** Totals across the artefact. */
export interface ParityTotals {
  readonly pages: number;
  readonly pagesPassed: number;
  readonly nodesCompared: number;
  readonly stylesCompared: number;
  readonly inlineCssRewrites: number;
  readonly linkedCssRewrites: number;
  readonly assetsVerified: number;
  readonly assetsHashed: number;
  readonly rewrites: RewriteCounts;
  readonly residualRefs: number;
  readonly scriptTags: number;
  readonly failures: number;
  /** Residual composition, re-derived entry by entry. */
  readonly residualComposition: {
    readonly canonical: number;
    readonly "deferred-css": number;
    readonly unlocalisable: number;
  };
}

/**
 * The opt-in secondary stage, recorded but never run here.
 *
 * It is deliberately not installed: Playwright and every other real-browser driver
 * download a binary at install time, which this repository forbids. The design lives
 * in `docs/fidelity-gate.md`.
 */
export interface PixelDiffStage {
  readonly status: "not-run";
  readonly stage: "secondary";
  readonly reason: string;
}

/** `dist/parity-report.json` — the gate's machine-readable verdict. */
export interface ParityReport {
  readonly generatedAt: string;
  readonly gate: "equivalence";
  /** The document treated as the authority: it is what the emitter must reproduce. */
  readonly authority: string;
  /** The artefact under test. */
  readonly artefact: string;
  readonly irVersion: string;
  readonly baseUrl: string;
  readonly formSink: string;
  readonly verdict: "pass" | "fail";
  readonly checks: readonly CheckId[];
  readonly pages: readonly PageParity[];
  readonly totals: ParityTotals;
  readonly failures: readonly ParityFailure[];
  readonly pixelDiff: PixelDiffStage;
  readonly notes: readonly string[];
}

/** Thrown when the gate cannot evaluate at all — exit 2, never a pass. */
export class CannotEvaluateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CannotEvaluateError";
  }
}

/** An empty rewrite tally. */
export function emptyRewriteCounts(): RewriteCounts {
  return {
    asset: 0,
    navigation: 0,
    "internal-path": 0,
    "form-sink": 0,
    canonical: 0,
    "meta-asset": 0,
  };
}
