//! Site IR v1.1 — the frozen intermediate representation.
//!
//! Every source adapter produces this; every emitter consumes it. The JSON
//! Schema at `schemas/site-ir.schema.json` is the source of truth and these
//! structs are hand-synced to it (`deny_unknown_fields` mirrors the schema's
//! `additionalProperties: false`).
//!
//! Two rules the types cannot express, and every consumer must obey:
//!
//! 1. [`DomSkeleton::html`] is a normalized HTML skeleton whose **class names are
//!    preserved byte-for-byte**. It is the fidelity carrier. Never re-author it
//!    into a component tree.
//! 2. [`Style`] entries are **ordered and verbatim**. There is no pruning field
//!    and no "cleaned" variant; emitters emit them in [`Style::order`].
//!
//! Markdown is never the IR. [`Page::prose_markdown`] is an optional projection
//! for search or editing and no emitter may read it.
//!
//! v1.1 is **additive**: [`Style::origin`], [`Page::style_order`],
//! [`UnsupportedCapability::evidence`] and [`SiteIr::security_findings`] are all
//! optional, so every v1.0 document is still a valid v1.1 document. Inline CSS
//! (Divi emits 5-14 `<style>` blocks per page) needs no `href`, so
//! [`Style::href`] is required only for linked entries; [`SiteIr::validate`]
//! enforces that, because serde cannot. [`Page::style_order`] is the per-page
//! cascade and [`SiteIr::validate`] also enforces that each of its `sha256`
//! values resolves to a [`Style`]: that is a cross-reference, not a shape.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Semver of the IR shape these types describe.
pub const IR_VERSION: &str = "1.1.0";

/// Opaque JSON data: island props, wire shapes.
pub type JsonObject = Map<String, Value>;

/// A Site IR validation failure. Never a panic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IrError(pub String);

impl fmt::Display for IrError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for IrError {}

/// True when the version is in the 1.x family this crate validates.
///
/// Mirrors the schema pattern `^1\.[0-9]+\.[0-9]+$`.
pub fn is_supported_ir_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    let [major, minor, patch] = parts.as_slice() else {
        return false;
    };
    *major == "1"
        && !minor.is_empty()
        && !patch.is_empty()
        && minor.bytes().all(|b| b.is_ascii_digit())
        && patch.bytes().all(|b| b.is_ascii_digit())
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SiteIr {
    /// Semantic version of the IR shape. Only `1.x.y` is valid here.
    pub ir_version: String,
    pub site: Site,
    pub pages: Vec<Page>,
    pub assets: Vec<Asset>,
    /// Ordered, verbatim stylesheet chain.
    pub styles: Vec<Style>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub menus: Vec<Menu>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub taxonomies: Vec<Taxonomy>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<Author>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forms: Vec<Form>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub behaviors: Vec<Behavior>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub api_contracts: Vec<ApiContract>,
    pub capabilities: Capabilities,
    /// Security observations about the source site. Additive in v1.1.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub security_findings: Vec<SecurityFinding>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub redirects: Vec<Redirect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture: Option<Capture>,
}

