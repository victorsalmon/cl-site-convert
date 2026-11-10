/**
 * The capability catalog: the plugins, builders and platform features this
 * converter knows how to reason about, and — for each — whether a static
 * conversion can carry it.
 *
 * A catalog entry is a *classification with a reason*, not an allowlist. The
 * detector (`detect.ts`) only ever treats a capability as safe because an entry
 * here says so; a namespace nobody catalogued is blocking by construction. That
 * is the whole point: unknown is not safe, and "we did not look" must never
 * render as "nothing to see".
 *
 * Three classes, and only three:
 *
 *  - `supported` — the rendered result is enough. Divi markup, a redirect map,
 *    SEO metadata: capture the output and the feature survives.
 *  - `needs-handling` — convertible, but it needs a decision outside the
 *    emitter: a form needs a sink, a cache needs bypassing during capture, a
 *    mailer/CRM needs its outbound path replaced. These are recorded as
 *    `blocking: false` in the IR but they are **not** nothing; the CLI names
 *    them so the pipeline knows what still has to be wired.
 *  - `unsupported-blocking` — the capability holds server-side state that cannot
 *    be statically expressed (cart, checkout, membership, booking, multilingual
 *    routing, LMS, forum). The conversion halts.
 *
 * Signatures are deliberately two-source: a REST namespace proves a plugin is
 * *installed and announcing itself*, while a DOM marker proves the feature is
 * actually *rendered on a page*. A plugin can be installed and unused; a form
 * can be embedded with no namespace of its own. Either alone is evidence, and
 * the report says which one fired.
 */

/** How a detected capability fares under static conversion. */
export type CapabilityClass = "supported" | "needs-handling" | "unsupported-blocking";

/** A pattern tested against captured HTML, with a name good enough to print. */
export interface DomMarker {
  /** What the matched bytes mean, e.g. `Divi section wrapper`. */
  name: string;
  /**
   * Tested against the raw captured HTML with `RegExp.exec`. Must be specific
   * to the feature: a marker that fires on ordinary prose turns a brochure site
   * into a false block, which is its own kind of failure. Never stateful
   * (`/g`), so repeated tests stay independent.
   */
  pattern: RegExp;
}

/** One recognised capability, with the evidence that proves it. */
export interface CapabilityCatalogEntry {
  /** Stable key, matches the schema's `^[a-z][a-z0-9-]*$`. Used in the IR. */
  key: string;
  /** Human name for the classification table. */
  label: string;
  classification: CapabilityClass;
  /**
   * Why this classification, in one sentence, written so that a blocking entry
   * tells the operator what would have to change. It is quoted verbatim into
   * the report's `detail`, so it must stand alone.
   */
  rationale: string;
  /**
   * REST namespace stems. A stem matches the namespace whose first path segment
   * equals it, or begins with `<stem>-` (so `wc` covers `wc-blocks`, and
   * `fluentform` covers `fluentform/v1`).
   */
  namespaces: readonly string[];
  markers: readonly DomMarker[];
}

/**
 * Core WordPress namespaces: WordPress itself, not a capability decision.
 *
 * `wp/v2` is the site's own content API and the substrate this converter reads;
 * the rest are core editor/health/oEmbed machinery. Listing them keeps the
 * "unrecognised namespace blocks" rule honest instead of blocking every
 * WordPress site on earth.
 */
export const CORE_NAMESPACES: readonly string[] = [
  "oembed",
  "wp",
  "wp-abilities",
  "wp-block-editor",
  "wp-embed",
  "wp-site-health",
];

/**
 * A namespace the catalog does not know still has to be judged. These stems are
 * the ones that *smell* like server-side state — commerce, membership, booking,
 * payments, courses, portals. A stranger matching one of these is called out in
 * the report by name so the operator sees the suspicion and not just the block.
 * It is a hint for the reader, never a pass: everything unrecognised blocks.
 */
const STATEFUL_NAMESPACE_HINTS: readonly string[] = [
  "account",
  "appointment",
  "booking",
  "calendar",
  "cart",
  "checkout",
  "commerce",
  "course",
  "customer",
  "donat",
  "ecommerce",
  "event",
  "invoice",
  "learn",
  "lms",
  "member",
  "order",
  "pay",
  "portal",
  "reserv",
  "shop",
  "store",
  "subscri",
  "ticket",
];

/** True when an unrecognised namespace looks like it carries server-side state. */
export function looksStateful(namespaceStem: string): boolean {
  const stem = namespaceStem.toLowerCase();
  return STATEFUL_NAMESPACE_HINTS.some((hint) => stem.includes(hint));
}

