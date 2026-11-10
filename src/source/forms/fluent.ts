/**
 * Fluent Forms extraction — the plugin's own shapes, not a guess at them.
 *
 * Fluent Forms (6.2.17 on this site) renders in two very different ways, and the
 * difference is the whole reason this module exists:
 *
 *  - **Standard** markup: a real `<form class="frm-fluent-form fluent_form_3">`
 *    with every input in the document. Ordinary HTML; parsed by `generic.ts`.
 *  - **Conversational** markup (`ffc_conv_wrapper`): an **empty mount** —
 *    `<div data-var_name="fluent_forms_global_var_1" id="ffc_app_instance_1">` —
 *    and the fields arrive only after the app boots. `/tmh/apply/` is this shape.
 *
 * A capture normalises scripts away (see `wp-rest/dom.ts`), so a conversational
 * page keeps the form's identity and loses its fields. That is not a gap this
 * module may paper over by inventing fields; it resolves them from the plugin's
 * own published config, which the same form serves on its query-string render
 * (`/?fluent-form=3`), and records the resolution as evidence.
 *
 * The config is the authority for the conversational shape. It carries
 * `form.questions[]` — id, title, type, `ff_input_type`, placeholder, required,
 * `validationRules`, `options`, `conditional_logics` and, for the name element,
 * nested `fields[]`. It also carries the submit contract: `ajaxurl`, `nonce` and
 * the `extra_inputs` the app posts alongside the answers. `nonce` values are
 * **never** copied out — the names are, with `valueRecorded: false`.
 */

import type { FormFieldOption, FormFieldType } from "../../schema/site-ir.js";
import { conditionalFromJson } from "./generic.js";
import type {
  ConditionalLogic,
  Detection,
  ExtractedField,
  ExtractedForm,
  HiddenFieldRecord,
  SubmitConfiguration,
} from "./types.js";

/** The JS global Fluent Forms marks its conversational mount with. */
const GLOBAL_VAR_PATTERN = /\bvar\s+(fluent_forms_global_var(?:_\d+)?)\s*=\s*/;

export interface FluentGlobalConfig {
  /** The variable name the mount references (`fluent_forms_global_var_1`). */
  varName: string;
  /** The parsed object. */
  config: Record<string, unknown>;
  /** Byte length of the JSON, so a recording can be checked for truncation. */
  jsonLength: number;
}

/**
 * Extract `var fluent_forms_global_var[_n] = {…};` from a document.
 *
 * Brace matching rather than a regex on `};` because the JSON contains nested
 * objects and escaped braces inside strings. A regex would truncate silently,
 * and a truncated config yields a form with missing questions — the exact defect
 * this extractor is supposed to prevent.
 */
export function parseFluentGlobalConfig(html: string): FluentGlobalConfig | null {
  const marker = GLOBAL_VAR_PATTERN.exec(html);
  if (marker === null || marker.index === undefined) return null;
  const varName = marker[1];
  if (varName === undefined) return null;

  const start = marker.index + marker[0].length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) return null;

  const json = html.slice(start, end);
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { varName, config: parsed as Record<string, unknown>, jsonLength: json.length };
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** Fluent's `validationRules` is sometimes an object and sometimes an array. */
function validationRuleMap(value: unknown): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  const record = asRecord(value);
  if (record !== null) {
    for (const [key, rule] of Object.entries(record)) {
      const asObject = asRecord(rule);
      result[key] = asObject ?? { value: rule };
    }
    return result;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const rule = asRecord(entry);
      if (rule === null) continue;
      const name = asString(rule["rule"]) ?? asString(rule["name"]);
      if (name !== undefined) result[name] = rule;
    }
  }
  return result;
}

/** Mini rule object → the five validation fields Site IR v1.1 can hold. */
function validationFromRules(
  rules: Record<string, Record<string, unknown>>,
): ExtractedField["validation"] | undefined {
  const validation: NonNullable<ExtractedField["validation"]> = {};
  const message =
    asString(rules["required"]?.["message"]) ??
    asString(rules["min"]?.["message"]) ??
    asString(rules["max"]?.["message"]);

  const min = asNumber(rules["min"]?.["value"]);
  if (min !== undefined) validation.min = min;
  const max = asNumber(rules["max"]?.["value"]);
  if (max !== undefined) validation.max = max;
  const minLength = asNumber(rules["min_length"]?.["value"]);
  if (minLength !== undefined) validation.minLength = minLength;
  const maxLength = asNumber(rules["max_length"]?.["value"]);
  if (maxLength !== undefined) validation.maxLength = maxLength;
  const pattern = asString(rules["regex"]?.["value"]) ?? asString(rules["pattern"]?.["value"]);
  if (pattern !== undefined && pattern.length > 0) validation.pattern = pattern;
  if (message !== undefined && message.length > 0 && Object.keys(validation).length > 0) {
    validation.message = message;
  }
  return Object.keys(validation).length === 0 ? undefined : validation;
}

