# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A generator that produces two static French-language pages for Pokemon GO PvP:

1. `rankings_fr.html` — top picks per league (Super/Hyper/Master), scraped from pvpoke.com and enriched with French names/sprites/move names from PokeAPI.
2. `battle_fr.html` — an interactive tool (pick a Pokemon, set IVs/moveset) that, for each league, auto-maxes its level to the highest CP those IVs allow under that league's cap and looks up its rank in pvpoke.com's precomputed rankings, using pvpoke's own vendored `Pokemon`/`Battle` classes client-side so the level/CP math matches pvpoke.com exactly. No live battles are simulated — there's no opponent list or shield/bait AI involved.

## Commands

```bash
python update_name_cache.py   # refresh vendor/pvpoke/data/name_cache.json from PokeAPI (standalone, no other prerequisite)
python sync_engine.py         # vendor pvpoke's engine JS + gamemaster/rankings data into vendor/pvpoke/
python pvpoke_fr.py           # generate rankings_fr.html, vendor/pvpoke/data/i18n_fr.json, and battle_fr.html
./generate.sh                 # convenience wrapper: runs update_name_cache.py, then sync_engine.py, then pvpoke_fr.py, in that order
```

`update_name_cache.py` is standalone and is the **only** script that ever queries PokeAPI. It fetches its own copy of the live gamemaster (`https://pvpoke.com/data/gamemaster.min.json`, the same one `sync_engine.py` vendors) rather than reading `vendor/pvpoke/`'s copy, so it has no prerequisite and can run before anything else with no setup. That matters because it's the slow, PokeAPI-rate-limited step: a cold cache means walking every Pokemon and move in the full gamemaster (~1700 species, ~330 moves) with rate-limiting sleeps between requests, on the order of 30-45+ minutes. It writes confirmed lookups to `vendor/pvpoke/data/name_cache.json` (see the cache section below). `pvpoke_fr.py` **never** talks to PokeAPI itself — it only ever reads whatever `update_name_cache.py` already resolved into that cache file, falling back to a formatted slug for anything genuinely still missing there. `generate.sh` calls `update_name_cache.py` as its first step for this reason.

`sync_engine.py` must run before `pvpoke_fr.py` — `pvpoke_fr.py`'s i18n builder and `battle_fr.html`'s engine `<script>` tags both depend on `vendor/pvpoke/` being populated. None of the three scripts take arguments or have a package-manager dependency beyond the Python 3 standard library (`urllib`, `json`, `math`, `time`, `re`, `html`, `os`). All three fetch live data from the network, so running them requires internet access. Because `generate.sh` runs `update_name_cache.py` first, the cache is already warm by the time `pvpoke_fr.py` runs, so a `./generate.sh` run only pays PokeAPI's cost once, up front, for species/moves that are new or previously failed — the `sync_engine.py`/`pvpoke_fr.py` steps after it are comparatively fast (mostly file downloads + local computation).

Neither `update_name_cache.py`, `pvpoke_fr.py`, nor `generate.sh` does any git operations — all three are pure generation, no git awareness, so `generate.sh` is safe to run repeatedly with no side effects beyond the files it writes. Committing `vendor/pvpoke/data/name_cache.json` (if it changed) is entirely up to the caller: the CI workflow (see below) does that itself as an explicit step, calling `update_name_cache.py` directly rather than going through `generate.sh`, specifically so it can commit/PR that one file before spending any time on the rest of the pipeline. Running `generate.sh` locally won't commit anything on its own — `git add`/`git commit` it yourself if you want to keep a locally-refreshed cache.

There is no test suite, linter, or CI check to run against this repo. `test_engine.js` (Node, run via `node test_engine.js`) is a standalone headless smoke test for the vendored battle engine + `gamemaster_shim.js` — not part of the generated site, useful when changing `gamemaster_shim.js` or after `sync_engine.py` pulls an upstream engine change, to catch integration breaks (missing globals, API shape changes) before they show up in the browser. The only automated job is the GitHub Actions workflow below.

```bash
./serve.sh [port]       # serve the repo over HTTP (default port 8934) and open battle_fr.html
```

`serve.sh` is for manually testing `battle_fr.html` in a browser (species search, IV/moveset form, per-league level/CP/rank) against whatever's already on disk in `vendor/pvpoke/` — it doesn't run `sync_engine.py`/`pvpoke_fr.py` for you, so re-run those first if you need fresher data. It kills anything already bound to the port before starting, waits for the server to actually respond before opening the browser, and stops the server on exit/Ctrl+C.

## Architecture

