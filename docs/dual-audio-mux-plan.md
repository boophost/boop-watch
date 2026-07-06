# Plan: Dual-audio combination flow (`enrich.mux-tracks`)

## Problem this solves

The Library-import upgrade flow wants **playable dual-audio** episodes. But the
two goals conflict on the indexers:

- **Dual-audio** anime releases skew **English-named** and skew **AV1 / HEVC
  10-bit** (encoded for small size).
- Our Jellyfin transcodes on a **Tesla T4 (Turing)** which **cannot hardware-
  decode AV1** (AV1 NVDEC is Ampere+). So an AV1 source forces a CPU software
  decode that stalls playback (black screen), and re-encoding 28 AV1 episodes to
  h264 costs ~5–8h on a saturated 6-core node — lossy and slow.

Net: a *ready-made, playable (h264/HEVC), dual-audio* release is often scarce.

## The idea: manufacture a dual-audio file instead of finding one

Most sub-only releases (e.g. SubsPlease WEB) are **h264 + Japanese audio** —
perfectly playable on the T4. Separately, a dual release we already have (or can
grab) carries the **English dub** track. So:

> Take the **playable h264 video + Japanese audio** from release A, **mux in the
> English audio (and/or subs)** from release B → one file that is **h264,
> dual-audio, and needs no video transcode.**

The mux is a **container remux** (`ffmpeg -map … -c copy`): seconds per episode,
lossless, no GPU/CPU-transcode. This is strictly better than transcoding AV1.

Concretely for Frieren: our library already holds the BlackRabbit BD file with
`jpn` + **`eng` Opus** audio (streams 1 and 2). We only need a playable h264
video to attach that `eng` track to.

## The load-bearing risk: A/V sync across sources

Audio from release B only lines up with video from release A if they share the
**same edit and framerate**. Failure modes:

- **Different framerate** (23.976 vs 25) → progressive drift. Rare for same-
  source anime, but must be checked.
- **Different cut** (BD uncensored / different intro-logo cards / recap trims vs
  WEB) → a **constant or piecewise offset**. Common for BD-vs-WEB pairs.
- **Same edit** → lines up directly, or with a single constant delay.

**This plan is gated on a sync test** (see "Validation", below). Outcome decides
the shape of the node:

- Clean / constant-offset → build the node with an optional `audioOffset`
  (single `-itsoffset`). Ship it.
- Piecewise / drifting → cross-source muxing is unreliable for BD↔WEB; **do not**
  auto-mux. Fall back to allowing **HEVC** dual releases (T4 HW-decodes HEVC) or
  grabbing an h264 dual directly. Park the node.

## The node: `enrich.mux-tracks`

A new ffmpeg node, sibling to `enrich.extract-subs` / `enrich.media-probe`
(`server/flowNodes.ts`). Category `enrich`.

**Purpose:** given a primary file (video + its own audio) and a donor file,
produce a new file = primary video + selected donor audio/subtitle tracks,
stream-copied (no re-encode).

**Inputs:** `in` (one stream). Each item must carry the primary file path and the
donor file path as fields.

**Outputs:** `muxed` (success — item now points at the new file) / `skipped`
(donor missing / no matching donor track / mux error — original file untouched).

**Config:**

| key | default | meaning |
|---|---|---|
| `fileField` | `file_path` | primary file (video source; kept as-is) |
| `donorField` | `donor_path` | the file to steal tracks from |
| `audioLang` | `eng` | ISO code(s) of the donor **audio** track to add (empty = none) |
| `subLang` | `` | ISO code(s) of donor **subtitle** track to add (empty = none) |
| `audioOffset` | `0` | seconds to shift the donor audio (`-itsoffset`); constant-delay correction |
| `outDir` | `` | where the muxed file lands (empty = `DATA_DIR/work`) |
| `setDefaultAudio` | `jpn` | which audio language to flag `default` in the output (player pref) |

**Behavior (per item):**
1. Probe both files (reuse the `ffprobe` pattern from `media-probe`). Resolve the
   donor audio track index by `audioLang` (and sub by `subLang`). If none, →
   `skipped`.
2. Build an ffmpeg command:
   ```
   ffmpeg -i <primary> [-itsoffset <audioOffset> -i <donor>]
     -map 0:v -map 0:a            # primary video + its audio
     -map 1:a:<donorAudioIdx>     # donor audio (if audioLang set)
     [-map 1:s:<donorSubIdx>]     # donor sub (if subLang set)
     -c copy
     -disposition:a:<jpnIdx> default   # setDefaultAudio
     <outDir>/<name>.mkv
   ```
   MKV container (holds any codec combo; Opus+h264+ASS all fine).
3. On success set `file_path` = new file, add `mux_added_audio` / `mux_added_sub`
   notes → `muxed`. On any ffmpeg error → `skipped`, original untouched.

**Conventions to match** (from existing nodes):
- `execFileP('ffprobe'|'ffmpeg', …)` with a timeout + `maxBuffer` (see
  `media-probe` / `extract-subs`).
- `str/num/bool` config helpers; `allInputs(inputs)`; `ctx.notes.push(...)` for
  the Activity log; `ctx.dryRun` short-circuits before writing.
- Register in `IMPLS` + it auto-appears in the editor palette and `NODE_SPECS`.

