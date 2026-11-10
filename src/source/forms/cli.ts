#!/usr/bin/env node
/**
 * `capture:forms` — extract every form in the capture into Form IR, and print the
 * table an operator needs to reason about the migration.
 *
 * Offline by default and therefore re-runnable and diffable: it reads
 * `capture/site-ir.json` (the 19 captured pages) plus
 * `tests/fixtures/forms/recordings.json` (the renders that are not pages), and
 * writes two artifacts:
 *
 *   capture/site-ir.json    forms[] + apiContracts[]  (schema-conformant subset)
 *   capture/forms.json      everything the IR cannot hold, plus per-route outcomes
 *
 * `--fetch` is the only mode that touches the network: it performs the polite,
 * robots-aware, read-only fetch of `/?fluent-form=3` and re-verifies that
 * `/tmh/apply/` serves the same question set. `--check` writes nothing and exits 1
 * when the committed artifacts no longer match what the capture produces, so a
 * hand edit or an upstream form change cannot go unnoticed.
 *
 * Exit codes: 0 extracted; 1 the artifacts are stale or the capture is
 * unusable; 2 cannot-evaluate (missing recorded evidence).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseFluentGlobalConfig } from "./fluent.js";
import { extractForms, fieldTypes, hasFileUpload, requiredCount } from "./extract.js";
import type { ConversationalResolver, ExtractOptions } from "./extract.js";
import { buildSidecar, projectForms } from "./project.js";
import { DEFAULT_FETCH_PLAN, fetchFormRecordings } from "./capture.js";
import { RecordingIndexError, readRecordedHtml, readRecordingIndex } from "./recordings.js";
import type { RecordingIndex } from "./recordings.js";
import type { ExtractedForm, FormExtraction } from "./types.js";
import { slugifyRoute } from "./extract.js";

export const DEFAULT_IR_PATH = "capture/site-ir.json";
export const DEFAULT_SIDECAR_PATH = "capture/forms.json";
export const DEFAULT_INDEX_PATH = "tests/fixtures/forms/recordings.json";
export const DEFAULT_RECORDINGS_DIR = "tests/fixtures/forms";

export interface CaptureFormsOptions {
  cwd?: string;
  ir?: string;
  sidecar?: string;
  index?: string;
  /** Write the artifacts. False for `--check`. */
  write?: boolean;
  io?: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  };
}

interface SiteIrPage {
  url?: unknown;
  title?: unknown;
  dom?: { html?: unknown };
}

interface SiteIrDocument {
  site?: { baseUrl?: unknown; title?: unknown };
  pages?: unknown;
  forms?: unknown;
  apiContracts?: unknown;
  [key: string]: unknown;
}

