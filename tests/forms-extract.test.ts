/**
 * Form extraction (P4.1a) - the Form IR the conversion must preserve.
 *
 * What is protected here, in descending order of importance:
 *
 *  1. **A form is never invented.** A page with no form markup yields `absent`
 *     with a reason; a `null`-shaped answer, not an empty form. This is the
 *     negative case the bead asked for, and it is checked twice: once on a
 *     synthetic page and once on every real captured page that has no form.
 *  2. **A site search box is not an application form.** All 19 captured pages
 *     carry a Divi `et-search-form` and three carry a second WordPress search
 *     block. Treating those as forms would report 22 phantom forms and bury the
 *     two real ones.
 *  3. **The real form's field set is exactly what the plugin publishes.** 14
 *     questions become 15 fields (the name element expands to two), 12 required,
 *     and the submitted names are the plugin's own (`input_text_1`, `fbclid`, …
 *     preserved byte-for-byte because the sink envelope is keyed on them).
 *  4. **Session tokens are named, never valued.** The recorded render has a live
 *     nonce; the extractor must produce its NAME and must not reproduce the value
 *     anywhere in its output.
 *  5. **The standard markup path covers every field type the IR can hold**, plus
 *     the two it cannot (`password`, `time`) which must be reported, not
 *     coerced.
 *
 * Everything runs against recorded evidence on disk: the capture, the polite
 * fetch of `/?fluent-form=3` recorded in `tests/fixtures/forms/`, and one
 * synthetic standard-markup form. No network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseFluentGlobalConfig } from "../src/source/forms/fluent.js";
import {
  extractForm,
  extractForms,
  fieldTypes,
  hasFileUpload,
  requiredCount,
  slugifyRoute,
} from "../src/source/forms/extract.js";
import type { ExtractOptions } from "../src/source/forms/extract.js";
import {
  readRecordingIndex,
  redactSecurityTokens,
  securityValuesIn,
  sha256,
} from "../src/source/forms/recordings.js";
import { resolverFromRecordings } from "../src/source/forms/cli.js";
import type { ExtractedForm } from "../src/source/forms/types.js";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FIXTURES = join(ROOT, "tests/fixtures/forms");

const ir = JSON.parse(readFileSync(join(ROOT, "capture/site-ir.json"), "utf8")) as {
  pages: Array<{ url: string; dom: { html: string } }>;
};

const index = readRecordingIndex(join(FIXTURES, "recordings.json"));
const resolver = resolverFromRecordings(index, ROOT);

function pageHtml(route: string): string {
  const page = ir.pages.find((candidate) => candidate.url === route);
  if (page === undefined) throw new Error(`capture has no page ${route}`);
  return page.dom.html;
}

function recordingHtml(route: string): string {
  const render = index.renders.find((candidate) => candidate.route === route);
  if (render === undefined) throw new Error(`no recording for ${route}`);
  return readFileSync(join(ROOT, render.path), "utf8");
}

function extracted(results: ReturnType<typeof extractForms>): ExtractedForm[] {
  return results.filter((result) => result.status === "extracted").map((result) => result.form);
}

function options(route: string, extra: Partial<ExtractOptions> = {}): ExtractOptions {
  return { route, resolveConversational: resolver, ...extra };
}

/** Every string value in a structure, for the "no token leaked" assertion. */
function allStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const entry of value) allStrings(entry, into);
  else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) allStrings(entry, into);
  }
  return into;
}

