/**
 * Plugin detection — measured from the markup, never assumed.
 *
 * The brief for this bead arrived with a known ambiguity: the form plugin had
 * been called both *Fluent Forms* and *WP Forms*. The decision recorded in
 * `docs/01-DECISIONS.md` is that the extractor **detects** and the capability
 * report names what it found. This file is that detection, and it is deliberately
 * evidence-carrying: every match returns the literal token that proved it, so a
 * later reader can check the claim against the document instead of trusting a
 * boolean.
 *
 * Detection order matters. Fluent Forms renders in three shapes and the most
 * specific signal wins:
 *
 *  1. **Conversational mount** — a `<div class="ffc_conv_form">` placeholder with
 *     `data-form_id`. There is no `<form>` element at all; the fields are built by
 *     script. This is the shape `/tmh/apply/` actually serves.
 *  2. **Hidden nonce** — `<input name="_fluentform_3_fluentformnonce">`, the
 *     strongest static proof that a `<form>` is Fluent Forms.
 *  3. **Wrapper class** — `frm-fluent-form` / `fluent_form_3`.
 *  4. **Form id attribute** — `<form id="fluentform_3">`.
 *
 * Anything else is reported as `generic-form`, which is honest: it is a form, and
 * pretending to know its plugin would be fabrication.
 */

import { attr, classTokens, elementBlocks, openingTags, withoutComments } from "./html.js";
import type { Detection, DetectionMatch, FormIdEvidence } from "./types.js";

interface IdCandidate {
  formId: string;
  from: FormIdEvidence;
  evidence: string;
}

const FLUENT_WRAPPER_CLASS = "frm-fluent-form";
const CONVERSATIONAL_CLASS = "ffc_conv_form";

/** Append a candidate only when its id is a plausible Fluent Forms id (digits). */
function idCandidate(
  value: string | undefined,
  from: FormIdEvidence,
  evidence: string,
): IdCandidate | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return { formId: trimmed, from, evidence };
}

/**
 * The plugin's form id from an element's attributes.
 *
 * `data-form_id` is checked first because it is what the plugin's own JS reads;
 * the wrapper class is the fallback because Fluent Forms names it with an
 * underscore (`fluent_form_3`) while the shortcode uses a hyphen
 * (`fluent-form-3`). Both spellings appear in the wild.
 */
export function formIdFromAttributes(
  attributes: Record<string, string>,
  openingTag: string,
): IdCandidate | null {
  const fromData = idCandidate(attr(attributes, "data-form_id"), "data-form_id", openingTag);
  if (fromData !== null) return fromData;

  for (const token of classTokens(attributes)) {
    const wrapper = /^fluent[-_]form[-_](\d+)$/i.exec(token);
    if (wrapper?.[1] !== undefined) {
      return { formId: wrapper[1], from: "wrapper-class", evidence: token };
    }
  }

  const fromId = /^fluentform_(\d+)$/i.exec(attributes["id"] ?? "");
  if (fromId?.[1] !== undefined) {
    return { formId: fromId[1], from: "form-id-attribute", evidence: `id="${attributes["id"]}"` };
  }
  return null;
}

/** The form id inside a hidden `_fluentform_<id>_fluentformnonce` input. */
export function formIdFromNonceInputs(inner: string): IdCandidate | null {
  for (const input of openingTags(inner, "input")) {
    const name = attr(input.attributes, "name") ?? "";
    const match = /^_fluentform_(\d+)_fluentformnonce$/i.exec(name);
    if (match?.[1] !== undefined) {
      return { formId: match[1], from: "hidden-nonce", evidence: `name="${name}"` };
    }
  }
  return null;
}

/**
 * Identify a `<form>` element as Fluent Forms, or not.
 *
 * The hidden nonce is checked before the classes: a theme that re-skins the
 * wrapper class can lose `frm-fluent-form`, but the nonce is what the plugin
 * actually posts, so it survives re-skinning.
 */
export function detectFormElement(
  openingTag: string,
  attributes: Record<string, string>,
  inner: string,
): Detection | null {
  const tokens = classTokens(attributes);
  const nonce = formIdFromNonceInputs(inner);
  const byAttributes = formIdFromAttributes(attributes, openingTag);

  const evidence: string[] = [];
  let matched: DetectionMatch | null = null;

  if (nonce !== null) {
    matched = "fluent-hidden-nonce";
    evidence.push(nonce.evidence);
  }
  if (tokens.includes(FLUENT_WRAPPER_CLASS)) {
    matched ??= "fluent-form-wrapper";
    evidence.push(`class="${FLUENT_WRAPPER_CLASS}"`);
  }
  if (tokens.some((token) => /^fluent[-_]form[-_]\d+$/i.test(token))) {
    matched ??= "fluent-form-class";
    evidence.push(...tokens.filter((token) => /^fluent[-_]form[-_]\d+$/i.test(token)));
  }
  if (byAttributes !== null) evidence.push(byAttributes.evidence);

  if (matched === null) return null;

  const chosen = nonce ?? byAttributes;
  return {
    source: "fluent-forms",
    matched,
    evidence: [...new Set(evidence)],
    formId: chosen?.formId ?? null,
    formIdFrom: chosen?.from ?? null,
  };
}

export interface ConversationalMount {
  detection: Detection;
  /** The element that carries the mount, for evidence. */
  openingTag: string;
}

/**
 * Find a Fluent Forms conversational mount — the shape that has form identity but
 * no fields, because the fields are built by script after load.
 */
export function detectConversationalMount(html: string): ConversationalMount | null {
  const document = withoutComments(html);
  const wrappers = elementBlocks(document, "div").filter((block) =>
    classTokens(block.attributes).includes(FLUENT_WRAPPER_CLASS),
  );

  for (const wrapper of wrappers) {
    const mount = elementBlocks(wrapper.inner, "div").find((block) =>
      classTokens(block.attributes).includes(CONVERSATIONAL_CLASS),
    );
    if (mount === undefined) continue;
    const id = formIdFromAttributes(wrapper.attributes, wrapper.openingTag);
    const evidence = [
      `class="${FLUENT_WRAPPER_CLASS}"`,
      `class="${CONVERSATIONAL_CLASS}"`,
      ...(id === null ? [] : [id.evidence]),
    ];
    return {
      openingTag: wrapper.openingTag,
      detection: {
        source: "fluent-forms",
        matched: "fluent-conversational-mount",
        evidence,
        formId: id?.formId ?? null,
        formIdFrom: id?.from ?? null,
      },
    };
  }
  return null;
}

/**
 * Is this `<form>` the site's own search box rather than an application form?
 *
 * This matters on this site: **all 19** captured pages carry a Divi
 * `et-search-form` (`role="search"`, `method="get"`, one `name="s"` input), and
 * three carry a second WordPress block search form. An extractor that treats
 * every `<form>` as an application form would report 22 phantom forms and bury
 * the two real ones. Search is a navigation control, not a submission contract.
 */
export function isSiteSearch(attributes: Record<string, string>, inner: string): boolean {
  const tokens = classTokens(attributes);
  if ((attr(attributes, "role") ?? "").toLowerCase() === "search") return true;
  if (tokens.some((token) => /search/.test(token))) return true;

  const method = (attr(attributes, "method") ?? "").toLowerCase();
  const fieldNames = openingTags(inner, "input")
    .map((input) => attr(input.attributes, "name") ?? "")
    .filter((name) => name.length > 0);
  if (method === "get" && fieldNames.length === 1 && fieldNames[0] === "s") return true;
  return false;
}