### `pvpoke_fr.py` — rankings page + French i18n data

Organized top-to-bottom as a pipeline:

1. **Network fetch** (`fetch_json`) — generic JSON GET helper, used here for pvpoke.com only (rankings/gamemaster). It's also imported by `update_name_cache.py` for its PokeAPI calls — this is the one thing shared between "fetch site data" and "fetch names" concerns.
2. **French name/sprite lookup, cache-only** (`get_pokemon_info`, `get_move_fr`, `_cached_names`) — this script **never queries PokeAPI itself**. `_cached_names()` lazily loads `vendor/pvpoke/data/name_cache.json` once (memoized in `_name_cache`); `get_pokemon_info(species_id)` and `get_move_fr(move_id)` are plain dict lookups against it. On a cache miss, each falls back to a formatted slug instead of hitting the network: `get_move_fr` just title-cases the move ID, `get_pokemon_info` uses `FORM_SUFFIX_MAP` to strip a PvPoke form suffix (`_shadow`, `_galarian`, `_mega`, ...) and reapply it as a French label suffix (e.g. `landorus_therian` → "Landorus Therian", `necrozma_dusk_mane_shadow` → "... (Obscur)"), returning no sprite. This means generating a page is always fast and never PokeAPI-rate-limited — see `update_name_cache.py` below for where the real translations actually come from.
3. **IV/CP computation** (`calc_cp`, `find_best_ivs`, `CPM_TABLE`) — brute-forces the best IV spread (0-15 per stat) and level for a given CP cap by maximizing stat product, replicating PvPoke's "rank 1 IVs" logic locally rather than fetching it. For Master League (no CP cap), it skips the search and just uses level 51 / 15-15-15.
4. **Row building** (`build_league_rows`) — combines gamemaster base stats + rankings + move/name lookups into per-Pokemon row dicts.
5. **HTML generation** (`build_cards`, `build_html`) — pure string templating (f-strings), no template engine. Renders CSS-only tabs (radio inputs + sibling selectors, no JS) for the three leagues, with all styling inlined in a `<style>` block.
6. **i18n export** (`build_i18n_json`) — walks *every* Pokemon and move in the vendored `gamemaster.json` (not just the top-N ranked ones) via the same `get_pokemon_info`/`get_move_fr` helpers, and writes `vendor/pvpoke/data/i18n_fr.json` (`{"pokemon": {speciesId: {name, sprite}}, "moves": {moveId: name}}`). This is what `battle_fr.html` reads client-side to show French labels over the engine's English-only data. Species/moves not yet in `name_cache.json` show up here with a fallback slug rather than a PokeAPI miss log — run `update_name_cache.py` to actually resolve them.
7. **Battle page HTML** (`build_battle_html`) — generates `battle_fr.html`: French form controls (species picker, IVs grouped on one line, moveset grouped on one line) plus one stacked panel per league (no tabs — all three leagues show at once), then `<script src>`s the vendored engine files in dependency order followed by `gamemaster_shim.js` and `battle_driver.js`.

### `update_name_cache.py` — the only script that talks to PokeAPI

