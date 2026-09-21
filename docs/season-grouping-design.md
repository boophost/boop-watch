# Design: grouping seasons of the same show in `/manage`

**Status:** Stage 1 shipped in v2.103.0 (PR #391), together with the P5 and P7 fixes below.
Stage 2 is designed but deliberately not built — see §4.
**UI mockups:** <https://claude.ai/artifact/QEzfSvhs1CojGGfD3hSW7p> — five artboards: the list today,
Stage 1, Stage 2, the new show page, and the cour page's before/after.
**Scope:** the admin catalog (`/manage` → Catalog list, series detail). The public portal already
groups correctly and is **out of scope** except where it supplies data.

---

## 1. Where we are today

### The data model

A catalog row (`series`) is **one metadata entry**, not one show. For anime that means one MAL
entry, and MAL splits a show **per cour**. The only thing tying cours together is the season
mapping (`server/seasonMap.ts`), which resolves `mal_id → anidb_id → {tvdb_id, season, offset}`
from two public datasets and writes three columns onto the row:

| column | meaning |
|---|---|
| `tvdb_id` | the TVDB **show** — the de-facto grouping key |
| `tvdb_season` | which Jellyfin `Season NN` this cour's episodes land in |
| `episode_offset` | where in that season this cour starts (S1 cour 2 → 11) |
| `mapping_source` | `auto` \| `manual` — manual wins and auto-enrich leaves it alone |

`enrichSeasonMapping()` runs on add (`server/index.ts:845`), on re-sync, and inside the
`enrich.metadata` flow node.

### What each surface does with it

- **Catalog list** (`src/pages/manage/Library.tsx` → `SeriesList.tsx`): a **flat grid of rows**,
  ordered by `added_at`. `tvdb_id` / `tvdb_season` are already in the payload
  (`SeriesEntry`) and **entirely unused by the UI**. This is the thing that's confusing.
- **Series detail** (`src/pages/SeriesDetail.tsx`): per-cour, plus a `SeasonSwitch` chip row added
  in v2.101.0 (PR #387) — `/api/series/:id/status` returns `siblings` (same section, same
  `tvdb_id`, sorted by season then offset) rendered as `[S1 · 1-11] [S1 · 12-23] [S2 · 1-12] …`.
  So **grouping already exists on the detail page** and nowhere else.
- **Public portal** (`server/publicRoutes.ts`): grouping is the *primary* model there —
  `franchiseForSeries()` takes a Jellyfin series and returns every catalog cour belonging to it
  (anchored on `mal_id` → `tvdb_id`, falling back to fuzzy title match), and
  `catalogCoursForSeason()` maps one JF season back to the 1–2 cours that make it up.
  `portalSeriesForCatalog()` is the reverse bridge.
- **Sourcing pipeline** (wants, torrents, library_files, banners, episode caches, chase): keyed on
  **`mal_id`**, i.e. per-cour, deliberately. Grouping must not touch this.

### Real numbers (prod, 2026-09-21)

```
[anime]  rows=33  tvdb_id null=2  distinct tvdb groups=23  multi-row groups=4  rows in them=12
   272849  #52 S1+0 auto    Space Dandy            | #53 S1+13 auto  Space Dandy 2
   352408  #23 S2+0 auto    Slime 2nd Season       | #24 S3+0 auto   Slime 3rd  | #25 S4+0 auto Slime 4th
   371310  #29 S1+0 manual  Mushoku Tensei         | #35 S1+11 manual Part 2   | #30 S2+0 manual Mushoku II
           #36 S2+12 manual Season 2 Part 2        | #27 S3+0 manual Season 3
   418364  #55 S1+0 auto    Witch from Mercury     | #56 S1+12 auto  Witch from Mercury S2 cour
[tv]     rows=6  tvdb_id null=6      (TMDB rows — TMDB seasons *are* library seasons)
[movies] rows=3  tvdb_id null=3
```

Mushoku's own numbers are worth a second look: cour #30 (S2, offset 0) is 13 episodes, so it runs
1–13, while cour #36 starts at **offset 12**, i.e. episode 13. Both claim episode 13. The mapping is
`manual` on all five rows, so this is a hand-entered offset, not a dataset error — and it is
invisible in a flat list, which is a small argument for the whole design.

So: **12 of 33 anime rows (36%) are a cour of something else in the list**, concentrated in four
shows. A "Mushoku" search returns five near-identical long titles. 23 shows read as 33 entries.

### Three facts that shape every option below

1. **`tvdb_id` is missing for brand-new titles.** The two unmapped rows (`KAIJU GIRL CARAMELISE`,
   `The Frontier Lord Begins with Zero Subjects`) are current-season shows not yet in the
   Fribb/ScudLee datasets. Every new seasonal add spends its first weeks ungroupable. Any grouping
   key that *requires* `tvdb_id` must degrade to "own group of one", not vanish.
2. **A group can be missing its anchor.** Slime's catalog rows are S2, S3, S4 — there is no S1 row,
   though the Jellyfin series (`mal 37430`) is S1. A group therefore cannot assume a "first cour"
   exists, and the group's identity cannot be "the S1 row's title".
3. **There is no stored show name.** `tvdb_id` is a number. The candidates for a display name are
   the Jellyfin series name (`portal_items.name`, e.g. *"Mushoku Tensei: Jobless Reincarnation"* —
   nice, but only exists for titles in a Public collection), the earliest cour's title, or an
   admin-entered one.

---

## 2. The problems, stated precisely

| # | Problem | Evidence |
|---|---|---|
| P1 | The catalog list shows cours as peers of shows; count and scanning are both wrong | 33 cards for 23 shows |
| P2 | Sibling cours are scattered — `added_at` order puts Mushoku S1 and S3 far apart | list is `ORDER BY added_at` |
| P3 | Titles don't disambiguate — "…Season 2 Part 2" vs "…Season 2" at a glance | why `SeasonSwitch` labels by *shape*, not title |
| P4 | Adding a show gives no signal that its other cours are already in the catalog | `inCatalog` is per `source_id` only |
| P5 | Per-show settings are edited from an arbitrary cour's page | season titles are keyed on **JF series id**, i.e. already per-show, but live on a per-cour page |
| P6 | Health/chase is per-cour, so "is this show fully imported?" needs 5 page visits | `AttentionBand` / chase chips are per-row |
| P7 | Unmapped rows are invisible as a problem — a null `tvdb_id` looks like a normal row | 2 rows today; the import sink falls back to "Season 1, no offset", which is silently wrong for a later cour |
| P8 | Deleting "the show" means deleting 5 rows one by one | `DELETE /api/series/:id` |

P1–P3 are the stated complaint. P4–P8 are what a grouping design has to not make worse — and
mostly gets to fix for free.

---

## 3. Design space

Four axes, mostly independent: **what the group key is**, **where grouping is materialised**,
**how the group is presented**, and **what moves from cour-level to show-level**.

### 3.1 The group key

**Option K1 — `tvdb_id`, derived (status quo, promoted to the list).**
Already computed, already correct for the four real groups, already what `siblings` uses.
- ✅ Zero schema change; the list payload already carries it.
- ✅ Consistent with the detail page and the portal.
- ❌ Null for new titles (P7) and for *every* TV/movie row — those degrade to singleton groups,
  which is correct behaviour but means the feature does nothing for two of three sections.
- ❌ No override: a wrong dataset merge (or split) can only be fixed by hand-editing `tvdb_id`,
  which also changes **library placement**. Grouping and placement would share one lever.
- ❌ TVDB "absolute ordering" shows have a null `defaulttvdbseason`; they group but can't order.

**Option K2 — a `show_id` FK to a new `shows` table.**
```sql
CREATE TABLE shows (
  id INTEGER PRIMARY KEY,
  section TEXT NOT NULL,
  title TEXT NOT NULL,          -- admin-editable display name
  tvdb_id INTEGER,              -- provenance, not identity
  poster_url TEXT,
  created_at TEXT
);
ALTER TABLE series ADD COLUMN show_id INTEGER;  -- nullable
```
Auto-populated from `tvdb_id` on enrich; an admin can **merge** two shows or **split** a row out.
- ✅ Grouping becomes explicit and fixable, independent of TVDB placement.
- ✅ Gives the group a real name and poster (solves fact 3 without depending on Jellyfin).
- ✅ Works for TV/movies too — a movie *franchise* (Macross films, a trilogy) can be a show, which
  `tvdb_id` can never express.
- ❌ A second identity concept next to `(section, source, source_id)`; two things to keep in sync,
  and a reconcile job (what happens when auto-enrich later learns a `tvdb_id` that contradicts a
  manual merge? — the `mapping_source: 'manual'` precedent answers this: manual wins).
- ❌ Real migration + backfill, and every list/search/detail query grows a join.

**Option K3 — the Jellyfin/portal series id.**
Group by "what the portal shows as one show", via the existing `portalSeriesForCatalog()`.
- ✅ Grouping in `/manage` would be **exactly** what a viewer sees — no second notion of a show.
- ✅ Free display name and poster (`portal_items.name` / `image_url`).
- ❌ Only exists for titles **in a Public collection**. A catalog row being sourced but not yet
  published has no portal item, so it cannot be grouped — backwards, since pre-publication is
  exactly when the admin is working in `/manage`.
- ❌ Depends on the portal sync cache + a fuzzy title fallback; a grouping that changes when
  Jellyfin re-syncs is hard to trust.

**Option K4 — fuzzy title clustering.** Normalised-prefix / token clustering, no ids.
- ✅ Works with no external data, including for new titles.
- ❌ Merges *Macross Plus* / *Macross Zero* / *Macross Delta* — three separate TVDB shows that are
  correctly separate today. The portal already learned this lesson (`titleMatchesFranchise` is a
  last-resort fallback, deliberately anchored to `tvdb_id` first). Not viable alone; usable only as
  a **suggestion** ("these 3 look related — group them?") feeding K2.

### 3.2 Where grouping is materialised

- **M1 — client-side only.** `SeriesList` groups the array it already has by `tvdb_id`. No API
  change at all. Cheapest possible. Breaks down once you want a group-level chase chip or a
  server-side sorted/paginated list.
- **M2 — server-side, in `GET /api/series`.** Return `{ groups: [{ key, title, poster, rows[],
  health }] }` alongside (or instead of) `series`. Lets the server compute aggregate state once
  and keeps the client dumb. Needs a back-compat shape — the QA agent and the MCP CLI read this
  route.
- **M3 — a new resource.** `GET /api/shows` + `GET /api/shows/:key` with `/api/series/:id`
  untouched. Cleanest separation; most surface area. Pairs naturally with K2.

### 3.3 Presentation

**Option P-A — collapsed group card in the list** (mockup):

```
┌────────────────────────────────────────────────────────────┐
│ ▣  Mushoku Tensei: Jobless Reincarnation      5 cours  ⌄   │
│    ───────────────────────────────────────────────────     │
│    S1 · 1–11   S1 · 12–23   S2 · 1–12   S2 · 13–24   S3 ·… │
│    ● complete  ● complete   ● complete  ⚠ 2 missing  ◐ 3/14│
└────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────┐
│ ▣  Frieren Beyond Journey's End                            │
│    28 episodes · complete                                  │
└────────────────────────────────────────────────────────────┘
```
One card per show; a single-cour show renders exactly as today (no new chrome — same principle as
the section switcher and `SeasonSwitch` hiding themselves at n=1). Clicking a season chip goes
straight to that cour's existing detail page. **This alone fixes P1, P2, P3 and most of P6**, and
with K1+M1 it is a one-file change.

**Option P-B — a show page** (`/manage/show/:key`) that owns the seasons.

```
Mushoku Tensei: Jobless Reincarnation            [TVDB 371310] [manual]
Seasons  [S1 ▸ 23 eps]  [S2 ▸ 24 eps]  [S3 ▸ 14 eps]
─────────────────────────────────────────────────────────────────────
▾ Season 1   ·  2 cours  ·  23/23 in library
    1–11   Mushoku Tensei: Jobless Reincarnation      #29  ✔
    12–23  …Part 2                                    #35  ✔
▾ Season 2   ·  2 cours  ·  22/24 in library   ⚠
    …
Show settings:  season titles · artwork · delete show
```
The cour page stays at `/manage/series/:id` for everything cour-scoped (mapping, offset, downloads,
per-episode rows). The show page is the new *default* destination from the list.
- ✅ Gives per-show settings a home (P5) — notably **season titles, which are already keyed on the
  JF series id and are per-show today while living on a per-cour page**.
- ✅ Natural place for "add the missing cour" and group delete (P4, P8).
- ❌ Two page types to maintain; needs a rule for which one a link goes to.

**Option P-C — grouping as a list *mode*.** A toggle (`Group by show` ⇄ `Flat`), URL-persisted like
`?section=`. Low-risk escape hatch; also the honest answer for "I want to see the 2 unmapped rows".
Probably worth having whatever else is chosen, though a default that's right needs no toggle.

**Option P-D — leave the list alone; fix search and add only.** Deduplicate the search dropdown by
show and surface siblings in `AddSeriesModal`. Addresses P3/P4 only. Cheap, but doesn't answer the
actual complaint.

### 3.4 What becomes show-level

| Concern | Today | Should be | Note |
|---|---|---|---|
| Season titles | per-row page, keyed on JF series id | **show** | already show-scoped data on a cour page — a latent bug, two cours of one show edit the same rows |
| Artwork (`series_banners`) | per `mal_id` | **per season**, arguably | the portal serves art per JF season; a per-cour selection for a 2-cour season is a coin flip today |
| Season mapping / offset | per row | **cour** | this *is* the per-cour fact; must stay |
| Wants / torrents / library_files / chase | per `mal_id` | **cour**, aggregated for display | do not touch the pipeline keys |
| MAL metadata, synopsis, episode cache | per `mal_id` | **cour** | correct as-is |
| Delete | per row | **both** — "remove cour" and "remove show" | |

---

## 4. Recommendation

**Ship it in two stages, keyed on `tvdb_id` first.**

### Stage 1 — grouped list (K1 + M1/M2 + P-A + P-C)

Group `SeriesList` by `tvdb_id`, singletons render unchanged, season chips link to the existing
cour pages, `?group=flat` escapes. No schema change, no new route, no pipeline contact. This is
~90% of the felt problem for ~10% of the work, and it is **reversible** — if grouped-by-default
turns out wrong after a week of use, the toggle's default flips back.

Decisions it forces (all small):
- **Group title**: prefer `portal_items.name` when the show is published (nicest, matches the
  portal), else the lowest-`(season, offset)` cour's `title_english ?? title`. Never assume an S1
  row exists (Slime).
- **Group poster**: the same row's `image_url`.
- **Count in the section switcher**: keep counting **rows**, and label the group card `5 cours` —
  the number of things you can act on shouldn't change because of a view mode.
- **Unmapped rows** (`tvdb_id IS NULL`): render as singletons **with a quiet "unmapped" marker**.
  This turns P7 from invisible into visible at zero cost, and the marker is actionable — an
  unmapped row is also a row whose imports can't be placed.

### Stage 2 — the show page + real grouping identity (K2 + M3 + P-B)

Only if Stage 1 proves the shape. Adds `shows`/`show_id` with merge/split, a `/manage/show/:key`
page, show-level season titles and delete, and "this show already has cours in your catalog" in the
add modal. Note K2 subsumes K1: `shows.tvdb_id` keeps the auto path, while `show_id` gives an
override lever that — unlike editing `tvdb_id` — **doesn't also move files in the library**. That
separation is the main argument for Stage 2 ever happening.

**Explicitly not recommended:** K3 (portal-anchored) as the identity — a catalog that can only group
what's already published is backwards for an admin tool. K4 as anything but a suggestion source —
it merges the three Macross shows, which are correctly distinct today.

---

## 5. Open questions

1. **Show vs franchise.** Is *Macross Plus* / *Zero* / *Delta* one entry or three? `tvdb_id` says
   three; a viewer might say one. Stage 1 says three (and that's fine); Stage 2's manual merge is
   the place to answer differently, per-show.
2. **Does TV/movies want this at all?** TMDB rows have one row per show already, with seasons
   inside. Grouping is anime-only in practice — which is an argument for keeping Stage 1 purely
   presentational rather than putting a `show_id` on every row in the table.
3. **Where does a link land?** Portal "view in manage", the QA agent, `mcp/`, and every existing
   bookmark point at `/manage/series/:id`. Stage 2 must keep that working and decide whether the
   list's default click target becomes the show page.
4. **Season-titles bug.** Two cours of one season currently edit the same `portal_season_titles`
   rows from two different pages with no indication. Worth filing as a bug **independently** of
   this design.
5. **Should art move to per-season?** Related but separable; it changes `series_banners`' key and
   touches the portal's serving path. Probably its own design.
6. **Who backfills `show_id`** if Stage 2 happens — a migration over `tvdb_id`, with null-tvdb rows
   left unassigned and adopted on their next successful enrich.

## 6. Suggested issues

- `list: group the catalog by show (Stage 1)` — enhancement, p1
- `series row with no tvdb_id is silently unplaceable and ungroupable` — bug (P7)
- `season titles are show-scoped data edited from a cour page` — bug (P5, question 4)
- `add modal doesn't say the show's other cours are already in the catalog` — enhancement (P4)
- `shows table + merge/split + show page (Stage 2)` — enhancement, blocked on Stage 1
- `Mushoku S2: cours #30 and #36 both claim episode 13` — bug, found while writing this

---

### Appendix: files that matter

| File | Why |
|---|---|
| `src/components/SeriesList.tsx` | the flat grid — Stage 1 lives here |
| `src/pages/manage/Library.tsx` | list page, section switcher, counts |
| `src/pages/SeriesDetail.tsx` | cour page; `SeasonSwitch` at :1035, season-mapping editor at :1080 |
| `src/components/series/SeasonSwitch.tsx` | the grouping UI that already exists |
| `server/seriesStatus.ts:120-240` | `SeriesSibling` + how siblings are resolved and ordered |
| `server/seasonMap.ts` | where `tvdb_id` / season / offset come from, and the manual-override rule |
| `server/publicRoutes.ts:60-165` | `franchiseForSeries`, `catalogCourForSeries`, `portalSeriesForCatalog` |
| `server/db.ts:54-89, 588-610` | the mapping columns and `setSeasonMapping` |
| `server/index.ts:483-501, 757+, 845` | list route, add route, enrich-on-add |
