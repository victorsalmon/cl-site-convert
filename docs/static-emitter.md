# Static emitter (`src/emit/static-html/`)

Site IR → a complete static tree under `dist/site/`. This is the `--emit static`
baseline: no islands, no bootloader, no host knowledge. `--emit islands` must be this
output **plus** mount slots and lazily loaded bundles, so anything that changes here
changes there.

```powershell
pnpm emit:static                 # build + emit dist/site/ + dist/emit-static.report.json
pnpm emit:static --no-assets     # pages and CSS only, no media copy

# A deployment declares its own canonical origin and (once it exists) its form sink:
node dist/emit/static-html/index.js --base-url https://site.upscalehavens.ca --form-sink /api/submit
```

`dist/` is generated output and is **gitignored**. The tree is reproducible from
`capture/site-ir.json`, `capture/asset-rewrite-map.json` and `capture/assets/**`, so
no build artifact is ever committed. `dist/site/` is the deployable directory for a
later `src/deploy/` bead; nothing in it knows which host receives it — except the
canonical links, which are told, on purpose (§ Self-containment).

## Inputs

| Input | Why |
| :--- | :--- |
| `capture/site-ir.json` | pages (`dom.html`, `styleOrder`, `islands`), `styles[]`, `assets[]`, `site.baseUrl` |
| `capture/asset-rewrite-map.json` | captured url → mirrored local path; the only rewrite table |
| `capture/routes.manifest.json` | the 19 route paths, so navigation can target them |
| `capture/assets/media/<localPath>` | every `assets[]` blob, hash-checked before it is copied |
| `capture/assets/styles/<localPath>` | linked stylesheet bytes (**7** files) |
| `capture/assets/styles/deferred/<sha256>.css` | captured Divi deferred sheets (**11** files for 18 links) |
| `capture/assets/styles/inline/<sha256>.css` | inline `<style>` block bytes (**48** files) |

Every byte read is verified against the IR's recorded `sha256` before use. A drifted
capture fails at emit; it is never shipped on trust.

## Output

| Path | Contents |
| :--- | :--- |
| `dist/site/index.html` | `/` |
| `dist/site/<route>/index.html` | `/care/` → `dist/site/care/index.html` (pretty URLs, WP permalink shape) |
| `dist/site/<localPath>` | each `assets[]` blob at its mirrored site path |
| `dist/site/<localPath>` | each linked stylesheet, with its own `url(...)` targets rewritten |
| `dist/emit-static.report.json` | the per-page table, the self-reference before/after table and the allowlist, machine-readable |

Two files cannot coexist at one path: every write claims its output path first, so a
route and an asset that would collide is a build failure.

## The four transforms

Everything else is the captured bytes.

1. **Cascade rebuild.** All captured `<link rel="stylesheet">` tags **and every
   deferred `<link rel="preload" as="style">` whose bytes the page's cascade carries**
   are removed from `<head>`, and the page's `styleOrder` is emitted as one contiguous
   block where the first of them stood: `origin: "linked"` → `<link rel="stylesheet"
   href="…">`, `origin: "inline"` → `<style>` wrapping the captured bytes. Order,
   count and origin are asserted against `styleOrder` before the page is written; a
   mismatch is a build failure, not a warning. A deferred preload whose href the
   cascade does **not** carry is genuinely unknown: it is preserved byte-identical and
   reported (`preservedDeferredLinks`), never dropped.

   *Why one block:* the capture deleted the inline `<style>` nodes, so their
   interleaved positions between non-CSS head elements are not recorded anywhere.
   Reconstructing them would be invention. What is recorded — and what cascade
   actually depends on — is the order of the CSS itself, which is preserved exactly.

   *Why a deferred link is replaced rather than kept:* its CSS is now shipped from
   the tree, so leaving the `onload="this.rel='stylesheet'"` preload as well would load
   the same bytes twice. The replacement keeps the captured `id` and `media` (Divi's
   `divi-dynamic-css` node keeps its identity) and drops only `as` and `onload`.

   Non-stylesheet head elements (`<meta>`, `<title>`, `<link rel="icon">`, …) keep
   their captured bytes and their relative order.