describe("detection", () => {
  it("recognises the conversational mount on /tmh/apply/ as Fluent Forms", () => {
    const results = extractForms(pageHtml("/tmh/apply/"), options("/tmh/apply/"));
    const form = extracted(results)[0];
    expect(form).toBeDefined();
    expect(form?.source).toBe("fluent-forms");
    expect(form?.detection.matched).toBe("fluent-conversational-mount");
    expect(form?.pluginFormId).toBe("3");
    expect(form?.detection.evidence).toContain('class="frm-fluent-form"');
  });

  it("records where the plugin form id came from", () => {
    const results = extractForms(pageHtml("/tmh/apply/"), options("/tmh/apply/"));
    const form = extracted(results)[0];
    expect(form?.detection.formId).toBe("3");
    expect(form?.detection.formIdFrom).toBe("data-form_id");
  });

  it("reads the query-string render from its own embedded config", () => {
    const html = recordingHtml("/?fluent-form=3");
    const results = extractForms(html, { route: "/?fluent-form=3", id: "fluent-form-3-query" });
    const form = extracted(results)[0];
    expect(form?.source).toBe("fluent-forms");
    expect(form?.detection.matched).toBe("fluent-conversational-mount");
    expect(form?.submit.renderMode).toBe("conversational");
  });

  it("identifies standard Fluent Forms markup by its wrapper class and hidden nonce", () => {
    const html = readFileSync(join(FIXTURES, "fluent-standard.synthetic.html"), "utf8");
    const results = extractForms(html, { route: "/synthetic/" });
    const form = extracted(results)[0];
    expect(form?.source).toBe("fluent-forms");
    // The hidden nonce is the strongest signal, so it is the one reported.
    expect(form?.detection.matched).toBe("fluent-hidden-nonce");
    expect(form?.pluginFormId).toBe("9");
    expect(form?.detection.formIdFrom).toBe("hidden-nonce");
  });

  it("does not call a generic POST form Fluent Forms", () => {
    const html = `<form action="/contact" method="post">
      <input type="text" name="note" aria-required="true">
      <input type="submit" value="Send">
    </form>`;
    const form = extracted(extractForms(html, { route: "/contact/" }))[0];
    expect(form?.source).toBe("generic-form");
    expect(form?.detection.matched).toBe("generic-form");
  });
});

describe("no form markup means no form", () => {
  it("returns absent with a reason for a page with no form", () => {
    const html = readFileSync(join(FIXTURES, "no-form.html"), "utf8");
    const extraction = extractForm(html, { route: "/apply/" });
    expect(extraction.status).toBe("absent");
    if (extraction.status !== "absent") throw new Error("expected absent");
    expect(extraction.result.route).toBe("/apply/");
    expect(extraction.result.reason).toMatch(/no <form> element/);
    // And never an empty form dressed up as a finding.
    expect(JSON.stringify(extraction)).not.toContain('"fields":[]');
  });

  it("ignores a commented-out form", () => {
    const html =
      '<div><p>Apply below</p><!-- <form><input name="email" type="email"></form> --></div>';
    const extraction = extractForm(html, { route: "/apply/" });
    expect(extraction.status).toBe("absent");
  });

  it("treats a Divi search box as search, not an application form", () => {
    const results = extractForms(pageHtml("/care/"), options("/care/"));
    expect(extracted(results)).toHaveLength(0);
    const absence = results.find((result) => result.status === "absent");
    expect(absence?.status).toBe("absent");
    if (absence?.status !== "absent") throw new Error("expected absent");
    expect(absence.result.rejected).toBe("site-search");
  });

  it("reports every captured page without a form as absent, and only two pages have one", () => {
    const withForms = ir.pages
      .map((page) => ({
        route: page.url,
        forms: extracted(extractForms(page.dom.html, options(page.url))),
      }))
      .filter((entry) => entry.forms.length > 0);
    expect(withForms.map((entry) => entry.route)).toEqual(["/tmh/apply/"]);

    const absentPages = ir.pages.filter(
      (page) =>
        page.url !== "/tmh/apply/" &&
        extracted(extractForms(page.dom.html, options(page.url))).length === 0,
    );
    expect(absentPages).toHaveLength(18);
  });

  it("names the empty Divi code module on /mlm/applym/, which is where its form would be", () => {
    const results = extractForms(pageHtml("/mlm/applym/"), options("/mlm/applym/"));
    expect(extracted(results)).toHaveLength(0);
    const absence = results[0];
    if (absence?.status !== "absent") throw new Error("expected absent");
    expect(absence.result.reason).toMatch(/empty Divi code module/);
  });

  it("finds no form on the onboard/offboard pages, which hold only the search box", () => {
    // The bead's acceptance criterion assumed these pages carry forms. They do not:
    // measured, each has exactly one <form> - the Divi site search - and no other
    // input, textarea, select or empty code module at all.
    for (const route of ["/tmh/onboard-tmh/", "/tmh/offboard/", "/mlm/onboard-mlm/"]) {
      const results = extractForms(pageHtml(route), options(route));
      expect(extracted(results)).toHaveLength(0);
      const reasons = results
        .filter((result) => result.status === "absent")
        .map((result) => (result.status === "absent" ? result.result.reason : ""));
      expect(reasons.join("\n")).toMatch(/site search box/);
      expect(reasons.join("\n")).not.toMatch(/empty Divi code module/);
    }
  });
});

