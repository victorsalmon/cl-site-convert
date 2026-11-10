# The fidelity gate (`src/verify/parity/`)

```powershell
pnpm validate:parity      # builds dist/site, then verifies it
pnpm gate                 # step 13 of 13
```

**Exit codes.** `0` every page is equivalent; `1` the artefact drifted (or the run
failed); `2` **cannot evaluate** — `capture/site-ir.json` or `dist/site` is missing.
Exit 2 is never a pass: a gate that cannot run is not a green gate
(cl-common ADR 0012).

The gate **builds what it verifies**: `validate:parity` runs `pnpm emit:static` first,
so a stale `dist/site` can never be certified.

## The claim: deterministic equivalence, not screenshot similarity

The emitter does not re-implement layout. It replays the captured DOM and ships the
captured CSS **bytes** in the captured cascade order. There is no layout engine in the
conversion path to disagree with a browser.

So the fidelity claim is an identity:

> if the emitted DOM tree, the CSS bytes and the cascade order are identical to the
> capture, then rendering is identical **by construction**.

That is what this gate measures, per page, with the Site IR
(`capture/site-ir.json`, v1.1) as the **authority** and `dist/site/` as the artefact.

A pixel diff is the weaker instrument, and it is treated as one: it samples a handful
of viewports and interaction states, and it can pass while a rule is silently missing.
It is designed below as an **opt-in secondary stage** and is deliberately not
installed (a real-browser driver downloads a binary at install time, which
`docs/01-DECISIONS.md` forbids).

## What the gate checks

| Check | What it proves | Where it lives |
| :--- | :--- | :--- |
| `artefact-set` | the tree serves exactly the routes the IR declares — no extra, no missing | `index.ts` |
| `document-shell` | doctype and `<html>` attributes are the captured ones (quirks mode cannot change) | `index.ts` |
| `body-tree` | tags, attribute names **in order**, class lists and text nodes are identical, apart from the closed set of permitted reference rewrites | `tree.ts`, `dom.ts` |
| `head-tree` | the same, for the head outside the rebuilt cascade block | `tree.ts`, `index.ts` |
| `cascade` | the style sequence equals `page.styleOrder` in count, order and origin, and every block is the captured bytes outside `url()` | `cascade.ts` |
| `assets` | every local file the page references exists, and matches its recorded `sha256` | `assets.ts` |
| `residuals` | surviving absolute self-references equal the committed allowlist **exactly** | `allowlist.ts` |
| `scripts` | a page that mounts no island carries no `<script>` and asks for no bundle | `index.ts` (via `islands/mounts`) |
| `cross-page-leak` | no page carries content that belongs to a different page | `leak.ts` |

The report is written to `dist/parity-report.json` (`dist/` is gitignored) and a
per-page table is printed. Every check names itself in a failure, which is what makes
the failure actionable and the negative proof possible.

### The permitted differences, and nothing else

`body-tree` is only credible if its permitted set is closed. Each expected value is
**re-derived from the captured value and the capture's own data** — never by asking
the emitter what the answer should be:

| Difference | Rule |
| :--- | :--- |
| `img[src]`, `img[srcset]`, `source[srcset]`, `link[href]` | must equal the path `capture/asset-rewrite-map.json` prescribes, relative to the page; `srcset` candidates are compared one by one with their descriptors |
| `a[href]`, `link[href]` to the source host | must equal the site-root-relative form of the captured path — `navigation` when the target is a captured route, `internal-path` when it is a WordPress path the static host does not serve (`/feed/`, `/wp-json/`) |
| `form[action]` to the source host | must equal the configured sink (`/api/submit` by default) |
| `link[rel=canonical][href]` | must equal `${base-url}` + the captured path |
| `meta[content]` naming a captured image | must equal the asset-map path relative to the page |

Everything else fails: a tag, an attribute name, an attribute's **order**, a class
token, a text node, an unclassified value, or a mapped path the verifier cannot
re-derive. The comparison stops at the first difference and reports its node path
(`html > body > div#et-boc > section.et_pb_section[2]`), because the second difference
is almost always a consequence of the first.

### Why the cascade check compares bytes, not hashes

`styles[].sha256` hashes the **captured** file. The emitter legitimately rewrites
`url()` bodies inside both inline blocks and linked stylesheets, so an emitted file's
raw hash is *not* the recorded one — and asserting it would be a false requirement
that could only be satisfied by weakening the check.

So the contract is stated precisely:

1. the captured bytes must hash to the recorded `sha256` — a capture that drifted from
   its own record certifies nothing;
2. every byte of the emitted block **outside** `url()` must be identical to the
   capture;
3. every `url()` that moved must be the substitution the asset map prescribes,
   resolved relative to the page (inline) or to the stylesheet's own directory
   (linked).

