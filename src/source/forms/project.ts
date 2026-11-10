/**
 * Projection from extraction to artifact.
 *
 * Two destinations, and the split is the point:
 *
 *  - `capture/site-ir.json` gets a **schema-conformant** `forms[]` plus the
 *    `apiContracts[]` its `submitContract.endpointRef` must resolve against. The
 *    schema forbids unknown properties, so anything it cannot express is left out
 *    — the projection narrows, it never widens the schema.
 *  - `capture/forms.json` gets **everything**: the plugin's own form id, the
 *    render mode, nonce field names (never values), visibility rules, upload
 *    limits, controls the IR has no type for, and the per-route outcome including
 *    the pages where no form was found.
 *
 * Neither destination is allowed to invent a value. A field name the schema's
 * pattern would reject is a hard error here, not a silently skipped field: an
 * emitted form missing one input submits a different envelope than the source.
 */

import type { ApiContract, Form, FormField } from "../../schema/site-ir.js";
import type { FormAbsence, FormExtraction, ExtractedForm, FieldsUnavailable } from "./types.js";

/** The Site IR subset, plus the wire contracts its forms point at. */
export interface FormProjection {
  forms: Form[];
  apiContracts: ApiContract[];
}

/** Everything the IR cannot hold, plus the reasons it cannot. */
export interface FormSidecar {
  generatedBy: string;
  baseUrl: string;
  capturedAt: string;
  note: string;
  schemaGaps: string[];
  forms: ExtractedForm[];
  routes: RouteOutcome[];
  fileUpload: FileUploadSummary;
  submitEndpoints: ApiContract[];
}

export interface RouteOutcome {
  route: string;
  status: "extracted" | "fields-unavailable" | "absent";
  formId?: string;
  reason?: string;
  rejected?: string;
  detection?: string;
}

export interface FileUploadSummary {
  any: boolean;
  forms: string[];
  fields: Array<{ form: string; name: string; accept?: string; maxSizeBytes?: number }>;
}

/** Schema-valid field names only. A rejection here is a defect, not a skip. */
const FIELD_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.[\]-]*$/;

function toIrField(formId: string, field: ExtractedForm["fields"][number]): FormField {
  if (!FIELD_NAME_PATTERN.test(field.name)) {
    throw new Error(
      `form ${formId}: field name "${field.name}" is not a valid Site IR field name; refusing to emit a partial form`,
    );
  }
  const projected: FormField = { name: field.name, type: field.type };
  if (field.label !== undefined) projected.label = field.label;
  if (field.placeholder !== undefined) projected.placeholder = field.placeholder;
  if (field.required !== undefined) projected.required = field.required;
  if (field.multiple === true) projected.multiple = true;
  if (field.defaultValue !== undefined) projected.defaultValue = field.defaultValue;
  if (field.options !== undefined && field.options.length > 0) {
    projected.options = field.options.map((option) => ({
      label: option.label,
      value: option.value,
    }));
  }
  if (field.validation !== undefined) projected.validation = { ...field.validation };
  return projected;
}

/** Stable id for the wire contract a form posts to. */
export function contractIdFor(form: ExtractedForm): string {
  if (form.source === "fluent-forms") return "fluentform-submit";
  return `${form.id}-submit`;
}

function contractFor(form: ExtractedForm): ApiContract {
  const url = form.submit.action ?? form.submit.ajaxUrl ?? form.route;
  const requestShape: Record<string, unknown> = {
    ...(form.submit.method === null ? {} : { method: form.submit.method }),
    ...(form.submit.enctype === null ? {} : { enctype: form.submit.enctype }),
    ...(form.submit.renderMode === undefined ? {} : { renderMode: form.submit.renderMode }),
    fields: form.fields.map((field) => ({ name: field.name, type: field.type })),
    ...(form.submit.extraInputNames.length === 0
      ? {}
      : { extraInputNames: form.submit.extraInputNames }),
    ...(form.submit.nonceFieldNames.length === 0
      ? {}
      : { nonceFieldNames: form.submit.nonceFieldNames }),
  };

  const notes = [
    form.source === "fluent-forms"
      ? "Captured Fluent Forms submission. Fluent Forms is PHP and does not survive the conversion; this is the wire contract the replacement must honour."
      : "Captured HTML form submission; the replacement sink must accept the same field names.",
    "Nonce values are session-bound and are deliberately not recorded; every nonce the source requires is a Pages Function concern, not an IR value.",
    form.source === "fluent-forms"
      ? "Target sink is Pabbly (form island -> Pages Function -> POST -> Pabbly -> Google Sheets). The Pabbly URL is a Function secret and never appears in the IR."
      : "Target sink is decided by the sink bead, not here.",
    ...(form.submit.notes ?? []),
  ];

  const contract: ApiContract = {
    id: contractIdFor(form),
    method: form.submit.method?.toUpperCase() === "GET" ? "GET" : "POST",
    url,
    requestShape,
    notes: notes.join(" "),
  };
  return contract;
}