/** `options[]` as the plugin stores them: `{label, value}` plus editor noise. */
function optionsFrom(value: unknown): FormFieldOption[] {
  if (!Array.isArray(value)) return [];
  const options: FormFieldOption[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;
    const label = asString(record["label"]) ?? asString(record["value"]);
    const optionValue = asString(record["value"]) ?? label;
    if (label === undefined || optionValue === undefined) continue;
    options.push({ label, value: optionValue });
  }
  return options;
}

/** A question's visibility rules, when Fluent recorded any. */
function conditionalFromQuestion(question: Record<string, unknown>): ConditionalLogic | undefined {
  const logics = question["conditional_logics"];
  if (logics === undefined) return undefined;
  const logic = conditionalFromJson(logics, JSON.stringify(logics));
  return logic ?? undefined;
}

/**
 * The Site IR type for one question, or the reason it has none.
 *
 * `null` means "no opinion" (an unknown question type, where the caller should
 * record and skip). `{ unmapped }` means "understood, but the IR cannot express
 * it" — a difference that matters for the report.
 */
function typeFromQuestion(
  ffInputTypeRaw: unknown,
  elementRaw: unknown,
  attributeTypeRaw: unknown,
): { type: FormFieldType } | { unmapped: string } | null {
  const ffInputType = (asString(ffInputTypeRaw) ?? "").toLowerCase();
  const element = (asString(elementRaw) ?? "").toLowerCase();
  const attributeType = (asString(attributeTypeRaw) ?? "").toLowerCase();

  if (attributeType === "hidden" || ffInputType === "input_hidden") return { type: "hidden" };
  if (attributeType === "email" || ffInputType === "input_email") return { type: "email" };
  if (attributeType === "url" || ffInputType === "input_url") return { type: "url" };
  if (attributeType === "tel" || ffInputType === "input_tel") return { type: "tel" };
  if (attributeType === "number" || ffInputType === "input_number") return { type: "number" };
  if (attributeType === "date" || ffInputType === "input_date") return { type: "date" };
  if (attributeType === "time" || ffInputType === "input_time") {
    return { unmapped: `input type="${attributeType || ffInputType}" has no Site IR field type` };
  }
  if (
    ffInputType === "input_file" ||
    ffInputType === "input_file_upload" ||
    element === "input_file"
  ) {
    return { type: "file" };
  }
  if (ffInputType === "textarea" || element === "textarea") return { type: "textarea" };
  if (ffInputType === "select" || element === "select") return { type: "select" };
  if (ffInputType === "input_radio" || element === "input_radio") return { type: "radio" };
  if (ffInputType === "input_checkbox" || element === "input_checkbox") {
    return { type: "checkbox-group" };
  }
  if (ffInputType === "input_text" || element === "input_text") {
    // The config states the concrete HTML type for a text question; an unstated
    // one is a plain text input.
    if (attributeType === "textarea") return { type: "textarea" };
    return { type: "text" };
  }
  if (ffInputType === "input_turnstile" || element === "turnstile") return { type: "turnstile" };
  return null;
}