Which is stronger than a hash: it says *what* changed and *why*, and a reordering
reports as *"this position ships the CSS captured at position 1 — the cascade order
drifted"* rather than a 200-character byte diff.

The stylesheet's emitted **location** is deliberately not part of the claim. What
matters is that the bytes at that location are the bytes the capture recorded, so a
swapped pair is caught by the bytes.

### The residual allowlist is not a second source of truth

`tests/fixtures/self-contained/allowlist.json` is the committed allowlist, and the
emitter's own acceptance suite asserts against the same file. The gate reads it and
requires **set equality**:

- measured residual = allowlisted residual (no more, no fewer);
- every entry is justified independently: the captured document must contain the value
  verbatim, a canonical must name its own route, and anything else may only survive
  because the asset map has no entry for it.

Composition of the committed capture: **19 canonical, 18 deferred CSS, 3
unlocalisable**. A fourth category, or a new absolute self-reference, fails.

### The cross-page leak, and why tree equality cannot catch it

Every page is compared against *its own* IR entry. A page assembled from the wrong
template — or a node pasted in from a sibling route — is still self-consistent if the
IR describes that route the same way. So one check is derived only from the capture: a
token an `id`, or a run of text of at least 24 characters — that appears in **exactly
one** captured page is unique to that page, and no emitted page may carry a token that
is unique to a different one.

On the committed capture that is 271 unique tokens: at least one unique `id` on every
page, and 5–50 unique text runs on most of them. Text shared across pages (the header,
the nav, the footer) is not a leak and is not treated as one.

## What the equivalence does NOT cover

The claim is exact about the things it names, and silent about nothing else. These are
outside it, and no amount of green changes that:

1. **Font rasterisation and glyph fallback.** The gate proves the `@font-face` rules
   and the font files are the captured bytes. It cannot prove the browser on the
   visitor's machine rasterises them identically: hinting, gamma and synthetic bold
   vary by OS, GPU and browser build.
2. **Externally hosted resources.** Google Fonts, YouTube, `signal.org`, `sweepy.com`
   and every other third-party asset are copied byte-identically as *references* and
   never fetched. If the third party changes or removes them, the emitted page changes
   with them. That is why `capture/asset-rewrite-map.json` mirrors what it can and why
   the unresolved ones are allowlisted rather than hidden.
3. **Browser bugs and version drift.** Two browsers given identical DOM and CSS can
   still disagree (grid sub-pixel rounding, sticky-positioning quirks, `:has()` support
   differences). Equivalence makes the *input* identical; it makes no promise about a
   rendering engine's implementation.
4. **Anything that needs JavaScript to render.** Static emission ships zero scripts, so
   any content a script would create is absent from both the capture and the artefact
   — identical, and equally missing. The live case is the **Fluent Forms
   conversational mount**: the form on `/tmh/apply/` is rendered by
   `conversationalForm.js` at runtime, so the captured DOM holds the mount, not the
   questions. The gate will report that page as equivalent *and it will still be
   missing the form*. That gap belongs to the forms/island beads, not here —
   deliberately stated so a green gate is never read as "the form works".
5. **Behaviour.** Hover transitions, sticky nav, accordions and dropdowns are CSS and
   DOM, so their *inputs* are proven; their *behaviour under a real pointer* is not.
   That is the pixel-diff stage's territory, below.
6. **Deferred Divi CSS.** `<link rel="preload" as="style" onload="…">` was never
   captured (bead `cl-site-convert-mzi`), so those 18 references stay absolute and
   allowlisted. The gate asserts they are *exactly* those 18 — it cannot assert CSS it
   does not have.
7. **Accessibility and semantics.** The gate proves parity with the capture, including
   the capture's own defects: the scheme-less `href="chatgpt.com"` anchors are
   reproduced faithfully rather than fixed. Parity is not quality.
8. **Responsive breakpoints as separate artefacts.** There is nothing viewport-specific
   to compare: the same CSS ships to every viewport, so a media-query layout is proven
   byte-wise, not rendered.
9. **The attributes of an inline `<style>` element itself.** The capture recorded every
   inline block's element id (`#global-styles-inline-css`, `#et-critical-inline-css`, …)
   in `capture/style-chain.json` as `detail` plus a `sourceElementSha256`, but the IR
   has no field to carry it, so the emitter ships `<style media="…">` with the id
   dropped. Rendering is unaffected — no CSS rule depends on a stylesheet element's own
   id — but it *is* a head-byte difference the gate cannot see, because the cascade
   block is excluded from `head-tree` by construction. Recorded as a recommendation in
   the B5.1 report; fixing it needs a schema field (`schemas/` is a separate owner).

## The opt-in pixel diff (designed, not installed)

Status in every report: `pixelDiff.status = "not-run"`, `stage = "secondary"`.

