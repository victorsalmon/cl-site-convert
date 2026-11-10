/**
 * Form IR — the shape `capture:forms` produces, and the split between what the
 * Site IR can carry and what it cannot.
 *
 * The Site IR (v1.1) has a `form` shape: `id`, `source`, `title`, `page`,
 * `fields[]` and `submitContract`. That is the *contract* a form has to honour
 * after the conversion. It is deliberately smaller than what a capture can see:
 * it has no place for the plugin's own form id, a field's visibility rules, a
 * file input's `accept`/size limits, or the names of the nonce fields.
 *
 * Those facts are not optional, they are just not IR: an upload field's accepted
 * types are the difference between a working replacement and a rejected file,
 * and a conditional field that is always rendered would be a behaviour change.
 * So the extractor keeps them in `ExtractedForm` and the projector splits the
 * result: the IR gets a schema-conformant subset, and `capture/forms.json`
 * (the sidecar) gets everything. Nothing is dropped silently — a field the IR
 * cannot hold is named in `docs/01-DECISIONS.md`-style reporting rather than
 * quietly widened out of the schema.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **Never invent a form.** No form markup means `absent` with a reason, not
 *     an empty form. An unrecognised field type is skipped and reported, never
 *     coerced into `text`.
 *  2. **Never record a security token's value.** Nonces and other hidden fields
 *     are listed by NAME with `valueRecorded: false`. They are session-bound,
 *     useless statically, and recording them would put a live CSRF token in git.
 */

import type { FormFieldOption, FormFieldType, FormValidation } from "../../schema/site-ir.js";

/** Which extractor matched. `generic-form` means "a form, but not a known plugin". */
export type DetectedSource = "fluent-forms" | "generic-form";

/** How the source was recognised, so the claim is auditable rather than a guess. */
export type DetectionMatch =
  | "fluent-conversational-mount"
  | "fluent-form-wrapper"
  | "fluent-hidden-nonce"
  | "fluent-form-class"
  | "generic-form";

/** Where the plugin's own form id came from. */
export type FormIdEvidence =
  "data-form_id" | "hidden-nonce" | "wrapper-class" | "form-id-attribute" | "conversational-global";

export interface Detection {
  source: DetectedSource;
  matched: DetectionMatch;
  /** Literal tokens that proved the match, e.g. `data-form_id="3"`. */
  evidence: string[];
  /** Plugin form id and how it was found, when it was. */
  formId: string | null;
  formIdFrom: FormIdEvidence | null;
}

/**
 * One visibility rule. `raw` is kept because plugins express this differently
 * and re-encoding a rule I do not fully understand would be a behaviour change.
 */
export interface ConditionalRule {
  field: string;
  operator: string;
  value: string;
}

export interface ConditionalLogic {
  /** `any` / `all` when the plugin stated its matching mode. */
  match?: string;
  rules: ConditionalRule[];
  /** The plugin's own JSON, verbatim, so nothing is lost in normalisation. */
  raw: string;
}

/**
 * File-input limits. Not in Site IR v1.1 `formField` (its `validation` has only
 * pattern/min/max/minLength/maxLength), so these live in the sidecar.
 */
export interface FileConstraints {
  accept?: string;
  /** Bytes, only when the markup states a unit that makes the conversion certain. */
  maxSizeBytes?: number;
  /** The untouched attribute value when the unit is not stated. Never guessed at. */
  maxSizeRaw?: string;
  multiple?: boolean;
}

export interface ExtractedField {
  /** Submitted name, preserved exactly: the sink envelope depends on it. */
  name: string;
  type: FormFieldType;
  label?: string;
  placeholder?: string;
  required?: boolean;
  multiple?: boolean;
  defaultValue?: string;
  options?: FormFieldOption[];
  validation?: {
    pattern?: string;
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    message?: string;
  };
  /** Visibility rules from the markup/config. Sidecar only. */
  conditional?: ConditionalLogic;
  /** Upload limits. Sidecar only. */
  file?: FileConstraints;
  /** Date-input mask the plugin states (`d/m/Y`), when it states one. Sidecar only. */
  dateFormat?: string;
  /** True for a hidden field whose value is a session token. Value never stored. */
  security?: boolean;
  /**
   * The question a sub-field belongs to (`first_name` inside the `names` element).
   * Sidecar only: the IR field list is flat, and the conversational renderer posts
   * these names flat, so the submitted name is `first_name`, not `names[first_name]`.
   */
  parentName?: string;
}

/**
 * A hidden input, recorded by name. `valueRecorded` is always `false`: a nonce is
 * bound to the session that produced the page, so a recorded value is both
 * useless and a credential-shaped artefact in a git history.
 */
export interface HiddenFieldRecord {
  name: string;
  security: boolean;
  valueRecorded: false;
}

/** Everything the markup says about how the form is submitted. */
export interface SubmitConfiguration {
  action: string | null;
  method: string | null;
  enctype: string | null;
  /** `data-*` on the form/wrapper the plugin uses, e.g. `data-form_id`. */
  dataAttributes: Record<string, string>;
  /** `ajaxurl` from the captured plugin config, when the plugin states one. */
  ajaxUrl?: string;
  /** REST namespace root from the captured config, when stated. */
  restUrl?: string;
  restNamespace?: string;
  /**
   * Which render the route serves. The two Fluent Forms shapes post different
   * envelopes (the conversational app sends flat input names; the standard form
   * nests them), so this is part of the wire contract, not a styling detail.
   */
  renderMode?: "conversational" | "standard";
  /** Hidden input names the plugin adds outside the visible field list. */
  extraInputNames: string[];
  /** Names of the fields the plugin uses as CSRF/session tokens. */
  nonceFieldNames: string[];
  /** Measured facts about the request that the schema has no field for. */
  notes?: string[];
}

export interface ExtractedForm {
  /** IR-safe slug, e.g. `fluent-form-3`. */
  id: string;
  source: DetectedSource;
  /** The plugin's own form id (`3`), which the IR has no field for. */
  pluginFormId: string | null;
  title?: string;
  /** Captured route, faithfully: may carry a query string (`/?fluent-form=3`). */
  route: string;
  fields: ExtractedField[];
  hiddenFields: HiddenFieldRecord[];
  submit: SubmitConfiguration;
  validation?: FormValidation;
  detection: Detection;
}

/**
 * A recognised form render whose fields are not in the document. Fluent Forms'
 * conversational mode ships an empty mount and renders the fields from a script
 * blob; the capture strips scripts, so the mount is real and the fields are not.
 * That is a distinct outcome from "no form", and must not be laundered into one.
 */
export interface FieldsUnavailable {
  route: string;
  source: DetectedSource;
  pluginFormId: string | null;
  reason: string;
  detection: Detection;
}

export interface FormAbsence {
  route: string;
  reason: string;
  /** A `<form>` was present but rejected as something other than an application form. */
  rejected?: "site-search" | "no-fields";
}

export type FormExtraction =
  | { status: "extracted"; form: ExtractedForm }
  | { status: "fields-unavailable"; result: FieldsUnavailable }
  | { status: "absent"; result: FormAbsence };

/** One live recording of a form render that is not one of the 19 captured pages. */
export interface FormRecording {
  /** Route as fetched, query string included (`/?fluent-form=3`). */
  route: string;
  /** Repository-relative path of the recorded HTML. */
  path: string;
  /** Plugin form id, when known. */
  pluginFormId: string | null;
  /** Why this render had to be fetched separately. */
  note: string;
}