/**
 * Build the IR's `forms[]` and the `apiContracts[]` its `submitContract`s need.
 *
 * `forms` are emitted in the order given; the caller sorts, because ordering is a
 * presentation choice and this function should not hide one behind its own.
 */
export function projectForms(extracted: readonly ExtractedForm[]): FormProjection {
  const forms: Form[] = [];
  const contracts = new Map<string, ApiContract>();

  for (const form of extracted) {
    const spam = form.validation?.spam ?? [];
    const projected: Form = {
      id: form.id,
      source: form.source,
      page: form.route,
      fields: form.fields.map((field) => toIrField(form.id, field)),
      submitContract: {
        sink: "pabbly",
        endpointRef: contractIdFor(form),
        honeypot:
          spam.includes("honeypot") || form.fields.some((field) => field.type === "honeypot"),
        turnstile:
          spam.includes("turnstile") || form.fields.some((field) => field.type === "turnstile"),
      },
    };
    if (form.title !== undefined) projected.title = form.title;
    if (form.validation !== undefined) projected.validation = { ...form.validation };
    forms.push(projected);
    contracts.set(contractIdFor(form), contractFor(form));
  }

  return { forms, apiContracts: [...contracts.values()] };
}

/** The sidecar: every measured fact the IR has no field for, named as such. */
export function buildSidecar(options: {
  baseUrl: string;
  capturedAt: string;
  extractions: readonly FormExtraction[];
  forms: readonly ExtractedForm[];
  contracts: readonly ApiContract[];
  schemaGaps?: readonly string[];
}): FormSidecar {
  const routes: RouteOutcome[] = [];
  const seen = new Set<string>();
  const record = (outcome: RouteOutcome): void => {
    // Two search boxes on one page are one fact about that page, not two rows.
    const key = `${outcome.route}\u0000${outcome.status}\u0000${outcome.reason ?? ""}\u0000${outcome.formId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push(outcome);
  };

  for (const extraction of options.extractions) {
    if (extraction.status === "extracted") {
      record({
        route: extraction.form.route,
        status: "extracted",
        formId: extraction.form.id,
        detection: `${extraction.form.source} (${extraction.form.detection.matched})`,
      });
      continue;
    }
    if (extraction.status === "fields-unavailable") {
      const unavailable: FieldsUnavailable = extraction.result;
      record({
        route: unavailable.route,
        status: "fields-unavailable",
        reason: unavailable.reason,
        detection: `${unavailable.source} (${unavailable.detection.matched})`,
      });
      continue;
    }
    const absence: FormAbsence = extraction.result;
    record({
      route: absence.route,
      status: "absent",
      reason: absence.reason,
      ...(absence.rejected === undefined ? {} : { rejected: absence.rejected }),
    });
  }

  const uploadFields: FileUploadSummary["fields"] = [];
  for (const form of options.forms) {
    for (const field of form.fields) {
      if (field.type !== "file") continue;
      uploadFields.push({
        form: form.id,
        name: field.name,
        ...(field.file?.accept === undefined ? {} : { accept: field.file.accept }),
        ...(field.file?.maxSizeBytes === undefined
          ? {}
          : { maxSizeBytes: field.file.maxSizeBytes }),
      });
    }
  }

  return {
    generatedBy: "capture:forms",
    baseUrl: options.baseUrl,
    capturedAt: options.capturedAt,
    note: "Sidecar: form facts the Site IR v1.1 form shape cannot hold. `capture/site-ir.json` carries only the schema-conformant projection; this file is the evidence behind it. Nonce/hidden security fields are listed by NAME with valueRecorded=false; their values are session-bound and never recorded.",
    schemaGaps: [
      ...(options.schemaGaps ?? []),
      "`form` has no field for the plugin's own form id (Fluent Forms id 3): it is carried in `id`/`title` here and in the sidecar.",
      "`formField` has no `conditional` field, so visibility rules (`conditional_logics`) are recorded here only.",
      "`formField.validation` has no `accept`/`maxFileSize`, so upload limits are recorded here only.",
      "`formField` has no `dateFormat`, so a date input's mask is recorded here only.",
      "`formField` has no `parentName`, so a sub-field (first_name inside the `names` element) cannot say what it belongs to in the IR.",
      "`form.page` is a single route: a form rendered on more than one route (and a conversational mount whose fields are only visible on the query-string render) cannot be expressed as one entry.",
    ],
    forms: [...options.forms],
    routes,
    fileUpload: {
      any: uploadFields.length > 0,
      forms: [...new Set(uploadFields.map((field) => field.form))],
      fields: uploadFields,
    },
    submitEndpoints: [...options.contracts],
  };
}