describe("the real form: Fluent Form 3", () => {
  const form = extracted(extractForms(pageHtml("/tmh/apply/"), options("/tmh/apply/")))[0];

  it("has the measured field set", () => {
    expect(form).toBeDefined();
    expect(form?.fields).toHaveLength(15);
    expect(requiredCount(form as ExtractedForm)).toBe(12);
    expect(fieldTypes(form as ExtractedForm)).toEqual([
      "text",
      "email",
      "select",
      "checkbox-group",
      "date",
      "hidden",
    ]);
  });

  it("preserves the submitted names exactly", () => {
    expect(form?.fields.map((field) => field.name)).toEqual([
      "first_name",
      "last_name",
      "input_text_1",
      "email",
      "dropdown_1",
      "checkbox",
      "checkbox_1",
      "dropdown_2",
      "dropdown_3",
      "datetime",
      "datetime_1",
      "dropdown_4",
      "dropdown",
      "fbclid",
      "gclid",
    ]);
  });

  it("expands the name element into two flat sub-fields and records the parent", () => {
    const first = form?.fields[0];
    expect(first?.name).toBe("first_name");
    expect(first?.parentName).toBe("names");
    expect(first?.label).toBe("First Name");
    expect(first?.required).toBe(true);
  });

  it("keeps select options and the plugin's placeholder", () => {
    const room = form?.fields.find((field) => field.name === "dropdown_1");
    expect(room?.type).toBe("select");
    expect(room?.placeholder).toBe("- Select -");
    expect(room?.options).toEqual([
      { label: "Vernon - Chrysocolla [$993]", value: "Vernon - Chrysocolla [$993]" },
    ]);
    const pets = form?.fields.find((field) => field.name === "checkbox_1");
    expect(pets?.type).toBe("checkbox-group");
    expect(pets?.options).toHaveLength(6);
  });

  it("records the date mask, which the IR has no field for", () => {
    const earliest = form?.fields.find((field) => field.name === "datetime");
    expect(earliest?.type).toBe("date");
    expect(earliest?.dateFormat).toBe("d/m/Y");
  });

  it("has no file-upload field", () => {
    expect(hasFileUpload(form as ExtractedForm)).toBe(false);
  });

  it("records the submit contract: admin-ajax POST, form 3, conversational", () => {
    expect(form?.submit.action).toBe("https://upscalehavens.ca/wp-admin/admin-ajax.php");
    expect(form?.submit.method).toBe("post");
    expect(form?.submit.renderMode).toBe("conversational");
    expect(form?.submit.restNamespace).toBe("fluentform");
    expect(form?.submit.extraInputNames).toContain("item_3__fluent_sf");
    expect(form?.validation?.spam).toContain("honeypot");
  });

  it("attributes the fields to /tmh/apply/ from the recorded query render, and says so", () => {
    expect(form?.route).toBe("/tmh/apply/");
    expect(form?.submit.notes?.some((note) => note.includes("/?fluent-form=3"))).toBe(true);
  });

  it("produces an identical field set from the query-string render", () => {
    const query = extracted(
      extractForms(recordingHtml("/?fluent-form=3"), {
        route: "/?fluent-form=3",
        id: "fluent-form-3-query",
      }),
    )[0];
    expect(query?.fields).toEqual(form?.fields);
  });

  it("reports fields-unavailable when no recorded config exists for the form id", () => {
    // The same mount, with resolution disabled: the mount is real, the fields are
    // not in the document, and the extractor must say that rather than emit an
    // empty form.
    const extraction = extractForm(pageHtml("/tmh/apply/"), { route: "/tmh/apply/" });
    expect(extraction.status).toBe("fields-unavailable");
    if (extraction.status !== "fields-unavailable") throw new Error("expected unavailable");
    expect(extraction.result.pluginFormId).toBe("3");
    expect(extraction.result.reason).toMatch(/fields are built by script/);
  });
});

