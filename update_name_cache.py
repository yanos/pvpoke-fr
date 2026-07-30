#!/usr/bin/env python3
"""Refresh vendor/pvpoke/data/name_cache.json: confirmed French Pokemon/move names + sprites
from PokeAPI, for every species and move in pvpoke's current gamemaster.

This is the only script that talks to PokeAPI -- pvpoke_fr.py just reads whatever this leaves in
name_cache.json (falling back to a formatted slug for anything not yet resolved here), so it
never needs its own 30-45+ minute PokeAPI walk just to generate a page.

Standalone by design -- fetches its own copy of the live gamemaster instead of depending on
sync_engine.py's vendored copy, so it can run before anything else in the pipeline. That's the
point: this is the slow, PokeAPI-rate-limited step, so getting it committed via its own PR
happens before any time is spent regenerating the site pages.

Run: python3 update_name_cache.py
"""

import json, time

from pvpoke_fr import fetch_json, ARTWORK, FORM_SUFFIX_MAP, NAME_CACHE_PATH

GAMEMASTER_URL = "https://pvpoke.com/data/gamemaster.min.json"

GO_TYPE_VARIANTS = {
    "WEATHER_BALL_FIRE":     ("weather-ball", "Feu"),
    "WEATHER_BALL_ICE":      ("weather-ball", "Glace"),
    "WEATHER_BALL_ROCK":     ("weather-ball", "Roche"),
    "WEATHER_BALL_WATER":    ("weather-ball", "Eau"),
    "HIDDEN_POWER_ICE":      ("hidden-power", "Glace"),
    "HIDDEN_POWER_FIRE":     ("hidden-power", "Feu"),
    "HIDDEN_POWER_ELECTRIC": ("hidden-power", "Electrik"),
    "HIDDEN_POWER_GROUND":   ("hidden-power", "Sol"),
    "HIDDEN_POWER_GRASS":    ("hidden-power", "Plante"),
    "HIDDEN_POWER_ROCK":     ("hidden-power", "Roche"),
    "HIDDEN_POWER_WATER":    ("hidden-power", "Eau"),
    "HIDDEN_POWER_FLYING":   ("hidden-power", "Vol"),
    "HIDDEN_POWER_PSYCHIC":  ("hidden-power", "Psy"),
    "HIDDEN_POWER_FIGHTING": ("hidden-power", "Combat"),
    "HIDDEN_POWER_BUG":      ("hidden-power", "Insecte"),
    "HIDDEN_POWER_POISON":   ("hidden-power", "Poison"),
    "HIDDEN_POWER_DARK":     ("hidden-power", "Tenebres"),
    "HIDDEN_POWER_GHOST":    ("hidden-power", "Spectre"),
    "HIDDEN_POWER_DRAGON":   ("hidden-power", "Dragon"),
    "HIDDEN_POWER_STEEL":    ("hidden-power", "Acier"),
}

MOVE_API_OVERRIDES = {
    "SUPER_POWER": "superpower",
    "ROLLOUT":     "rollout",
}

# ── Move name lookup via PokeAPI ──────────────────────────────────────────────

_move_cache = {}
_move_cache_missing = set()  # move/API ids whose French name wasn't found (title-case fallback
                              # used instead) — excluded from the persisted cache so they're
                              # always retried on the next run rather than staying stuck.

def _fetch_move_fr(api_id):
    time.sleep(0.2)
    try:
        data = fetch_json(f"https://pokeapi.co/api/v2/move/{api_id}/")
        for n in data.get("names", []):
            if n["language"]["name"] == "fr":
                return n["name"]
    except Exception as e:
        print(f"    [move miss: {api_id}] {e}")
    return None

def get_move_fr(move_id):
    if move_id in _move_cache:
        return _move_cache[move_id]

    if move_id in GO_TYPE_VARIANTS:
        base_api, type_suffix = GO_TYPE_VARIANTS[move_id]
        if base_api not in _move_cache:
            base_fr = _fetch_move_fr(base_api)
            _move_cache[base_api] = base_fr
            if base_fr is None:
                _move_cache_missing.add(base_api)
        base_fr = _move_cache[base_api]
        if base_fr:
            result = f"{base_fr} {type_suffix}"
        else:
            result = move_id.replace("_", " ").title()
            _move_cache_missing.add(move_id)
        _move_cache[move_id] = result
        return result

    api_id = MOVE_API_OVERRIDES.get(move_id, move_id.lower().replace("_", "-"))
    fr = _fetch_move_fr(api_id)
    if fr:
        result = fr
    else:
        result = move_id.replace("_", " ").title()
        _move_cache_missing.add(move_id)
    _move_cache[move_id] = result
    return result

