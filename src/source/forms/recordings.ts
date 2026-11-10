/**
 * Recorded form renders — the evidence the offline extractor reads.
 *
 * Two of the three forms in this capture are not in `capture/site-ir.json`:
 *
 *  - `/?fluent-form=3` is a render reachable **only** by query string, so the 19
 *    captured pages cannot contain it;
 *  - `/tmh/apply/` *is* a captured page, but it serves Fluent Forms'
 *    conversational shape, whose fields the capture normalised away with the
 *    scripts.
 *
 * So the fields had to be fetched once, politely, and recorded. This module owns
 * that recording: where it lives, what it is allowed to contain, and how the
 * equivalence claim between the two renders is expressed so a later run can check
 * it rather than trust it.
 *
 * **Redaction is mandatory, not cosmetic.** A Fluent Forms page embeds live CSRF
 * nonces in the markup and in its JS config. They are session-bound, so recording
 * one is both useless and a credential-shaped artefact in git history. Every value
 * whose *key* is a nonce is replaced with `REDACTED` before the bytes are written;
 * names, field structure and every other byte are kept. `assertNoSecurityValues`
 * is the test hook that proves nothing leaked.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Names that mark a value as a session token rather than form data. */
const SECURITY_VALUE_KEYS =
  "fluent_forms_admin_nonce|token_nonce|file_delete_nonce|_fluentform_\\d+_fluentformnonce|nonce";

export const REDACTED = "REDACTED";

/** SHA-256 of a string, hex. Used for artifact and config digests. */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Replace every session-token VALUE in a recorded document, leaving every name,
 * field and byte of structure intact.
 *
 * Both spellings the plugin emits are covered: `"nonce":"…"` inside the JS config
 * (including `extra_inputs` entries) and `value="…"` on a hidden `<input>` whose
 * name is a nonce, in either attribute order.
 */
export function redactSecurityTokens(html: string): string {
  let redacted = html.replace(
    new RegExp(`("(?:${SECURITY_VALUE_KEYS})"\\s*:\\s*)"[^"]*"`, "gi"),
    `$1"${REDACTED}"`,
  );

  // name → value attribute order.
  redacted = redacted.replace(
    new RegExp(
      `(<input\\b[^>]*\\bname\\s*=\\s*"(?:[^"]*nonce[^"]*)"[^>]*\\bvalue\\s*=\\s*")[^"]*(")`,
      "gi",
    ),
    `$1${REDACTED}$2`,
  );
  // value → name attribute order.
  redacted = redacted.replace(
    new RegExp(
      `(<input\\b[^>]*\\bvalue\\s*=\\s*")[^"]*("[^>]*\\bname\\s*=\\s*"(?:[^"]*nonce[^"]*)")`,
      "gi",
    ),
    `$1${REDACTED}$2`,
  );
  return redacted;
}

/**
 * Assert a recorded document carries no nonce value.
 *
 * The check is on the *shape* of what a nonce looks like after the field name it
 * belongs to, not on a list of values (which would require having stored them).
 * A non-empty quoted value following a nonce key, other than `REDACTED`, is the
 * defect this guards against.
 */
export function securityValuesIn(html: string): string[] {
  const found: string[] = [];
  const keyPattern = new RegExp(`"(?:${SECURITY_VALUE_KEYS})"\\s*:\\s*"([^"]*)"`, "gi");
  for (const match of html.matchAll(keyPattern)) {
    const value = match[1];
    if (value !== undefined && value !== REDACTED) found.push(value);
  }
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    if (!/name\s*=\s*"[^"]*nonce[^"]*"/i.test(match[0])) continue;
    const value = /\bvalue\s*=\s*"([^"]*)"/i.exec(match[0])?.[1];
    if (value !== undefined && value !== REDACTED) found.push(value);
  }
  return found;
}

/** One recorded render, as the index describes it. */
export interface RecordedRender {
  /** Route as fetched; the query string is part of the identity. */
  route: string;
  /** Repository-relative path of the redacted HTML. */
  path: string;
  /** IR slug this render extracts to, so the artifact id is not re-derived. */
  formId?: string;
  pluginFormId: string | null;
  note: string;
  httpStatus: number;
  /** Bytes stored, after redaction. */
  bytes: number;
  /** SHA-256 of the stored bytes, so a hand edit is visible. */
  sha256: string;
  /** The JS global the config was read from. */
  configVarName: string | null;
  /** SHA-256 of `form.questions` alone: the field set, with no session values. */
  questionsSha256: string | null;
  questionCount: number;
}

