# Template clustering (P2.2)

"Convert 19 pages" is not a unit of work. Pages come in shapes, and the shape is
what decides how much review, QA and visual-parity coverage the conversion needs.
This document describes how `src/analysis/cluster.ts` measures that, what it
measured on the real capture, and how to re-run it.

**Measured answer: 19 pages → 15 shape templates.** Four shapes are shared by two
pages each; eleven pages have a shape of their own. Numbers, tables and the
disagreement with the WordPress `template` field are below, unrounded.

Output artifact: `capture/template-registry.json` (committed; a test asserts a
re-run reproduces it byte-for-byte).

## What is being measured

The Site IR's `dom.html` for each page, read as page-builder structure only:

```text
section → row → column
```

A page's signature is the ordered list of its **content** sections, each section
being the ordered column counts of its rows. For example, measured from the
capture:

| Route | Signature | Label |
| :--- | :--- | :--- |
| `/mlm/` | `[[2],[3]]` | 2 sections `[2 \| 3]` |
| `/care/sweepy-admin/` | `[[1],[1,4],[1,3],[1,4]]` | 4 sections `[1 \| 1+4 \| 1+3 \| 1+4]` |
| `/tmh/apply/` | `[[1,2],[1,2,1],[1],[1,2,1,3,3],[1],[],[1]]` | 7 sections, one of them empty |
| `/ush/owner/` | `[]` | 0 sections (site chrome only) |

The signature also records, without comparing them:

- `templateClasses` — the sorted `page-template-*` body classes (the WP shell);
- `siteChrome` — the shapes of Divi themes-builder layout sections;
- `sectionCount`, `rowCount`, `columnCount` — the totals the counts imply.

Deliberately **not** in the signature, because each varies with content and would
split one template into many:

| Ignored | Why |
| :--- | :--- |
| Text, `src`, `srcset`, `href`, `alt` | Content, not structure. |
| `et_pb_section_3`, `et_pb_heading_12`, `et_pb_column_3`, `et_pb_button_0_wrapper` | Divi instance numbers, re-emitted on every edit. |
| `page-id-557`, `postid-…`, `menu-item-529`, `wp-image-662` | WordPress identity, different on every page. |
| Module *type* (`et_pb_text` vs `et_pb_blurb`), `et_pb_bg_layout_*` | Presentation of the same slot; the slot is the structure. |

`et_pb_column_1_3` and `et_pb_column_4_4` **survive** the instance-class filter:
the trailing segment of `et_pb_column_1_3` is a fraction, not an index. The rule
is: a token ending in exactly one integer is an instance (`et_pb_heading_12`); a
token ending in two is a column fraction (`et_pb_column_1_3`).

## Site chrome is not the page template

Divi's Theme Builder renders its global footer as a real `et_pb_section`, so 16
of the 19 captured pages end in the same `<footer>` section carrying
`et_pb_section_1_tb_footer`. Counting that as page structure would make every page
look like every other page — it would collapse this measurement to "1 template".

Sections whose class list carries a theme-builder marker (`_tb_footer` /
`_tb_header`) are recorded as `siteChrome` and excluded from the compared shape.
The rule is a marker, not a guess, and the capture corroborates it exactly: the
three pages without that footer are precisely the three pages whose REST
`template` is `page-template-blank.php`.

Two pages are chrome and nothing else: `/ush/owner/` and `/ush/privacy-policy/`
have an empty `div.entry-content` and no page-builder section of their own. They
are reported as `chromeOnlyRoutes` rather than silently measuring as "0 sections
like each other".

## Similarity

Bounded `0..1`, symmetric, order-preserving, and `1` exactly when the structures
are identical:

```text
sectionSim(a, b) = 2·LCS(a.rows, b.rows) / (|a.rows| + |b.rows|)     both empty ⇒ 1
shapeSim(A, B)   = 2·max(Σ matched sectionSim) / (|A| + |B|)         both empty ⇒ 1
```

`LCS` is the longest common subsequence of column counts, so `[1,3]` and `[1,2]`
score `0.5`, and `[1,3]` and `[3,1]` score `0.5` as well (order is respected).
The outer alignment matches sections in order, so adding a section costs part of
the score instead of all of it. Reordering sections is *not* the same shape.

Clustering is **complete-link agglomerative**: the pair with the highest
*minimum* cross-similarity merges first, and a merge only happens at or above the
threshold. Complete-link is chosen because the registry makes a promise to its
reader — "any member of this cluster is the exemplar for the rest" — and
single-link would break it by chaining (`A≈B`, `B≈C`, but `A≉C`). Ties are broken
by the clusters' sorted member routes, so the result does not depend on page
order.

