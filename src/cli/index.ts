#!/usr/bin/env node
/**
 * `cl-site-convert` CLI — skeleton.
 *
 * This is a thin stub: it knows the pipeline *shape* and nothing else. Source
 * capture, IR building, emitting and deploying are separate seams that land in
 * later beads. The stage names below are the contract this stub prints, so the
 * seams cannot drift without the help text changing.
 */
import { pathToFileURL } from "node:url";

export const CLI_NAME = "cl-site-convert";
export const CLI_VERSION = "0.1.0";

/**
 * Pipeline stages, in execution order. `source` is the only stage that talks to
 * the live site; everything downstream consumes the Site IR.
 */
export const PIPELINE_STAGES = [
  "source  live WordPress -> Site IR (route manifest, DOM skeleton, assets, capabilities)",
  "ir      Site IR v1 (frozen, versioned)",
  "emit    Site IR -> dist/ (static-html baseline) | dist/ (+ islands mount slots)",
  "deploy  dist/ + api/ -> target (artifact push, never git integration)",
] as const;

export interface CliResult {
  /** Process exit code the caller should use. */
  code: number;
  stdout: string;
  stderr: string;
}

const USAGE = [
  `Usage: ${CLI_NAME} <command> [options]`,
  "",
  "Commands:",
  "  build    Run the pipeline: source -> ir -> emit -> deploy",
  "  help     Show this help",
  "",
  "Options:",
  "  -h, --help     Show this help",
  "  -V, --version  Print the version",
  "",
  "Pipeline stages:",
  ...PIPELINE_STAGES.map((stage) => `  ${stage}`),
  "",
  "No pipeline is implemented yet (skeleton bead B0.5).",
].join("\n");

/**
 * Run the CLI with already-split arguments.
 *
 * Pure with respect to the process: it never reads process.argv and never
 * writes to stdout/stderr itself, which keeps it directly unit-testable.
 */
export function run(argv: readonly string[]): CliResult {
  const [first] = argv;

  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    return { code: 0, stdout: USAGE, stderr: "" };
  }

  if (first === "--version" || first === "-V") {
    return { code: 0, stdout: `${CLI_NAME} ${CLI_VERSION}`, stderr: "" };
  }

  if (first === "build") {
    // Deliberately not implemented: the stub reports the stage plan and exits
    // cleanly so downstream plumbing can be wired against it.
    return {
      code: 0,
      stdout: ["Pipeline (not implemented yet):", ...PIPELINE_STAGES.map((s) => `  ${s}`)].join(
        "\n",
      ),
      stderr: "",
    };
  }

  return {
    code: 1,
    stdout: "",
    stderr: `Unknown command: ${first}\n\n${USAGE}`,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const result = run(process.argv.slice(2));
  if (result.stdout.length > 0) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.code;
}
