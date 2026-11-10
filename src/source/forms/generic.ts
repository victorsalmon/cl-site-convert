/**
 * Field parsing for a `<form>` element — the generic fallback, and the path a
 * Fluent Forms page takes when it renders standard (non-conversational) markup.
 *
 * The same parser serves both on purpose: once the plugin is identified as
 * Fluent Forms, the *fields* are ordinary HTML inputs, and a second parser would
 * be a second place for the two to disagree. What the plugin identity changes is
 * the option-label convention, the honeypot name and the submit contract — not
 * how a `<select>` works.
 *
 * Three rules:
 *
 *  1. **A name is preserved exactly.** The sink envelope is keyed on it, so
 *     `input_text_1` stays `input_text_1` and `names[first_name]` stays that.
 *  2. **An unmappable control is reported, never coerced.** A
 *     `<input type="password">` has no type in Site IR v1.1; inventing `text`
 *     would put a password field into a public form definition.
 *  3. **A security token is listed by name only.** The value is never read.
 */

import type { FormFieldOption } from "../../schema/site-ir.js";
import {
  attr,
  classTokens,
  elementBlocks,
  hasFlag,
  innermostBlockAt,
  isSecurityTokenName,
  nestedElementBlocks,
  openingTags,
  text,
} from "./html.js";
import type {
  ConditionalLogic,
  ConditionalRule,
  ExtractedField,
  HiddenFieldRecord,
} from "./types.js";

export interface UnmappedControl {
  name: string;
  reason: string;
}

export interface ParsedForm {
  fields: ExtractedField[];
  hiddenFields: HiddenFieldRecord[];
  /** Controls the IR has no type for, with the reason. Never silently dropped. */
  unmapped: UnmappedControl[];
}

/** Input `type` values that map straight onto a Site IR field type. */
const DIRECT_INPUT_TYPES: Record<string, ExtractedField["type"]> = {
  text: "text",
  email: "email",
  tel: "tel",
  url: "url",
  number: "number",
  date: "date",
};

/** Controls that are actions or chrome, not submitted data. */
const NON_FIELD_INPUT_TYPES = new Set(["submit", "button", "reset", "image"]);

interface ConditionalEntry {
  logic: ConditionalLogic;
  /** Where the rule set was written; a control inside it is the one it controls. */
  start: number;
  end: number;
}

/**
 * Read `data-conditionals`-style JSON into rules this extractor can attribute to
 * a field. Anything it cannot decode is still returned with its `raw` text, so a
 * caller can record it rather than lose it.
 */
export function conditionalFromJson(value: unknown, raw: string): ConditionalLogic | null {
  if (value === null || typeof value !== "object") return null;

  const rules: ConditionalRule[] = [];
  let match: string | undefined;

  const takeRule = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    const field = typeof record["field"] === "string" ? record["field"] : null;
    if (field === null) return;
    const operator = typeof record["operator"] === "string" ? record["operator"] : "==";
    const compared = record["value"];
    rules.push({
      field,
      operator,
      value: compared === null || compared === undefined ? "" : String(compared),
    });
  };

  const walk = (candidate: unknown, depth: number): void => {
    if (depth > 3 || candidate === null || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const entry of candidate) walk(entry, depth + 1);
      return;
    }
    const record = candidate as Record<string, unknown>;
    if (typeof record["match"] === "string") match ??= record["match"];
    if (typeof record["match_type"] === "string") match ??= record["match_type"];
    if (typeof record["field"] === "string") takeRule(record);
    // Walk each known container exactly once: visiting every array-valued key as
    // well would read `conditions` twice and duplicate the rule.
    for (const key of ["conditions", "rules", "conditionals", "logic", "0"]) {
      if (key in record) walk(record[key], depth + 1);
    }
  };

  walk(value, 0);
  if (rules.length === 0) return null;
  return match === undefined ? { rules, raw } : { match, rules, raw };
}

function conditionalEntries(inner: string): ConditionalEntry[] {
  const entries: ConditionalEntry[] = [];
  const tagNames = new Set<string>();
  for (const match of inner.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bdata-conditional[^>]*>/gi)) {
    if (match[1] !== undefined) tagNames.add(match[1].toLowerCase());
  }

  for (const tagName of tagNames) {
    for (const block of nestedElementBlocks(inner, tagName)) {
      for (const [name, raw] of Object.entries(block.attributes)) {
        if (!/^data-conditional/i.test(name)) continue;
        let decoded: unknown = null;
        // Keep the spelling that actually parsed: an entity-encoded attribute
        // (`&quot;…&quot;`) is not JSON, and recording the encoded form as `raw`
        // would make the sidecar unreadable.
        let rawText = raw;
        for (const candidate of [raw, attr(block.attributes, name) ?? raw]) {
          try {
            decoded = JSON.parse(candidate);
            rawText = candidate;
            break;
          } catch {
            decoded = null;
          }
        }
        const logic = conditionalFromJson(decoded, rawText);
        if (logic === null) continue;
        entries.push({ logic, start: block.start, end: block.start + block.markup.length });
      }
    }
  }
  return entries;
}