/** The equivalence proof between a mount-only page and its query-string render. */
export interface ConfigComparison {
  mountRoute: string;
  mountConfigVarName: string;
  mountQuestionsSha256: string;
  questions: number;
  identical: boolean;
  observedAt: string;
}

export interface RecordingIndex {
  baseUrl: string;
  capturedAt: string;
  /** Politeness actually applied, recorded rather than claimed. */
  minIntervalMs: number;
  userAgent: string;
  /** How many requests the fetch made. */
  requests: number;
  note: string;
  renders: RecordedRender[];
  comparison: ConfigComparison | null;
}

/** Sentinel: the index is missing, so nothing may be assumed about the renders. */
export class RecordingIndexError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new RecordingIndexError(`recording index: \`${key}\` must be a non-empty string`);
  }
  return value;
}

/**
 * Read and shape-check the index. Every defect is thrown, never defaulted: a
 * recording whose path or route is wrong would silently extract the wrong form.
 */
export function parseRecordingIndex(raw: unknown): RecordingIndex {
  const record = asRecord(raw);
  if (record === null) throw new RecordingIndexError("recording index: root must be an object");
  const rendersRaw = record["renders"];
  if (!Array.isArray(rendersRaw) || rendersRaw.length === 0) {
    throw new RecordingIndexError("recording index: `renders` must be a non-empty array");
  }

  const renders: RecordedRender[] = rendersRaw.map((entry, position) => {
    const render = asRecord(entry);
    if (render === null) {
      throw new RecordingIndexError(`recording index: renders[${position}] must be an object`);
    }
    const pluginFormId = render["pluginFormId"];
    const parsed: RecordedRender = {
      route: requiredString(render, "route"),
      path: requiredString(render, "path"),
      ...(typeof render["formId"] === "string" ? { formId: render["formId"] } : {}),
      pluginFormId: typeof pluginFormId === "string" ? pluginFormId : null,
      note: requiredString(render, "note"),
      httpStatus: Number(render["httpStatus"] ?? 0),
      bytes: Number(render["bytes"] ?? 0),
      sha256: requiredString(render, "sha256"),
      configVarName: typeof render["configVarName"] === "string" ? render["configVarName"] : null,
      questionsSha256:
        typeof render["questionsSha256"] === "string" ? render["questionsSha256"] : null,
      questionCount: Number(render["questionCount"] ?? 0),
    };
    return parsed;
  });

  const comparisonRaw = asRecord(record["comparison"]);
  const comparison: ConfigComparison | null =
    comparisonRaw === null
      ? null
      : {
          mountRoute: requiredString(comparisonRaw, "mountRoute"),
          mountConfigVarName: requiredString(comparisonRaw, "mountConfigVarName"),
          mountQuestionsSha256: requiredString(comparisonRaw, "mountQuestionsSha256"),
          questions: Number(comparisonRaw["questions"] ?? 0),
          identical: comparisonRaw["identical"] === true,
          observedAt: requiredString(comparisonRaw, "observedAt"),
        };

  return {
    baseUrl: requiredString(record, "baseUrl"),
    capturedAt: requiredString(record, "capturedAt"),
    minIntervalMs: Number(record["minIntervalMs"] ?? 0),
    userAgent: requiredString(record, "userAgent"),
    requests: Number(record["requests"] ?? 0),
    note: requiredString(record, "note"),
    renders,
    comparison,
  };
}

/** Read the index from disk, or throw: an absent index is not an empty capture. */
export function readRecordingIndex(path: string): RecordingIndex {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new RecordingIndexError(
      `recording index not found at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseRecordingIndex(JSON.parse(text));
  } catch (error) {
    if (error instanceof RecordingIndexError) throw error;
    throw new RecordingIndexError(
      `recording index at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Read one recorded render's HTML, verifying its recorded digest first. */
export function readRecordedHtml(
  index: RecordingIndex,
  render: RecordedRender,
  cwd: string,
): string {
  const absolute = resolve(cwd, render.path);
  const html = readFileSync(absolute, "utf8");
  const actual = sha256(html);
  if (render.sha256 !== actual) {
    throw new RecordingIndexError(
      `recorded render ${render.path} does not match its index digest (expected ${render.sha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…)`,
    );
  }
  return html;
}
