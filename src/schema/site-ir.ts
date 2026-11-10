/**
 * Site IR v1 — TypeScript projection of `schemas/site-ir.schema.json`.
 *
 * Hand-synced to the schema. The schema is the source of truth: if the two ever
 * disagree the schema wins and this file is the defect. `tests/fixtures/site-ir`
 * plus `scripts/validate-ir.mjs` are the conformance proof.
 *
 * Two rules this type cannot express, and every consumer must obey:
 *  - `dom.html` is a normalized HTML skeleton whose class names are preserved
 *    byte-for-byte. Never re-author it into a component tree.
 *  - `styles` is ordered and verbatim. Never prune, reorder, or "clean" it.
 */

/** Version of the IR shape this file describes. */
export const IR_VERSION = "1.0.0" as const;

/** Semver range the v1 schema accepts (`1.x.y`). */
export const IR_VERSION_PATTERN = /^1\.\d+\.\d+$/;

export function isSupportedIrVersion(version: string): boolean {
  return IR_VERSION_PATTERN.test(version);
}

/** Opaque JSON data: island props, wire shapes. Never `any`. */
export type JsonObject = Record<string, unknown>;

export type PageStatus = "publish" | "draft" | "private" | "pending" | "future";

export type AssetKind = "image" | "font" | "script" | "document" | "media" | "other";

export type FormFieldType =
  | "text"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "checkbox-group"
  | "file"
  | "date"
  | "hidden"
  | "honeypot"
  | "turnstile";

export type SinkKind = "webhook" | "pabbly" | "email-ses" | "sheets-direct";

export type BehaviorKind =
  "toggle" | "tabs" | "accordion" | "slider" | "modal" | "ajax-form" | "scroll" | "copy" | "other";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RedirectCode = 301 | 302 | 307 | 308;

export type ArtifactKind =
  "site-ir" | "static-html" | "islands-wasm" | "api-functions" | "deployment" | "capability-report";

export interface Permalinks {
  /** WordPress permalink structure, e.g. `/%postname%/`. */
  structure: string;
  homeUrl?: string;
  siteUrl?: string;
}

export interface Subsite {
  id: string;
  /** Path prefix with trailing slash, e.g. `/tmh/`. */
  path: string;
  title: string;
}

export interface Site {
  baseUrl: string;
  title: string;
  description?: string;
  /** WordPress locale, e.g. `en_CA`. */
  locale: string;
  permalinks: Permalinks;
  subsites?: Subsite[];
}

/**
 * The fidelity carrier. `html` is a normalized skeleton; class names are
 * byte-for-byte identical to the captured page.
 */
export interface DomSkeleton {
  html: string;
  doctype?: string;
}

export interface IslandMount {
  /** Mount slot id, e.g. `island-apply-form`. */
  id: string;
  /** PascalCase registered component name. Rust internals stay out of the IR. */
  component: string;
  props: JsonObject;
}

export interface PageMeta {
  description?: string;
  authorId?: string;
  publishedAt?: string;
  updatedAt?: string;
  wpId?: number;
}

export interface PageSeo {
  canonical?: string;
  robots?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  jsonLd?: JsonObject[];
}

export interface Page {
  /** Site-relative path, always leading slash. */
  url: string;
  slug: string;
  title?: string;
  status: PageStatus;
  /** Captured template id; empty string when the site has none. */
  template: string;
  subsite?: string;
  dom: DomSkeleton;
  meta?: PageMeta;
  seo?: PageSeo;
  islands?: IslandMount[];
  /** OPTIONAL prose projection. Never the IR, never an emitter input. */
  proseMarkdown?: string;
}

export interface Asset {
  sourceUrl: string;
  localPath: string;
  sha256: string;
  kind: AssetKind;
  bytes?: number;
  contentType?: string;
  referencedBy?: string[];
}

/** Ordered, verbatim. There is deliberately no pruning or cleaned flag. */
export interface Style {
  href: string;
  localPath: string;
  sha256: string;
  /** 0-based cascade order; emitters link ascending and never reorder. */
  order: number;
  media?: string;
  subsite?: string;
}