/** The file-input limits, read only where the markup states them. */
function fileConstraints(attributes: Record<string, string>): {
  accept?: string;
  maxSizeBytes?: number;
  maxSizeRaw?: string;
  multiple?: boolean;
} {
  const result: {
    accept?: string;
    maxSizeBytes?: number;
    maxSizeRaw?: string;
    multiple?: boolean;
  } = {};
  const accept = attr(attributes, "accept");
  if (accept !== undefined && accept.trim().length > 0) result.accept = accept.trim();
  if (hasFlag(attributes, "multiple")) result.multiple = true;

  for (const [name, value] of Object.entries(attributes)) {
    if (!/^data-(?:max[-_]?file[-_]?size|max[-_]?size)/i.test(name)) continue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      result.maxSizeRaw = value;
      continue;
    }
    if (/mb/i.test(name)) {
      result.maxSizeBytes = Math.round(numeric * 1024 * 1024);
    } else {
      // No unit in the attribute name: record the number as written rather than
      // pick a multiplier and assert a limit the site never stated.
      result.maxSizeRaw = value;
    }
  }
  return result;
}

function validationFrom(
  attributes: Record<string, string>,
): ExtractedField["validation"] | undefined {
  const validation: NonNullable<ExtractedField["validation"]> = {};
  const pattern = attr(attributes, "pattern");
  if (pattern !== undefined && pattern.length > 0) validation.pattern = pattern;

  const numberFrom = (name: string): number | undefined => {
    const raw = attr(attributes, name);
    if (raw === undefined || raw.trim().length === 0) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  const min = numberFrom("min");
  if (min !== undefined) validation.min = min;
  const max = numberFrom("max");
  if (max !== undefined) validation.max = max;
  const minLength = numberFrom("minlength");
  if (minLength !== undefined) validation.minLength = minLength;
  const maxLength = numberFrom("maxlength");
  if (maxLength !== undefined) validation.maxLength = maxLength;
  const message = attr(attributes, "title") ?? attr(attributes, "data-error-message");
  if (message !== undefined && message.length > 0) validation.message = message;

  return Object.keys(validation).length === 0 ? undefined : validation;
}

function isRequired(attributes: Record<string, string>): boolean {
  if (hasFlag(attributes, "required")) return true;
  if ((attr(attributes, "aria-required") ?? "").toLowerCase() === "true") return true;
  return false;
}

/** Label text for a control, by explicit `for=`, wrapping `<label>`, or nothing. */
function labelFor(
  attributes: Record<string, string>,
  offset: number,
  labelBlocks: ReturnType<typeof elementBlocks>,
  byFor: ReadonlyMap<string, string>,
): string | undefined {
  const id = attr(attributes, "id");
  if (id !== undefined) {
    const match = byFor.get(id);
    if (match !== undefined) return match;
  }
  const wrapper = innermostBlockAt(labelBlocks, offset);
  if (wrapper === null) return undefined;
  // Remove the control itself so its placeholder/value never becomes the label.
  const withoutControls = wrapper.inner.replace(/<(?:input|select|textarea|button)\b[^>]*>/gi, " ");
  const value = text(withoutControls);
  return value.length === 0 ? undefined : value;
}

function optionLabelFrom(
  inner: string,
  offset: number,
  labelBlocks: ReturnType<typeof elementBlocks>,
): string | undefined {
  const wrapper = innermostBlockAt(labelBlocks, offset);
  if (wrapper === null) return undefined;
  const withoutControls = wrapper.inner.replace(/<(?:input|select|textarea)\b[^>]*>/gi, " ");
  const value = text(withoutControls);
  return value.length === 0 ? undefined : value;
}

function selectOptions(blockInner: string): { options: FormFieldOption[]; placeholder?: string } {
  const options: FormFieldOption[] = [];
  let placeholder: string | undefined;
  for (const option of openingTags(blockInner, "option")) {
    const close = blockInner.indexOf("</option", option.end);
    const body = close < 0 ? "" : blockInner.slice(option.end, close);
    const label = text(body);
    const value = attr(option.attributes, "value") ?? label;
    if (value.length === 0 && label.length > 0) {
      placeholder ??= label;
      continue;
    }
    if (value.length === 0) continue;
    options.push({ label: label.length > 0 ? label : value, value });
  }
  return placeholder === undefined ? { options } : { options, placeholder };
}

/**
 * Parse the fields of one `<form>` element.
 *
 * `inner` is the markup between `<form>` and `</form>`; the opening tag itself is
 * not needed here, because the submit configuration is read by the caller.
 */
export function parseFormFields(inner: string): ParsedForm {
  // Fields are collected with their byte offset and sorted at the end: textareas
  // and selects have to be read before inputs (an input inside one would be
  // malformed), but the emitted order must still be the document's order, because
  // that is the order the source renders and submits.
  const ordered: Array<{ offset: number; field: ExtractedField }> = [];
  const add = (field: ExtractedField, offset: number): void => {
    ordered.push({ offset, field });
  };
  const hiddenFields: HiddenFieldRecord[] = [];
  const unmapped: UnmappedControl[] = [];
  const conditionals = conditionalEntries(inner);

  const labelBlocks = elementBlocks(inner, "label");
  const byFor = new Map<string, string>();
  for (const label of labelBlocks) {
    const target = attr(label.attributes, "for");
    if (target === undefined) continue;
    const value = text(label.inner);
    if (value.length > 0) byFor.set(target, value);
  }

  const attachConditional = (field: ExtractedField, offset: number): void => {
    const entry = conditionals.find(
      (candidate) => candidate.start <= offset && offset < candidate.end,
    );
    if (entry === undefined) return;
    field.conditional = { ...entry.logic };
  };

  // Textareas and selects are elements, not void tags, so they are read first and
  // their offsets remembered: an `<input>` inside either would be malformed HTML
  // and must not be counted twice.
  const elementRanges: Array<{ start: number; end: number }> = [];

  for (const area of elementBlocks(inner, "textarea")) {
    if (!area.closed) continue;
    const name = attr(area.attributes, "name");
    if (name === undefined || name.length === 0) continue;
    elementRanges.push({ start: area.start, end: area.start + area.markup.length });
    const field: ExtractedField = {
      name,
      type: "textarea",
      required: isRequired(area.attributes),
    };
    const label = labelFor(area.attributes, area.start, labelBlocks, byFor);
    if (label !== undefined) field.label = label;
    const placeholder = attr(area.attributes, "placeholder");
    if (placeholder !== undefined && placeholder.length > 0) field.placeholder = placeholder;
    const maxLength = attr(area.attributes, "maxlength");
    if (
      maxLength !== undefined &&
      maxLength.trim().length > 0 &&
      Number.isFinite(Number(maxLength))
    ) {
      field.validation = { maxLength: Number(maxLength) };
    }
    if (area.inner.trim().length > 0) field.defaultValue = area.inner.trim();
    attachConditional(field, area.start);
    add(field, area.start);
  }

  for (const select of elementBlocks(inner, "select")) {
    if (!select.closed) continue;
    const name = attr(select.attributes, "name");
    if (name === undefined || name.length === 0) continue;
    elementRanges.push({ start: select.start, end: select.start + select.markup.length });
    const parsed = selectOptions(select.inner);
    const field: ExtractedField = {
      name,
      type: "select",
      required: isRequired(select.attributes),
      options: parsed.options,
    };
    if (hasFlag(select.attributes, "multiple")) field.multiple = true;
    const label = labelFor(select.attributes, select.start, labelBlocks, byFor);
    if (label !== undefined) field.label = label;
    if (parsed.placeholder !== undefined) field.placeholder = parsed.placeholder;
    attachConditional(field, select.start);
    add(field, select.start);
  }

  const insideElement = (offset: number): boolean =>
    elementRanges.some((range) => range.start <= offset && offset < range.end);

  /** Choice groups accumulate per submitted name, because that is how they post. */
  const choiceGroups = new Map<
    string,
    { type: "radio" | "checkbox-group" | "checkbox"; field: ExtractedField; offset: number }
  >();

  for (const input of openingTags(inner, "input")) {
    if (insideElement(input.start)) continue;
    const attributes = input.attributes;
    const rawType = (attr(attributes, "type") ?? "text").toLowerCase();
    const name = attr(attributes, "name");
    const tokens = classTokens(attributes);

    if (rawType === "hidden" || tokens.includes("ff_hp")) {
      if (name === undefined || name.length === 0) continue;
      if (tokens.includes("ff_hp") || /__fluent_sf$/i.test(name)) {
        hiddenFields.push({ name, security: false, valueRecorded: false });
        add({ name, type: "honeypot" }, input.start);
        continue;
      }
      const security = isSecurityTokenName(name);
      hiddenFields.push({ name, security, valueRecorded: false });
      // A token field is listed and never read: the value is session-bound.
      if (security) continue;
      // Plugin/WordPress plumbing is posted, not answered: `__fluent_form_…`,
      // `_wp_http_referer`, `_wpnonce`. It belongs to the submit contract
      // (`submit.extraInputNames`), not to the field list a visitor fills in. The
      // rule is the naming convention, not a list of plugin names, so it holds for
      // a plugin this extractor has never seen.
      if (name.startsWith("_")) continue;
      const defaultValue = attr(attributes, "value");
      const field: ExtractedField = { name, type: "hidden" };
      if (defaultValue !== undefined && defaultValue.length > 0) {
        field.defaultValue = defaultValue;
      }
      add(field, input.start);
      continue;
    }

    if (NON_FIELD_INPUT_TYPES.has(rawType)) continue;
    if (name === undefined || name.length === 0) {
      unmapped.push({ name: "", reason: `input type="${rawType}" has no name` });
      continue;
    }

    if (tokens.includes("cf-turnstile") || name === "cf-turnstile-response") {
      add({ name, type: "turnstile" }, input.start);
      continue;
    }

    if (rawType === "radio" || rawType === "checkbox") {
      const groupType: "radio" | "checkbox-group" | "checkbox" =
        rawType === "radio"
          ? "radio"
          : name.endsWith("[]") || choiceGroups.has(name)
            ? "checkbox-group"
            : "checkbox";
      const existing = choiceGroups.get(name);
      const optionValue = attr(attributes, "value") ?? "";
      const optionLabel =
        optionLabelFrom(inner, input.start, labelBlocks) ??
        (optionValue.length > 0 ? optionValue : undefined);
      const option: FormFieldOption | null =
        optionValue.length === 0 && optionLabel === undefined
          ? null
          : { label: optionLabel ?? optionValue, value: optionValue };

      if (existing === undefined) {
        const field: ExtractedField = {
          name,
          type: groupType,
          required: isRequired(attributes),
          options: option === null ? [] : [option],
        };
        const label = labelFor(attributes, input.start, labelBlocks, byFor);
        if (label !== undefined) field.label = label;
        choiceGroups.set(name, { type: groupType, field, offset: input.start });
        add(field, input.start);
        attachConditional(field, input.start);
        continue;
      }

      // More than one input under the same name is a group, whatever the first
      // one looked like: a lone checkbox under a repeated name is still a group.
      if (existing.type === "checkbox" && groupType === "checkbox-group") {
        existing.field.type = "checkbox-group";
        existing.type = "checkbox-group";
      }
      if (option !== null) existing.field.options?.push(option);
      continue;
    }

    if (rawType === "file") {
      const constraints = fileConstraints(attributes);
      const field: ExtractedField = {
        name,
        type: "file",
        required: isRequired(attributes),
      };
      const label = labelFor(attributes, input.start, labelBlocks, byFor);
      if (label !== undefined) field.label = label;
      if (Object.keys(constraints).length > 0) field.file = constraints;
      attachConditional(field, input.start);
      add(field, input.start);
      continue;
    }

    const mapped = DIRECT_INPUT_TYPES[rawType];
    if (mapped === undefined) {
      unmapped.push({ name, reason: `input type="${rawType}" has no Site IR field type` });
      continue;
    }

    const field: ExtractedField = { name, type: mapped, required: isRequired(attributes) };
    const label = labelFor(attributes, input.start, labelBlocks, byFor);
    if (label !== undefined) field.label = label;
    const placeholder = attr(attributes, "placeholder");
    if (placeholder !== undefined && placeholder.length > 0) field.placeholder = placeholder;
    const defaultValue = attr(attributes, "value");
    if (defaultValue !== undefined && defaultValue.length > 0) field.defaultValue = defaultValue;
    const validation = validationFrom(attributes);
    if (validation !== undefined) field.validation = validation;
    attachConditional(field, input.start);
    add(field, input.start);
  }

  // Cloudflare Turnstile is a widget plus a hidden response input, so the marker
  // element is the evidence that the form is protected - not an `input` type.
  if (
    /<div\b[^>]*class="[^"]*cf-turnstile/i.test(inner) &&
    !ordered.some((entry) => entry.field.type === "turnstile")
  ) {
    add({ name: "cf-turnstile-response", type: "turnstile" }, inner.length);
  }

  const fields = ordered
    .sort((left, right) => left.offset - right.offset)
    .map((entry) => entry.field);
  return { fields, hiddenFields, unmapped };
}