/** One conversational question → zero or more IR fields. */
function fieldsFromQuestion(question: Record<string, unknown>): {
  fields: ExtractedField[];
  unmapped: Array<{ name: string; reason: string }>;
} {
  const fields: ExtractedField[] = [];
  const unmapped: Array<{ name: string; reason: string }> = [];
  const name = asString(question["name"]) ?? asString(question["id"]);
  if (name === undefined) return { fields, unmapped };

  const title = asString(question["title"]) ?? undefined;
  const conditional = conditionalFromQuestion(question);
  const required = asBoolean(question["required"]);
  const placeholder = asString(question["placeholder"]) ?? undefined;
  const options = optionsFrom(question["options"]);
  const rules = validationRuleMap(question["validationRules"]);

  // The name element is a container: its sub-fields are the real inputs, and the
  // conversational renderer writes `name="<sub-field name>"` on each one (measured
  // in `conversationalForm.js`, which binds `name: n.attributes.name`). The
  // submitted names are therefore flat, and the parent is recorded, not merged in.
  const subFields = question["fields"];
  if (Array.isArray(subFields) && subFields.length > 0) {
    const requiredNames = new Set<string>();
    if (Array.isArray(question["requiredFields"])) {
      for (const entry of question["requiredFields"]) {
        const record = asRecord(entry);
        const requiredName = asString(record?.["name"]);
        if (requiredName !== undefined) requiredNames.add(requiredName);
      }
    }

    for (const entry of subFields) {
      const subField = asRecord(entry);
      if (subField === null) continue;
      const subAttributes = asRecord(subField["attributes"]);
      const subSettings = asRecord(subField["settings"]);
      const subName = asString(subAttributes?.["name"]);
      if (subName === undefined) continue;
      const mapped = typeFromQuestion(
        subField["ff_input_type"],
        subField["element"],
        subAttributes?.["type"],
      );
      if (mapped === null) {
        unmapped.push({ name: subName, reason: "name sub-field has no site IR field type" });
        continue;
      }
      if ("unmapped" in mapped) {
        unmapped.push({ name: subName, reason: mapped.unmapped });
        continue;
      }
      const field: ExtractedField = {
        name: subName,
        type: mapped.type,
        parentName: name,
        required: requiredNames.has(subName) || asBoolean(subField["required"]),
      };
      const label = asString(subSettings?.["label"]) ?? asString(subField["title"]);
      if (label !== undefined && label.length > 0) field.label = label;
      const subPlaceholder = asString(subAttributes?.["placeholder"]);
      if (subPlaceholder !== undefined && subPlaceholder.length > 0) {
        field.placeholder = subPlaceholder;
      }
      const subRules = validationRuleMap(
        subSettings?.["validation_rules"] ?? subField["validationRules"],
      );
      const validation = validationFromRules(subRules);
      if (validation !== undefined) field.validation = validation;
      if (conditional !== undefined) field.conditional = { ...conditional };
      fields.push(field);
    }
    return { fields, unmapped };
  }

  const mapped = typeFromQuestion(
    question["ff_input_type"],
    question["element"],
    asRecord(question["attributes"])?.["type"],
  );
  if (mapped === null) {
    unmapped.push({
      name,
      reason: `question type "${asString(question["type"]) ?? "?"}" is not understood`,
    });
    return { fields, unmapped };
  }
  if ("unmapped" in mapped) {
    unmapped.push({ name, reason: mapped.unmapped });
    return { fields, unmapped };
  }

  const field: ExtractedField = { name, type: mapped.type, required };
  if (title !== undefined && title.length > 0) field.label = title;
  if (placeholder !== undefined && placeholder.length > 0) field.placeholder = placeholder;
  if (options.length > 0) field.options = options;
  if (mapped.type === "checkbox-group" && asBoolean(question["is_multiple"])) field.multiple = true;
  const validation = validationFromRules(rules);
  if (validation !== undefined) field.validation = validation;
  if (conditional !== undefined) field.conditional = { ...conditional };
  if (mapped.type === "date") {
    const dateConfig = asRecord(question["dateConfig"]);
    const dateFormat = asString(dateConfig?.["dateFormat"]);
    if (dateFormat !== undefined && dateFormat.length > 0) field.dateFormat = dateFormat;
  }
  fields.push(field);
  return { fields, unmapped };
}

export interface ConversationalExtraction {
  form: ExtractedForm;
  /** The variable the mount referenced, recorded so the mount and config match. */
  varName: string;
  unmapped: Array<{ name: string; reason: string }>;
}

/**
 * Build the form from a conversational config.
 *
 * `route` is the route the fields are *attributed* to; `configRoute` is where the
 * config was actually read, which is different on `/tmh/apply/` (whose own DOM
 * carries only the mount). Both are recorded so the attribution is auditable.
 */
