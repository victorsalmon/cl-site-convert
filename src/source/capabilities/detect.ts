/**
 * Capability detection: the fail-loudly gate.
 *
 * A WordPress site is not just HTML. Plugins bring carts, memberships,
 * bookings, multilingual routing and form handlers, and none of them survive a
 * static conversion by accident. This module answers one question — *what does
 * this site do that the emitter cannot reproduce?* — and refuses to answer it
 * optimistically.
 *
 * Two independent evidence sources, both recorded rather than guessed:
 *
 *  1. **REST namespaces** from `/wp-json/`. A plugin that registers a namespace
 *     is announcing itself. Cheap, complete for well-behaved plugins, and
 *     useless for a plugin that registers nothing.
 *  2. **Rendered DOM markers** from captured pages. A form embedded in a page is
 *     evidence even when no namespace exists. Tested against recorded HTML, so
 *     the detector is offline and deterministic.
 *
 * Every finding names the evidence that proved it — the exact namespace token,
 * or the matched marker and the route it was found on. A report that says
 * "unsupported: woocommerce" without saying how it knows is an opinion.
 *
 * ## The rule that matters
 *
 * **A capability we cannot classify is blocking.** An unrecognised non-core REST
 * namespace blocks the conversion, because "not in the catalog" means "nobody
 * has shown this is stateless", and a static site silently drops server-side
 * behaviour it does not know about. Adding the plugin to `catalog.ts` with a
 * reason is the way to unblock it — never a wildcard, never a silence.
 *
 * ## Not evaluating is not passing
 *
 * With no evidence at all — no namespaces, no pages — the report is
 * `cannot-evaluate`, the CLI exits 2, and the report carries a blocking
 * `cannot-evaluate` entry so that even a consumer reading only the JSON refuses.
 * An empty report would look exactly like a clean site, which is the one failure
 * mode this module exists to prevent.
 *
 * Output: `capture/capabilities.json`, which is exactly the Site IR
 * `capabilities` object (`schemas/site-ir.schema.json` -> `$defs/capabilities`).
 * The richer `findings`/`evidence` live in the returned report and on stdout,
 * never in the file: the schema is frozen and forbids extra fields.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CATALOG, entryForNamespace, isCoreNamespace, looksStateful } from "./catalog.js";
import type { CapabilityCatalogEntry, CapabilityClass } from "./catalog.js";

/**
 * Capability key used for the "we could not look" case. It is emitted as a
 * `blocking: true` entry, so the JSON never reads as a clean bill of health.
 */
export const CANNOT_EVALUATE_KEY = "cannot-evaluate";

/** One entry of the IR's `capabilities.unsupported[]`. */
export interface UnsupportedCapability {
  capability: string;
  detail?: string;
  blocking?: boolean;
  where?: string[];
}

/** The IR's `capabilities` object. This is what lands in `capture/capabilities.json`. */
export interface SiteCapabilities {
  supported: string[];
  unsupported: UnsupportedCapability[];
}

/** Where a finding was proved. */
export type EvidenceKind = "rest-namespace" | "dom-marker" | "rest-endpoint";

/** One piece of evidence, naming its literal token and where it came from. */
export interface CapabilityEvidence {
  kind: EvidenceKind;
  /** The exact token that matched: a namespace, a marker's matched bytes, an endpoint. */
  value: string;
  /** `/wp-json/`, a route path, or an endpoint path. */
  source: string;
}

/** A classified capability, with the evidence that proved it. */
export interface CapabilityFinding {
  /** Stable schema-safe key, e.g. `woocommerce`. */
  key: string;
  label: string;
  classification: CapabilityClass;
  rationale: string;
  evidence: CapabilityEvidence[];
  /** Route paths where DOM evidence was found. Empty for REST-only findings. */
  where: string[];
}

/** What the detector actually looked at. Printed, and kept beside the report. */
export interface EvidenceSummary {
  /** Every namespace the site published, core included, in the order seen. */
  restNamespaces: string[];
  /** Route paths whose rendered HTML was scanned. */
  domPages: string[];
  /** Evidence kinds that carried data. */
  kinds: EvidenceKind[];
  /** Provenance of each input consulted, e.g. `manifest:capture/routes.manifest.json`. */
  origins: string[];
  /** Coverage gaps and unreadable inputs. Never silent. */
  reasons: string[];
}