impl SiteIr {
    /// Referential-integrity checks a JSON Schema cannot express.
    ///
    /// Returns every problem found, so an adapter fails loudly with the whole
    /// list rather than one error at a time.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if !is_supported_ir_version(&self.ir_version) {
            errors.push(format!(
                "irVersion `{}` is not a supported 1.x version",
                self.ir_version
            ));
        }

        let mut page_urls = std::collections::BTreeSet::new();
        for page in &self.pages {
            if !page.url.starts_with('/') {
                errors.push(format!("page `{}` url must start with `/`", page.url));
            }
            if !page_urls.insert(page.url.as_str()) {
                errors.push(format!("duplicate page url `{}`", page.url));
            }
            let mut island_ids = std::collections::BTreeSet::new();
            for island in &page.islands {
                if !island_ids.insert(island.id.as_str()) {
                    errors.push(format!(
                        "page `{}` has duplicate island id `{}`",
                        page.url, island.id
                    ));
                }
            }
        }

        let subsites: std::collections::BTreeSet<&str> = self
            .site
            .subsites
            .iter()
            .flatten()
            .map(|s| s.id.as_str())
            .collect();
        if !subsites.is_empty() {
            for page in &self.pages {
                if let Some(subsite) = page.subsite.as_deref() {
                    if !subsites.contains(subsite) {
                        errors.push(format!(
                            "page `{}` references unknown subsite `{}`",
                            page.url, subsite
                        ));
                    }
                }
            }
        }

        let mut style_orders = std::collections::BTreeSet::new();
        for style in &self.styles {
            if !style_orders.insert(style.order) {
                errors.push(format!("duplicate style order `{}`", style.order));
            }
            // The schema states this as `if origin == inline then ... else href`,
            // which serde cannot express.
            if !style.is_inline() && style.href.is_none() {
                errors.push(format!(
                    "style at order {} has no `href`; only an `origin: \"inline\"` style may omit it",
                    style.order
                ));
            }
        }

        let style_shas: std::collections::BTreeSet<&str> = self
            .styles
            .iter()
            .map(|style| style.sha256.as_str())
            .collect();
        for page in &self.pages {
            for sha in page.style_order.iter().flatten() {
                // `styleOrder` is a cross-reference the JSON Schema cannot check.
                if !style_shas.contains(sha.as_str()) {
                    errors.push(format!(
                        "page `{}` styleOrder references unknown style sha256 `{}`",
                        page.url, sha
                    ));
                }
            }
        }

        let contract_ids: std::collections::BTreeSet<&str> =
            self.api_contracts.iter().map(|c| c.id.as_str()).collect();
        for form in &self.forms {
            if !contract_ids.contains(form.submit_contract.endpoint_ref.as_str()) {
                errors.push(format!(
                    "form `{}` submitContract references unknown apiContract `{}`",
                    form.id, form.submit_contract.endpoint_ref
                ));
            }
        }

        for behavior in &self.behaviors {
            if let Some(contract) = behavior.endpoint_ref.as_deref() {
                if !contract_ids.contains(contract) {
                    errors.push(format!(
                        "behavior on `{}` references unknown apiContract `{}`",
                        behavior.page, contract
                    ));
                }
            }
            if !page_urls.contains(behavior.page.as_str()) {
                errors.push(format!(
                    "behavior references unknown page `{}`",
                    behavior.page
                ));
            }
        }

        for redirect in &self.redirects {
            if !redirect.from.starts_with('/') {
                errors.push(format!(
                    "redirect `from` must be site-relative: `{}`",
                    redirect.from
                ));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Site {
    pub base_url: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// WordPress locale, e.g. `en_CA`.
    pub locale: String,
    pub permalinks: Permalinks,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subsites: Option<Vec<Subsite>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Permalinks {
    /// WordPress permalink structure, e.g. `/%postname%/`.
    pub structure: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub home_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Subsite {
    pub id: String,
    /// Path prefix with trailing slash, e.g. `/tmh/`.
    pub path: String,
    pub title: String,
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    /// Site-relative path, always leading slash.
    pub url: String,
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub status: PageStatus,
    /// Captured template id; empty string when the site has none.
    pub template: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subsite: Option<String>,
    pub dom: DomSkeleton,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<PageMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seo: Option<PageSeo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub islands: Vec<IslandMount>,
    /// The cascade order for **this** page: `sha256` values resolving to
    /// [`SiteIr::styles`] entries, first-to-last in captured document position.
    ///
    /// This is not [`Style::order`]. `order` is the site-level chain index; it
    /// does not say what one page loads or in what sequence. Emitters MUST use
    /// `style_order`. Optional, so a v1.0/v1.1 document without it stays valid;
    /// absent means the page inherits the site chain in ascending `order`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_order: Option<Vec<String>>,
    /// OPTIONAL prose projection. Never the IR, never an emitter input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prose_markdown: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageStatus {
    Publish,
    Draft,
    Private,
    Pending,
    Future,
}

/// The fidelity carrier: a normalized HTML skeleton with class names preserved
/// byte-for-byte.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomSkeleton {
    pub html: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doctype: Option<String>,
}

/// A mount record. The IR never encodes Rust component internals: the bundle
/// resolves `component` at runtime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IslandMount {
    pub id: String,
    pub component: String,
    pub props: JsonObject,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wp_id: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageSeo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canonical: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub robots: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub og_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub og_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub og_image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json_ld: Option<Vec<JsonObject>>,
}

// ---------------------------------------------------------------------------
// Assets and styles
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub source_url: String,
    pub local_path: String,
    pub sha256: String,
    pub kind: AssetKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referenced_by: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    Image,
    Font,
    Script,
    Document,
    Media,
    Other,
}

/// Where a stylesheet entry came from. Absent means [`StyleOrigin::Linked`],
/// which is the v1.0 shape.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StyleOrigin {
    #[default]
    Linked,
    Inline,
}