Owns everything PokeAPI-related that `pvpoke_fr.py` used to do itself: `GO_TYPE_VARIANTS` (GO-only composite moves like Weather Ball/Hidden Power, built from a base move name + French type suffix since they don't exist as single PokeAPI moves), `MOVE_API_OVERRIDES` (the handful of move IDs whose PvPoke slug doesn't match PokeAPI's), `get_move_fr`/`_fetch_move_fr`/`prefetch_moves` (real PokeAPI-backed move translation, memoized in `_move_cache`), and `get_pokemon_info` (real PokeAPI-backed Pokemon name + official-artwork sprite lookup, using `FORM_SUFFIX_MAP` — imported from `pvpoke_fr.py`, see above — for both the French label suffix *and* the PokeAPI slug suffix, since the two naming schemes diverge for forms). Falls back to the same title-cased-slug logic as `pvpoke_fr.py` on a genuine PokeAPI miss (no French name / no sprite found); those fallback entries are tracked in `_move_cache_missing`/`_info_cache_missing` and deliberately excluded when `save_name_cache()` writes `vendor/pvpoke/data/name_cache.json` — anything that fell back is retried from PokeAPI on every future run rather than being locked in as a permanent "known" bad translation (PokeAPI does add French names for new species/moves over time). `load_name_cache()` pre-populates `_move_cache`/`_info_cache` from that same file at startup, so a warm run only pays PokeAPI's cost for species/moves that are new or still missing.

`main()` fetches its own copy of the live gamemaster directly (`https://pvpoke.com/data/gamemaster.min.json` — not the vendored copy `sync_engine.py` writes), so this script has no prerequisite and can run before anything else in the pipeline. No git operations, no HTML generation — just the cache refresh. `generate.sh` calls it as an ordinary first step; the CI workflow *also* calls it directly, ahead of `generate.sh`, specifically so it can commit/PR that one file before spending any time on `sync_engine.py`/`pvpoke_fr.py` (see below) — the second call, from inside `generate.sh` a few steps later, just finds an already-warm cache and does almost nothing.

### `battle_fr.html` — client-side level/CP/rank lookup

The engine runs entirely in the browser (IVs/moveset are chosen at runtime, so results can't be precomputed at build time). There's no live battle simulation — just enough of pvpoke's engine to build a `Pokemon`, compute its CP at a given level, and read French labels + precomputed ranks off the vendored JSON. Load order matters and is hardcoded in `build_battle_html`:

```
vendor/pvpoke/engine/DamageCalculator.js
vendor/pvpoke/engine/Battle.js
vendor/pvpoke/engine/Pokemon.js
gamemaster_shim.js
battle_driver.js
```

`ActionLogic.js`/`TimelineEvent.js`/`TimelineAction.js`/`DecisionOption.js`/`TeamRanker.js` are still pulled into `vendor/pvpoke/engine/` by `sync_engine.py` (and still exercised by `test_engine.js`) but are deliberately **not** `<script>`-tagged into `battle_fr.html` — they only matter for simulating actual turn-by-turn battles/shield AI, which this page no longer does.

- **`vendor/pvpoke/engine/*.js`** — pvpoke's own engine classes (`Battle`, `Pokemon`, `DamageCalculator`), vendored verbatim by `sync_engine.py`. This is what makes the level/CP math match pvpoke.com exactly — it's their code, their formulas.
- **`gamemaster_shim.js`** (hand-written, NOT vendored) — replaces pvpoke's real `GameMaster.js`, which is jQuery/DOM/localStorage-coupled and the only engine-adjacent file that is. Implements just the surface the vendored files actually call: `getInstance()`, `.data`/`.rankings`, `getPokemonById`, `getMoveById`, `getCupById`, `getFormat`, `loadRankingData` — loading from the same-origin vendored JSON via `fetch()` instead of `$.ajax` against pvpoke.com.
- **`battle_driver.js`** (hand-written) — wires the above together: populates the species picker and move pickers, and re-runs automatically on any input change (species selection, IV edit, moveset change — no button). For each league it builds a custom `Pokemon` from the form (`buildUserPokemon`/`buildPokemon`), calls `maxLevelForCap()` to walk levels upward (0.5 steps) until CP would exceed that league's cap and backs off one step — the highest level those IVs support under the cap — then looks up the species' precomputed rank via `globalRank()`, which scans the same `gm.rankings["all"+"overall"+cp]` array (from `vendor/pvpoke/data/rankings/rankings-*.json`, loaded once at `init()`) that `rankings_fr.html` is built from, by `speciesId`.
  - The species picker is a text input (`#species-search`) with a live-filtered suggestions dropdown (`#species-suggestions`, French name substring match, sprite + keyboard nav), not a plain `<select>` — the full gamemaster is too long to scroll through. The canonical `speciesId` is tracked in a hidden `#species-select` input so the rest of the driver (`onSpeciesChange`, `buildUserPokemon`) can keep reading `.value` from one place regardless of how it was set. Picking a suggestion (click or Enter) calls `selectSpecies(speciesId)`, which updates both the hidden value and the visible search text, re-triggers the moveset dropdowns, and re-runs the computation.
  - The picker excludes Shadow forms entirely (`populateSpeciesPicker` filters out any gamemaster entry tagged `"shadow"`) — a species' Shadow form is never separately selectable, since `buildVariantList()` always shows it alongside the selected (non-Shadow) species instead (see below).
- Results are rendered as one stacked panel per **variant**, not just per league: `buildVariantList(speciesId)` walks the selected species' forward evolution line breadth-first (via each gamemaster entry's `family.evolutions`, so branching lines like Eevee's are fully covered) and, at every stage (the selected species and each evolution), also includes that stage's Shadow form if `speciesId + "_shadow"` exists in the gamemaster. Each variant gets its own panel with all three leagues' level/CP/rank; only the user-selected species uses the form's chosen moveset — every other variant (Shadow form, evolutions, evolutions' Shadow forms) defaults to its own best-ranked moveset (`defaultMoveset()`) at the same IVs, since move-pool controls aren't duplicated per variant. Panels for anything other than the plain selected species carry a small badge (`.variant-badge`) reading "Obscur" and/or "Evolution".

### Data flow / sources

- Rankings + base stats + elite move flags, plus the full gamemaster and battle engine, come from pvpoke.com / pvpoke's GitHub repo (`sync_engine.py` → `vendor/pvpoke/`).
- French names, sprites, and move translations come from pokeapi.co.
- `TOP_N` (36) controls how many ranked Pokemon per league appear on `rankings_fr.html`; `battle_fr.html`'s species picker and `i18n_fr.json` cover the entire gamemaster, not just the top-N.

### Output

`.github/workflows/rankings.yml` runs daily at 08:00 UTC (or on manual dispatch), in this order: `update_name_cache.py` refreshes the name cache first (before anything else — see why in the `update_name_cache.py` section above), then `sync_engine.py` refreshes `vendor/pvpoke/`, then `pvpoke_fr.py` (via `generate.sh`) generates both pages, then everything (`rankings_fr.html` → `index.html`, `battle_fr.html`, `battle_driver.js`, `gamemaster_shim.js`, `vendor/`) is deployed straight to GitHub Pages via `actions/upload-pages-artifact` + `actions/deploy-pages`. The generated *pages* are never committed — they only ever live in the Pages deployment, not in git history. (This replaced an earlier setup that committed `docs/index.html` daily, which spammed the commit log; Pages must be configured in repo Settings → Pages with source "GitHub Actions", not "Deploy from a branch".)

The one exception is `vendor/pvpoke/data/name_cache.json`. Right after this first, direct `update_name_cache.py` call, the workflow does its own commit-if-changed check (`git status --porcelain`), then — only if that produced a commit — force-pushes it to a dedicated `chore/name-cache-update` branch and opens a PR for it (`gh pr create`, skipped if a PR for that branch is already open — the force-push alone updates an existing PR's diff, since GitHub tracks PRs by branch head). It's PR-based rather than a direct push to `main` because `main` may have branch protection blocking direct pushes from `github-actions[bot]`. The branch is force-pushed (never `main`) so each day's update sits cleanly on top of the latest `main` instead of accumulating drift; requires `contents: write` + `pull-requests: write` permissions and a git identity configured for the commit (both set in the workflow, before this step). This workflow only triggers on `schedule`/`workflow_dispatch`, not `push`, so the PR branch push can't retrigger it. `generate.sh` runs afterward purely to build the site — it doesn't commit anything itself, and its own internal call to `update_name_cache.py` (see above) just finds the cache already warm from the step before, so it has little left to add.

### Adding support for a new move or form quirk

When PvPoke introduces a new composite move or a new regional/mega form, the fix is almost always a one-line addition to `GO_TYPE_VARIANTS`/`MOVE_API_OVERRIDES` (both in `update_name_cache.py`) or `FORM_SUFFIX_MAP` (in `pvpoke_fr.py`, imported by `update_name_cache.py`) rather than new logic — check there first if a Pokemon/move renders with a fallback (title-cased slug) instead of its proper French name. This applies to both `rankings_fr.html` and `battle_fr.html`/`i18n_fr.json`, since they're both ultimately populated from the one `vendor/pvpoke/data/name_cache.json` that `update_name_cache.py` maintains.

### Re-syncing the vendored engine (`sync_engine.py`)

`ENGINE_FILES` in `sync_engine.py` lists exactly which files get pulled from `pvpoke/pvpoke@master` into `vendor/pvpoke/engine/` — everything battle-simulation-related except `GameMaster.js` (replaced by `gamemaster_shim.js`, since it's the only engine-adjacent file with jQuery/DOM/localStorage coupling). Files are vendored verbatim and overwritten on every run; don't hand-edit anything under `vendor/pvpoke/`. `vendor/pvpoke/VERSION` records the upstream commit SHA pulled.

If pvpoke changes its engine in a way that breaks this integration — a new bare global referenced by a vendored file (like `settings`/`getDefaultMultiBattleSettings`, both defined inline on pvpoke's real page rather than in any engine file, and hand-ported into `test_engine.js`), a renamed/removed engine file, or a changed `GameMaster` method signature — `node test_engine.js` is the fastest way to catch it locally before it reaches the browser. Note `battle_fr.html` itself only loads `DamageCalculator.js`/`Battle.js`/`Pokemon.js` (see above), so it doesn't need those two globals at all; `test_engine.js` still defines them because it separately exercises the full `TeamRanker`/`ActionLogic` battle-simulation path that `battle_fr.html` no longer uses.
