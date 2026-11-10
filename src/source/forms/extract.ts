/**
 * The form extractor — one captured document in, one Form IR (or an honest
 * non-answer) out.
 *
 * It never fetches. Everything it needs is in the document it is given, plus an
 * optional resolver for the one case a document cannot answer for itself: a
 * Fluent Forms conversational mount, whose fields are built by script and are
 * therefore absent from a normalised capture. The resolver is passed in (rather
 * than read from disk here) so the extraction logic stays a pure function and the
 * caller owns provenance.
 *
 * The three outcomes are deliberately different, because collapsing them is how a
 * conversion quietly loses a form:
 *
 *  - `extracted` — markup matched and fields were read.
 *  - `fields-unavailable` — a form is definitely there and its fields are
 *    definitely not in this document (a conversational mount). Distinct from
 *    "no form": the emit step must mount something.
 *  - `absent` — no application form on this page, with the reason (a Divi search
 *    box is not a form to convert; an empty `<form>` is a defect worth naming).
 */

import type { FormValidation } from "../../schema/site-ir.js";
import { dataAttributes, elementBlocks, withoutComments } from "./html.js";
import { detectConversationalMount, detectFormElement, isSiteSearch } from "./detect.js";
import {
  formFromConversationalConfig,
  parseFluentGlobalConfig,
  submitFromFormElement,
} from "./fluent.js";
import type { FluentGlobalConfig } from "./fluent.js";
import { parseFormFields } from "./generic.js";
import type {
  Detection,
  ExtractedField,
  ExtractedForm,
  FormAbsence,
  FormExtraction,
  FieldsUnavailable,
  SubmitConfiguration,
} from "./types.js";

export interface ConversationalResolver {
  /** The config object, already parsed. */
  global: FluentGlobalConfig;
  /** Route the config was read from, recorded as provenance. */
  configRoute: string;
  /** True when this config was proven equivalent to the route's own render. */
  verifiedIdentical?: boolean;
}

export interface ExtractOptions {
  /** Captured route, faithfully: may include a query string. */
  route: string;
  /** IR slug to use for an extracted form. Required: naming is the caller's job. */
  id?: string;
  title?: string;
  /** Resolve the field set for a conversational mount by plugin form id. */
  resolveConversational?: (formId: string | null) => ConversationalResolver | null;
  /**
   * Override the resolver's config for this route, when the document *is* the
   * conversational render and carries its own `fluent_forms_global_var`.
   */
  useOwnConversationalConfig?: boolean;
}

/** Lowercase slug of a route, used when a caller has not named the form itself. */
export function slugifyRoute(route: string): string {
  const slug = route
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "root" : slug;
}

function absent(route: string, reason: string, rejected?: FormAbsence["rejected"]): FormExtraction {
  const result: FormAbsence = { route, reason };
  if (rejected !== undefined) result.rejected = rejected;
  return { status: "absent", result };
}

/** Every `<form>` element on the page, classified. */
interface ClassifiedForm {
  openingTag: string;
  attributes: Record<string, string>;
  inner: string;
  detection: Detection | null;
  search: boolean;
}

function classifyForms(document: string): ClassifiedForm[] {
  return elementBlocks(document, "form")
    .filter((block) => block.closed)
    .map((block) => ({
      openingTag: block.openingTag,
      attributes: block.attributes,
      inner: block.inner,
      detection: detectFormElement(block.openingTag, block.attributes, block.inner),
      search: isSiteSearch(block.attributes, block.inner),
    }));
}

/**
 * Extract every form the document actually carries.
 *
 * A page may hold several `<form>` elements (two WordPress search boxes on
 * `/ush/owner/`), so the return is a list. Order is: the Fluent Forms form first
 * when there is one, because that is the submission contract this conversion
 * exists to preserve; search boxes and empty forms are reported after it.
 */