2. **Asset references.** `img[src]`, `img[srcset]`, `source[srcset]`, `link[href]` and
   `url(...)` inside linked and inline CSS are re-pointed through
   `asset-rewrite-map.json`. Rewritten values are **relative**: `"../".repeat(depth)`
   plus the mapped path, where depth is the page's directory depth for HTML and inline
   CSS, and the stylesheet's directory depth for a linked file. The same artifact
   therefore works at a host root, under a preview subpath, or from `file://`.

   Two derivations sit on top of an exact key match, both deterministic: a
   protocol-relative url (`//host/path`, Divi's `@font-face` style) resolves through
   `site.baseUrl`'s scheme, and a `?query`/`#fragment` suffix is looked up without the
   tail and re-attached verbatim.

3. **Self-reference localisation** (`./localise.ts`, § Self-containment below). Every
   absolute reference to the captured origin becomes site-root relative; form actions
   point at a configured sink; meta images localise through the asset map; canonical
   links stay absolute on the per-target `--base-url`.

4. **Nothing else.** The body is the captured body, byte for byte: tags, attribute
   order, class lists, whitespace and text. No wrapper divs, no reordering, no
   deletions, no fixes. External references (`signal.org`, `www.youtube.com`,
   `support.hp.com`, `sweepy.com`, `mailto:`, …) are untouched, and so is the live
   site's own defect —
   the scheme-less `href="chatgpt.com"` anchors stay broken exactly as captured.

## Self-containment

B2.1 shipped a *mirror*: asset references were portable but 352 absolute
`https://upscalehavens.ca/…` references still pointed home. On a `*.pages.dev` preview
that meant every internal click jumped back to the live WordPress site and every form
posted to production. The transform that fixes it, and what it deliberately does not
touch:

| Reference | Emitted form | Why |
| :--- | :--- | :--- |
| `a[href]` to a captured route | `/care/` (site-root relative, query and fragment preserved) | the target exists in the tree; portable across hosts and subpaths |
| `a[href]` to anything else on the source host | `/feed/`, `/wp-json/…` | a WordPress endpoint that does not exist on the static host is still an internal reference: absolute would leak traffic to production |
| `link[rel=canonical]` | absolute, on `--base-url` | **SEO**: a canonical URL must be absolute, and a preview must not declare the apex |
| `form[action]` | the configured sink (`--form-sink`, default `/api/submit`) | never post to the live WordPress install |
| `meta[content]` pointing at a captured image | relative path from the asset map | `msapplication-TileImage` is a real image reference |
| `link[rel=preload][as=style]` (Divi deferred CSS) | replaced by a `link[rel=stylesheet]` from the cascade, or preserved if uncaptured | its bytes are captured; leaving the preload too would load the CSS twice |
| `img[src]`/`srcset` the capture does not hold | **untouched, reported** | the live site 404s it; there is nothing to point at |

**`--base-url` is per target, and the default is a trap.** It defaults to the captured
origin so a local emit stays faithful, but a preview deployment emitted with the default
would publish `https://upscalehavens.ca/…` canonicals from `*.pages.dev` and tell search
engines the new site duplicates the old one. The preview and the apex **must** be
emitted with different values; the emitter prints a `note:` when they differ and the
report records the origin it used.

**`--form-sink` defaults to an endpoint that does not exist.** `/api/submit` is the
contract the forms-sink bead will implement. A submitted form therefore 404s — loudly
and harmlessly — instead of writing to the live WordPress site. Any deployment that
ships forms must pass a real sink. Note that all 18 captured forms are the theme's
`method="get"` search form; the Fluent Forms submissions are not in the captured DOM
(they are reached by query string), so the forms bead owns those separately.

### The allowlist, and why it is not a weakened test

`tests/emit-static-selfcontained.test.ts` measures the residual absolute
self-references in the emitted tree and asserts the set **equals**
`tests/fixtures/self-contained/allowlist.json` exactly. Every entry is then justified
independently — never by asking the emitter:

| Category | Count | Reason |
| :--- | ---: | :--- |
| `canonical` | 19 | SEO requires absolute; rewritten to `--base-url` |
| `unlocalisable` | 3 | the live site 404s them, so no bytes exist to localise (2 distinct images on `/mlm/applym/`) |

The `deferred-css` category is **empty** as of `cl-site-convert-mzi`: all 18 deferred
references were captured and are emitted from the cascade, so a deferred survivor is
now a defect rather than an allowlisted exception. The category itself stays in the
classifier because an *unknown* deferred link (one the capture never fetched) is still
preserved-and-reported rather than dropped.

Anything else that survives is a defect: the emitter itself throws
`LocalisationError: … is not a canonical URL, a deferred-CSS asset, or an unlocalisable
asset — it is a localisation defect, not an allowlist entry`, and the test fails. A
mutation that leaves one anchor absolute is therefore red twice — at emit and at test.

### Deferred CSS, measured and placed (`capture:deferred-css`)

Divi's per-page dynamic CSS is emitted as
`<link rel="preload" as="style" onload="this.rel='stylesheet'">`, so a capture that
only looks for `rel="stylesheet"` misses it. The deferred pass closes that:

```powershell
pnpm capture:deferred-css
# = build + capture the bytes + extend capture/style-chain.json + project the IR
```

It re-fetches each page politely (serialised, ≥600 ms apart, robots-aware, read-only),
recovers the **whole** style element sequence in document order — linked, inline and
deferred interleaved — and requires the existing part of that sequence to equal the
page's `styleOrder` exactly. A page that drifted fails the capture instead of
receiving a guessed position. Each deferred href is fetched once, stored under
`capture/assets/styles/deferred/<sha256>.css`, and deduplicated by sha256: 18
references collapsed to 11 files, 128,679 B total → 96,121 B on disk.

The chain is extended by a **stable topological merge** of the existing chain path plus
every page sequence, so existing entries keep their relative order (27 shifted index)
and each new entry lands where that page's document had it: 9 of the 18 land mid-cascade
(position 4 on seven pages; position 9 on `/mlm/applym/` and `/tmh/apply/`), the other
nine are last because their documents put them last. The per-page report
(`capture/deferred-css.capture-report.json`) records each position and the total-vs-
unique byte count, and `tests/deferred-css.test.ts` re-derives both from the IR.

## What is proved, and how

`tests/emit-static-site.test.ts` emits the committed capture once and asserts against
the bytes on disk:

- all 19 routes exist at their pretty-URL paths;
- the emitted `<head>` sequence equals `page.styleOrder` exactly (count, order,
  origin), with expected origins re-derived from the capture rather than from the
  emitter's resolver;
- zero `<script>` tags and zero mount slots on every page (`bundlesForHtml` against a
  no-bundles manifest returns `[]`; a page that mounts anything is refused);
- captured vs emitted CSS differs **only** inside `url(...)` bodies, each change
  explained by a map entry — for the 7 document-linked sheets, the 11 captured
  deferred sheets and the 116 inline blocks alike;
- every captured deferred preload link is gone and its bytes are a cascade stylesheet
  link on disk (18 links, 0 surviving `onload="this.rel='stylesheet'"`);
- every emitted `<style>` is the captured file with only url bodies substituted (and
  the verbatim wrapper is unit-tested separately);
- every body element, attribute and class list matches the capture, with value changes
  allowed only on the asset-bearing attributes **and** the four localised attributes
  (`a[href]`, `link[href]`, `form[action]`, `meta[content]`), each re-derived from the
  captured value by the test itself;
- every rewritten reference resolves on disk — the only unresolvable references are the
  three known `href="chatgpt.com"` anchors the live site itself ships.

`tests/emit-static-selfcontained.test.ts` adds: navigation, forms, canonicals under two
base URLs, meta images, the allowlist equality and its composition, external references
and the mutation probe.

Both suites are unit-level evidence. The **gate-level** proof is separate and stricter:
`pnpm validate:parity` (`src/verify/parity/`) treats `capture/site-ir.json` as the
authority and proves the whole emitted tree is *equivalent* to it — body and head trees,
CSS bytes in the captured cascade order, asset hashes, residual allowlist equality, the
zero-script rule and a cross-page leak check. It is a deterministic equivalence, not a
screenshot diff; what that does and does not cover is `docs/fidelity-gate.md`.

## Known gaps, reported not hidden

- **WordPress discovery links now 404 instead of leaking.** `rel="alternate"` feeds,
  `wp-json`, `xmlrpc.php` and `shortlink` are localised to site-root paths that the
  static host does not serve. They are head metadata nobody fetches on page load, and
  they were already unusable on a static host; the alternative — leaving them absolute
  — would keep pointing a preview at production. Pruning them is a fidelity decision
  this emitter does not take unilaterally.
- **The forms sink is a contract, not an implementation.** `/api/submit` does not exist
  yet.
- **`<meta content>` values that are not image references are still untouched**, even
  when they look like URLs: only values the asset map knows are localised, and the rest
  are reported as unlocalisable rather than guessed at.
- **`srcset` candidates the map does not know are left absolute and reported.** The two
  broken gallery images on `/mlm/applym/` are the whole of that set.
- **Extensionless stylesheet paths.** Three captured Google Fonts sheets have no
  extension. A missing `.css` is appended *in the same directory*, because a host that
  sniffs nothing would serve them as `application/octet-stream` and a browser refuses
  to apply that as CSS. Renaming in place cannot invalidate a relative `url(...)`.