## The threshold is chosen from the data

Across the 19 captured pages there are 171 page pairs. The measured ladder is:

| Score | Pairs | What it means |
| :--- | ---: | :--- |
| `1.000` | 3 | Identical shape: `/mlm/`+`/tmh/`, the two onboard pages, the two chrome-only `/ush/` pages |
| `0.875` | 1 | `/care/sweepy-admin/` + `/care/ttlock-admin/` — the same four sections, one row's column count differs (4 vs 5) |
| `0.800` | 2 | `/care/showings/` against `/resources/sweepy/` and `/tmh/offboard/` — one section each, so the page score is the section score; 2 rows vs 3 rows |
| `0.667` | 12 | A different section count, sharing only a prefix |
| below | rest | Unrelated layouts |

- `0.800` is a **false positive**: those pages have genuinely different content
  blocks and share only a prefix. The threshold must be above it.
- `0.875` is the **cheapest genuine match**: one content block has one more or
  fewer column than its twin. The threshold must not exceed it.

So every threshold in `(0.800, 0.875]` produces the identical partition, and
`CLUSTER_THRESHOLD = 0.85` is the midpoint of that band — the point furthest from
both sides. This is not a round-number guess: a test re-clusters at `0.801`,
`0.82`, `0.85`, `0.86` and `0.875` and asserts the same 15 clusters, and the two
bracket scores are asserted as data (`withinClusterSimilarity.min = 0.875`,
`highestBetweenClusterSimilarity = 0.800`). Below the band, at `0.800`, the false
positive merges and the count drops to 14; above it, at `0.876`, the sweepy/ttlock
pair splits and the count is 16. Both are asserted too, so the band is pinned from
outside as well as inside.

If a future capture moves those scores, the tests fail rather than the threshold
quietly becoming arbitrary.

## The cluster table

```text
template clustering — 19 page(s) → 15 shape template(s)
threshold 0.85 (complete-link, band 0.8 < t <= 0.875)
4 shared cluster(s) covering 8 page(s); 11 page(s) with a shape of their own

id      n  sections  shape                                                  exemplar                members
------  -  --------  -----------------------------------------------------  ----------------------  ----------------------------------------
tpl-01  2  4         [1 | 1+4 | 1+3 | 1+4]                                  /care/sweepy-admin/     /care/sweepy-admin/, /care/ttlock-admin/
tpl-02  2  2         [2 | 3]                                                /mlm/                   /mlm/, /tmh/
tpl-03  2  1         [1+3]                                                  /mlm/onboard-mlm/       /mlm/onboard-mlm/, /tmh/onboard-tmh/
tpl-04  2  0         (site chrome only)                                     /ush/owner/             /ush/owner/, /ush/privacy-policy/
tpl-05  1  2         [1 | 2]                                                /                       /
tpl-06  1  4         [1+3 | 3 | 2 | 2+2]                                    /care/                  /care/
tpl-07  1  1         [1+2]                                                  /care/showings/         /care/showings/
tpl-08  1  1         [1+1+3+3]                                              /care/signal-admin/     /care/signal-admin/
tpl-09  1  10        [1+2 | 1 | 1 | 2+2+2 | 1 | 2+2 | 1 | 1+2 | 1+3+3 | 1]  /mlm/applym/            /mlm/applym/
tpl-10  1  1         [1]                                                    /resources/             /resources/
tpl-11  1  1         [2]                                                    /resources/checklists/  /resources/checklists/
tpl-12  1  1         [1+1+2]                                                /resources/sweepy/      /resources/sweepy/
tpl-13  1  7         [1+2 | 1+2+1 | 1 | 1+2+1+3+3 | 1 | empty | 1]          /tmh/apply/             /tmh/apply/
tpl-14  1  1         [1+2+1]                                                /tmh/offboard/          /tmh/offboard/
tpl-15  1  2         [1 | 1]                                                /ush/thanks/            /ush/thanks/
```

Measured totals: 45 content sections, 76 rows, 137 columns.

This site does **not** have "a few templates with content slots". Divi here is
hand-built page by page, so the honest reading is fifteen skeletons — which is
why the conversion is 15 shapes of review, not 3. It is still a useful
measurement: it says the four shared shapes cover 8 pages, the two application
forms differ from everything (including each other), and the eight pages under
`/care/` and `/resources/` between them contribute 7 of the 15 shapes.

## WP `template` vs DOM shape: both reported

The REST API's `template` field partitions 19 pages into 2 groups. DOM shape
partitions the same 19 into 15. They are different measurements:

```text
wp template              pages  clusters  shapes  chrome
-----------------------  -----  --------  ------  -------------
(none)                   16     12        13      theme-builder
page-template-blank.php  3      3         3       none
```

- **Agreement — the template field predicts the shell.** All 16 pages on the
  default template carry the theme-builder footer; all 3 pages on
  `page-template-blank.php` carry no site chrome at all. 19/19, no exceptions.
- **Divergence — the template field does not predict the layout.** The 16
  default pages fall into 12 shape clusters (13 distinct signatures), and their
  pairwise similarity ranges `0.000`–`1.000`. The 3 blank-template pages are three
  different shapes: `/mlm/applym/` (10 sections), `/tmh/apply/` (7 sections) and
  `/ush/thanks/` (2 sections), with pairwise similarity `0.333`–`0.569` — closer to
  unrelated than to each other. The blank template is a *shell*, not a layout.
- **No cluster mixes WP templates** on this capture: the three blank-template
  pages are so different from each other that they never share a cluster with a
  default page either. The registry still records `wpTemplates` per cluster and
  reports `cluster-mixes-wp-templates` when it happens, so a future page that
  reuses a shape under a different shell is visible instead of silent.

**Both partitions are in `capture/template-registry.json`**: `clusters[].members[]`
carries each page's `template` and `templateClasses`, and
`wpTemplateCrossCheck.groups[]`/`findings[]` carry the template-side view.

### What the divergence implies for the emitter

- **`template` is not a layout key.** Any per-template work — a fixture, a QA
  matrix row, a visual-parity baseline, a CSS carve-out — must key on the
  DOM-shape cluster id, not on `page-template-*.php`.
- **`template` is a valid shell key.** It does predict header/footer/nav
  presence (19/19 here), so it is the right input for deciding whether a page
  ships site chrome — e.g. whether the theme-builder footer section must be
  rendered.
- **Islands cannot be inferred from either.** The two application-form pages
  (`/tmh/apply/`, `/mlm/applym/`) are both blank-template and both structured
  differently, so form islands must come from the extracted form/behaviour
  records, not from a template assumption.
- **Effort scales with 15, not 2.** Anything scheduled per template is 15 units.
  The four shared shapes are the only places where one review covers two pages.

## How to re-run

```powershell
pnpm analyze:templates            # measure, print the table, rewrite the registry
pnpm analyze:templates --check    # write nothing; exit 1 if the committed registry is stale
pnpm analyze:templates --ir <path> --out <path>
```

Exit codes: `0` measured, `1` the IR could not be read as a Site IR (or
`--check` found a stale registry), `2` readable IR with no pages —
`cannot-evaluate`, never "0 templates". A registry with `status:
"cannot-evaluate"` must not be read as a measurement.

The command is pure analysis: it reads `capture/site-ir.json` and nothing else —
no network, no browser. Re-running after a fresh capture is the only step needed
to update the number, and a byte-diff of `capture/template-registry.json` is the
review artefact.

## What a new page must look like to join a cluster

A page joins an existing cluster only if **every** member already in it scores at
least `0.85` against the newcomer (complete-link), and the same content region
rules apply:

1. The page must have a page-builder body: `et_pb_section` elements containing
   `et_pb_row`s containing `et_pb_column`s. A page with no section has an empty
   shape and joins the chrome-only cluster, if one exists.
2. Its **content** section sequence must match — theme-builder sections
   (`_tb_footer`/`_tb_header`) are excluded, so a page reusing a shape under a
   different shell still joins.
3. Rows per section and columns per row must agree, within the similarity budget:
   one row's column count may differ (that is the `0.875` case that keeps
   sweepy/ttlock together); an added or removed section costs enough score to
   break the match at one section of a one-section page.
4. Text, images, links and Divi instance numbers are irrelevant.
5. `page-template-*` classes are irrelevant to membership — they are recorded and
   the cross-check reports a mixed cluster instead of preventing it.

Cluster ids (`tpl-01` …) are assigned by size (largest first) then exemplar route,
so they are stable for a fixed page set but can renumber when the capture changes.
Cite the route, not the id, in anything durable. `exemplarRoute` is the page to
open first for a cluster.

## Limits of this measurement

- It measures **structure**, not difficulty. A single-section page whose one
  section holds a 40-field form can be more work than a ten-section marketing
  page; the registry says how many shapes exist, not how hard each is.
- It reads the captured DOM, so it inherits the capture: two pages agree only as
  far as their capture is faithful.
- Similarity is a heuristic with a measured plateau. It is not a proof of
  equivalence, and it says nothing about CSS, typography or behaviour.
