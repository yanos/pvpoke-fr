# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-script generator that produces a static French-language HTML page ranking the top Pokemon GO PvP picks for all three leagues (Super/Hyper/Master). It scrapes live rankings from pvpoke.com and enriches them with French names/sprites/move names from PokeAPI, then renders one self-contained HTML file.

## Commands

```bash
python pvpoke_fr.py
```

This is the only command in the project — no build step, no package manager, no dependencies beyond the Python 3 standard library (`urllib`, `json`, `math`, `time`, `re`, `html`). It fetches live data from the network, so running it requires internet access and takes a while (PokeAPI calls are rate-limited with `time.sleep` between requests). Output is written to `rankings_fr.html` in the working directory.

There is no test suite, linter, or CI check to run — the only automated job is the GitHub Actions workflow below.

## Architecture

Everything lives in `pvpoke_fr.py`, organized top-to-bottom as a pipeline:

1. **Network fetch** (`fetch_json`) — generic JSON GET helper used for both pvpoke.com and pokeapi.co.
2. **Move name lookup** (`get_move_fr`, `prefetch_moves`) — translates PvPoke move IDs to French via PokeAPI's `/move/{id}` endpoint. `GO_TYPE_VARIANTS` handles GO-only composite moves (Weather Ball, Hidden Power) that don't exist as single PokeAPI moves — they're built from a base move name + a French type suffix. `MOVE_API_OVERRIDES` patches the handful of move IDs whose PvPoke slug doesn't match PokeAPI's slug. Results are memoized in `_move_cache` since many Pokemon share moves.
3. **Pokemon name/sprite lookup** (`get_pokemon_info`) — resolves PvPoke `speciesId` (e.g. `landorus_therian`, `necrozma_dusk_mane`) to a French display name and official-artwork sprite URL. `FORM_SUFFIX_MAP` strips PvPoke form suffixes (`_shadow`, `_galarian`, `_mega`, ...) and maps them to both a French label suffix and a PokeAPI slug suffix, since the two naming schemes diverge for forms. Falls back to a title-cased slug if PokeAPI has no French name. Memoized in `_info_cache`.
4. **IV/CP computation** (`calc_cp`, `find_best_ivs`, `CPM_TABLE`) — brute-forces the best IV spread (0-15 per stat) and level for a given CP cap by maximizing stat product, replicating PvPoke's "rank 1 IVs" logic locally rather than fetching it. For Master League (no CP cap), it skips the search and just uses level 51 / 15-15-15.
5. **Row building** (`build_league_rows`) — combines gamemaster base stats + rankings + move/name lookups into per-Pokemon row dicts.
6. **HTML generation** (`build_cards`, `build_html`) — pure string templating (f-strings), no template engine. Renders CSS-only tabs (radio inputs + sibling selectors, no JS) for the three leagues, with all styling inlined in a `<style>` block.

### Data flow / sources

- Rankings + base stats + elite move flags come from pvpoke.com's public JSON API (`gamemaster/pokemon.json` and `rankings/all/overall/rankings-{cp}.json`).
- French names, sprites, and move translations come from pokeapi.co.
- `TOP_N` (36) controls how many ranked Pokemon per league are included.

### Output

`.github/workflows/rankings.yml` runs daily at 08:00 UTC (or on manual dispatch), runs `python pvpoke_fr.py`, and deploys the resulting HTML straight to GitHub Pages via `actions/upload-pages-artifact` + `actions/deploy-pages`. Nothing is committed back to the repo — the generated page lives only in the Pages deployment, not in git history. (This replaced an earlier setup that committed `docs/index.html` daily, which spammed the commit log; Pages must be configured in repo Settings → Pages with source "GitHub Actions", not "Deploy from a branch".)

### Adding support for a new move or form quirk

When PvPoke introduces a new composite move or a new regional/mega form, the fix is almost always a one-line addition to `GO_TYPE_VARIANTS`, `MOVE_API_OVERRIDES`, or `FORM_SUFFIX_MAP` rather than new logic — check there first if a Pokemon/move renders with a fallback (title-cased slug) instead of its proper French name.