/** `convertible` is the only status that permits emit. */
export type DetectionStatus = "convertible" | "blocked" | "cannot-evaluate";

/** The full detection result. `capabilities` is the IR-shaped part. */
export interface CapabilityReport {
  status: DetectionStatus;
  capabilities: SiteCapabilities;
  findings: CapabilityFinding[];
  evidence: EvidenceSummary;
  reasons: string[];
}

/** A rendered page, as captured. `path` is the site-relative route. */
export interface DomPage {
  path: string;
  html: string;
}

/**
 * Everything the detector is allowed to know.
 *
 * Deliberately file-shaped rather than network-shaped: the caller records the
 * evidence (B1.1 route enumeration, B1.2/B1.3 page capture) and this module
 * reads it. That is what keeps the gate offline, reproducible, and testable
 * against fixtures.
 */
export interface CapabilityEvidenceInput {
  /** Recorded `/wp-json/` response body, exactly as served. */
  restRoot?: string;
  /** Pre-parsed namespaces, e.g. from `capture/routes.manifest.json`. */
  namespaces?: readonly string[];
  /** True when `/wp-json/wp/v2/users` answered 200 without authentication. */
  usersEndpointOpen?: boolean;
  /** User count from `X-WP-Total`, when it was readable. */
  userCount?: number | null;
  /** Captured pages to scan for DOM markers. */
  pages?: readonly DomPage[];
}

/** Order findings by severity, then key, so two runs print the same table. */
const CLASS_ORDER: Readonly<Record<CapabilityClass, number>> = {
  "unsupported-blocking": 0,
  "needs-handling": 1,
  supported: 2,
};

/** Dedupe while keeping the site's own ordering. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Pull `namespaces` out of a recorded `/wp-json/` body.
 *
 * Returns `null` when the body cannot be trusted as a REST root, and records
 * why. A body that parses but carries no namespaces is *not* evidence of a
 * plugin-free site: a real REST root always advertises at least `wp/v2`.
 */
function namespacesFromRestRoot(restRoot: string, reasons: string[]): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(restRoot);
  } catch (error) {
    reasons.push(
      `recorded /wp-json/ body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    reasons.push("recorded /wp-json/ body is not a JSON object");
    return null;
  }
  const namespaces = (parsed as Record<string, unknown>)["namespaces"];
  if (!Array.isArray(namespaces)) {
    reasons.push("recorded /wp-json/ body has no `namespaces` array");
    return null;
  }
  const tokens = namespaces.filter((token): token is string => typeof token === "string");
  if (tokens.length === 0) {
    reasons.push("recorded /wp-json/ body advertised no namespaces");
    return null;
  }
  return unique(tokens);
}

/** Keep only pages with a usable route path and non-empty HTML, saying what was dropped. */
function usablePages(pages: readonly DomPage[], reasons: string[]): DomPage[] {
  const usable: DomPage[] = [];
  let dropped = 0;
  for (const page of pages) {
    if (typeof page.path !== "string" || !page.path.startsWith("/") || page.html.length === 0) {
      dropped += 1;
      continue;
    }
    usable.push(page);
  }
  if (dropped > 0) {
    reasons.push(
      `${dropped} captured page(s) were unusable (missing route path or empty HTML) and were not scanned`,
    );
  }
  return usable;
}

/** The sentence that names the evidence behind a finding. */
function evidenceSentence(evidence: readonly CapabilityEvidence[]): string {
  const parts = evidence.map((item) => {
    if (item.kind === "rest-namespace") return `REST namespace \`${item.value}\``;
    if (item.kind === "dom-marker") return `DOM marker \`${item.value}\` on ${item.source}`;
    return `\`${item.source}\` answered unauthenticated`;
  });
  return parts.join("; ");
}

/** Render a finding into the IR's flat `detail` string. */
function detailFor(finding: CapabilityFinding): string {
  const prefix = finding.classification === "unsupported-blocking" ? "Blocking" : "Needs handling";
  const evidence = evidenceSentence(finding.evidence);
  return evidence.length === 0
    ? `${prefix}: ${finding.label} — ${finding.rationale}`
    : `${prefix}: ${finding.label} — ${finding.rationale} Evidence: ${evidence}.`;
}
/**
 * Detect, classify and report.
 *
 * Pure: no I/O, no clock, no network. Everything it concludes is derived from
 * `input`, which is why the fixtures can pin the behaviour exactly.
 */