export function extractForms(html: string, options: ExtractOptions): FormExtraction[] {
  const document = withoutComments(html);
  const results: FormExtraction[] = [];
  const forms = classifyForms(document);
  const applicationForms = forms.filter((form) => !form.search);

  for (const form of forms) {
    if (!form.search) continue;
    results.push(
      absent(
        options.route,
        "site search box (role=search / single ?s= field), not an application form",
        "site-search",
      ),
    );
  }

  const fluentForms = applicationForms.filter((form) => form.detection?.source === "fluent-forms");
  const genericForms = applicationForms.filter((form) => form.detection === null);

  if (fluentForms.length > 0) {
    for (const form of fluentForms) {
      if (form.detection === null) continue;
      const parsed = parseFormFields(form.inner);
      for (const control of parsed.unmapped) {
        results.push(absent(options.route, `unmapped control ${control.name}: ${control.reason}`));
      }
      if (parsed.fields.length === 0) {
        results.push(
          absent(options.route, "Fluent Forms markup matched but carried no fields", "no-fields"),
        );
        continue;
      }
      const submit = submitFromFormElement(
        form.attributes,
        dataAttributes(form.attributes),
        parsed.hiddenFields,
      );
      results.push({
        status: "extracted",
        form: buildForm(options, form.detection, parsed.fields, parsed.hiddenFields, submit),
      });
    }
    return results;
  }

  // A conversational mount has no `<form>` element at all: the wrapper is a div and
  // the fields are script-built. Identity survives the capture; the fields do not.
  const mount = detectConversationalMount(document);
  if (mount !== null) {
    const ownConfig =
      options.useOwnConversationalConfig === false ? null : parseFluentGlobalConfig(document);
    const resolved =
      ownConfig !== null
        ? { global: ownConfig, configRoute: options.route }
        : (options.resolveConversational?.(mount.detection.formId) ?? null);

    if (resolved === null) {
      const unavailable: FieldsUnavailable = {
        route: options.route,
        source: "fluent-forms",
        pluginFormId: mount.detection.formId,
        reason:
          "Fluent Forms conversational mount: the fields are built by script, and the capture strips scripts. No recorded config exists for this form id.",
        detection: mount.detection,
      };
      results.push({ status: "fields-unavailable", result: unavailable });
      return results;
    }

    const built = formFromConversationalConfig(resolved.global, {
      route: options.route,
      id: options.id ?? `fluent-form-${mount.detection.formId ?? "unknown"}`,
      detection: mount.detection,
      configRoute: resolved.configRoute,
      ...(options.title === undefined ? {} : { title: options.title }),
    });
    if (built === null) {
      results.push({
        status: "fields-unavailable",
        result: {
          route: options.route,
          source: "fluent-forms",
          pluginFormId: mount.detection.formId,
          reason: `recorded config at ${resolved.configRoute} has no form.questions`,
          detection: mount.detection,
        },
      });
      return results;
    }
    results.push({ status: "extracted", form: built.form });
    return results;
  }

  for (const form of genericForms) {
    const parsed = parseFormFields(form.inner);
    for (const control of parsed.unmapped) {
      results.push(absent(options.route, `unmapped control ${control.name}: ${control.reason}`));
    }
    const dataFields = parsed.fields.filter((field) => field.type !== "hidden");
    if (dataFields.length === 0) {
      results.push(
        absent(
          options.route,
          "a <form> is present but carries no visible data fields",
          "no-fields",
        ),
      );
      continue;
    }
    const submit = submitFromFormElement(
      form.attributes,
      dataAttributes(form.attributes),
      parsed.hiddenFields,
    );
    results.push({
      status: "extracted",
      form: buildForm(
        options,
        {
          source: "generic-form",
          matched: "generic-form",
          evidence: [`<form ${form.openingTag.slice(1, 60)}`],
          formId: null,
          formIdFrom: null,
        },
        parsed.fields,
        parsed.hiddenFields,
        submit,
      ),
    });
  }

  if (results.length === 0) {
    // A page can carry the *container* for a form and still hold no form: `/mlm/applym/`
    // has an empty Divi code module, so the form is either injected client-side or the
    // render produced nothing. That is a different defect from "no form here", and the
    // reason should say which one the document shows.
    const emptyCodeModule =
      /<div[^>]*class="[^"]*\bet_pb_code\b[^"]*"[^>]*>\s*<\/div>/i.test(document) ||
      /<div[^>]*class="[^"]*\bet_pb_code_inner\b[^"]*"[^>]*>\s*<\/div>/i.test(document);
    results.push(
      absent(
        options.route,
        emptyCodeModule
          ? "no <form> element and no recognised form markup; the page carries an empty Divi code module where the form would be embedded"
          : "no <form> element and no recognised form markup",
      ),
    );
  }
  return results;
}

function buildForm(
  options: ExtractOptions,
  detection: Detection,
  fields: ExtractedForm["fields"],
  hiddenFields: ExtractedForm["hiddenFields"],
  submit: SubmitConfiguration,
): ExtractedForm {
  const form: ExtractedForm = {
    id: options.id ?? `${detection.source}-${slugifyRoute(options.route)}`,
    source: detection.source,
    pluginFormId: detection.formId,
    route: options.route,
    fields,
    hiddenFields,
    submit,
    detection,
  };
  if (options.title !== undefined) form.title = options.title;
  const spam = spamFrom(fields);
  if (spam !== undefined) form.validation = spam;
  return form;
}

function spamFrom(fields: readonly ExtractedField[]): FormValidation | undefined {
  const spam: Array<"honeypot" | "turnstile"> = [];
  if (fields.some((field) => field.type === "honeypot")) spam.push("honeypot");
  if (fields.some((field) => field.type === "turnstile")) spam.push("turnstile");
  return spam.length === 0 ? undefined : { spam };
}

/** Convenience for callers that expect at most one form: the first, or the reason. */
export function extractForm(html: string, options: ExtractOptions): FormExtraction {
  const results = extractForms(html, options);
  const extracted = results.find((result) => result.status === "extracted");
  if (extracted !== undefined) return extracted;
  const unavailable = results.find((result) => result.status === "fields-unavailable");
  if (unavailable !== undefined) return unavailable;
  return (
    results[0] ?? { status: "absent", result: { route: options.route, reason: "no form markup" } }
  );
}

/** True when any extracted form accepts a file upload. */
export function hasFileUpload(form: ExtractedForm): boolean {
  return form.fields.some((field) => field.type === "file");
}

/** Count of fields a visitor must fill in. */
export function requiredCount(form: ExtractedForm): number {
  return form.fields.filter((field) => field.required === true).length;
}

/** Distinct field types in first-appearance order, for the CLI table. */
export function fieldTypes(form: ExtractedForm): string[] {
  return [...new Set(form.fields.map((field) => field.type))];
}