/**
 * The catalog, ordered roughly by how often we expect to meet each entry.
 *
 * Ordering has no semantic weight (the report sorts its own output), but
 * grouping keeps related builders/forms together for whoever edits it next.
 */
export const CATALOG: readonly CapabilityCatalogEntry[] = [
  // ---- page builders: rendered output is the deliverable -------------------
  {
    key: "divi",
    label: "Divi builder",
    classification: "supported",
    rationale:
      "Divi shortcodes render into deep static div nesting with class names preserved verbatim, so the builder itself is not needed to reproduce the page.",
    namespaces: ["divi"],
    markers: [
      { name: "Divi module class", pattern: /et_pb_/i },
      { name: "Divi builder wrapper", pattern: /\bet-boc\b/i },
      { name: "Divi theme stylesheet", pattern: /et_divi\b/i },
      { name: "Divi v4 markup", pattern: /et-pb-/i },
    ],
  },
  {
    key: "elementor",
    label: "Elementor builder",
    classification: "supported",
    rationale:
      "Elementor renders to static markup and stylesheets that are captured as-is; any dynamic widget it mounts is caught by that widget's own plugin signature.",
    namespaces: ["elementor"],
    markers: [
      { name: "Elementor widget class", pattern: /elementor-widget/i },
      { name: "Elementor data attribute", pattern: /data-elementor/i },
    ],
  },

  // ---- SEO / redirects: captured as structured IR --------------------------
  {
    key: "redirection",
    label: "Redirection plugin",
    classification: "supported",
    rationale:
      "The redirect map is exported from the plugin and carried as IR `redirects[]`, so the 301 surface survives without the plugin.",
    namespaces: ["redirection"],
    markers: [],
  },
  {
    key: "yoast-seo",
    label: "Yoast SEO",
    classification: "supported",
    rationale:
      "Titles, descriptions, canonicals, robots directives and JSON-LD are read into `page.seo`, which is exactly the surface the emitter reproduces.",
    namespaces: ["yoast"],
    markers: [
      { name: "Yoast schema graph", pattern: /yoast-schema-graph/i },
      { name: "Yoast comment marker", pattern: /yoast/i },
    ],
  },
  {
    key: "rank-math",
    label: "Rank Math SEO",
    classification: "supported",
    rationale:
      "The SEO surface it renders is captured into `page.seo`; the plugin has no other static-visible behaviour.",
    namespaces: ["rankmath"],
    markers: [{ name: "Rank Math marker", pattern: /rank-math/i }],
  },

  // ---- forms: extracted, then replaced ------------------------------------
  {
    key: "fluent-forms",
    label: "Fluent Forms",
    classification: "needs-handling",
    rationale:
      "Forms are extracted into IR `forms[]` and their submissions leave through `src/sinks/`; a sink (webhook, pabbly or email-ses) must be chosen before emit, because nothing here runs PHP.",
    namespaces: ["fluentform", "fluent-form", "fluentforms"],
    markers: [
      { name: "Fluent Forms wrapper", pattern: /fluentform/i },
      { name: "Fluent Forms markup", pattern: /fluent-form/i },
      { name: "Fluent Forms field", pattern: /\bff-el-input\b/i },
    ],
  },
  {
    key: "wpforms",
    label: "WPForms",
    classification: "needs-handling",
    rationale:
      "Form fields are extracted into IR `forms[]` and need a sink; WPForms' own submit handler cannot be carried into a static site.",
    namespaces: ["wpforms"],
    markers: [
      { name: "WPForms wrapper", pattern: /wpforms-form/i },
      { name: "WPForms asset", pattern: /wpforms/i },
    ],
  },
  {
    key: "contact-form-7",
    label: "Contact Form 7",
    classification: "needs-handling",
    rationale:
      "Form fields are extracted into IR `forms[]` and need a sink; the `wp-json/contact-form-7` submit route is PHP and cannot survive.",
    namespaces: ["contact-form-7"],
    markers: [{ name: "CF7 wrapper", pattern: /wpcf7/i }],
  },
  {
    key: "gravity-forms",
    label: "Gravity Forms",
    classification: "needs-handling",
    rationale:
      "Form fields are extracted into IR `forms[]` and need a sink; entries, notifications and add-ons are server-side and are not migrated.",
    namespaces: ["gravityforms", "gf"],
    markers: [{ name: "Gravity Forms wrapper", pattern: /gform_/i }],
  },
  {
    key: "ninja-forms",
    label: "Ninja Forms",
    classification: "needs-handling",
    rationale:
      "Form fields are extracted into IR `forms[]` and need a sink; its AJAX submit endpoint is PHP.",
    namespaces: ["ninja-forms"],
    markers: [{ name: "Ninja Forms wrapper", pattern: /nf-form/i }],
  },

  // ---- outbound glue: replaced by sinks -----------------------------------
  {
    key: "fluent-smtp",
    label: "FluentSMTP",
    classification: "needs-handling",
    rationale:
      "It is outbound mail delivery, which no static site performs; the sink owns delivery (or the notifications are dropped by decision).",
    namespaces: ["fluent-smtp"],
    markers: [{ name: "FluentSMTP asset", pattern: /fluent-smtp/i }],
  },
  {
    key: "fluent-crm",
    label: "FluentCRM",
    classification: "needs-handling",
    rationale:
      "Contacts and lists live in the CRM server-side and historical submissions are deliberately not migrated, so the only open decision is where new submissions are routed.",
    namespaces: ["fluent-crm", "fluentcrm"],
    markers: [{ name: "FluentCRM asset", pattern: /fluentcrm|fluent-crm/i }],
  },
  {
    key: "wp-webhooks",
    label: "WP Webhooks",
    classification: "needs-handling",
    rationale:
      "It is pure glue and is eliminated: Pabbly accepts inbound webhooks directly, so the chain becomes form island -> Function -> Pabbly with the same envelope.",
    namespaces: ["wp-webhooks", "wpwebhooks"],
    markers: [{ name: "WP Webhooks asset", pattern: /wp-webhooks/i }],
  },
  {
    key: "akismet",
    label: "Akismet",
    classification: "needs-handling",
    rationale:
      "Spam filtering is server-side; the replacement is honeypot plus Turnstile in the form island, which is a deliberate behaviour change to verify rather than assume.",
    namespaces: ["akismet"],
    markers: [{ name: "Akismet asset", pattern: /akismet/i }],
  },
  {
    key: "wordfence",
    label: "Wordfence",
    classification: "needs-handling",
    rationale:
      "The WAF/login protection cannot be expressed in static output; that protection has to be provided by the host (Cloudflare) or the migration silently drops a security control.",
    namespaces: ["wordfence"],
    markers: [{ name: "Wordfence asset", pattern: /wordfence/i }],
  },

  // ---- capture hazards ----------------------------------------------------
  {
    key: "litespeed-cache",
    label: "LiteSpeed Cache",
    classification: "needs-handling",
    rationale:
      "The cache must be primed or bypassed deliberately during capture, otherwise the golden baseline is recorded from a stale layer and every later parity diff inherits the error.",
    namespaces: ["litespeed"],
    markers: [{ name: "LiteSpeed marker", pattern: /litespeed/i }],
  },

  // ---- blocking: server-side state a static site cannot express ----------
  {
    key: "woocommerce",
    label: "WooCommerce",
    classification: "unsupported-blocking",
    rationale:
      "Cart, checkout, orders, stock and payment state are server-side and e-commerce is out of scope by decision; a brochure conversion cannot represent them.",
    namespaces: ["woocommerce", "wc"],
    markers: [
      { name: "WooCommerce markup", pattern: /woocommerce/i },
      { name: "WooCommerce block", pattern: /wc-block/i },
      { name: "Add-to-cart control", pattern: /add[_-]to[_-]cart/i },
      { name: "Cart table", pattern: /shop_table|cart_totals/i },
      { name: "WooCommerce payment field", pattern: /wc_payment/i },
    ],
  },
  {
    key: "wpml",
    label: "WPML (multilingual)",
    classification: "unsupported-blocking",
    rationale:
      "WPML routes and serves per-locale content from one database; there is no static expression of that routing without a locale model this converter does not have.",
    namespaces: ["wpml", "sitepress"],
    markers: [
      { name: "WPML markup", pattern: /wpml/i },
      { name: "WPML language switcher", pattern: /wpml-ls-|icl-lang/i },
      { name: "Sitepress marker", pattern: /sitepress/i },
    ],
  },
  {
    key: "polylang",
    label: "Polylang (multilingual)",
    classification: "unsupported-blocking",
    rationale:
      "Per-locale routing and translated content pairs are database state; converting one language silently would drop the others.",
    namespaces: ["polylang"],
    markers: [
      { name: "Polylang markup", pattern: /polylang/i },
      { name: "Polylang language switcher", pattern: /\bpll_/i },
    ],
  },
  {
    key: "translatepress",
    label: "TranslatePress (multilingual)",
    classification: "unsupported-blocking",
    rationale:
      "Translations are stored server-side per URL and swapped at render time; a static capture can only ever contain one language.",
    namespaces: ["trp", "translatepress"],
    markers: [
      { name: "TranslatePress markup", pattern: /translatepress/i },
      { name: "Language switcher", pattern: /trp-language-switcher/i },
    ],
  },
  {
    key: "membership",
    label: "Membership / gated content",
    classification: "unsupported-blocking",
    rationale:
      "Access rules decide what a visitor may see per role and per login; a static site has no session, so gated content would either leak or disappear.",
    namespaces: [
      "memberpress",
      "membership",
      "paid-memberships-pro",
      "pmpro",
      "restrict-content",
      "s2member",
      "ultimate-member",
      "woocommerce-memberships",
    ],
    markers: [
      { name: "MemberPress markup", pattern: /memberpress/i },
      { name: "Paid Memberships Pro markup", pattern: /pmpro/i },
      { name: "Restrict Content markup", pattern: /restrict-content/i },
      { name: "s2Member marker", pattern: /s2member/i },
      { name: "Ultimate Member markup", pattern: /ultimate-member|\bum-login\b/i },
    ],
  },
  {
    key: "booking",
    label: "Booking / appointments",
    classification: "unsupported-blocking",
    rationale:
      "Availability, reservations and calendars are transactional server-side state; there is no static representation of 'is this slot free'.",
    namespaces: [
      "amelia",
      "ameliabooking",
      "bookly",
      "booking",
      "bookingpress",
      "easy-appointments",
      "woocommerce-bookings",
    ],
    markers: [
      { name: "Bookly markup", pattern: /bookly/i },
      { name: "Amelia markup", pattern: /\bamelia\b/i },
      { name: "Booking form markup", pattern: /booking-form|bookingpress/i },
    ],
  },
  {
    key: "lms",
    label: "Course / LMS",
    classification: "unsupported-blocking",
    rationale:
      "Enrolments, progress and lesson gating are per-user server state; a static course page cannot honour them.",
    namespaces: ["learndash", "learnpress", "lifterlms", "sensei", "tutor", "tutorlms"],
    markers: [
      { name: "LearnDash markup", pattern: /learndash/i },
      { name: "LifterLMS markup", pattern: /lifterlms/i },
      { name: "Tutor LMS markup", pattern: /tutor-lms/i },
      { name: "Sensei markup", pattern: /sensei-course/i },
    ],
  },
  {
    key: "forum",
    label: "Forum / community",
    classification: "unsupported-blocking",
    rationale:
      "Threads, replies, moderation and member profiles are mutable server-side state; capturing them statically freezes a conversation that is expected to continue.",
    namespaces: ["bbpress", "buddyboss", "buddyboss-platform", "wpforo"],
    markers: [
      { name: "bbPress markup", pattern: /bbpress/i },
      { name: "BuddyBoss markup", pattern: /buddyboss/i },
      { name: "wpForo markup", pattern: /wpforo/i },
    ],
  },
  {
    key: "ecommerce",
    label: "Other e-commerce platform",
    classification: "unsupported-blocking",
    rationale:
      "Any shop, cart or checkout — whatever the plugin — carries orders and payment state that a static site cannot hold; the entry names the platform so the decision is explicit rather than assumed.",
    namespaces: [
      "bigcommerce",
      "easy-digital-downloads",
      "ecwid",
      "edd",
      "marketpress",
      "shopify",
      "wpecommerce",
    ],
    markers: [
      { name: "Easy Digital Downloads markup", pattern: /\bedd_/i },
      { name: "Shopify embed", pattern: /shopify/i },
      { name: "Ecwid embed", pattern: /ecwid/i },
      { name: "BigCommerce embed", pattern: /bigcommerce/i },
    ],
  },
  {
    key: "events",
    label: "Events calendar",
    classification: "unsupported-blocking",
    rationale:
      "Recurring events, venues and RSVPs are computed and stored server-side; a static page would freeze one rendering of a moving calendar.",
    namespaces: ["events-calendar", "the-events-calendar", "tribe", "tribe-events"],
    markers: [
      { name: "The Events Calendar markup", pattern: /tribe-events/i },
      { name: "Events calendar asset", pattern: /events-calendar/i },
    ],
  },
];

/** Find the catalog entry that owns a REST namespace token, if any. */
export function entryForNamespace(namespace: string): CapabilityCatalogEntry | undefined {
  const stem = namespace.split("/")[0]?.toLowerCase() ?? "";
  return CATALOG.find((entry) =>
    entry.namespaces.some((candidate) => stem === candidate || stem.startsWith(`${candidate}-`)),
  );
}

/**
 * True when a namespace is WordPress core rather than a capability decision.
 *
 * Exact stem match only. A prefix rule here would swallow real plugins: `wp` is
 * core, but `wp-webhooks` and `wpml` are not, and they must still be classified.
 */
export function isCoreNamespace(namespace: string): boolean {
  const stem = namespace.split("/")[0]?.toLowerCase() ?? "";
  return CORE_NAMESPACES.includes(stem);
}
