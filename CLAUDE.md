# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A generator that produces two static French-language pages for Pokemon GO PvP:

1. `rankings_fr.html` — top picks per league (Super/Hyper/Master), scraped from pvpoke.com and enriched with French names/sprites/move names from PokeAPI.
2. `battle_fr.html` — an interactive battle simulator (pick a Pokemon, set IVs/level/moveset/shields, see how it fares against each league's meta) that runs pvpoke.com's own battle engine client-side, vendored verbatim into this repo, so results match pvpoke.com exactly (same engine, same data, same opponent list, full shield/bait AI).

## Commands

```bash
python sync_engine.py   # vendor pvpoke's engine JS + gamemaster/rankings data into vendor/pvpoke/
python pvpoke_fr.py      # generate rankings_fr.html, vendor/pvpoke/data/i18n_fr.json, and battle_fr.html
./generate.sh            # convenience wrapper: runs both of the above in order
```

`sync_engine.py` must run first — `pvpoke_fr.py`'s i18n builder and `battle_fr.html`'s engine `<script>` tags both depend on `vendor/pvpoke/` being populated. Neither script takes arguments or has a package-manager dependency beyond the Python 3 standard library (`urllib`, `json`, `math`, `time`, `re`, `html`, `os`). Both fetch live data from the network, so running them requires internet access. `pvpoke_fr.py` takes a while — it walks every Pokemon and move in the full gamemaster (~1700 species, ~330 moves) through PokeAPI with rate-limiting sleeps between requests, so a full run is on the order of 30-45+ minutes. `sync_engine.py` is comparatively fast (a handful of file downloads).

There is no test suite, linter, or CI check to run against this repo. `test_engine.js` (Node, run via `node test_engine.js`) is a standalone headless smoke test for the vendored battle engine + `gamemaster_shim.js` — not part of the generated site, useful when changing `gamemaster_shim.js` or after `sync_engine.py` pulls an upstream engine change, to catch integration breaks (missing globals, API shape changes) before they show up in the browser. The only automated job is the GitHub Actions workflow below.

```bash
./serve.sh [port]       # serve the repo over HTTP (default port 8934) and open battle_fr.html
```

`serve.sh` is for manually testing `battle_fr.html` in a browser (species search, IV/moveset form, running a battle) against whatever's already on disk in `vendor/pvpoke/` — it doesn't run `sync_engine.py`/`pvpoke_fr.py` for you, so re-run those first if you need fresher data. It kills anything already bound to the port before starting, waits for the server to actually respond before opening the browser, and stops the server on exit/Ctrl+C.

## Architecture

### `pvpoke_fr.py` — rankings page + French i18n data

Organized top-to-bottom as a pipeline:

1. **Network fetch** (`fetch_json`) — generic JSON GET helper used for both pvpoke.com and pokeapi.co.
2. **Move name lookup** (`get_move_fr`, `prefetch_moves`) — translates PvPoke move IDs to French via PokeAPI's `/move/{id}` endpoint. `GO_TYPE_VARIANTS` handles GO-only composite moves (Weather Ball, Hidden Power) that don't exist as single PokeAPI moves — they're built from a base move name + a French type suffix. `MOVE_API_OVERRIDES` patches the handful of move IDs whose PvPoke slug doesn't match PokeAPI's slug. Results are memoized in `_move_cache` since many Pokemon share moves.
3. **Pokemon name/sprite lookup** (`get_pokemon_info`) — resolves PvPoke `speciesId` (e.g. `landorus_therian`, `necrozma_dusk_mane`) to a French display name and official-artwork sprite URL. `FORM_SUFFIX_MAP` strips PvPoke form suffixes (`_shadow`, `_galarian`, `_mega`, ...) and maps them to both a French label suffix and a PokeAPI slug suffix, since the two naming schemes diverge for forms. Falls back to a title-cased slug if PokeAPI has no French name. Memoized in `_info_cache`.
4. **IV/CP computation** (`calc_cp`, `find_best_ivs`, `CPM_TABLE`) — brute-forces the best IV spread (0-15 per stat) and level for a given CP cap by maximizing stat product, replicating PvPoke's "rank 1 IVs" logic locally rather than fetching it. For Master League (no CP cap), it skips the search and just uses level 51 / 15-15-15.
5. **Row building** (`build_league_rows`) — combines gamemaster base stats + rankings + move/name lookups into per-Pokemon row dicts.
6. **HTML generation** (`build_cards`, `build_html`) — pure string templating (f-strings), no template engine. Renders CSS-only tabs (radio inputs + sibling selectors, no JS) for the three leagues, with all styling inlined in a `<style>` block.
7. **i18n export** (`build_i18n_json`) — walks *every* Pokemon and move in the vendored `gamemaster.json` (not just the top-N ranked ones) via the same `get_pokemon_info`/`get_move_fr`/`prefetch_moves` helpers, and writes `vendor/pvpoke/data/i18n_fr.json` (`{"pokemon": {speciesId: {name, sprite}}, "moves": {moveId: name}}`). This is what `battle_fr.html` reads client-side to show French labels over the engine's English-only data. This is the slow part of a full run — PokeAPI has no French name for very new species (Paldea forms, Paradox Pokemon) or some composite move variants, which log as `[pokemon miss: ...]`/`[move miss: ...]` and fall back to a title-cased slug; this is expected, not a bug.
8. **Battle page HTML** (`build_battle_html`) — generates `battle_fr.html`: French form controls (species/IV/level/moveset/shield/bait pickers) plus the same CSS-only tab pattern as `build_html`, then `<script src>`s the vendored engine files in dependency order followed by `gamemaster_shim.js` and `battle_driver.js`.

### `battle_fr.html` — client-side battle simulator

The engine runs entirely in the browser (IVs/moveset are chosen at runtime, so results can't be precomputed at build time). Load order matters and is hardcoded in `build_battle_html`:

```
vendor/pvpoke/engine/DamageCalculator.js
vendor/pvpoke/engine/ActionLogic.js
vendor/pvpoke/engine/TimelineEvent.js
vendor/pvpoke/engine/TimelineAction.js
vendor/pvpoke/engine/DecisionOption.js
vendor/pvpoke/engine/Battle.js
vendor/pvpoke/engine/Pokemon.js
vendor/pvpoke/engine/TeamRanker.js
gamemaster_shim.js
battle_driver.js
```

- **`vendor/pvpoke/engine/*.js`** — pvpoke's own battle engine (`Battle`, `Pokemon`, `DamageCalculator`, `ActionLogic` for shield/bait AI, `TeamRanker` for ranking one Pokemon against a whole league, timeline/decision classes), vendored verbatim by `sync_engine.py`. This is what makes results match pvpoke.com exactly — it's their code, their data, their opponent list.
- **`gamemaster_shim.js`** (hand-written, NOT vendored) — replaces pvpoke's real `GameMaster.js`, which is jQuery/DOM/localStorage-coupled and the only engine-adjacent file that is. Implements just the surface the vendored files actually call: `getInstance()`, `.data`/`.rankings`, `getPokemonById`, `getMoveById`, `getCupById`, `getFormat`, `loadRankingData`, `generateFilteredPokemonList` — loading from the same-origin vendored JSON via `fetch()` instead of `$.ajax` against pvpoke.com.
- **`battle_driver.js`** (hand-written) — wires the above together: populates the species picker and move pickers, reads the form on submit, builds a `Pokemon` from the user's inputs, and calls `ranker.setTargets([])` + `ranker.rank([poke], cp, cup)` — the empty target list makes `TeamRanker` fall back to `gm.generateFilteredPokemonList()` against the "all" cup, i.e. pvpoke's own full opponent set for that league, not an approximation. Also defines two page-level globals that pvpoke's *own* battle page defines inline in its HTML (not in any engine file) but that `TeamRanker.js`/`Pokemon.js` reference directly: `getDefaultMultiBattleSettings()` and a `settings` object (`matrixDirection`, `hardMovesetLinks`, etc.). If a future `sync_engine.py` pull adds a new bare-global reference like this, `node test_engine.js` will surface it immediately as a `ReferenceError`.
  - The species picker is a text input (`#species-search`) with a live-filtered suggestions dropdown (`#species-suggestions`, French name substring match, sprite + keyboard nav), not a plain `<select>` — the full gamemaster is too long to scroll through. The canonical `speciesId` is tracked in a hidden `#species-select` input so the rest of the driver (`onSpeciesChange`, `buildUserPokemon`) can keep reading `.value` from one place regardless of how it was set. Picking a suggestion (click or Enter) calls `selectSpecies(speciesId)`, which updates both the hidden value and the visible search text and re-triggers the moveset dropdowns.
- Renders three league tabs (reusing `build_html`'s CSS-only tab pattern) with a win/loss matchup list, French names/sprites from `i18n_fr.json`.

### Data flow / sources

- Rankings + base stats + elite move flags, plus the full gamemaster and battle engine, come from pvpoke.com / pvpoke's GitHub repo (`sync_engine.py` → `vendor/pvpoke/`).
- French names, sprites, and move translations come from pokeapi.co.
- `TOP_N` (36) controls how many ranked Pokemon per league appear on `rankings_fr.html`; `battle_fr.html`'s species picker and `i18n_fr.json` cover the entire gamemaster, not just the top-N.

### Output

`.github/workflows/rankings.yml` runs daily at 08:00 UTC (or on manual dispatch): `sync_engine.py` refreshes `vendor/pvpoke/`, then `pvpoke_fr.py` generates both pages, then everything (`rankings_fr.html` → `index.html`, `battle_fr.html`, `battle_driver.js`, `gamemaster_shim.js`, `vendor/`) is deployed straight to GitHub Pages via `actions/upload-pages-artifact` + `actions/deploy-pages`. Nothing is committed back to the repo — the generated site lives only in the Pages deployment, not in git history. (This replaced an earlier setup that committed `docs/index.html` daily, which spammed the commit log; Pages must be configured in repo Settings → Pages with source "GitHub Actions", not "Deploy from a branch".)

### Adding support for a new move or form quirk

When PvPoke introduces a new composite move or a new regional/mega form, the fix is almost always a one-line addition to `GO_TYPE_VARIANTS`, `MOVE_API_OVERRIDES`, or `FORM_SUFFIX_MAP` rather than new logic — check there first if a Pokemon/move renders with a fallback (title-cased slug) instead of its proper French name. This applies to both `rankings_fr.html` and `battle_fr.html`/`i18n_fr.json`, since they share the same lookup functions.

### Re-syncing the vendored engine (`sync_engine.py`)

`ENGINE_FILES` in `sync_engine.py` lists exactly which files get pulled from `pvpoke/pvpoke@master` into `vendor/pvpoke/engine/` — everything battle-simulation-related except `GameMaster.js` (replaced by `gamemaster_shim.js`, since it's the only engine-adjacent file with jQuery/DOM/localStorage coupling). Files are vendored verbatim and overwritten on every run; don't hand-edit anything under `vendor/pvpoke/`. `vendor/pvpoke/VERSION` records the upstream commit SHA pulled.

If pvpoke changes its engine in a way that breaks this integration — a new bare global referenced by a vendored file (like `settings`/`getDefaultMultiBattleSettings`, both defined inline on pvpoke's real page rather than in any engine file, and hand-ported into `battle_driver.js`), a renamed/removed engine file, or a changed `GameMaster` method signature — `node test_engine.js` is the fastest way to catch it locally before it reaches the browser.