**Why it is secondary.** It samples. A viewport matrix of six widths and five
interaction states is thirty renders of nineteen pages — 570 comparisons that still
miss the seventh width, the third hover, the `:focus-visible` state a keyboard user
sees. It also has to *tolerate* differences (antialiasing, font availability,
sub-pixel rounding), so its threshold is a judgement call that can hide a real defect.
Equivalence has no threshold and no sampling: it is the same bytes. When the two
disagree, the pixel diff is the one that is wrong.

**Why it is still worth designing.** It covers exactly what equivalence cannot: real
rasterisation, real fonts, real layout under a pointer, and it can catch a *capture*
defect (the capture itself missing a rule) that a replay faithfully reproduces.

### Viewport matrix

| Name | Width × height | Why |
| :--- | :--- | :--- |
| `mobile-s` | 360 × 800 | smallest common phone; Divi's `max-width: 479px` band |
| `mobile-l` | 414 × 896 | larger phone, still the mobile band |
| `tablet` | 768 × 1024 | Divi's tablet band (`980px` cap) |
| `laptop` | 1280 × 800 | the primary desktop band |
| `desktop` | 1536 × 864 | wide desktop; the widest band before Divi's `1405px` container cap |
| `wide` | 1920 × 1080 | the "does it centre" case |

Device pixel ratio 1, reduced-motion **off** for the primary run and **on** for a
second pass (a site that animates a hero must be compared in the same motion state).

### Interaction-state matrix

Per page, per viewport, the same states, applied deterministically:

| State | How it is reached |
| :--- | :--- |
| `default` | navigation complete, `networkidle`, fonts ready (`document.fonts.ready`), 250 ms settle |
| `hover-primary` | pointer over the first primary-nav item |
| `focus-visible` | keyboard focus on the first focusable element in `<main>` |
| `nav-dropdown-open` | click the first nav item that has a submenu, then wait for the transition |
| `accordion-open` | click the first `[class*="et_pb_toggle"]` heading, wait for the transition |
| `form-visible` | only on pages carrying a form: scroll the first form into view (the Fluent Forms island is *expected to differ* — see the allowlist) |

Each state is a separate baseline image, named
`<route>__<viewport>__<state>.png`, so a state that never rendered is visible as a
missing baseline rather than a silent pass.

### Threshold

Per-pixel comparison in CIELAB space with a perceptual metric, not raw RGB:

- **per-pixel tolerance**: ΔE ≤ 2.0 (below the just-noticeable difference; absorbs
  antialiasing and sub-pixel rounding);
- **per-image budget**: at most **0.1 %** of pixels may exceed the per-pixel tolerance;
- **structural requirement**: no region larger than 24 × 24 px may be entirely above
  tolerance, which is what catches a missing rule (a whole block shifting) even when
  the pixel *count* stays under budget.

A page fails if any state fails. The metric and its numbers are recorded with the
baseline, so a threshold change is a reviewed commit, not a quiet tweak.

### Baseline policy and the per-page allowlist

Baselines are generated **from the capture, not from the artefact** — rendering the
captured DOM + captured CSS in the same browser — so the diff compares the artefact to
the original, never to itself. They are committed as PNGs (or as a content-addressed
hash plus a regenerated artifact) and regenerated only by an explicit command that
prints every image whose baseline moved.

The allowlist is per page **and per state**, and every entry carries a reason and an
expiry:

| Entry | Reason |
| :--- | :--- |
| `/tmh/apply/` `form-visible` | Fluent Forms conversational mount is JavaScript-rendered; the static arm ships the mount, not the questions |
| any page, `hover-*` | a CSS transition captured mid-flight is not a layout difference; the comparison waits for `transitionend` and this entry only absorbs a known non-terminating animation |
| any page, `wide` | a fluid container that rounds differently at 1920 is accepted as ≤ ΔE 3.0 |

An allowlisted failure is still **printed** as an allowlisted failure. An allowlist
entry with no expiry date is a gate defect, not a waiver — the same rule as ADR 0012.

### Why not install it here

Playwright, Puppeteer, Steel-in-a-container and Browserless clients all resolve a
browser binary at install time (or need a hosted browser). This repository's security
posture is official-distribution-only, pinned, and no npm package that downloads a
binary at install time (`docs/01-DECISIONS.md`, 2026-11-11). The stage therefore stays
a design until that posture changes — and when it changes, it arrives as its own bead
with its own threshold review, because it is the *secondary* check.

## Reading a failure

```
FAILURES (2):
  [body-tree] /care/ @ html > body > div#et-boc > section.et_pb_section[2]
    class list differs
    expected: et_pb_section et_pb_section_2 et_pb_with_background
    actual  : et_pb_section et_pb_section_2
  [cascade] /care/ @ html > head > style[3]
    this position ships the CSS captured at position 4 — the cascade order drifted
```

The check id says which contract broke, the path says where, and the expected/actual
pair says what the captured authority demanded. Nothing in the message asks the reader
to trust the emitter.
