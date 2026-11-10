# Static emitter (`src/emit/static-html/`)

Site IR → a complete static tree under `dist/site/`. This is the `--emit static`
baseline: no islands, no bootloader, no host knowledge. `--emit islands` must be this
output **plus** mount slots and lazily loaded bundles, so anything that changes here
changes there.

```powershell
pnpm emit:static                 # build + emit dist/site/ + dist/emit-static.report.json
pnpm emit:static --no-assets     # pages and CSS only, no media copy
```

`dist/` is generated output and is **gitignored**. The tree is reproducible from
`capture/site-ir.json`, `capture/asset-rewrite-map.json` and `capture/assets/**`, so
no build artifact is ever committed. `dist/site/` is the deployable directory for a
later `src/deploy/` bead; nothing in it knows which host receives it.

## Inputs

| Input | Why |
| :--- | :--- |
| `capture/site-ir.json` | pages (`dom.html`, `styleOrder`, `islands`), `styles[]`, `assets[]`, `site.baseUrl` |
| `capture/asset-rewrite-map.json` | captured url → mirrored local path; the only rewrite table |
| `capture/assets/media/<localPath>` | every `assets[]` blob, hash-checked before it is copied |
| `capture/assets/styles/<localPath>` | linked stylesheet bytes (**7** files) |
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
| `dist/emit-static.report.json` | the per-page table and totals, machine-readable |

Two files cannot coexist at one path: every write claims its output path first, so a
route and an asset that would collide is a build failure.

## The three transforms

Everything else is the captured bytes.

1. **Cascade rebuild.** All captured `<link rel="stylesheet">` tags are removed from
   `<head>` and the page's `styleOrder` is emitted as one contiguous block where the
   first link stood: `origin: "linked"` → `<link rel="stylesheet" href="…">`,
   `origin: "inline"` → `<style>` wrapping the captured bytes. Order, count and origin
   are asserted against `styleOrder` before the page is written; a mismatch is a build
   failure, not a warning.

   *Why one block:* the capture deleted the inline `<style>` nodes, so their
   interleaved positions between non-CSS head elements are not recorded anywhere.
   Reconstructing them would be invention. What is recorded — and what cascade
   actually depends on — is the order of the CSS itself, which is preserved exactly.

   Non-stylesheet head elements (`<meta>`, `<title>`, `<link rel="preload|icon">`, …)
   keep their captured bytes and their relative order.

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

3. **Nothing else.** The body is the captured body, byte for byte: tags, attribute
   order, class lists, whitespace and text. No wrapper divs, no reordering, no fixes.
   Navigation links (`<a href>`), `<meta content>` images and scheme-less anchors are
   left exactly as captured, including the live site's own defects.

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
  explained by a map entry;
- every emitted `<style>` is the captured file with only url bodies substituted (and
  the verbatim wrapper is unit-tested separately);
- every body element, attribute and class list matches the capture, with value changes
  allowed only on the four asset-bearing attributes, and each changed value must
  resolve to a real file in the tree;
- every rewritten reference resolves on disk — the only unresolvable references are the
  three known `href="chatgpt.com"` anchors the live site itself ships.

## Known gaps, reported not hidden

- **Deferred CSS.** Divi emits `<link rel="preload" as="style"
  onload="this.rel='stylesheet'">` for per-page dynamic CSS. Those are not
  `rel="stylesheet"` links, so they are preserved as captured and their CSS was never
  captured by B1.3: they still point at the source host. Deferred-CSS capture is a
  separate bead.
- **Navigation links** are not rewritten; anchors still point at the live site.
- **`<meta content="…">` image references** (e.g. `msapplication-TileImage`) are not
  asset references in this bead's scope and stay absolute.
- **Extensionless stylesheet paths.** Three captured Google Fonts sheets have no
  extension. A missing `.css` is appended *in the same directory*, because a host that
  sniffs nothing would serve them as `application/octet-stream` and a browser refuses
  to apply that as CSS. Renaming in place cannot invalidate a relative `url(...)`.
