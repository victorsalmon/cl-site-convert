/**
 * Plugin template — the smallest plugin that actually runs.
 *
 * The pipeline never imports a plugin's internals by hand: it reads `plugin.json`
 * and calls the handlers this module publishes on the `hooks` record, keyed by
 * the manifest's `hooks` entries (`capture:start`, `capture:page`, `capture:end`).
 * That indirection is the whole contract; everything else here is a real, if
 * minimal, source adapter that produces a valid Site IR document.
 *
 * Nothing in this file is a placeholder: `captureStart` -> `capturePage`* ->
 * `captureEnd` runs, validates its input, and returns the IR shape the emitters
 * consume. Copy the directory, rename it, and replace the bodies.
 */

export const PLUGIN_NAME = "plugin-template";

/**
 * Site IR shape version this plugin emits. Kept in step with `IR_VERSION` in
 * `src/schema/site-ir.ts`; the conformance harness fails when `irRange` in
 * `plugin.json` stops accepting the version the repo actually speaks.
 */
export const IR_VERSION = "1.0.0";

/**
 * @typedef {object} CaptureInput
 * @property {string} baseUrl
 * @property {string} [title]
 * @property {string} [locale]
 * @property {string} [description]
 * @property {{ structure?: string }} [permalinks]
 */

/**
 * @typedef {object} PageInput
 * @property {string} url   Site-relative, leading slash.
 * @property {string} slug
 * @property {string} html  Normalized DOM skeleton, class names preserved.
 * @property {string} [title]
 * @property {"publish"|"draft"|"private"|"pending"|"future"} [status]
 * @property {string} [template]
 */

/**
 * @typedef {object} CaptureContext
 * @property {object} site
 * @property {object[]} pages
 */

/**
 * `capture:start` — open a capture and return the context the other hooks mutate.
 *
 * @param {CaptureInput} input
 * @returns {CaptureContext}
 */
export function captureStart(input) {
  if (typeof input?.baseUrl !== "string" || input.baseUrl.length === 0) {
    throw new Error(`${PLUGIN_NAME}: capture:start requires a non-empty baseUrl`);
  }

  return {
    site: {
      baseUrl: input.baseUrl,
      title: input.title ?? input.baseUrl,
      locale: input.locale ?? "en_CA",
      permalinks: { structure: input.permalinks?.structure ?? "/%postname%/" },
      ...(input.description === undefined ? {} : { description: input.description }),
    },
    pages: [],
  };
}

/**
 * `capture:page` — map one captured page into a Site IR page record.
 *
 * `html` is passed through untouched: it is the fidelity carrier, so this
 * template never re-authors markup or renames classes.
 *
 * @param {CaptureContext} context
 * @param {PageInput} page
 * @returns {object}
 */
export function capturePage(context, page) {
  if (typeof page?.url !== "string" || !page.url.startsWith("/")) {
    throw new Error(`${PLUGIN_NAME}: capture:page requires a site-relative url starting with "/"`);
  }
  if (typeof page.slug !== "string" || page.slug.length === 0) {
    throw new Error(`${PLUGIN_NAME}: capture:page requires a non-empty slug`);
  }
  if (typeof page.html !== "string" || page.html.length === 0) {
    throw new Error(`${PLUGIN_NAME}: capture:page requires a non-empty html skeleton`);
  }

  const irPage = {
    url: page.url,
    slug: page.slug,
    status: page.status ?? "publish",
    template: page.template ?? "",
    dom: { html: page.html },
    ...(page.title === undefined ? {} : { title: page.title }),
  };

  context.pages.push(irPage);
  return irPage;
}

/**
 * `capture:end` — close the capture and return the assembled Site IR document.
 *
 * @param {CaptureContext} context
 * @returns {object}
 */
export function captureEnd(context) {
  return {
    irVersion: IR_VERSION,
    site: context.site,
    pages: context.pages,
    assets: [],
    styles: [],
    capabilities: { supported: [], unsupported: [] },
    capture: { sourceAdapter: PLUGIN_NAME, capturedAt: new Date().toISOString() },
  };
}

/**
 * Manifest hook name -> handler. This record is the load surface; a hook the
 * manifest declares but this record omits is a load-time failure, not a runtime
 * surprise.
 */
export const hooks = {
  "capture:start": captureStart,
  "capture:page": capturePage,
  "capture:end": captureEnd,
};
