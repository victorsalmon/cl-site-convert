#!/usr/bin/env node
/**
 * Project `capture/style-chain.json` into `capture/site-ir.json`.
 *
 *   node scripts/project-style-chain.mjs            # rewrite the IR in place
 *   node scripts/project-style-chain.mjs --check    # exit 1 if it would change
 *
 * Why this exists: `styles[].order` is a single **site-level** chain index, so it
 * cannot say what one page loads or in what cascade sequence. The captured chain
 * records that per page in `styleChain[].pages[]`, and this script is the only
 * place that turns it into the IR: `styles[]` gets every chain entry (linked and
 * inline) and each page gets its own `styleOrder` — an ordered list of `sha256`
 * values.
 *
 * Nothing here invents an order. `styleOrder` is the page's chain entries sorted
 * by their captured `order`; a page with no chain entry fails loudly instead of
 * falling back to the site sequence.
 *
 * Integrity: every inline entry's bytes are re-hashed from `capturePath` and must
 * equal the recorded `sha256` and `bytes`. A drifting hash is a failure, not a
 * warning — the whole point of `sha256` is that the shipped bytes are verbatim.
 *
 * The projection is idempotent: running it twice produces a byte-identical file.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CHAIN_PATH = join(REPO_ROOT, "capture", "style-chain.json");
const IR_PATH = join(REPO_ROOT, "capture", "site-ir.json");
const checkOnly = process.argv.includes("--check");

function fail(message) {
  console.error(`project-style-chain: ${message}`);
  process.exit(1);
}

/**
 * Verify the chain's claims about its own bytes, then build the `styles[]` entry.
 * The schema forbids unknown properties, so chain-only fields (`capturePath`,
 * `bytes`, `pages`, `detail`) are deliberately not carried over.
 */
function styleEntry(entry) {
  const capturePath = join(REPO_ROOT, entry.capturePath);
  let stat;
  try {
    stat = readFileSync(capturePath);
  } catch {
    fail(`chain entry ${entry.order} points at a missing file: ${entry.capturePath}`);
  }
  const actual = createHash("sha256").update(stat).digest("hex");
  if (actual !== entry.sha256) {
    fail(
      `chain entry ${entry.order} (${entry.capturePath}) hashes to ${actual}, ` +
        `not the recorded ${entry.sha256}`,
    );
  }
  if (entry.bytes !== undefined && stat.length !== entry.bytes) {
    fail(
      `chain entry ${entry.order} (${entry.capturePath}) is ${stat.length} bytes, ` +
        `not the recorded ${entry.bytes}`,
    );
  }
  if (entry.origin === "inline") {
    return {
      origin: "inline",
      localPath: entry.localPath,
      sha256: entry.sha256,
      order: entry.order,
    };
  }
  if (!entry.href) fail(`linked chain entry ${entry.order} has no href`);
  const style = {
    href: entry.href,
    localPath: entry.localPath,
    sha256: entry.sha256,
    order: entry.order,
  };
  if (entry.media !== undefined) style.media = entry.media;
  return style;
}

const chain = JSON.parse(readFileSync(CHAIN_PATH, "utf8"));
const ir = JSON.parse(readFileSync(IR_PATH, "utf8"));

const chainEntries = chain.styleChain ?? [];
if (chainEntries.length === 0) fail("the chain is empty: capture it before projecting");

const orders = chainEntries.map((entry) => entry.order);
const duplicateOrder = orders.find((order, index) => orders.indexOf(order) !== index);
if (duplicateOrder !== undefined) fail(`duplicate chain order ${duplicateOrder}`);
for (const [index, order] of orders.entries()) {
  // A gap would mean an entry was dropped, and `styles[]` is ordered and complete.
  if (order !== index) fail(`chain order ${order} is out of sequence at index ${index}`);
}

const styles = chainEntries.map(styleEntry);
const styleShas = new Set(styles.map((style) => style.sha256));

// The IR's linked entries were captured by B1.3 from the same documents. If the
// regenerated form differs, one of the two is stale: stop rather than rewrite
// evidence silently.
const previousStyles = new Map((ir.styles ?? []).map((style) => [style.order, style]));
for (const style of styles) {
  const previous = previousStyles.get(style.order);
  if (previous === undefined) continue;
  if (JSON.stringify(previous) !== JSON.stringify(style)) {
    fail(
      `styles[${style.order}] would change:\n  ir:    ${JSON.stringify(previous)}\n` +
        `  chain: ${JSON.stringify(style)}`,
    );
  }
}

const chainPages = new Set(chainEntries.flatMap((entry) => entry.pages ?? []));
const irPages = ir.pages.map((page) => page.url);
for (const url of chainPages) {
  if (!irPages.includes(url)) fail(`the chain references a page the IR does not have: ${url}`);
}
for (const url of irPages) {
  if (!chainPages.has(url)) fail(`page ${url} appears in no chain entry: it would load no CSS`);
}

const chainLengths = [];
const pages = ir.pages.map((page) => {
  const pageChain = chainEntries
    .filter((entry) => (entry.pages ?? []).includes(page.url))
    .sort((a, b) => a.order - b.order);
  if (pageChain.length === 0) fail(`page ${page.url} has an empty cascade`);
  const styleOrder = pageChain.map((entry) => entry.sha256);
  if (!styleOrder.every((sha) => styleShas.has(sha))) {
    fail(`page ${page.url} references a sha256 outside styles[]`);
  }
  if (new Set(styleOrder).size !== styleOrder.length) {
    fail(`page ${page.url} references the same sha256 twice; its cascade is ambiguous`);
  }
  chainLengths.push({ url: page.url, length: styleOrder.length });

  // `styleOrder` belongs next to `dom` — both describe what the page ships.
  const projected = {};
  for (const [key, value] of Object.entries(page)) {
    projected[key] = value;
    if (key === "dom") projected.styleOrder = styleOrder;
  }
  if (projected.styleOrder === undefined) fail(`page ${page.url} has no dom to sit beside`);
  return projected;
});

// `origin: "inline"` and `pages[].styleOrder` are v1.1 fields, so an artifact that
// carries them is a v1.1 document. Nothing else in the shape moved.
const projected = {};
for (const [key, value] of Object.entries(ir)) {
  projected[key] = key === "styles" ? styles : key === "pages" ? pages : value;
}
if (projected.irVersion === "1.0.0") projected.irVersion = "1.1.0";

const serialized = `${JSON.stringify(projected, null, 2)}\n`;
const current = readFileSync(IR_PATH, "utf8");

if (checkOnly) {
  if (current !== serialized) fail(`${IR_PATH} is not the projection of the captured chain`);
  console.log("capture/site-ir.json is the projection of the captured chain");
  process.exit(0);
}

writeFileSync(IR_PATH, serialized);

const inline = styles.filter((style) => style.origin === "inline").length;
const linked = styles.length - inline;
console.log(
  `styles[]: ${styles.length} entries (${linked} linked, ${inline} inline; ` +
    `${styleShas.size} distinct sha256)`,
);
for (const { url, length } of chainLengths) {
  console.log(`  ${String(length).padStart(3)}  ${url}`);
}