describe("session tokens", () => {
  it("lists the nonce by name and never records its value", () => {
    const form = extracted(extractForms(pageHtml("/tmh/apply/"), options("/tmh/apply/")))[0];
    const nonce = form?.hiddenFields.find(
      (field) => field.name === "_fluentform_3_fluentformnonce",
    );
    expect(nonce).toEqual({
      name: "_fluentform_3_fluentformnonce",
      security: true,
      valueRecorded: false,
    });
    expect(form?.submit.nonceFieldNames).toEqual(["_fluentform_3_fluentformnonce"]);
    // No nonce field becomes a submitted form field.
    expect(form?.fields.some((field) => field.name === "_fluentform_3_fluentformnonce")).toBe(
      false,
    );
  });

  it("never emits a token VALUE from the recorded render", () => {
    const html = recordingHtml("/?fluent-form=3");
    const config = parseFluentGlobalConfig(html);
    expect(config).not.toBeNull();
    const form = extracted(
      extractForms(html, { route: "/?fluent-form=3", id: "fluent-form-3-query" }),
    )[0];
    const projected = allStrings(form).join("\n");
    // The recording is redacted, so any token-shaped value left in the document is
    // the one to prove absent from the extraction.
    expect(securityValuesIn(html)).toEqual([]);
    expect(projected).not.toContain("REDACTED");
    expect(projected).not.toContain("dummyvalue1234567890");
  });

  it("redacts a live-looking nonce in both config and input markup", () => {
    const html =
      '<input type="hidden" name="_fluentform_7_fluentformnonce" value="abc123">' +
      '<input value="def456" name="_fluentform_7_fluentformnonce">' +
      'var fluent_forms_global_var = {"nonce":"xyz789","form_id":7};';
    const redacted = redactSecurityTokens(html);
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("def456");
    expect(redacted).not.toContain("xyz789");
    expect(securityValuesIn(html).sort()).toEqual(["abc123", "def456", "xyz789"]);
    expect(securityValuesIn(redacted)).toEqual([]);
  });
});