export function detectCapabilities(input: CapabilityEvidenceInput): CapabilityReport {
  const reasons: string[] = [];
  const origins: string[] = [];

  const namespaces: string[] = [];
  if (input.namespaces !== undefined && input.namespaces.length > 0) {
    namespaces.push(...unique(input.namespaces));
    origins.push("namespaces:supplied");
  } else if (input.restRoot !== undefined) {
    namespaces.push(...(namespacesFromRestRoot(input.restRoot, reasons) ?? []));
    origins.push("rest-root:supplied");
  } else {
    reasons.push("no REST namespaces were available (no manifest and no recorded /wp-json/ body)");
  }

  const pages = usablePages(input.pages ?? [], reasons);
  if (pages.length === 0) {
    reasons.push(
      "no rendered pages were available: a capability visible only in the DOM could be missed",
    );
  }

  const evidence: EvidenceSummary = {
    restNamespaces: namespaces,
    domPages: pages.map((page) => page.path),
    kinds: [],
    origins,
    reasons,
  };

  // A REST root that answered at all — even with only core namespaces — is
  // evidence. So is any page we could read.
  const hasEvidence = namespaces.length > 0 || pages.length > 0;
  if (!hasEvidence) {
    return cannotEvaluate(evidence, reasons);
  }

  const findings = collectFindings(namespaces, pages, input, reasons);

  const supported = findings
    .filter((finding) => finding.classification === "supported")
    .map((finding) => finding.key)
    .sort();

  const unsupported = findings
    .filter((finding) => finding.classification !== "supported")
    .map((finding) => toUnsupported(finding))
    .sort(
      (a, b) =>
        Number(b.blocking === true) - Number(a.blocking === true) ||
        a.capability.localeCompare(b.capability),
    );

  const kinds: EvidenceKind[] = [];
  if (namespaces.length > 0) kinds.push("rest-namespace");
  if (pages.length > 0) kinds.push("dom-marker");
  if (findings.some((finding) => finding.evidence.some((item) => item.kind === "rest-endpoint"))) {
    kinds.push("rest-endpoint");
  }
  evidence.kinds = kinds;

  const status: DetectionStatus = unsupported.some((entry) => entry.blocking === true)
    ? "blocked"
    : "convertible";

  return {
    status,
    capabilities: { supported, unsupported },
    findings: [...findings].sort(
      (a, b) =>
        CLASS_ORDER[a.classification] - CLASS_ORDER[b.classification] || a.key.localeCompare(b.key),
    ),
    evidence,
    reasons: [...reasons],
  };
}

/** Build a `cannot-evaluate` report: no evidence, a blocking entry, exit 2. */
function cannotEvaluate(evidence: EvidenceSummary, reasons: string[]): CapabilityReport {
  const detail = `Cannot evaluate: no capability evidence was available (${reasons.join("; ")}). Refusing to report a site as convertible when nothing was read.`;
  return {
    status: "cannot-evaluate",
    capabilities: {
      supported: [],
      unsupported: [{ capability: CANNOT_EVALUATE_KEY, detail, blocking: true }],
    },
    findings: [],
    evidence,
    reasons: [...reasons],
  };
}

/** Group matches per catalog entry, preserving the order evidence was found. */
interface FindingAccumulator {
  entry: CapabilityCatalogEntry;
  evidence: CapabilityEvidence[];
  where: Set<string>;
}

