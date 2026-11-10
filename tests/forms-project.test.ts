/**
 * Form artifact projection (P4.1a) - what lands in the Site IR, and what cannot.
 *
 * The Site IR's `form` shape is frozen and forbids unknown properties, so the
 * extractor's output has to be **narrowed**, not widened. This suite is the proof
 * that the narrowing is deliberate and that nothing was dropped silently:
 *
 *  1. **The committed artifacts are reproducible.** Re-running the projection on
 *     the capture must byte-match `capture/site-ir.json` and `capture/forms.json`,
 *     so neither can be hand-edited or left stale (a `--check` test, no writes).
 *  2. **The IR is conformant and self-consistent.** Every form's
 *     `submitContract.endpointRef` resolves to an `apiContracts[]` entry, ids are
 *     unique, routes are the captured routes (query string included), and every
 *     field name matches the schema's pattern - checked here as well as by
 *     `pnpm validate:ir`, because a schema alone will not catch a duplicate id.
 *  3. **The sidecar carries what the IR cannot**, and says so: the plugin's form
 *     id, the render mode, conditional rules, upload limits, the per-route
 *     outcomes (including the two pages that have no form) and the schema gaps.
 *  4. **No session token reaches either artifact**, and no file-upload field exists
 *     in this migration - which is the operator's open question, answered.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildCaptureForms,
  formatFileUploadVerdict,
  formatFormTable,
  main,
  serialiseJson,
} from "../src/source/forms/cli.js";
import { projectForms } from "../src/source/forms/project.js";
import { securityValuesIn } from "../src/source/forms/recordings.js";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const built = buildCaptureForms({ cwd: ROOT });
const irText = readFileSync(join(ROOT, "capture/site-ir.json"), "utf8");
const sidecarText = readFileSync(join(ROOT, "capture/forms.json"), "utf8");
const ir = JSON.parse(irText) as {
  forms?: Array<{
    id: string;
    source: string;
    page?: string;
    fields: Array<{ name: string; type: string; required?: boolean }>;
    submitContract: { sink: string; endpointRef: string; honeypot?: boolean };
    validation?: { spam?: string[] };
    title?: string;
  }>;
  apiContracts?: Array<{ id: string; method: string; url: string; requestShape?: unknown }>;
  pages: Array<{ url: string }>;
};
const sidecar = JSON.parse(sidecarText) as {
  forms: Array<Record<string, unknown>>;
  routes: Array<{ route: string; status: string; reason?: string; formId?: string }>;
  fileUpload: { any: boolean; forms: string[]; fields: unknown[] };
  schemaGaps: string[];
  note: string;
  submitEndpoints: unknown[];
};

const FIELD_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.[\]-]*$/;
const FIELD_TYPES = new Set([
  "text",
  "email",
  "tel",
  "url",
  "number",
  "textarea",
  "select",
  "radio",
  "checkbox",
  "checkbox-group",
  "file",
  "date",
  "hidden",
  "honeypot",
  "turnstile",
]);

describe("committed artifacts are reproducible", () => {
  it("capture/site-ir.json matches what the capture produces now", () => {
    expect(built.irText).toBe(irText);
  });

  it("capture/forms.json matches what the capture produces now", () => {
    expect(built.sidecarText).toBe(sidecarText);
  });

  it("serialises with the committed convention (2-space JSON, trailing newline)", () => {
    expect(built.irText.endsWith("}\n")).toBe(true);
    expect(serialiseJson({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it("`--check` exits 0 on the committed artifacts and writes nothing", async () => {
    const lines: string[] = [];
    const code = await main(["--check"], {
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("artifacts are up to date.");
    expect(readFileSync(join(ROOT, "capture/site-ir.json"), "utf8")).toBe(irText);
  });

  it("exits 2 when the recorded evidence is missing", async () => {
    const errors: string[] = [];
    const code = await main(["--check", "--index", "tests/fixtures/forms/does-not-exist.json"], {
      stdout: () => undefined,
      stderr: (line) => errors.push(line),
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/cannot evaluate/);
  });

  it("rejects an unknown argument instead of ignoring it", async () => {
    const errors: string[] = [];
    const code = await main(["--nonsense"], {
      stdout: () => undefined,
      stderr: (line) => errors.push(line),
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/unknown argument/);
  });
});

describe("Site IR conformance", () => {
  it("emits one form entry per captured render", () => {
    expect(ir.forms?.map((form) => form.id)).toEqual(["fluent-form-3", "fluent-form-3-query"]);
  });

  it("keeps each form on its captured route, query string included", () => {
    expect(ir.forms?.map((form) => form.page)).toEqual(["/tmh/apply/", "/?fluent-form=3"]);
  });

  it("resolves every submitContract.endpointRef to an apiContract", () => {
    const ids = new Set((ir.apiContracts ?? []).map((contract) => contract.id));
    for (const form of ir.forms ?? []) {
      expect(ids.has(form.submitContract.endpointRef)).toBe(true);
      expect(form.submitContract.sink).toBe("pabbly");
    }
  });

  it("describes the capture's wire contract, not a fabricated endpoint", () => {
    const contract = ir.apiContracts?.[0];
    expect(contract?.id).toBe("fluentform-submit");
    expect(contract?.method).toBe("POST");
    expect(contract?.url).toBe("https://upscalehavens.ca/wp-admin/admin-ajax.php");
    const shape = contract?.requestShape as {
      renderMode?: string;
      extraInputNames?: string[];
      nonceFieldNames?: string[];
    };
    expect(shape.renderMode).toBe("conversational");
    expect(shape.extraInputNames).toContain("item_3__fluent_sf");
    expect(shape.nonceFieldNames).toEqual(["_fluentform_3_fluentformnonce"]);
  });

  it("emits only schema-legal field names and types", () => {
    for (const form of ir.forms ?? []) {
      expect(form.fields.length).toBeGreaterThan(0);
      for (const field of form.fields) {
        expect(field.name).toMatch(FIELD_NAME_PATTERN);
        expect(FIELD_TYPES.has(field.type)).toBe(true);
      }
    }
  });

  it("carries the measured field counts and required counts", () => {
    for (const form of ir.forms ?? []) {
      expect(form.fields).toHaveLength(15);
      expect(form.fields.filter((field) => field.required === true)).toHaveLength(12);
    }
  });

  it("records the spam protection the form actually has", () => {
    for (const form of ir.forms ?? []) {
      expect(form.validation?.spam).toEqual(["honeypot"]);
      expect(form.submitContract.honeypot).toBe(true);
    }
  });

  it("is the same form definition on both routes", () => {
    const [page, query] = ir.forms ?? [];
    expect(page?.fields).toEqual(query?.fields);
  });

  it("points every form id at a page that exists in pages[]", () => {
    const urls = new Set(ir.pages.map((page) => page.url));
    const pageForm = ir.forms?.find((form) => form.id === "fluent-form-3");
    expect(urls.has(pageForm?.page ?? "")).toBe(true);
    // The query render is deliberately NOT a page: it is a render, reachable only
    // by query string, and adding it to pages[] would make the emitter route it.
    const queryForm = ir.forms?.find((form) => form.id === "fluent-form-3-query");
    expect(urls.has(queryForm?.page ?? "")).toBe(false);
  });
});

describe("the projector refuses an invalid form", () => {
  it("throws rather than emitting a field the schema cannot name", () => {
    expect(() =>
      projectForms([
        {
          id: "bad",
          source: "generic-form",
          pluginFormId: null,
          route: "/bad/",
          fields: [{ name: "not a name", type: "text" }],
          hiddenFields: [],
          submit: {
            action: "/x",
            method: "post",
            enctype: null,
            dataAttributes: {},
            extraInputNames: [],
            nonceFieldNames: [],
          },
          detection: {
            source: "generic-form",
            matched: "generic-form",
            evidence: [],
            formId: null,
            formIdFrom: null,
          },
        },
      ]),
    ).toThrow(/not a valid Site IR field name/);
  });
});

describe("the sidecar carries what the IR cannot", () => {
  it("records the per-route outcome for every captured page", () => {
    expect(sidecar.routes).toHaveLength(20);
    expect(sidecar.routes.filter((route) => route.status === "extracted")).toHaveLength(2);
  });

  it("reports the two pages with no form and why", () => {
    const absent = sidecar.routes.filter((route) => route.status === "absent");
    const reasons = absent.map((route) => `${route.route} ${route.reason ?? ""}`).join("\n");
    expect(absent.length).toBe(18);
    expect(reasons).toMatch(/\/mlm\/applym\/ .*empty Divi code module/);
    expect(reasons).toMatch(/\/ush\/thanks\/ /);
    expect(reasons).not.toMatch(/\/tmh\/apply\//);
  });

  it("never records a route as a form because it carries a search box", () => {
    const searchRoutes = sidecar.routes.filter((route) => route.status === "absent");
    expect(searchRoutes.every((route) => route.formId === undefined)).toBe(true);
  });

  it("names every schema gap it hit, and each one is a real omission", () => {
    expect(sidecar.schemaGaps.length).toBeGreaterThanOrEqual(6);
    const gaps = sidecar.schemaGaps.join("\n");
    for (const gap of ["form id", "conditional", "accept", "dateFormat", "single route"]) {
      expect(gaps).toContain(gap);
    }
  });

  it("keeps the plugin's own form id, which the IR has no field for", () => {
    for (const form of sidecar.forms) {
      expect(form["pluginFormId"]).toBe("3");
    }
  });

  it("keeps conditional rules, upload limits and dates out of the IR but in the sidecar", () => {
    for (const form of sidecar.forms) {
      expect(Array.isArray(form["fields"])).toBe(true);
      const fields = form["fields"] as Array<Record<string, unknown>>;
      expect(fields.some((field) => field["dateFormat"] === "d/m/Y")).toBe(true);
    }
  });

  it("states that nonce values are not recorded", () => {
    expect(sidecar.note).toMatch(/Nonce\/hidden security fields are listed by NAME/);
    expect(sidecar.note).toMatch(/never recorded/);
  });

  it("carries no security token value", () => {
    expect(securityValuesIn(sidecarText)).toEqual([]);
    expect(securityValuesIn(irText)).toEqual([]);
    expect(sidecarText).not.toContain("dummyvalue1234567890");
  });
});

describe("the operator's open question: file uploads", () => {
  it("answers no, from the data", () => {
    expect(sidecar.fileUpload.any).toBe(false);
    expect(sidecar.fileUpload.forms).toEqual([]);
    expect(sidecar.fileUpload.fields).toEqual([]);
  });

  it("says so in the CLI output, with the reason it matters", () => {
    const verdict = formatFileUploadVerdict(built.forms);
    expect(verdict).toContain("NO form has a file-upload field");
    expect(verdict).toContain("Google Sheets can store a URL, not a file");
  });

  it("would say yes if a form had one", () => {
    const base = built.forms[0];
    if (base === undefined) throw new Error("expected an extracted form");
    const withUpload = {
      ...base,
      fields: [...base.fields, { name: "cv", type: "file" as const }],
    };
    expect(formatFileUploadVerdict([withUpload])).toContain("file upload: 1 form(s) accept a file");
  });
});

describe("the printed table", () => {
  it("reports id, route, field count, types, required count and file upload", () => {
    const table = formatFormTable(built.forms);
    const lines = table.split("\n");
    expect(lines[0]).toContain("form id");
    expect(lines[0]).toContain("file upload");
    expect(lines[1]).toContain("fluent-form-3");
    expect(lines[1]).toContain("/tmh/apply/");
    expect(lines[1]).toContain("15");
    expect(lines[1]).toContain("no");
    expect(lines[2]).toContain("/?fluent-form=3");
  });
});