describe("standard markup with every field type", () => {
  const html = readFileSync(join(FIXTURES, "fluent-standard.synthetic.html"), "utf8");
  const form = extracted(extractForms(html, { route: "/synthetic/", id: "synthetic" }))[0] as
    ExtractedForm | undefined;

  it("extracts one form", () => {
    expect(form).toBeDefined();
  });

  it("maps every type the IR can hold", () => {
    expect(fieldTypes(form as ExtractedForm)).toEqual([
      "text",
      "email",
      "tel",
      "url",
      "number",
      "date",
      "textarea",
      "select",
      "radio",
      "checkbox-group",
      "checkbox",
      "file",
      "honeypot",
      "turnstile",
    ]);
  });

  it("reads labels by for=, required flags and placeholders", () => {
    const name = form?.fields.find((field) => field.name === "input_text");
    expect(name?.label).toBe("Full name");
    expect(name?.placeholder).toBe("Enter your full name");
    expect(name?.required).toBe(true);
  });

  it("reads validation attributes", () => {
    const name = form?.fields.find((field) => field.name === "input_text");
    expect(name?.validation).toEqual({
      pattern: "[A-Za-z .'-]+",
      minLength: 2,
      maxLength: 80,
      message: "Letters, spaces, apostrophes and hyphens only",
    });
    const count = form?.fields.find((field) => field.name === "input_number");
    expect(count?.validation).toEqual({ min: 1, max: 12 });
    expect(count?.defaultValue).toBe("2");
  });

  it("groups repeated names into choice fields and labels each option", () => {
    const radio = form?.fields.find((field) => field.name === "input_radio");
    expect(radio?.type).toBe("radio");
    expect(radio?.options).toEqual([
      { label: "Yes", value: "Yes" },
      { label: "No", value: "No" },
    ]);
    const amenities = form?.fields.find((field) => field.name === "input_checkbox[]");
    expect(amenities?.type).toBe("checkbox-group");
    expect(amenities?.options).toEqual([
      { label: "In-suite laundry", value: "laundry" },
      { label: "Gigabit internet", value: "internet" },
    ]);
    const single = form?.fields.find((field) => field.name === "single_checkbox");
    expect(single?.type).toBe("checkbox");
    expect(single?.options).toEqual([{ label: "I agree to the house rules", value: "1" }]);
  });

  it("separates the select placeholder from its options", () => {
    const dropdown = form?.fields.find((field) => field.name === "dropdown");
    expect(dropdown?.placeholder).toBe("- Select -");
    expect(dropdown?.options).toEqual([
      { label: "Room A — $900", value: "room-a" },
      { label: "Room B — $1,100", value: "room-b" },
    ]);
  });

  it("records upload constraints, which the IR cannot hold", () => {
    const upload = form?.fields.find((field) => field.name === "input_file");
    expect(upload?.type).toBe("file");
    expect(upload?.file).toEqual({
      accept: ".pdf,.jpg,.png",
      maxSizeBytes: 3 * 1024 * 1024,
      maxSizeRaw: "3",
    });
    expect(hasFileUpload(form as ExtractedForm)).toBe(true);
  });

  it("records conditional visibility, which the IR cannot hold", () => {
    const employer = form?.fields.find((field) => field.name === "employer");
    expect(employer?.conditional).toEqual({
      match: "any",
      rules: [{ field: "input_radio", operator: "==", value: "Yes" }],
      raw: '{"match":"any","conditions":[{"field":"input_radio","operator":"==","value":"Yes"}]}',
    });
    // And an unconditioned field carries no rule.
    expect(form?.fields.find((field) => field.name === "input_email")?.conditional).toBeUndefined();
  });

  it("reports controls it cannot express instead of coercing them", () => {
    expect(form?.fields.some((field) => field.name === "input_password")).toBe(false);
    expect(form?.fields.some((field) => field.name === "input_time")).toBe(false);
    const results = extractForms(html, { route: "/synthetic/" });
    const reasons = results
      .filter((result) => result.status === "absent")
      .map((result) => (result.status === "absent" ? result.result.reason : ""));
    expect(reasons.join("\n")).toMatch(/input_password: input type="password"/);
    expect(reasons.join("\n")).toMatch(/input_time: input type="time"/);
  });

  it("detects every security field and none of their values", () => {
    expect(form?.hiddenFields).toEqual([
      { name: "__fluent_form_embded_post_id", security: false, valueRecorded: false },
      { name: "_fluentform_9_fluentformnonce", security: true, valueRecorded: false },
      { name: "_wp_http_referer", security: false, valueRecorded: false },
      { name: "item_9__fluent_sf", security: false, valueRecorded: false },
    ]);
    expect(allStrings(form).join("\n")).not.toContain("dummyvalue1234567890");
  });

  it("marks the honeypot and turnstile spam protection", () => {
    expect(form?.fields.some((field) => field.type === "honeypot")).toBe(true);
    expect(form?.fields.some((field) => field.type === "turnstile")).toBe(true);
    expect(form?.validation?.spam).toEqual(["honeypot", "turnstile"]);
  });

  it("keeps the form's own submit configuration", () => {
    expect(form?.submit.method).toBe("post");
    expect(form?.submit.enctype).toBe("multipart/form-data");
    expect(form?.submit.renderMode).toBe("standard");
    expect(form?.submit.notes?.some((note) => note.includes("file upload"))).toBe(true);
  });
});

describe("recordings", () => {
  it("records the query render with its query string intact", () => {
    expect(index.renders.map((render) => render.route)).toEqual(["/?fluent-form=3"]);
    expect(index.minIntervalMs).toBeGreaterThanOrEqual(600);
    expect(index.requests).toBeGreaterThan(0);
  });

  it("proves the mount page and the query render serve the same question set", () => {
    expect(index.comparison).not.toBeNull();
    expect(index.comparison?.identical).toBe(true);
    expect(index.comparison?.mountRoute).toBe("/tmh/apply/");
    expect(index.comparison?.questions).toBe(14);
    expect(index.comparison?.mountQuestionsSha256).toBe(index.renders[0]?.questionsSha256);
  });

  it("has a digest that still matches the stored bytes", () => {
    for (const render of index.renders) {
      const html = readFileSync(join(ROOT, render.path), "utf8");
      expect(sha256(html)).toBe(render.sha256);
      expect(Buffer.byteLength(html, "utf8")).toBe(render.bytes);
    }
  });

  it("slugifies a route deterministically", () => {
    expect(slugifyRoute("/tmh/apply/")).toBe("tmh-apply");
    expect(slugifyRoute("/?fluent-form=3")).toBe("fluent-form-3");
    expect(slugifyRoute("/")).toBe("root");
  });
});