/// Ordered, verbatim stylesheet entry. There is deliberately no pruning or
/// cleaned variant.
///
/// [`Style::order`] is the position in the chain counted across **both** linked
/// and inline entries, in captured document order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Style {
    /// Absent means `linked`. Skipped on serialize, so a v1.0 entry round-trips
    /// byte-identically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<StyleOrigin>,
    /// The captured url. Required unless [`Style::origin`] is
    /// [`StyleOrigin::Inline`]; [`SiteIr::validate`] enforces that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub href: Option<String>,
    pub local_path: String,
    /// Hash of the shipped bytes: proves verbatim hand-off.
    pub sha256: String,
    /// 0-based position in the chain. Emitters emit ascending and never reorder.
    pub order: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subsite: Option<String>,
}

impl Style {
    /// True when this entry is an inline `<style>` block rather than a link.
    pub fn is_inline(&self) -> bool {
        self.origin == Some(StyleOrigin::Inline)
    }
}

// ---------------------------------------------------------------------------
// Menus, taxonomies, authors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Menu {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    pub items: Vec<MenuItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MenuItem {
    pub label: String,
    pub href: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<MenuItem>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Taxonomy {
    /// WordPress taxonomy key, e.g. `category`.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hierarchical: Option<bool>,
    pub terms: Vec<Term>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Term {
    pub slug: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Author {
    pub id: String,
    pub slug: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Form {
    pub id: String,
    /// Captured form plugin, e.g. `fluent-forms`.
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    pub fields: Vec<FormField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<FormValidation>,
    pub submit_contract: SubmitContract,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormField {
    /// Submitted name, preserved exactly: the sink envelope depends on it.
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: FormFieldType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiple: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<FormFieldOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation: Option<FieldValidation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FormFieldType {
    Text,
    Email,
    Tel,
    Url,
    Number,
    Textarea,
    Select,
    Radio,
    Checkbox,
    CheckboxGroup,
    File,
    Date,
    Hidden,
    Honeypot,
    Turnstile,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormFieldOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldValidation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_length: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormValidation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub success_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spam: Option<Vec<SpamGuard>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpamGuard {
    Honeypot,
    Turnstile,
}

/// What must survive of a form plugin: the wire contract, not the PHP.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitContract {
    pub sink: SinkKind,
    /// References `apiContracts[].id`.
    pub endpoint_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub honeypot: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turnstile: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SinkKind {
    Webhook,
    Pabbly,
    EmailSes,
    SheetsDirect,
}

// ---------------------------------------------------------------------------
// Behaviors and API contracts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Behavior {
    pub page: String,
    pub selector: String,
    pub kind: BehaviorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub island_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<JsonObject>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BehaviorKind {
    Toggle,
    Tabs,
    Accordion,
    Slider,
    Modal,
    AjaxForm,
    Scroll,
    Copy,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiContract {
    pub id: String,
    pub method: HttpMethod,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_shape: Option<JsonObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_shape: Option<JsonObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

// ---------------------------------------------------------------------------
// Capabilities, redirects, capture
// ---------------------------------------------------------------------------

/// What the capture could and could not represent. `unsupported` exists so an
/// adapter fails loudly instead of silently degrading.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capabilities {
    pub supported: Vec<String>,
    pub unsupported: Vec<UnsupportedCapability>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnsupportedCapability {
    /// Stable capability key, e.g. `wpml`.
    pub capability: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// True when faithful conversion is impossible until this is resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking: Option<bool>,
    /// Page urls affected by this capability gap.
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub where_pages: Option<Vec<String>>,
    /// What proved this finding. Prose in `detail` is not evidence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Vec<CapabilityEvidence>>,
}

/// How a capability finding was proven.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityEvidenceKind {
    RestNamespace,
    DomMarker,
    RestEndpoint,
}

/// Machine-checkable proof of a capability finding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityEvidence {
    pub kind: CapabilityEvidenceKind,
    /// The literal namespace token, matched DOM marker, or endpoint url.
    pub value: String,
    /// Where it was observed, e.g. `/wp-json/` or the route the marker was on.
    pub source: String,
}

/// A security observation about the **source** site. Not a conversion blocker
/// unless `blocking` is true, and never a reason to drop the finding silently.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecurityFinding {
    pub id: String,
    /// Stable finding class, e.g. `public-user-enumeration`.
    pub kind: String,
    pub detail: String,
    /// True when the site must not be published from this IR until resolved.
    pub blocking: bool,
    /// Affected urls when page-scoped; absent for site-wide findings.
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub where_pages: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Redirect {
    pub from: String,
    pub to: String,
    pub code: RedirectCode,
}

/// A real redirect status. Only 301/302/307/308 are representable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct RedirectCode(u16);

impl RedirectCode {
    pub const PERMANENT: u16 = 301;
    pub const FOUND: u16 = 302;
    pub const TEMPORARY: u16 = 307;
    pub const PERMANENT_TEMPORARY: u16 = 308;

    pub fn new(code: u16) -> Result<Self, IrError> {
        match code {
            Self::PERMANENT | Self::FOUND | Self::TEMPORARY | Self::PERMANENT_TEMPORARY => {
                Ok(Self(code))
            }
            other => Err(IrError(format!(
                "redirect code `{other}` is not one of 301, 302, 307, 308"
            ))),
        }
    }

    pub fn get(self) -> u16 {
        self.0
    }

    pub fn is_permanent(self) -> bool {
        matches!(self.0, Self::PERMANENT | Self::PERMANENT_TEMPORARY)
    }
}

impl<'de> Deserialize<'de> for RedirectCode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let code = u16::deserialize(deserializer)?;
        Self::new(code).map_err(serde::de::Error::custom)
    }
}

impl TryFrom<u16> for RedirectCode {
    type Error = IrError;

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

/// Provenance of the IR. Optional, but recommended so two captures can be
/// diffed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    /// Adapter id, e.g. `wp-rest`.
    pub source_adapter: String,
    pub captured_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

// ---------------------------------------------------------------------------
// Conformance tests against the committed JSON fixtures
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = include_str!("../../../tests/fixtures/site-ir/minimal.valid.json");
    const WORDPRESS: &str =
        include_str!("../../../tests/fixtures/site-ir/wordpress-two-subsites.valid.json");
    const MISSING_VERSION: &str =
        include_str!("../../../tests/fixtures/site-ir/invalid-missing-irversion.json");
    const MISSING_PAGE_FIELD: &str =
        include_str!("../../../tests/fixtures/site-ir/invalid-missing-required-page-field.json");
    const UNKNOWN_FIELD: &str =
        include_str!("../../../tests/fixtures/site-ir/invalid-unknown-field.json");
    const BAD_REDIRECT: &str =
        include_str!("../../../tests/fixtures/site-ir/invalid-redirect-code.json");
    const DANGLING_CONTRACT: &str =
        include_str!("../../../tests/fixtures/site-ir/invalid-dangling-api-contract.json");
    const INLINE_STYLES: &str =
        include_str!("../../../tests/fixtures/site-ir/inline-styles.valid.json");
    const INLINE_STYLE_NO_SHA256: &str =
        include_str!("../../../tests/fixtures/site-ir/invalid-inline-style-missing-sha256.json");
    const BAD_STYLE_ORIGIN: &str =
        include_str!("../../../tests/fixtures/site-ir/invalid-style-origin.json");
    const UNKNOWN_STYLE_ORDER_SHA: &str =
        include_str!("../../../tests/fixtures/site-ir/invalid-style-order-unknown-sha256.json");

    fn parse(json: &str) -> Result<SiteIr, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn minimal_fixture_deserializes() {
        let ir = parse(MINIMAL).expect("minimal fixture must parse");
        assert!(is_supported_ir_version(&ir.ir_version));
        assert!(ir.validate().is_ok());
    }

    #[test]
    fn wordpress_fixture_deserializes_and_validates() {
        let ir = parse(WORDPRESS).expect("wordpress fixture must parse");
        assert_eq!(ir.site.subsites.as_ref().map(Vec::len), Some(2));
        assert!(ir.validate().is_ok(), "{:?}", ir.validate());

        let page = ir
            .pages
            .iter()
            .find(|page| page.url == "/tmh/")
            .expect("tmh page");

        // The fidelity carrier: class names survive parse + serialize untouched.
        assert!(page.dom.html.contains("class=\"site-header tmh-header\""));
        let round_tripped = serde_json::to_string(&ir).expect("serialize");
        let again = parse(&round_tripped).expect("re-parse");
        let page_again = again
            .pages
            .iter()
            .find(|page| page.url == "/tmh/")
            .expect("tmh page");
        assert_eq!(page_again.dom.html, page.dom.html);

        // Islands are mount records only.
        let apply_page = again
            .pages
            .iter()
            .find(|page| page.url == "/tmh/apply/")
            .expect("apply page");
        let island = apply_page.islands.first().expect("island mount");
        assert_eq!(island.component, "ApplyForm");
        assert!(island.props.contains_key("formId"));

        // Styles are ordered and verbatim: three sheets, orders 0..2 preserved.
        assert_eq!(again.styles.len(), 3);
        assert_eq!(
            again
                .styles
                .iter()
                .map(|style| style.order)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert_eq!(again.redirects[0].code.get(), 301);
        assert!(again.redirects[0].code.is_permanent());
    }

    #[test]
    fn missing_ir_version_is_rejected() {
        assert!(parse(MISSING_VERSION).is_err());
    }

    #[test]
    fn missing_required_page_field_is_rejected() {
        assert!(parse(MISSING_PAGE_FIELD).is_err());
    }

    #[test]
    fn unknown_field_is_rejected() {
        assert!(parse(UNKNOWN_FIELD).is_err());
    }

    #[test]
    fn bad_redirect_code_is_rejected() {
        assert!(parse(BAD_REDIRECT).is_err());
    }

    #[test]
    fn redirect_code_accepts_only_real_codes() {
        assert!(RedirectCode::new(301).is_ok());
        assert!(RedirectCode::new(308).is_ok());
        assert!(RedirectCode::new(200).is_err());
        assert!(RedirectCode::new(303).is_err());
    }

    #[test]
    fn validate_catches_dangling_api_contract_reference() {
        let mut ir = parse(WORDPRESS).expect("wordpress fixture must parse");
        ir.forms[0].submit_contract.endpoint_ref = "does-not-exist".into();
        let errors = ir.validate().expect_err("dangling contract must be caught");
        assert!(errors.iter().any(|e| e.contains("does-not-exist")));
    }

    #[test]
    fn schema_valid_but_referentially_broken_fixture_is_rejected() {
        // serde (like the JSON Schema) accepts the shape: the reference is a
        // cross-field rule, so only `validate` can reject it.
        let ir = parse(DANGLING_CONTRACT).expect("shape is schema-valid");
        let errors = ir
            .validate()
            .expect_err("referential checks must reject this IR");
        assert!(errors.iter().any(|e| e.contains("no-such-contract")));
        assert!(errors.iter().any(|e| e.contains("/missing-page/")));
    }

    // -- v1.1: additive, so a v1.0 document must still parse and validate ------

    #[test]
    fn supported_versions_cover_the_1x_family() {
        assert!(is_supported_ir_version("1.0.0"));
        assert!(is_supported_ir_version("1.1.0"));
        assert!(!is_supported_ir_version("2.0.0"));
    }

    #[test]
    fn v1_0_style_entry_still_parses_and_gains_nothing() {
        let ir = parse(WORDPRESS).expect("a v1.0 document must still parse");
        assert_eq!(ir.ir_version, "1.0.0");
        assert_eq!(ir.styles.len(), 3);
        for style in &ir.styles {
            assert_eq!(style.origin, None, "a v1.0 entry carries no `origin`");
            assert!(!style.is_inline());
            assert!(style.href.as_deref().is_some_and(|href| !href.is_empty()));
        }
        assert!(ir.security_findings.is_empty());
        assert!(ir.validate().is_ok(), "{:?}", ir.validate());

        // Round-tripping must not invent an `origin: "linked"`, which would
        // rewrite a committed v1.0 artifact on a load/save cycle.
        let json = serde_json::to_string(&ir).expect("serialize");
        assert!(!json.contains("\"origin\""));
        assert_eq!(parse(&json).expect("re-parse").styles, ir.styles);
    }

    #[test]
    fn v1_1_inline_style_entry_parses_without_href() {
        let ir = parse(INLINE_STYLES).expect("the v1.1 fixture must parse");
        assert_eq!(ir.ir_version, "1.1.0");

        // `order` is document position across both linked and inline entries.
        assert_eq!(
            ir.styles
                .iter()
                .map(|style| style.order)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
        assert!(!ir.styles[0].is_inline());
        assert!(ir.styles[0].href.is_some());

        let inline = &ir.styles[1];
        assert!(inline.is_inline());
        assert!(inline.href.is_none(), "inline CSS has no url");
        assert!(!inline.sha256.is_empty(), "the bytes are still hashed");
        assert!(
            !inline.local_path.is_empty(),
            "the bytes still land somewhere"
        );

        ir.validate().expect("the fixture is referentially valid");
    }

    #[test]
    fn v1_1_evidence_and_security_findings_parse() {
        let ir = parse(INLINE_STYLES).expect("the v1.1 fixture must parse");

        let capability = ir
            .capabilities
            .unsupported
            .first()
            .expect("one unsupported capability");
        let evidence = capability
            .evidence
            .as_ref()
            .and_then(|evidence| evidence.first())
            .expect("the finding carries proof");
        assert_eq!(evidence.kind, CapabilityEvidenceKind::RestNamespace);
        assert_eq!(evidence.value, "litespeed/v1");
        assert_eq!(evidence.source, "/wp-json/");

        let finding = ir.security_findings.first().expect("one security finding");
        assert_eq!(finding.id, "public-user-endpoint");
        assert_eq!(finding.kind, "public-user-enumeration");
        assert!(finding.detail.contains("/wp-json/wp/v2/users"));
        assert!(!finding.blocking);
        assert!(
            finding.where_pages.is_none(),
            "a site-wide finding names no page"
        );

        assert_eq!(
            parse(&serde_json::to_string(&ir).expect("serialize")).expect("re-parse"),
            ir
        );
    }

    #[test]
    fn inline_style_without_sha256_is_rejected() {
        // Inline only relaxes `href`; the shipped bytes are still hashed.
        assert!(parse(INLINE_STYLE_NO_SHA256).is_err());
    }

    #[test]
    fn unknown_style_origin_is_rejected() {
        assert!(parse(BAD_STYLE_ORIGIN).is_err());
    }

    #[test]
    fn linked_style_without_href_fails_validation() {
        // serde cannot express the schema's `if origin == inline ... else href`,
        // so `validate` is the enforcement point.
        let mut ir = parse(WORDPRESS).expect("v1.0 fixture must parse");
        ir.styles[0].href = None;
        let errors = ir.validate().expect_err("a linked style needs its href");
        assert!(errors.iter().any(|error| error.contains("href")));
    }

    // -- v1.1: per-page cascade (`page.styleOrder`) ----------------------------

    #[test]
    fn page_style_order_parses_in_document_position() {
        let ir = parse(INLINE_STYLES).expect("the v1.1 fixture must parse");
        let page = ir.pages.first().expect("one page");
        let order = page
            .style_order
            .as_ref()
            .expect("the page carries a cascade");
        assert_eq!(order.len(), 2);
        assert_eq!(order[0], ir.styles[0].sha256);
        assert_eq!(order[1], ir.styles[1].sha256);
        assert!(ir.validate().is_ok(), "{:?}", ir.validate());

        // Round-trip must preserve the per-page array, not re-derive it from the
        // site chain, and must not invent one for a page that has none.
        let json = serde_json::to_string(&ir).expect("serialize");
        assert!(json.contains("\"styleOrder\""));
        let again = parse(&json).expect("re-parse");
        assert_eq!(again.pages[0].style_order, page.style_order);
    }

    #[test]
    fn page_without_style_order_still_parses_and_validates() {
        // A v1.0 document predates the field: absent, never defaulted to `[]`,
        // because an empty array would claim the page loads no CSS at all.
        let ir = parse(WORDPRESS).expect("a v1.0 document must still parse");
        assert!(ir.pages.iter().all(|page| page.style_order.is_none()));
        assert!(ir.validate().is_ok(), "{:?}", ir.validate());

        let json = serde_json::to_string(&ir).expect("serialize");
        assert!(!json.contains("\"styleOrder\""));
    }

    #[test]
    fn validate_catches_unknown_style_order_sha256() {
        // Schema-valid (a 64-hex string) but referentially broken: only a
        // cross-reference check can reject it.
        let ir = parse(UNKNOWN_STYLE_ORDER_SHA).expect("shape is schema-valid");
        let errors = ir
            .validate()
            .expect_err("an unresolved styleOrder sha256 must be rejected");
        assert!(
            errors.iter().any(|e| e.contains("/dangling/")),
            "{errors:?}"
        );
        assert!(
            errors
                .iter()
                .any(|e| e.contains("references unknown style sha256")),
            "the message names the offending reference: {errors:?}"
        );
    }

    #[test]
    fn style_order_can_be_emptied_or_repointed_and_is_rechecked() {
        let mut ir = parse(INLINE_STYLES).expect("the v1.1 fixture must parse");
        ir.pages[0].style_order = Some(Vec::new());
        ir.validate()
            .expect("an explicitly empty chain is consistent, not dangling");

        ir.pages[0].style_order = Some(vec!["f".repeat(64)]);
        let errors = ir
            .validate()
            .expect_err("the repointed hash does not exist");
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].contains("unknown style sha256"));
    }
}
