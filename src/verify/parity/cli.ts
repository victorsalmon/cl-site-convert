/**
 * `validate:parity` — the fidelity gate, as a command.
 *
 * Exit codes, and why they are these three:
 *
 * | Code | Meaning |
 * | :--- | :--- |
 * | 0 | every page is equivalent to its IR entry |
 * | 1 | the artefact drifted, or the run itself failed |
 * | 2 | **cannot evaluate** — the IR or `dist/site` is missing. Never a pass (cl-common ADR 0012: a gate that cannot pass is a defect, and a gate that cannot run is not a green one) |
 *
 * `pnpm validate:parity` runs `pnpm emit:static` first, so the gate always builds
 * what it verifies: a stale `dist/site` can never be certified.
 */

import { pathToFileURL } from "node:url";

import { formatParityReport, verifyParity } from "./index.js";
import type { VerifyOptions } from "./index.js";
import { CannotEvaluateError } from "./types.js";

const USAGE = [
  "Usage: node dist/verify/parity/cli.js [options]",
  "",
  "Prove that dist/site is equivalent to the Site IR: identical body tree, identical",
  "CSS bytes in the captured cascade order, every asset present and hashed, residuals",
  "equal to the committed allowlist, no scripts on island-free pages, and no content",
  "that belongs to another page.",
  "",
  "Options:",
  "  --ir <path>         Site IR (default capture/site-ir.json)",
  "  --out <dir>         artefact directory (default dist/site)",
  "  --report <path>     report path (default dist/parity-report.json)",
  "  --assets <dir>      captured asset root (default capture/assets)",
  "  --map <path>        asset rewrite map (default capture/asset-rewrite-map.json)",
  "  --routes <path>     route manifest (default capture/routes.manifest.json)",
  "  --allowlist <path>  residual allowlist",
  "                      (default tests/fixtures/self-contained/allowlist.json)",
  "  --base-url <url>    canonical origin the artefact declares",
  "  --form-sink <url>   sink form actions point at",
  "  -h, --help          show this help",
].join("\n");

function parseArgs(argv: readonly string[]): VerifyOptions | null {
  const options: { -readonly [K in keyof VerifyOptions]: VerifyOptions[K] } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "-h" || arg === "--help") return null;
    if (value === undefined) return null;
    if (arg === "--ir") options.irPath = value;
    else if (arg === "--out") options.outDir = value;
    else if (arg === "--report") options.reportPath = value;
    else if (arg === "--assets") options.assetsRoot = value;
    else if (arg === "--map") options.rewriteMapPath = value;
    else if (arg === "--routes") options.routesPath = value;
    else if (arg === "--allowlist") options.allowlistPath = value;
    else if (arg === "--base-url") options.baseUrl = value;
    else if (arg === "--form-sink") options.formSink = value;
    else return null;
    index += 1;
  }
  return options;
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options === null) {
    process.stdout.write(`${USAGE}\n`);
    return argv.includes("--help") || argv.includes("-h") ? 0 : 2;
  }

  try {
    const report = await verifyParity(options);
    process.stdout.write(`${formatParityReport(report)}\n`);
    process.stdout.write(
      report.verdict === "pass"
        ? `\nwrote ${options.reportPath ?? "dist/parity-report.json"}\n`
        : `\nFAILED — see ${options.reportPath ?? "dist/parity-report.json"}\n`,
    );
    return report.verdict === "pass" ? 0 : 1;
  } catch (error) {
    if (error instanceof CannotEvaluateError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}

export { main };
