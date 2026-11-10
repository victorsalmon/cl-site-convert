/**
 * The one place this bead touches the live site: a read-only fetch of the form
 * render that exists only by query string.
 *
 * `/?fluent-form=3` is a page the route enumeration cannot reach (it is a query
 * parameter, not a path) and the capture therefore does not hold. Its fields are
 * also the only place the Fluent Forms fields survive in HTML at all, because the
 * page that carries the form (`/tmh/apply/`) uses the conversational shape.
 *
 * Constraints, all enforced by `PoliteFetcher` rather than by hope:
 *
 *  - one request at a time, `minIntervalMs` apart (>= 600 ms by default);
 *  - robots.txt read first and obeyed, including `Allow` overrides;
 *  - an honest, contactable User-Agent;
 *  - GET only. Nothing here posts a form, and nothing here may: a capture that
 *    submits is a capture that creates records on a production site.
 *
 * Two renders are fetched. One is stored as the evidence. The second is fetched
 * only to prove that the mount-only page and the query-string render serve the
 * **same question set** — the claim that lets `/tmh/apply/` be attributed a field
 * list it does not itself contain.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  PoliteFetcher,
  isPathAllowed,
  USER_AGENT,
  DEFAULT_MIN_INTERVAL_MS,
} from "../wp-rest/http.js";
import { parseFluentGlobalConfig } from "./fluent.js";
import type { ConfigComparison, RecordingIndex, RecordedRender } from "./recordings.js";
import {
  RecordingIndexError,
  redactSecurityTokens,
  securityValuesIn,
  sha256,
} from "./recordings.js";

/** The render that is stored, because it is not in the 19 captured pages. */
export const QUERY_RENDER_ROUTE = "/?fluent-form=3";

/** The page whose own document carries only a conversational mount. */
export const MOUNT_ROUTE = "/tmh/apply/";

export interface FetchPlanEntry {
  route: string;
  /** Store the redacted HTML as a recorded render. False for comparison-only. */
  store: boolean;
  /** File name inside the output directory, when stored. */
  file?: string;
  /** IR slug to give the extracted form. */
  formId?: string;
  note: string;
}

export const DEFAULT_FETCH_PLAN: readonly FetchPlanEntry[] = [
  {
    route: QUERY_RENDER_ROUTE,
    store: true,
    file: "fluent-form-3.query.html",
    formId: "fluent-form-3-query",
    note: "Fluent Forms conversational render reachable only by query string; not one of the 19 captured pages.",
  },
  {
    route: MOUNT_ROUTE,
    store: false,
    note: "Fetched for comparison only: proves the mount page serves the same question set as the query render.",
  },
];

export interface FetchFormsOptions {
  baseUrl: string;
  /** Directory the stored renders are written to, relative to `cwd`. */
  outDir: string;
  /** Paths recorded in the index, relative to `cwd`. Defaults to `outDir`. */
  indexPathPrefix?: string;
  plan?: readonly FetchPlanEntry[];
  minIntervalMs?: number;
  cwd?: string;
  io?: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  };
}

/** Digest of a config's question set: stable across sessions, no nonce inside. */
export function questionsDigest(config: Record<string, unknown>): {
  sha256: string;
  count: number;
} | null {
  const form = config["form"];
  if (form === null || typeof form !== "object") return null;
  const questions = (form as Record<string, unknown>)["questions"];
  if (!Array.isArray(questions)) return null;
  return { sha256: sha256(JSON.stringify(questions)), count: questions.length };
}

/**
 * Fetch, redact and record. Returns the index that was written; the caller decides
 * whether to persist it (and a test can call this with a fake fetcher instead).
 */
