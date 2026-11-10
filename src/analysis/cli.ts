#!/usr/bin/env node
/**
 * `analyze:templates` — measure the capture's template count and write the
 * registry.
 *
 * Reads `capture/site-ir.json` (the recorded capture), never the network, so the
 * answer is a function of the artifact and two runs can be diffed. Writes
 * `capture/template-registry.json` and prints the cluster table.
 *
 * Exit codes:
 *   0  measured (a registry was written)
 *   1  the run could not produce a measurement (unreadable IR, not a site IR)
 *   2  cannot-evaluate: the IR is readable but holds no pages
 *
 * `--check` writes nothing and exits 1 when the committed registry differs from
 * what the capture produces now — the staleness guard a test can call.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildTemplateRegistry, extractPageShape, formatRegistryTable } from "./cluster.js";
import type { PageShape, TemplateRegistry } from "./cluster.js";

/** Default inputs, relative to the working directory. */
export const DEFAULT_IR_PATH = "capture/site-ir.json";
export const DEFAULT_OUT_PATH = "capture/template-registry.json";

export interface AnalyzeTemplatesOptions {
  /** Directory relative paths resolve from. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  readonly io?: {
    readonly stdout: (line: string) => void;
    readonly stderr: (line: string) => void;
  };
}

interface ParsedArgs {
  readonly ir: string;
  readonly out: string;
  readonly check: boolean;
  readonly help: boolean;
}

const USAGE = [
  "Usage: analyze:templates [--ir <path>] [--out <path>] [--check]",
  "",
  "  --ir <path>   Site IR to measure (default: capture/site-ir.json)",
  "  --out <path>  registry to write (default: capture/template-registry.json)",
  "  --check       write nothing; fail when the committed registry is stale",
].join("\n");

function parseArgs(argv: readonly string[]): ParsedArgs {
  let ir = DEFAULT_IR_PATH;
  let out = DEFAULT_OUT_PATH;
  let check = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") check = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--ir") {
      const value = argv[index + 1];
      if (value !== undefined) {
        ir = value;
        index += 1;
      }
    } else if (argument === "--out") {
      const value = argv[index + 1];
      if (value !== undefined) {
        out = value;
        index += 1;
      }
    }
  }

  return { ir, out, check, help };
}

/** The slice of the Site IR this command reads. Deliberately structural. */
interface SiteIrInput {
  readonly irVersion?: unknown;
  readonly pages?: unknown;
  readonly capture?: { readonly capturedAt?: unknown } | undefined;
}

interface ReadablePage {
  readonly url: string;
  readonly template: string;
  readonly html: string;
}

/** Parse just enough of the IR to measure it. Unreadable pages are reported, never guessed. */
export type IrParseResult =
  | { readonly ok: true; readonly pages: PageShape[]; readonly reasons: string[] }
  | { readonly ok: false; readonly reason: string };

export function pagesFromIr(body: string): IrParseResult {
  let parsed: SiteIrInput;
  try {
    parsed = JSON.parse(body) as SiteIrInput;
  } catch (error) {
    return { ok: false, reason: `site IR is not valid JSON: ${(error as Error).message}` };
  }
  if (!Array.isArray(parsed.pages)) {
    return { ok: false, reason: "site IR has no `pages[]` array" };
  }

  const reasons: string[] = [];
  const pages: PageShape[] = [];
  parsed.pages.forEach((entry, index) => {
    const record = entry as Partial<ReadablePage> & { dom?: { html?: unknown } };
    if (typeof record.url !== "string") {
      reasons.push(`page ${index} has no string \`url\`; skipped`);
      return;
    }
    if (typeof record.dom?.html !== "string") {
      reasons.push(`page ${record.url} has no string \`dom.html\`; skipped`);
      return;
    }
    pages.push(
      extractPageShape({
        url: record.url,
        template: typeof record.template === "string" ? record.template : "",
        html: record.dom.html,
      }),
    );
  });

  return { ok: true, pages, reasons };
}

/** IR metadata recorded beside the measurement, so the registry names its input. */
function irMetadata(body: string): { irVersion: string; capturedAt: string | null } {
  try {
    const parsed = JSON.parse(body) as SiteIrInput;
    return {
      irVersion: typeof parsed.irVersion === "string" ? parsed.irVersion : "unknown",
      capturedAt: typeof parsed.capture?.capturedAt === "string" ? parsed.capture.capturedAt : null,
    };
  } catch {
    return { irVersion: "unknown", capturedAt: null };
  }
}

/** The exact bytes a registry is written as. Both the writer and `--check` use it. */
export function serialiseRegistry(registry: TemplateRegistry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

export async function runAnalyzeTemplates(
  argv: readonly string[],
  options: AnalyzeTemplatesOptions = {},
): Promise<number> {
  const io = options.io ?? {
    stdout: (line: string) => process.stdout.write(`${line}\n`),
    stderr: (line: string) => process.stderr.write(`${line}\n`),
  };
  const cwd = options.cwd ?? process.cwd();
  const args = parseArgs(argv);

  if (args.help) {
    io.stdout(USAGE);
    return 0;
  }

  let body: string;
  try {
    body = await readFile(resolve(cwd, args.ir), "utf8");
  } catch {
    io.stderr(`cannot read ${args.ir}`);
    return 1;
  }

  const parsedIr = pagesFromIr(body);
  if (!parsedIr.ok) {
    io.stderr(`cannot evaluate ${args.ir}`);
    io.stderr(`  ${parsedIr.reason}`);
    return 1;
  }

  const meta = irMetadata(body);
  const registry = buildTemplateRegistry({
    pages: parsedIr.pages,
    irVersion: meta.irVersion,
    capturedAt: meta.capturedAt,
  });
  const merged: TemplateRegistry = {
    ...registry,
    reasons: [...registry.reasons, ...parsedIr.reasons],
  };

  io.stdout(formatRegistryTable(merged));

  const outPath = resolve(cwd, args.out);
  const text = serialiseRegistry(merged);

  if (args.check) {
    let existing: string | null = null;
    try {
      existing = await readFile(outPath, "utf8");
    } catch {
      existing = null;
    }
    if (existing === text) {
      io.stdout(`${args.out} is up to date`);
      return merged.status === "computed" ? 0 : 2;
    }
    io.stderr(`${args.out} is stale: re-run \`pnpm analyze:templates\``);
    return 1;
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, text, "utf8");
  io.stdout(`wrote ${args.out}`);

  return merged.status === "computed" ? 0 : 2;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await runAnalyzeTemplates(process.argv.slice(2));
}