export interface CaptureFormsResult {
  ir: SiteIrDocument;
  sidecarText: string;
  irText: string;
  forms: ExtractedForm[];
  extractions: FormExtraction[];
  /** Routes with nothing to convert, for the report. */
  skipped: Array<{ route: string; reason: string }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Serialise the way the artifacts are committed: 2-space JSON, trailing newline. */
export function serialiseJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * A resolver built from the recorded renders, keyed by plugin form id.
 *
 * This is the only way a mount-only page can be attributed fields, and it is
 * deliberately narrow: a recording must exist for that exact form id, or the
 * extraction reports `fields-unavailable` rather than guessing.
 */
export function resolverFromRecordings(
  index: RecordingIndex,
  cwd: string,
): (formId: string | null) => ConversationalResolver | null {
  return (formId) => {
    if (formId === null) return null;
    for (const render of index.renders) {
      if (render.pluginFormId !== formId) continue;
      const html = readRecordedHtml(index, render, cwd);
      const global = parseFluentGlobalConfig(html);
      if (global === null) continue;
      const verified =
        index.comparison !== null &&
        index.comparison.identical &&
        index.comparison.mountQuestionsSha256 === render.questionsSha256;
      const resolver: ConversationalResolver = {
        global,
        configRoute: render.route,
        ...(verified ? { verifiedIdentical: true } : {}),
      };
      return resolver;
    }
    return null;
  };
}

/**
 * Produce both artifacts without writing them, so `--check` and the tests use the
 * exact code path the writer uses.
 */
export function buildCaptureForms(options: CaptureFormsOptions = {}): CaptureFormsResult {
  const cwd = options.cwd ?? process.cwd();
  const irPath = resolve(cwd, options.ir ?? DEFAULT_IR_PATH);
  const indexPath = resolve(cwd, options.index ?? DEFAULT_INDEX_PATH);

  let ir: SiteIrDocument;
  try {
    ir = JSON.parse(readFileSync(irPath, "utf8")) as SiteIrDocument;
  } catch (error) {
    throw new RecordingIndexError(
      `cannot read ${irPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const pages = Array.isArray(ir.pages) ? ir.pages : [];
  if (pages.length === 0) {
    throw new RecordingIndexError(`${irPath} holds no pages; nothing to extract from`);
  }

  const index = readRecordingIndex(indexPath);
  const resolveConversational = resolverFromRecordings(index, cwd);

  const extractions: FormExtraction[] = [];
  const forms: ExtractedForm[] = [];
  const skipped: Array<{ route: string; reason: string }> = [];
  const usedIds = new Set<string>();

  for (const rawPage of pages) {
    const page = asRecord(rawPage) as SiteIrPage | null;
    if (page === null) continue;
    const route = typeof page.url === "string" ? page.url : null;
    const html = asRecord(page.dom)?.["html"];
    if (route === null || typeof html !== "string") continue;

    const title = typeof page.title === "string" ? page.title : undefined;
    const results = extractForms(html, {
      route,
      ...(title === undefined ? {} : { title }),
      resolveConversational,
    } satisfies ExtractOptions);

    for (const result of results) {
      extractions.push(result);
      if (result.status === "extracted") {
        const form = result.form;
        form.id = uniqueId(form.id, usedIds);
        usedIds.add(form.id);
        forms.push(form);
        continue;
      }
      if (result.status === "fields-unavailable") {
        skipped.push({ route, reason: result.result.reason });
        continue;
      }
      if (result.result.rejected !== "site-search") {
        skipped.push({ route, reason: result.result.reason });
      }
    }
  }

  // Renders that are not pages: fetched once, recorded, and extracted by route
  // exactly as captured, query string included.
  for (const render of index.renders) {
    const html = readRecordedHtml(index, render, cwd);
    const id =
      render.formId ??
      `fluent-form-${render.pluginFormId ?? "unknown"}-${slugifyRoute(render.route)}`;
    const results = extractForms(html, {
      route: render.route,
      id,
      ...(render.note.length === 0 ? {} : { title: render.note }),
    });
    for (const result of results) {
      extractions.push(result);
      if (result.status !== "extracted") {
        skipped.push({
          route: render.route,
          reason: result.status === "absent" ? result.result.reason : result.result.reason,
        });
        continue;
      }
      const form = result.form;
      form.id = uniqueId(form.id, usedIds);
      usedIds.add(form.id);
      forms.push(form);
    }
  }

  if (forms.length === 0) {
    throw new RecordingIndexError(
      "no form was extracted from the capture or the recorded renders; refusing to write an empty forms artifact",
    );
  }

  const projection = projectForms(forms);
  const site = asRecord(ir.site) ?? {};
  const sidecar = buildSidecar({
    baseUrl: typeof site.baseUrl === "string" ? site.baseUrl : "",
    capturedAt: index.capturedAt,
    extractions,
    forms,
    contracts: projection.apiContracts,
  });

  const nextIr: SiteIrDocument = {
    ...ir,
    forms: projection.forms,
    apiContracts: projection.apiContracts,
  };

  return {
    ir: nextIr,
    irText: serialiseJson(nextIr),
    sidecarText: serialiseJson(sidecar),
    forms,
    extractions,
    skipped,
  };
}

function uniqueId(candidate: string, used: ReadonlySet<string>): string {
  if (!used.has(candidate)) return candidate;
  let suffix = 2;
  while (used.has(`${candidate}-${suffix}`)) suffix += 1;
  return `${candidate}-${suffix}`;
}

/** The table: one row per extracted form, the columns an operator reasons about. */
export function formatFormTable(forms: readonly ExtractedForm[]): string {
  const header = ["form id", "route", "fields", "types", "required", "file upload"];
  const rows = forms.map((form) => [
    form.id,
    form.route,
    String(form.fields.length),
    fieldTypes(form).join(","),
    String(requiredCount(form)),
    hasFileUpload(form) ? "YES" : "no",
  ]);
  const widths = header.map((label, index) =>
    Math.max(label.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();

  return [line(header), ...rows.map((row) => line(row))].join("\n");
}

/** The one question the operator was asked to settle, answered from the data. */
export function formatFileUploadVerdict(forms: readonly ExtractedForm[]): string {
  const withUpload = forms.filter((form) => hasFileUpload(form));
  if (withUpload.length === 0) {
    return [
      "file upload: NO form has a file-upload field.",
      "  Google Sheets can store a URL, not a file, and the current Pabbly flow has no",
      "  file field to carry: nothing needs object storage for this migration.",
    ].join("\n");
  }
  return [
    `file upload: ${withUpload.length} form(s) accept a file: ${withUpload.map((form) => form.id).join(", ")}.`,
    "  The Pabbly flow must be posting a URL, which means object storage plus a link is",
    "  required before those forms can be replaced.",
  ].join("\n");
}

const USAGE = [
  "Usage: capture:forms [--fetch] [--check] [--ir <path>] [--sidecar <path>] [--index <path>]",
  "",
  "  --fetch         politely fetch the query-string render (GET only) and rewrite the",
  "                  recording index before extracting",
  "  --check         write nothing; exit 1 when the committed artifacts are stale",
  "  --ir <path>     Site IR to read and update (default: capture/site-ir.json)",
  "  --sidecar <path> sidecar to write (default: capture/forms.json)",
  "  --index <path>  recording index (default: tests/fixtures/forms/recordings.json)",
].join("\n");

interface ParsedArgs {
  fetch: boolean;
  check: boolean;
  ir: string;
  sidecar: string;
  index: string;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    fetch: false,
    check: false,
    ir: DEFAULT_IR_PATH,
    sidecar: DEFAULT_SIDECAR_PATH,
    index: DEFAULT_INDEX_PATH,
    help: false,
  };
  for (let position = 0; position < argv.length; position += 1) {
    const argument = argv[position];
    if (argument === "--fetch") parsed.fetch = true;
    else if (argument === "--check") parsed.check = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--ir") parsed.ir = argv[++position] ?? parsed.ir;
    else if (argument === "--sidecar") parsed.sidecar = argv[++position] ?? parsed.sidecar;
    else if (argument === "--index") parsed.index = argv[++position] ?? parsed.index;
    else throw new RecordingIndexError(`unknown argument "${argument ?? ""}"\n\n${USAGE}`);
  }
  return parsed;
}

export async function main(
  argv: readonly string[],
  io: { stdout: (line: string) => void; stderr: (line: string) => void } = {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  },
): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (args.help) {
    io.stdout(USAGE);
    return 0;
  }

  const cwd = process.cwd();
  try {
    if (args.fetch) {
      const baseUrl = readBaseUrl(resolve(cwd, args.ir));
      io.stdout(`fetching form renders from ${baseUrl} (GET only, polite)\n`);
      const index = await fetchFormRecordings({
        baseUrl,
        outDir: DEFAULT_RECORDINGS_DIR,
        indexPathPrefix: DEFAULT_RECORDINGS_DIR,
        plan: DEFAULT_FETCH_PLAN,
        cwd,
        io,
      });
      const comparison = index.comparison;
      if (comparison !== null) {
        io.stdout(
          comparison.identical
            ? `verified: ${comparison.mountRoute} serves the same ${comparison.questions} questions as ${index.renders[0]?.route ?? "the recorded render"}`
            : `WARNING: ${comparison.mountRoute} question set DIFFERS from the recorded render; ${comparison.mountRoute} must not inherit those fields`,
        );
      }
      writeFileSync(resolve(cwd, args.index), serialiseJson(index), "utf8");
      io.stdout(
        `wrote ${args.index} (${index.requests} requests, ${index.minIntervalMs} ms apart)\n`,
      );
    }

    const built = buildCaptureForms({ cwd, ir: args.ir, index: args.index });
    const formTable = formatFormTable(built.forms);
    const verdict = formatFileUploadVerdict(built.forms);

    if (args.check) {
      const currentIr = readFileSync(resolve(cwd, args.ir), "utf8");
      const currentSidecar = readFileSync(resolve(cwd, args.sidecar), "utf8");
      const irMatches = currentIr === built.irText;
      const sidecarMatches = currentSidecar === built.sidecarText;
      io.stdout(formTable);
      io.stdout("");
      io.stdout(verdict);
      if (!irMatches || !sidecarMatches) {
        io.stderr(
          `\nSTALE: ${irMatches ? "" : `${args.ir} `}${sidecarMatches ? "" : args.sidecar} does not match the capture. Run \`pnpm capture:forms\`.`,
        );
        return 1;
      }
      io.stdout("\nartifacts are up to date.");
      return 0;
    }

    writeFileSync(resolve(cwd, args.ir), built.irText, "utf8");
    writeFileSync(resolve(cwd, args.sidecar), built.sidecarText, "utf8");

    io.stdout(formTable);
    io.stdout("");
    if (built.skipped.length > 0) {
      io.stdout(`routes with no form to convert (${built.skipped.length}):`);
      for (const skip of built.skipped) io.stdout(`  ${skip.route}  ${skip.reason}`);
      io.stdout("");
    }
    io.stdout(verdict);
    io.stdout("");
    io.stdout(`wrote ${args.ir} (${built.forms.length} form(s)) and ${args.sidecar}`);
    return 0;
  } catch (error) {
    if (error instanceof RecordingIndexError) {
      io.stderr(`cannot evaluate: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

function readBaseUrl(irPath: string): string {
  const ir = JSON.parse(readFileSync(irPath, "utf8")) as SiteIrDocument;
  const baseUrl = asRecord(ir.site)?.["baseUrl"];
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new RecordingIndexError(`${irPath} has no site.baseUrl`);
  }
  return baseUrl;
}

/** Run when invoked directly (`node dist/source/forms/cli.js`). */
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("/forms/cli.js") === true;
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