export function formFromConversationalConfig(
  global: FluentGlobalConfig,
  options: {
    /** Route the fields are attributed to. */
    route: string;
    /** IR slug to use; the caller owns naming so this function cannot hardcode it. */
    id: string;
    title?: string;
    detection: Detection;
    /** Where the config was read, when it was not this route's own document. */
    configRoute?: string;
  },
): ConversationalExtraction | null {
  const form = asRecord(global.config["form"]);
  if (form === null) return null;
  const questions = form["questions"];
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const pluginFormId =
    asString(form["id"]) ?? asString(global.config["form_id"]) ?? options.detection.formId;

  const fields: ExtractedField[] = [];
  const unmapped: Array<{ name: string; reason: string }> = [];
  for (const entry of questions) {
    const question = asRecord(entry);
    if (question === null) continue;
    const parsed = fieldsFromQuestion(question);
    fields.push(...parsed.fields);
    unmapped.push(...parsed.unmapped);
  }

  const extraInputs = asRecord(global.config["extra_inputs"]);
  const extraInputNames = extraInputs === null ? [] : Object.keys(extraInputs);
  const nonceFieldNames = extraInputNames.filter((name) => /nonce/i.test(name));

  const hiddenFields: HiddenFieldRecord[] = [];
  for (const name of extraInputNames) {
    hiddenFields.push({ name, security: /nonce/i.test(name), valueRecorded: false });
  }
  for (const field of fields) {
    if (field.type === "hidden") {
      hiddenFields.push({ name: field.name, security: false, valueRecorded: false });
    }
  }

  const rest = asRecord(global.config["rest"]);
  const submit: SubmitConfiguration = {
    action: asString(global.config["ajaxurl"]) ?? null,
    method: "post",
    enctype: null,
    dataAttributes: {},
    extraInputNames,
    nonceFieldNames,
    renderMode: "conversational",
    notes: [
      "action is posted as Admin AJAX with a `?t=<millisecond timestamp>` cache-buster",
      "body: FormData(action=fluentform_submit, form_id=<id>, data=<urlencoded answers + extra_inputs + isFFConversational=true>)",
    ],
  };
  const ajaxUrl = asString(global.config["ajaxurl"]);
  if (ajaxUrl !== undefined) submit.ajaxUrl = ajaxUrl;
  const restUrl = asString(rest?.["url"]);
  if (restUrl !== undefined) submit.restUrl = restUrl;
  const restNamespace = asString(rest?.["namespace"]);
  if (restNamespace !== undefined) submit.restNamespace = restNamespace;
  if (options.configRoute !== undefined) {
    submit.notes = [...(submit.notes ?? []), `fields read from ${options.configRoute}`];
  }

  const hasTurnstile = asBoolean(form["turnstile"]);
  const hasRecaptcha = asBoolean(form["reCaptcha"]) || asBoolean(form["hCaptcha"]);
  const spam: Array<"honeypot" | "turnstile"> = [];
  // Fluent Forms posts its honeypot as an extra input (`item_<id>__fluent_sf`), not
  // as a field, so a field-shaped check alone would report "no spam protection" for
  // a form that has it.
  const hasHoneypot =
    extraInputNames.some((name) => /__fluent_sf$/i.test(name)) ||
    fields.some((field) => field.type === "honeypot");
  if (hasHoneypot) spam.push("honeypot");
  if (hasTurnstile) spam.push("turnstile");
  if (hasRecaptcha) {
    unmapped.push({
      name: "",
      reason: "form-level reCAPTCHA/hCaptcha has no Site IR spam class (only honeypot/turnstile)",
    });
  }

  const id = options.id;
  const extracted: ExtractedForm = {
    id,
    source: "fluent-forms",
    pluginFormId: pluginFormId ?? null,
    route: options.route,
    fields,
    hiddenFields,
    submit,
    detection: {
      ...options.detection,
      formId: pluginFormId ?? options.detection.formId,
      formIdFrom: options.detection.formIdFrom ?? "conversational-global",
    },
  };
  if (options.title !== undefined) extracted.title = options.title;
  if (spam.length > 0) extracted.validation = { spam };

  return { form: extracted, varName: global.varName, unmapped };
}

/** Submit configuration read from a standard `<form>` element. */
export function submitFromFormElement(
  attributes: Record<string, string>,
  dataAttributes: Record<string, string>,
  hiddenFields: readonly HiddenFieldRecord[],
): SubmitConfiguration {
  const action = attributes["action"];
  const method = attributes["method"];
  const enctype = attributes["enctype"];
  const submit: SubmitConfiguration = {
    action: action === undefined ? null : action,
    method: method === undefined ? "post" : method.toLowerCase(),
    enctype: enctype === undefined ? null : enctype.toLowerCase(),
    dataAttributes,
    extraInputNames: hiddenFields.filter((field) => field.security).map((field) => field.name),
    nonceFieldNames: hiddenFields
      .filter((field) => field.security && /nonce/i.test(field.name))
      .map((field) => field.name),
    renderMode: "standard",
  };
  if (/multipart\/form-data/i.test(submit.enctype ?? "")) {
    submit.notes = ["enctype is multipart/form-data: the form accepts a file upload"];
  }
  return submit;
}