export async function fetchFormRecordings(options: FetchFormsOptions): Promise<RecordingIndex> {
  const cwd = options.cwd ?? process.cwd();
  const outDir = resolve(cwd, options.outDir);
  const indexPrefix = options.indexPathPrefix ?? options.outDir;
  const plan = options.plan ?? DEFAULT_FETCH_PLAN;
  const io = options.io ?? { stdout: () => undefined, stderr: () => undefined };

  const fetcher = new PoliteFetcher({
    baseUrl: options.baseUrl,
    minIntervalMs: options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    onRequest: (line) => io.stderr(`  ${line}`),
  });

  const rules = await fetcher.readRobots();
  if (rules.unreadable) {
    // Not a refusal: robots.txt could not be read, so it expressed no wish we can
    // honour. Recorded, because "we could not check" is not "we were allowed".
    io.stderr("note: robots.txt was unreadable; proceeding and recording that fact");
  }

  const observedAt = new Date().toISOString();
  const renders: RecordedRender[] = [];
  let comparison: ConfigComparison | null = null;
  let mountDigest: {
    route: string;
    varName: string;
    digest: { sha256: string; count: number };
  } | null = null;

  // The recordings directory is part of the tree; creating it is idempotent.
  mkdirSync(outDir, { recursive: true });

  for (const entry of plan) {
    const path = entry.route.split("?")[0] ?? entry.route;
    if (!isPathAllowed(path.length === 0 ? "/" : path, rules)) {
      throw new RecordingIndexError(
        `${entry.route} is disallowed by robots.txt (${rules.status === null ? "no status" : `HTTP ${rules.status}`}); refusing to fetch a forbidden route`,
      );
    }

    const response = await fetcher.fetch(entry.route);
    if (response.status !== 200) {
      throw new RecordingIndexError(
        `${entry.route} answered ${response.status}${response.location === null ? "" : ` -> ${response.location}`}; the recorded render must be a 200`,
      );
    }
    const html = response.body;
    if (/<form\b/i.test(html) === false && /ffc_conv_form/i.test(html) === false) {
      throw new RecordingIndexError(
        `${entry.route} answered 200 but carries neither a <form> nor a conversational mount; recording it would assert a form that is not there`,
      );
    }

    const config = parseFluentGlobalConfig(html);
    const digest = config === null ? null : questionsDigest(config.config);

    if (entry.route === MOUNT_ROUTE && config !== null && digest !== null) {
      mountDigest = { route: entry.route, varName: config.varName, digest };
    }

    if (!entry.store) {
      io.stdout(`compared ${entry.route}: ${digest?.count ?? 0} questions`);
      continue;
    }

    const redacted = redactSecurityTokens(html);
    const leaked = securityValuesIn(redacted);
    if (leaked.length > 0) {
      throw new RecordingIndexError(
        `redaction left ${leaked.length} security value(s) in ${entry.route}; refusing to write a recording that carries a live token`,
      );
    }

    const fileName = entry.file;
    if (fileName === undefined) {
      throw new RecordingIndexError(
        `fetch plan entry ${entry.route} is stored but has no file name`,
      );
    }
    const absolute = resolve(outDir, fileName);
    writeFileSync(absolute, redacted, "utf8");

    const formRecord =
      config === null ? null : (config.config["form"] as Record<string, unknown> | undefined);
    const render: RecordedRender = {
      route: entry.route,
      path: `${indexPrefix.replace(/\\/g, "/").replace(/\/+$/, "")}/${fileName}`,
      ...(entry.formId === undefined ? {} : { formId: entry.formId }),
      pluginFormId: formRecord?.["id"] === undefined ? null : String(formRecord["id"]),
      note: entry.note,
      httpStatus: response.status,
      bytes: Buffer.byteLength(redacted, "utf8"),
      sha256: sha256(redacted),
      configVarName: config?.varName ?? null,
      questionsSha256: digest?.sha256 ?? null,
      questionCount: digest?.count ?? 0,
    };
    renders.push(render);
    io.stdout(
      `recorded ${entry.route} -> ${render.path} (${render.bytes} B, ${render.questionCount} questions)`,
    );
  }

  const stored = renders.find((render) => render.questionsSha256 !== null);
  if (mountDigest !== null && stored !== undefined && stored.questionsSha256 !== null) {
    comparison = {
      mountRoute: mountDigest.route,
      mountConfigVarName: mountDigest.varName,
      mountQuestionsSha256: mountDigest.digest.sha256,
      questions: mountDigest.digest.count,
      identical: mountDigest.digest.sha256 === stored.questionsSha256,
      observedAt,
    };
  }

  if (renders.length === 0) {
    throw new RecordingIndexError("the fetch plan produced no stored render");
  }

  return {
    baseUrl: options.baseUrl,
    capturedAt: observedAt,
    minIntervalMs: options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    userAgent: USER_AGENT,
    requests: fetcher.requestCount,
    note: "Stored renders are byte-identical to the response except that every session-token value is replaced with REDACTED (names and structure kept). `questionsSha256` is over `form.questions` only, so it is stable across sessions and comparable between renders.",
    renders,
    comparison,
  };
}