## How it fits the Library-import flow

Add the mux **on the upgrade path, before the sub extract/import**, fed the
donor file. Two ways to source the donor English track, in preference order:

1. **We already have a dual copy in the library** (our exact case): the current
   AV1 BlackRabbit file *is* the donor for its own English track. The upgrade
   then becomes: grab a **playable h264 sub release** → mux in the `eng` track
   from the existing library file → replace. No dub-hunting needed.
2. **No dub on hand:** a second `enrich.torrent-search` (dub/dual release) feeds
   the donor path; `combine.*` pairs primary+donor per episode.

Because the flow already keys imports by show+season+episode and overwrites in
place (hardlink-safe), the muxed h264 dual file replaces the AV1 one exactly as
the sub→dual swap did before.

Pairing primary↔donor **per episode** uses the existing `combine.group-pick` /
`transform.compute` `{mal_id}|{torrent_episode}` key primitive — no new
domain-specific combine node.

## Validation — DONE, PASSED (2026-07-06, Frieren S1E01)

Test pair: `[SubsPlease] Sousou no Frieren - 01 (1080p)` (h264/aac/jpn, WEB) as
primary video; our library `BlackRabbit … S01E01` (AV1/opus, jpn+**eng**, BD) as
donor for the English dub.

**Framerate + duration:** both `24000/1001` fps; durations 1559.99s vs 1560.91s
(Δ0.9s). Same edit, same framerate.

**Audio cross-correlation** (JP-vs-JP, since same performance ⇒ its offset == the
offset the dub needs), mono 8kHz windows, 30s each:

| window | BR audio vs SP audio | corr peak |
|---|---|---|
| start (~75s) | +39.5 ms | 0.994 |
| mid (~765s) | −44.6 ms | 0.954 |
| end (~1455s) | +80.1 ms | 0.970 |

Offsets are **non-monotonic and within ±80 ms** → **no systematic drift** (drift
would be monotonic); the ±40–80 ms is scene-dependent correlation variance. Very
high peaks confirm it's genuinely the same audio. **±80 ms is inside dub
lip-sync tolerance** (perceptibility ≈125 ms audio-lag). ⇒ **zero offset is
fine**; `audioOffset` stays as an optional escape hatch.

**Actual mux verified:** `ffmpeg -i SP -i BR -map 0:v:0 -map 0:a:0 -map 1:a:1
-c copy` produced a valid **h264 + jpn(aac) + eng(opus)** MKV, full 1560s, in
**13 seconds** (stream copy, no re-encode). vs ~5–8h to transcode the AV1.

**Verdict: cross-source muxing is viable for same-source (WEB/BD, same edit)
pairs. Build the node.** The `-c copy` + `-itsoffset` design below is confirmed.

## Scope / non-goals

- No video re-encode, ever — that's the whole point.
- Not a general remuxer UI; one node with the fields above.
- Image subs (PGS) aren't handled (same as extract-subs) — text/ASS only for the
  sub side.
- If the sync test fails for BD↔WEB, prefer **HEVC dual** acquisition (T4
  HW-decodes HEVC) over muxing; keep this node for same-source pairs only.

## Deliverables checklist

- [x] Sync-test result recorded (offset constant? value?) — **gates the rest**
      (2026-07-06: same edit/framerate, ±80 ms non-monotonic, zero offset fine)
- [x] `enrich.mux-tracks` node in `server/flowNodes.ts` + registered
      (v2.24.1; idempotent re-run guard added in v2.24.2)
- [x] Donor field threaded via a generic `combine.join` (left-join by
      `group_key`, copies donor `file_path` → `donor_path`) — no domain node
- [x] Library-import seed graph: **Option 2** wired. Scoring is now
      playability-first (`import_score = playable*2 + dual`, playable = non-AV1);
      a playable-sub winner + a dubbed loser for the same episode → `combine.join`
      → `enrich.mux-tracks` → import. Dubbed losers are kept as donors; the donor
      hunt allows AV1 and only fires for shows with no dub on hand (fed by the
      "no donor" join output, so a muxed show doesn't re-hunt).
- [x] `npm run build:all`; both nodes unit-tested; `validateGraph` passes; full
      executor **dry-run** over representative episodes routes correctly
      (playable-sub+av1 → muxed; playable-dual → as-is; lone sub → import + hunt)
- [x] Version bump (2.24.1 → 2.24.2), committed to `dev`, verified on staging
      (rollout green, both nodes served by `boop-watch-dev`'s node-types).
      **dev→main PR still to open** once live multi-run settling is observed.
- [x] Clean up: no `synctest` qBit torrent exists (only the legit BlackRabbit
      AV1 dual, which is the Frieren donor — kept)

## Still to validate on real data (not doable in one session)

The node + mux are proven (real Frieren mux ran in 13 s; routing dry-run is
green). What a single session **can't** prove is the multi-*scheduled-run*
settling on live torrents: run N hunts + queues an AV1 donor, run N+1 (after it
downloads) pairs it with the kept playable-sub and muxes. Watch a real pass on
staging (donor category = `anime`, same as primary) before the `dev → main` PR,
and confirm: the AV1 donor is **not** imported as a winner, the muxed h264 file
replaces in place, and the donor torrent isn't deleted out from under the mux.