export interface MenuItem {
  label: string;
  href: string;
  target?: string;
  children?: MenuItem[];
}

export interface Menu {
  id: string;
  name: string;
  location?: string;
  items: MenuItem[];
}

export interface Term {
  slug: string;
  name: string;
  parent?: string;
}

export interface Taxonomy {
  /** WordPress taxonomy key, e.g. `category`. */
  name: string;
  label?: string;
  hierarchical?: boolean;
  terms: Term[];
}

export interface Author {
  id: string;
  slug: string;
  name: string;
  bio?: string;
  avatarPath?: string;
}

export interface FormFieldOption {
  label: string;
  value: string;
}

export interface FieldValidation {
  pattern?: string;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  message?: string;
}

export interface FormField {
  /** Submitted name, preserved exactly: the sink envelope depends on it. */
  name: string;
  type: FormFieldType;
  label?: string;
  placeholder?: string;
  required?: boolean;
  multiple?: boolean;
  defaultValue?: string;
  options?: FormFieldOption[];
  validation?: FieldValidation;
}

export interface FormValidation {
  requiredMessage?: string;
  successMessage?: string;
  errorMessage?: string;
  spam?: Array<"honeypot" | "turnstile">;
}

export interface SubmitContract {
  sink: SinkKind;
  /** References `apiContracts[].id`. */
  endpointRef: string;
  honeypot?: boolean;
  turnstile?: boolean;
}

export interface Form {
  id: string;
  /** Captured form plugin, e.g. `fluent-forms`. */
  source: string;
  title?: string;
  page?: string;
  fields: FormField[];
  validation?: FormValidation;
  submitContract: SubmitContract;
}

export interface Behavior {
  page: string;
  selector: string;
  kind: BehaviorKind;
  endpointRef?: string;
  islandId?: string;
  options?: JsonObject;
}

export interface ApiContract {
  id: string;
  method: HttpMethod;
  url: string;
  requestShape?: JsonObject;
  responseShape?: JsonObject;
  headers?: Record<string, string>;
  notes?: string;
}

export interface UnsupportedCapability {
  /** Stable capability key, e.g. `wpml`. */
  capability: string;
  detail?: string;
  /** True when faithful conversion is impossible until this is resolved. */
  blocking?: boolean;
  where?: string[];
}

export interface Capabilities {
  supported: string[];
  unsupported: UnsupportedCapability[];
}

export interface Redirect {
  from: string;
  /** Site-relative path or absolute url. */
  to: string;
  code: RedirectCode;
}

export interface Capture {
  /** Adapter id, e.g. `wp-rest`. */
  sourceAdapter: string;
  capturedAt: string;
  toolVersion?: string;
  notes?: string;
}

export interface SiteIr {
  /** Semver of the IR shape. Only `1.x.y` is valid for this schema. */
  irVersion: string;
  site: Site;
  pages: Page[];
  assets: Asset[];
  /** Ordered, verbatim stylesheet chain. */
  styles: Style[];
  menus?: Menu[];
  taxonomies?: Taxonomy[];
  authors?: Author[];
  forms?: Form[];
  behaviors?: Behavior[];
  apiContracts?: ApiContract[];
  capabilities: Capabilities;
  redirects?: Redirect[];
  capture?: Capture;
}

export type SiteIrValidationResult = { ok: true; ir: SiteIr } | { ok: false; errors: string[] };

/**
 * Structural guard used by adapters and emitters at the seam. Returns the value
 * typed only when the shape is present; the JSON Schema does the deep check.
 */
export function isSiteIr(value: unknown): value is SiteIr {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SiteIr>;
  if (typeof candidate.irVersion !== "string") return false;
  if (!isSupportedIrVersion(candidate.irVersion)) return false;
  if (typeof candidate.site !== "object" || candidate.site === null) return false;
  if (!Array.isArray(candidate.pages)) return false;
  if (!Array.isArray(candidate.assets)) return false;
  if (!Array.isArray(candidate.styles)) return false;
  if (typeof candidate.capabilities !== "object" || candidate.capabilities === null) {
    return false;
  }
  return true;
}