def prefetch_moves(move_ids):
    unique = sorted(set(move_ids) - set(_move_cache))
    if unique:
        print(f"  Fetching French names for {len(unique)} moves via PokeAPI...")
    for mid in unique:
        get_move_fr(mid)

# ── Pokemon info lookup via PokeAPI ───────────────────────────────────────────

_info_cache = {}
_info_cache_missing = set()  # species_ids whose French name and/or sprite lookup failed —
                              # excluded from the persisted cache so they're always retried on
                              # the next run rather than staying stuck on a fallback slug.

def get_pokemon_info(species_id):
    if species_id in _info_cache:
        return _info_cache[species_id]

    fr_suffix, api_suffix = "", ""
    base = species_id
    for pvp, fr, api in sorted(FORM_SUFFIX_MAP, key=lambda x: -len(x[0])):
        if base.endswith(pvp):
            base = base[:-len(pvp)]
            fr_suffix = fr
            api_suffix = api
            break

    base_h = base.replace("_", "-")
    pokemon_name = base_h + api_suffix
    species_name  = base_h

    sprite_url = None
    sprite_ok = False
    for attempt in range(2):
        time.sleep(0.3 * (attempt + 1))
        try:
            pdata = fetch_json(f"https://pokeapi.co/api/v2/pokemon/{pokemon_name}/")
            sprite_url = ARTWORK.format(pdata["id"])
            sprite_ok = True
            break
        except Exception as e:
            if attempt == 1:
                print(f"    [pokemon miss: {pokemon_name}] {e}")

    fr_name = None
    time.sleep(0.25)
    try:
        sdata = fetch_json(f"https://pokeapi.co/api/v2/pokemon-species/{species_name}/")
        for n in sdata.get("names", []):
            if n["language"]["name"] == "fr":
                fr_name = n["name"]
                break
    except Exception as e:
        print(f"    [species miss: {species_name}] {e}")

    name_ok = fr_name is not None
    if not name_ok:
        fr_name = base_h.replace("-", " ").title()

    result = (fr_name + fr_suffix, sprite_url)
    _info_cache[species_id] = result
    if not (name_ok and sprite_ok):
        _info_cache_missing.add(species_id)
    return result

# ── Cross-run name cache ──────────────────────────────────────────────────────

def load_name_cache():
    try:
        with open(NAME_CACHE_PATH, encoding="utf-8") as f:
            cache = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return
    _move_cache.update(cache.get("moves", {}))
    for sid, info in cache.get("pokemon", {}).items():
        _info_cache[sid] = (info["name"], info.get("sprite") or None)
    print(f"Loaded name cache: {len(_info_cache)} Pokemon, {len(_move_cache)} moves")

def save_name_cache():
    pokemon = {
        sid: {"name": name, "sprite": sprite}
        for sid, (name, sprite) in _info_cache.items()
        if sid not in _info_cache_missing
    }
    moves = {mid: name for mid, name in _move_cache.items() if mid not in _move_cache_missing}
    with open(NAME_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump({"pokemon": pokemon, "moves": moves}, f, ensure_ascii=False, indent=2, sort_keys=True)
    print(f"Saved name cache: {NAME_CACHE_PATH} ({len(pokemon)} Pokemon, {len(moves)} moves)")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    load_name_cache()

    print("Fetching current gamemaster...")
    gm = fetch_json(GAMEMASTER_URL)
    species = [p["speciesId"] for p in gm["pokemon"] if not p.get("aliasId")]
    move_ids = [m["moveId"] for m in gm["moves"]]

    print(f"Refreshing French names for {len(species)} Pokemon and {len(move_ids)} moves...")
    for sid in species:
        get_pokemon_info(sid)
    prefetch_moves(move_ids)

    save_name_cache()

if __name__ == "__main__":
    main()