function collectFindings(
  namespaces: readonly string[],
  pages: readonly DomPage[],
  input: CapabilityEvidenceInput,
  reasons: string[],
): CapabilityFinding[] {
  const accumulators = new Map<string, FindingAccumulator>();

  const accumulate = (entry: CapabilityCatalogEntry): FindingAccumulator => {
    const existing = accumulators.get(entry.key);
    if (existing !== undefined) return existing;
    const created: FindingAccumulator = { entry, evidence: [], where: new Set() };
    accumulators.set(entry.key, created);
    return created;
  };

  // ---- source 1: REST namespaces -----------------------------------------
  const unknownNamespaces: string[] = [];
  for (const namespace of namespaces) {
    if (isCoreNamespace(namespace)) continue;
    const entry = entryForNamespace(namespace);
    if (entry === undefined) {
      unknownNamespaces.push(namespace);
      continue;
    }
    accumulate(entry).evidence.push({
      kind: "rest-namespace",
      value: namespace,
      source: "/wp-json/",
    });
  }

  // ---- source 2: rendered DOM --------------------------------------------
  for (const page of pages) {
    for (const entry of CATALOG) {
      for (const marker of entry.markers) {
        const match = marker.pattern.exec(page.html);
        if (match === null) continue;
        const hit = accumulate(entry);
        if (hit.where.has(page.path)) continue;
        hit.where.add(page.path);
        hit.evidence.push({
          kind: "dom-marker",
          value: match[0],
          source: page.path,
        });
      }
    }
  }

  const findings: CapabilityFinding[] = [...accumulators.values()]
    .map((hit) => ({
      key: hit.entry.key,
      label: hit.entry.label,
      classification: hit.entry.classification,
      rationale: hit.entry.rationale,
      evidence: hit.evidence,
      where: [...hit.where].sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // ---- the rule that matters: unknown is blocking -------------------------
  if (unknownNamespaces.length > 0) {
    findings.push(unknownCapabilityFinding(unknownNamespaces, reasons));
  }

  const security = securityFinding(input);
  if (security !== undefined) findings.push(security);

  return findings;
}

/**
 * An unrecognised namespace blocks.
 *
 * The report names the namespace, and says whether it *looks* stateful, but the
 * classification does not depend on that guess: a benign-looking stranger is
 * equally unproven. Cataloguing it with a reason is the only way past this.
 */
function unknownCapabilityFinding(
  unknownNamespaces: readonly string[],
  reasons: string[],
): CapabilityFinding {
  const sorted = [...unknownNamespaces].sort();
  const suspicious = sorted.filter((namespace) => looksStateful(namespace.split("/")[0] ?? ""));
  const suspicion =
    suspicious.length > 0
      ? ` ${suspicious.join(", ")} ${suspicious.length === 1 ? "looks" : "look"} like it carries server-side state (commerce/membership/booking-shaped name).`
      : "";
  reasons.push(`unrecognised namespace(s): ${sorted.join(", ")}`);
  return {
    key: "unclassified-namespace",
    label: "Unrecognised plugin namespace",
    classification: "unsupported-blocking",
    rationale:
      "This plugin publishes a REST namespace that the capability catalog does not know, so nobody has shown its behaviour can be expressed statically; unknown is not safe, and adding it to the catalog with a reason is the only way to clear it." +
      suspicion,
    evidence: sorted.map((namespace) => ({
      kind: "rest-namespace" as const,
      value: namespace,
      source: "/wp-json/",
    })),
    where: [],
  };
}

/**
 * The public user endpoint is a finding about the *source* site, not about the
 * conversion. It is recorded so the exposure is not lost when the WordPress
 * install is retired, and it never blocks: `blocking: false`.
 *
 * Shape note: the frozen schema has no `securityFindings[]`, and adding one
 * would be a schema change. An informational `unsupported[]` entry carries it
 * today without inventing fields.
 */
function securityFinding(input: CapabilityEvidenceInput): CapabilityFinding | undefined {
  if (input.usersEndpointOpen !== true) return undefined;
  const count = input.userCount ?? null;
  const shape =
    count === null ? "an unknown number of users" : `${count} user${count === 1 ? "" : "s"}`;
  return {
    key: "rest-users-public",
    label: "Public user enumeration",
    classification: "needs-handling",
    rationale: `\`/wp-json/wp/v2/users\` answers without authentication and exposes ${shape} (identifiers only; no names or emails were recorded). This is a live security finding on the WordPress install, not a conversion blocker — recorded here so the exposure is not lost when the site is retired.`,
    evidence: [
      { kind: "rest-endpoint", value: "/wp-json/wp/v2/users", source: "/wp-json/wp/v2/users" },
    ],
    where: [],
  };
}

/** Project a finding into the IR's flat entry shape. */
function toUnsupported(finding: CapabilityFinding): UnsupportedCapability {
  const entry: UnsupportedCapability = {
    capability: finding.key,
    detail: detailFor(finding),
    blocking: finding.classification === "unsupported-blocking",
  };
  if (finding.where.length > 0) entry.where = finding.where;
  return entry;
}

// ---- the emit-time guard ----------------------------------------------------

/** Why a conversion was refused. */
export type RefusalReason = "blocking" | "cannot-evaluate";

/** Thrown by `assertConvertible`; the emitter (B2.1) must not catch it and continue. */
export class ConversionRefusedError extends Error {
  readonly reason: RefusalReason;
  readonly blocking: readonly UnsupportedCapability[];

  constructor(reason: RefusalReason, blocking: readonly UnsupportedCapability[], message: string) {
    super(message);
    this.name = "ConversionRefusedError";
    this.reason = reason;
    this.blocking = blocking;
  }
}

/** Normalise either a full report or a bare IR `capabilities` object. */
function capabilitiesOf(report: CapabilityReport | SiteCapabilities): SiteCapabilities {
  return "capabilities" in report ? report.capabilities : report;
}

/**
 * Refuse to emit when the capture could not prove the site is convertible.
 *
 * This is the small pure function the emitter calls before writing a single
 * byte. It refuses twice: on any `blocking: true` capability, and on a
 * `cannot-evaluate` sentinel entry (so a caller holding only the JSON still
 * cannot mistake silence for safety).
 */
export function assertConvertible(report: CapabilityReport | SiteCapabilities): void {
  const capabilities = capabilitiesOf(report);

  const notEvaluated = capabilities.unsupported.find(
    (entry) => entry.capability === CANNOT_EVALUATE_KEY,
  );
  if (notEvaluated !== undefined) {
    throw new ConversionRefusedError(
      "cannot-evaluate",
      capabilities.unsupported.filter((entry) => entry.blocking === true),
      `Refusing to convert: ${notEvaluated.detail ?? "capability evidence could not be evaluated"}`,
    );
  }

  const blocking = capabilities.unsupported.filter((entry) => entry.blocking === true);
  if (blocking.length === 0) return;

  const named = blocking
    .map((entry) => `${entry.capability}${entry.detail === undefined ? "" : ` — ${entry.detail}`}`)
    .join("; ");
  throw new ConversionRefusedError(
    "blocking",
    blocking,
    `Refusing to convert: ${blocking.length} blocking capability(ies): ${named}`,
  );
}

/** Exit code the CLI uses: 0 clean, 1 blocked, 2 cannot evaluate. */
export function exitCodeFor(report: CapabilityReport): 0 | 1 | 2 {
  if (report.status === "cannot-evaluate") return 2;
  if (report.status === "blocked") return 1;
  return 0;
}

// ---- reporting --------------------------------------------------------------

const CLASS_LABEL: Readonly<Record<CapabilityClass, string>> = {
  supported: "supported",
  "needs-handling": "needs-handling",
  "unsupported-blocking": "BLOCKING",
};

/** The console report. The table is the deliverable the operator reads. */
export function formatReport(report: CapabilityReport): string {
  const lines: string[] = [];
  const nonCore = report.evidence.restNamespaces.filter((ns) => !isCoreNamespace(ns));

  lines.push("Capability report");
  lines.push(
    `  REST namespaces : ${report.evidence.restNamespaces.length} seen, ${nonCore.length} non-core${nonCore.length > 0 ? ` (${nonCore.join(", ")})` : ""}`,
  );
  lines.push(`  rendered DOM    : ${report.evidence.domPages.length} page(s) scanned`);
  lines.push(`  evidence kinds  : ${report.evidence.kinds.join(", ") || "(none)"}`);
  for (const origin of report.evidence.origins) lines.push(`  input           : ${origin}`);

  if (report.findings.length > 0) {
    const width = Math.max(...report.findings.map((finding) => finding.label.length));
    lines.push("");
    lines.push(`  ${"CLASS".padEnd(16)}${"CAPABILITY".padEnd(width + 2)}EVIDENCE`);
    for (const finding of report.findings) {
      const evidence = evidenceSentence(finding.evidence) || "(no evidence recorded)";
      lines.push(
        `  ${CLASS_LABEL[finding.classification].padEnd(16)}${finding.label.padEnd(width + 2)}${evidence}`,
      );
    }
  }

  if (report.evidence.domPages.length > 0 && report.findings.some((f) => f.where.length > 0)) {
    lines.push("");
    for (const finding of report.findings) {
      if (finding.where.length === 0) continue;
      lines.push(`  ${finding.label} found on: ${finding.where.join(", ")}`);
    }
  }

  lines.push("");
  if (report.status === "cannot-evaluate") {
    lines.push("  RESULT: CANNOT EVALUATE — no capability evidence was available.");
    for (const reason of report.reasons) lines.push(`    - ${reason}`);
    lines.push("    Nothing is proven safe. The conversion must not proceed.");
    return lines.join("\n");
  }

  if (report.status === "blocked") {
    const blocking = report.capabilities.unsupported.filter((entry) => entry.blocking === true);
    lines.push(`  RESULT: BLOCKED — ${blocking.length} capability(ies) cannot be converted:`);
    for (const entry of blocking) {
      lines.push(`    - ${entry.capability}: ${entry.detail ?? "(no detail)"}`);
      if (entry.where !== undefined && entry.where.length > 0) {
        lines.push(`      where: ${entry.where.join(", ")}`);
      }
    }
    return lines.join("\n");
  }

  const supported = report.capabilities.supported;
  const handling = report.capabilities.unsupported.filter((entry) => entry.blocking !== true);
  lines.push(
    `  RESULT: CONVERTIBLE — ${supported.length} supported (${supported.join(", ") || "none"}), ${handling.length} needing handling (${handling.map((entry) => entry.capability).join(", ") || "none"}).`,
  );
  if (handling.length > 0) {
    lines.push("  These do not block, but they are not nothing:");
    for (const entry of handling) lines.push(`    - ${entry.capability}: ${entry.detail ?? ""}`);
  }
  return lines.join("\n");
}

// ---- CLI --------------------------------------------------------------------

const DEFAULT_MANIFEST = "capture/routes.manifest.json";
const DEFAULT_DOM_BUNDLE = "capture/dom.pages.json";
const DEFAULT_OUT = "capture/capabilities.json";

/** The DOM evidence bundle written by page capture: `{ "pages": [{ path, html }] }`. */
interface DomBundle {
  pages?: unknown;
}

interface CliArgs {
  manifest: string | null;
  restRoot: string | null;
  domBundle: string | null;
  out: string;
}

const USAGE = [
  "Usage: node dist/source/capabilities/detect.js [options]",
  "",
  "Classify every capability the recorded capture proves, and write",
  `${DEFAULT_OUT} (the Site IR \`capabilities\` object).`,
  "",
  "Exit codes:",
  "  0  no blocking capability",
  "  1  a blocking capability is present (each one is printed with its reason)",
  "  2  cannot evaluate (no evidence available)",
  "",
  "Options:",
  `  --manifest <path>      route manifest to read namespaces + REST facts from (default ${DEFAULT_MANIFEST})`,
  "  --no-manifest          do not read a route manifest",
  `  --dom-bundle <path>    captured pages as \`{ pages: [{ path, html }] }\` (default ${DEFAULT_DOM_BUNDLE})`,
  "  --rest-root <path>     recorded /wp-json/ body, when there is no manifest",
  `  --out <path>          report path (default ${DEFAULT_OUT})`,
].join("\n");

function parseArgs(argv: readonly string[]): CliArgs | null {
  const args: CliArgs = {
    manifest: DEFAULT_MANIFEST,
    restRoot: null,
    domBundle: DEFAULT_DOM_BUNDLE,
    out: DEFAULT_OUT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string | null => argv[i + 1] ?? null;
    if (arg === "--manifest") {
      const value = next();
      if (value === null) return null;
      args.manifest = value;
      i += 1;
    } else if (arg === "--no-manifest") {
      args.manifest = null;
    } else if (arg === "--dom-bundle") {
      const value = next();
      if (value === null) return null;
      args.domBundle = value;
      i += 1;
    } else if (arg === "--rest-root") {
      const value = next();
      if (value === null) return null;
      args.restRoot = value;
      i += 1;
    } else if (arg === "--out") {
      const value = next();
      if (value === null) return null;
      args.out = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      return null;
    } else {
      return null;
    }
  }
  return args;
}

/** Read a file when it exists; absence is data, not an error. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Facts the route manifest carries that the detector needs. */
export interface ManifestFacts {
  namespaces: string[];
  usersEndpointOpen: boolean;
  userCount: number | null;
}

/** Read the capability-relevant facts out of a B1.1 route manifest. */
export function factsFromManifest(body: string): ManifestFacts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rest = (parsed as Record<string, unknown>)["rest"];
  if (typeof rest !== "object" || rest === null) return null;
  const record = rest as Record<string, unknown>;
  const namespaces = Array.isArray(record["namespaces"])
    ? record["namespaces"].filter((value): value is string => typeof value === "string")
    : [];
  const userCount = record["userCount"];
  return {
    namespaces,
    usersEndpointOpen: record["usersEndpointOpen"] === true,
    userCount: typeof userCount === "number" ? userCount : null,
  };
}

/** Read a recorded DOM bundle; a malformed bundle yields no pages and a reason. */
export function pagesFromBundle(body: string, reasons: string[]): DomPage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    reasons.push(
      `DOM bundle is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    reasons.push("DOM bundle is not a JSON object");
    return [];
  }
  const pages = (parsed as DomBundle).pages;
  if (!Array.isArray(pages)) {
    reasons.push("DOM bundle has no `pages` array");
    return [];
  }
  return pages.flatMap((page) => {
    if (typeof page !== "object" || page === null) return [];
    const record = page as Record<string, unknown>;
    const path = record["path"];
    const html = record["html"];
    if (typeof path !== "string" || typeof html !== "string") return [];
    return [{ path, html }];
  });
}

export interface CapabilityCliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface CapabilityCliOptions {
  /** Directory the relative evidence paths are resolved from. Defaults to cwd. */
  cwd?: string;
  io?: CapabilityCliIo;
}

/**
 * The `capture:capabilities` command.
 *
 * Reads recorded evidence only — never the network — writes the IR-shaped
 * report, and returns 0 / 1 / 2. Being offline is the point: the gate result for
 * a site is a function of what was captured, so it can be re-run and diffed.
 */
export async function runCapabilityCli(
  argv: readonly string[],
  options: CapabilityCliOptions = {},
): Promise<number> {
  const io: CapabilityCliIo = options.io ?? {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  };
  const cwd = options.cwd ?? process.cwd();
  const resolvePath = (path: string): string => resolve(cwd, path);

  const args = parseArgs(argv);
  if (args === null) {
    io.stdout(USAGE);
    return argv.includes("--help") || argv.includes("-h") ? 0 : 1;
  }

  const reasons: string[] = [];
  const origins: string[] = [];
  const input: CapabilityEvidenceInput = {};

  if (args.manifest !== null) {
    const body = await readIfPresent(resolvePath(args.manifest));
    if (body === null) {
      reasons.push(`route manifest not found at ${args.manifest}`);
    } else {
      const facts = factsFromManifest(body);
      if (facts === null) {
        reasons.push(`route manifest at ${args.manifest} carries no readable \`rest\` facts`);
      } else {
        input.namespaces = facts.namespaces;
        input.usersEndpointOpen = facts.usersEndpointOpen;
        input.userCount = facts.userCount;
        origins.push(`manifest:${args.manifest}`);
      }
    }
  }

  if (args.restRoot !== null) {
    const body = await readIfPresent(resolvePath(args.restRoot));
    if (body === null) {
      reasons.push(`recorded /wp-json/ body not found at ${args.restRoot}`);
    } else {
      input.restRoot = body;
      origins.push(`rest-root:${args.restRoot}`);
    }
  }

  if (args.domBundle !== null) {
    const body = await readIfPresent(resolvePath(args.domBundle));
    if (body === null) {
      reasons.push(`DOM bundle not found at ${args.domBundle} (no rendered-DOM evidence)`);
    } else {
      const pages = pagesFromBundle(body, reasons);
      input.pages = pages;
      origins.push(`dom:${args.domBundle} (${pages.length} page(s))`);
    }
  }

  const report = detectCapabilities(input);
  report.evidence.origins = origins;
  const known = new Set(report.reasons);
  for (const reason of reasons) {
    if (known.has(reason)) continue;
    known.add(reason);
    report.reasons.push(reason);
    report.evidence.reasons.push(reason);
  }

  const outPath = resolvePath(args.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report.capabilities, null, 2)}\n`, "utf8");

  io.stdout(formatReport(report));
  io.stdout(`wrote ${args.out}`);

  return exitCodeFor(report);
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await runCapabilityCli(process.argv.slice(2));
}
