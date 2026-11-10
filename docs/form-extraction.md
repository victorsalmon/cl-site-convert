# Form extraction (P4.1a)

Fluent Forms is PHP. It does not survive a conversion to a static host, and the
architecture decision is explicit: forms are **extracted from and replaced, never
adapted** (`docs/01-DECISIONS.md`, "Forms: extracted and replaced, never
adapted"). What has to survive is the wire contract.

This document records what the extractor found, what it could not put in the Site
IR, and how each claim is checked.

```powershell
pnpm capture:forms            # extract from the capture + recordings, write artifacts, print the table
pnpm capture:forms --check    # write nothing; exit 1 when the committed artifacts are stale
pnpm capture:forms --fetch    # politely re-fetch the query-string render, then extract
```

Artifacts:

| File | Role |
| :--- | :--- |
| `capture/site-ir.json` → `forms[]`, `apiContracts[]` | the schema-conformant projection: what the replacement must honour |
| `capture/forms.json` | the sidecar: everything the IR shape cannot hold, plus per-route outcomes |
| `tests/fixtures/forms/` | the recorded render and the fixtures, byte-checked by digest |

## Measured: one form, two renders, two pages that look like forms and are not

| Route | Result | Fields |
| :--- | :--- | :--- |
| `/tmh/apply/` | Fluent Forms **conversational mount**, `data-form_id="3"` | 15 (from the recorded config) |
| `/?fluent-form=3` | Fluent Forms conversational render, query string only | 15 (same question set) |
| `/mlm/applym/` | **no form in the capture**: an empty Divi code module where it would be embedded | 0 |
| `/tmh/onboard-tmh/`, `/tmh/offboard/`, `/mlm/onboard-mlm/` | **no form in the capture**: zero inputs beyond the site search box | 0 |
| 18 other captured routes | site search box only (`role="search"`, one `?s=` field) | 0 |

Fields on form 3, in submitted order: 2 name sub-fields (`first_name`,
`last_name`), a text field, email, 6 selects, 2 checkbox groups, 2 dates, 2 hidden
tracking fields. **12 required. No file-upload field anywhere on the site.**

## The three findings that shaped the extractor

### 1. A captured conversational form keeps its identity and loses its fields

`/tmh/apply/` serves:

```html
<div class="frm-fluent-form ff_conv_app fluent_form_3" data-form_id="3">
  <div data-var_name="fluent_forms_global_var_1" class="ffc_conv_form" id="ffc_app_instance_1"></div>
</div>
```

There is no `<form>` element and no input. The fields are built by
`conversationalForm.js` after load, and the capture normalises `<script>` away, so
the mount survives and the field set does not. The extractor reports this as
`fields-unavailable` — **not** `absent`, and never as an empty form.

Resolution is explicit, not guessed: the plugin publishes the whole field set in
`var fluent_forms_global_var = {…}` on the query-string render of the same form,
and `pnpm capture:forms --fetch` proves the two renders serve the same questions
by comparing a SHA-256 of `form.questions` (the nonces differ per session; the
questions do not). That comparison is recorded in
`tests/fixtures/forms/recordings.json` as `comparison.identical`.

### 2. `?fluent-form=3` is a render, not a page

The route is reachable only by query string, so it cannot be in the 19 captured
pages. It is recorded separately, fetched once with `PoliteFetcher` (GET only,
600 ms apart, robots-aware, honest User-Agent) and extracted as its own form entry
whose `page` is the literal route `/?fluent-form=3`. It is deliberately **not**
added to `pages[]`: a page would be emitted as a document, and this is a render.

### 3. A site search box is not an application form

All 19 captured pages carry a Divi `et-search-form`; `/ush/owner/` and
`/ush/privacy-policy/` carry a second WordPress block search. Treating every
`<form>` as a form to convert would report 22 phantom forms and bury the two real
ones. Search is rejected by `role="search"`, a `search` class token, or
`method="get"` with exactly one `?s=` field, and the rejection is recorded per
route rather than silently dropped.

## Session tokens: named, never valued

A Fluent Forms page embeds live CSRF nonces in its config and in hidden inputs.
They are session-bound, useless statically, and a credential-shaped artefact in
git. So:

- hidden fields are listed by **name** with `valueRecorded: false`;
- `submit.nonceFieldNames` names the nonce inputs, and nothing else;
- the recorded render replaces every nonce **value** with `REDACTED` before it is
  written, in both spellings the plugin emits (`"nonce":"…"` in the config and
  `value="…"` on a hidden input, either attribute order);
- `securityValuesIn()` is the test hook, and two suites assert it returns nothing
  for both artifacts.

## The wire contract, as captured

Fluent Forms 6.2.17 posts the conversational form as **Admin AJAX**, read from the
plugin's own bundle (`conversationalForm.js`), not assumed:

```
POST https://upscalehavens.ca/wp-admin/admin-ajax.php?t=<ms>
FormData:
  action = fluentform_submit
  form_id = 3
  data = <urlencoded answers + extra_inputs + isFFConversational=true>
```

`extra_inputs` are `__fluent_form_embded_post_id`, `_fluentform_3_fluentformnonce`,
`_wp_http_referer` and `item_3__fluent_sf` (the honeypot). The IR records this as
`apiContracts[] id: fluentform-submit` and both forms point at it via
`submitContract.endpointRef`; `sink` is `pabbly`, per the decided chain
(`island → Pages Function → Pabbly → Sheets`). The Pabbly URL is a Function secret
and never appears in the IR.

Standard (non-conversational) markup is parsed by the same field parser and posts
`method`/`action` as the `<form>` states — the synthetic fixture in
`tests/fixtures/forms/fluent-standard.synthetic.html` covers that path with every
field type.

## What the Site IR cannot hold (schema asks, not schema edits)

`schemas/` was not touched. Each gap is recorded in `capture/forms.json`
`schemaGaps[]` and is a real omission, not a convenience:

1. **No plugin form id.** `form.id` is a slug; Fluent's `3` has no field.
2. **No `formField.conditional`.** Visibility rules (`conditional_logics`) are
   captured but sidecar-only, so an emitter reading the IR alone would render
   every field always.
3. **No `accept` / `maxFileSize` in `formField.validation`.** Upload limits are
   sidecar-only. Not needed for this site (no upload field) but needed the moment
   one appears.
4. **No `dateFormat`.** `d/m/Y` is the plugin's mask; a replacement defaulting to
   `Y-m-d` would silently reinterpret entered dates.
5. **No `parentName`.** `first_name` submits flat (the conversational renderer
   writes `name` from the sub-field), but nothing in the IR says it belongs to the
   `names` element.
6. **`form.page` is a single route.** A form rendered on more than one route — and
   a mount whose fields are only visible on the query-string render — cannot be
   expressed as one entry.
7. **Spam is only `honeypot`/`turnstile`.** A `reCAPTCHA`/`hCaptcha` form would
   have no representation; none exists on this site.

Also not expressible, and therefore reported rather than coerced: an
`<input type="password">` or `type="time"` has no Site IR field type. The extractor
skips it **and emits an `absent` result naming the control**, so a form with an
unsupported input fails loudly instead of shipping with a missing field.

## Verification

- `tests/forms-extract.test.ts` (39 tests): detection evidence, the negative cases
  (no form, commented-out form, search box, 18 real pages without a form),
  the measured field set and order, name expansion, options/placeholders, date
  mask, submit contract, token redaction, and the synthetic standard form with
  every field type plus the two it must refuse.
- `tests/forms-project.test.ts` (28 tests): the committed artifacts are
  reproducible byte-for-byte, the IR projection is schema-legal and internally
  consistent (`endpointRef` resolves, ids unique, every route is a captured page),
  the sidecar carries the gaps, and no token reaches either artifact.
- `pnpm validate:ir` validates `capture/site-ir.json` including the new
  `forms[]`/`apiContracts[]` referential rule.
