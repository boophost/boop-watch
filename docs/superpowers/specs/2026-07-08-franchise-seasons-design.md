# Franchise seasons — design

**Date:** 2026-07-08  
**Status:** Approved for implementation (approach 1)

## Problem

1. Manage pipeline for a multi-season cour (Slime S4) showed **24/13 playable** and chased **Ep 25** — on-site matching keyed only by episode number, so S1’s E1–E24 collided with S4.
2. Ghost Public titles (*Slime Diaries*, raw Erai Mushoku folder) appeared after Library import wrote release-named folders; portal sync never deletes rows that left the JF collection.
3. Wanted UX: franchise browse with season picker; related seasons via Jikan; watch/list scoped to the current season; recent rail uses exact season.

## Approach

**Franchise library + cour catalog**

- Keep one Jellyfin show folder with `Season N` (season-map / Library import).
- Catalog: one `/manage` row per MAL cour; `tvdb_season` scopes pipeline + chase to that JF season.
- Portal: one Public JF series; browse shows franchise poster → season picker. Recent entries keep `S·E` labels for the exact cour. (No Jikan “related” strip.)
- Season picker: poster cards (JF season art via `/img/:id/season/:n`) with the full season name + episode count, not bare `S·N` chips.
- Watch sidebar / title episode list: only the current season’s episodes. Watch `manageId`/chase are season-scoped like the catalog route, so an uncatalogued season never shows another cour’s chase stub.
- Sync: prune portal items not in the current Public collection; refuse release-looking folder names in import + collection add.

## Non-goals

- Physically splitting Slime into per-cour library folders.
- TVDB-based related grouping (use Jikan/MAL relations).
