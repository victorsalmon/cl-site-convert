#!/usr/bin/env node
/**
 * Site IR / plugin-manifest conformance validator.
 *
 *   node scripts/validate-ir.mjs            # all fixtures
 *   node scripts/validate-ir.mjs --verbose  # print every error path
 *
 * Contract:
 *  - a fixture whose filename contains `.valid.` MUST validate against its schema
 *  - any other fixture MUST be rejected
 *  - valid Site IR fixtures ALSO get referential-integrity checks a JSON Schema
 *    cannot express (subsite / island / apiContract references, style ordering,
 *    unique page urls)
 *
 * Exit codes: 0 pass, 1 a case failed, 2 cannot-evaluate (ajv missing).
 *
 * ajv (draft 2020-12) is a dev dependency and is NOT yet in package.json — the
 * root manifest is owned by another lane. Resolution order: local import, then
 * `node_modules` under the repo root or cwd, then any dir in AJV_RESOLVE_FROM
 * (path-delimited). Never reached, exits 2 rather than pretending to pass.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const verbose = process.argv.includes('--verbose');

const SUITES = [
  {
    name: 'site-ir',
    schemaPath: join(REPO_ROOT, 'schemas', 'site-ir.schema.json'),
    fixtureDir: join(REPO_ROOT, 'tests', 'fixtures', 'site-ir'),
    referential: true,
  },
  {
    name: 'plugin-manifest',
    schemaPath: join(REPO_ROOT, 'schemas', 'plugin-manifest.schema.json'),
    fixtureDir: join(REPO_ROOT, 'tests', 'fixtures', 'plugin-manifest'),
    referential: false,
  },
];

function cannotEvaluate(message) {
  console.error(`cannot-evaluate: ${message}`);
  process.exit(2);
}

async function loadAjv() {
  const candidates = [];
  const addRoot = (dir) => {
    if (!dir) return;
    candidates.push(join(dir, 'node_modules', 'ajv', 'dist', '2020.js'));
  };
  addRoot(REPO_ROOT);
  addRoot(process.cwd());
  for (const dir of (process.env.AJV_RESOLVE_FROM ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    addRoot(dir.trim());
  }

  try {
    const mod = await import('ajv/dist/2020.js');
    return mod.default ?? mod;
  } catch {
    // fall through to explicit paths
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate).href);
      return mod.default ?? mod;
    }
  }

  cannotEvaluate(
    'ajv (draft 2020-12) is not installed. Install it for the validator, e.g.\n' +
      '  pnpm add -D ajv\n' +
      'or point AJV_RESOLVE_FROM at a directory whose node_modules contains ajv.',
  );
}

/** Collect `instancePath` + message pairs from ajv errors. */
function formatErrors(errors) {
  return (errors ?? []).map((error) => {
    const path = error.instancePath || '(root)';
    const extra = error.params && 'additionalProperty' in error.params
      ? ` [${error.params.additionalProperty}]`
      : '';
    return `${path}: ${error.message}${extra}`;
  });
}

/**
 * Relationships the schema cannot police. Returns a list of problems; an empty
 * list means the IR is internally consistent.
 */
function referentialProblems(ir) {
  const problems = [];
  if (typeof ir !== 'object' || ir === null) return problems;
  const pages = Array.isArray(ir.pages) ? ir.pages : [];
  const subsites = new Set(
    (Array.isArray(ir.site?.subsites) ? ir.site.subsites : []).map((s) => s.id),
  );
  const contractIds = new Set(
    (Array.isArray(ir.apiContracts) ? ir.apiContracts : []).map((c) => c.id),
  );

  const seenUrls = new Set();
  const seenOrders = new Set();

  for (const page of pages) {
    if (typeof page?.url !== 'string') continue;
    if (seenUrls.has(page.url)) problems.push(`duplicate page url ${page.url}`);
    seenUrls.add(page.url);

    if (page.subsite !== undefined && subsites.size > 0 && !subsites.has(page.subsite)) {
      problems.push(`${page.url}: unknown subsite ${page.subsite}`);
    }

    const islandIds = new Set();
    for (const island of page.islands ?? []) {
      if (islandIds.has(island.id)) {
        problems.push(`${page.url}: duplicate island id ${island.id}`);
      }
      islandIds.add(island.id);
    }
  }

  for (const style of ir.styles ?? []) {
    if (seenOrders.has(style.order)) {
      problems.push(`duplicate style order ${style.order}`);
    }
    seenOrders.add(style.order);
  }

  for (const form of ir.forms ?? []) {
    const ref = form?.submitContract?.endpointRef;
    if (ref !== undefined && !contractIds.has(ref)) {
      problems.push(`form ${form.id}: unknown apiContract ${ref}`);
    }
  }

  for (const behavior of ir.behaviors ?? []) {
    if (behavior?.endpointRef !== undefined && !contractIds.has(behavior.endpointRef)) {
      problems.push(
        `${behavior.page}: behavior references unknown apiContract ${behavior.endpointRef}`,
      );
    }
    if (behavior?.page !== undefined && !seenUrls.has(behavior.page)) {
      problems.push(`behavior references unknown page ${behavior.page}`);
    }
  }

  return problems;
}

function fixtureFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

async function main() {
  const Ajv2020 = await loadAjv();
  const ajv = new Ajv2020({ allErrors: true, strict: true });

  let failures = 0;
  let cases = 0;
  const rows = [];

  for (const suite of SUITES) {
    const schema = JSON.parse(readFileSync(suite.schemaPath, 'utf8'));
    const validate = ajv.compile(schema);
    const files = fixtureFiles(suite.fixtureDir);

    if (files.length === 0) {
      failures += 1;
      rows.push({ suite: suite.name, file: '(none)', expected: 'fixtures', actual: 'missing', pass: false });
      continue;
    }

    for (const file of files) {
      cases += 1;
      const expectValid = file.includes('.valid.');
      const fixture = JSON.parse(readFileSync(join(suite.fixtureDir, file), 'utf8'));
      const schemaOk = validate(fixture);
      const schemaErrors = formatErrors(validate.errors);
      let problems = [];

      if (schemaOk && suite.referential) {
        problems = referentialProblems(fixture);
      }

      const isValid = schemaOk && problems.length === 0;
      const pass = isValid === expectValid;

      if (!pass) failures += 1;
      rows.push({
        suite: suite.name,
        file,
        expected: expectValid ? 'valid' : 'invalid',
        actual: isValid ? 'valid' : 'invalid',
        pass,
        schemaErrors,
        problems,
      });
    }
  }

  const width = Math.max(...rows.map((row) => `${row.suite}/${row.file}`.length));
  for (const row of rows) {
    const label = `${row.suite}/${row.file}`.padEnd(width);
    const status = row.pass ? 'PASS' : 'FAIL';
    console.log(`${status}  ${label}  expected=${row.expected} actual=${row.actual}`);
    if (!row.pass || verbose) {
      for (const error of row.schemaErrors ?? []) console.log(`        schema: ${error}`);
      for (const problem of row.problems ?? []) console.log(`        ir:     ${problem}`);
    }
  }

  console.log('');
  console.log(`${cases - failures}/${cases} fixtures behaved as expected`);
  if (failures > 0) {
    console.error(`${failures} fixture(s) failed`);
    process.exit(1);
  }
}

await main();
