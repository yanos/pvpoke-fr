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

from pvpoke_fr import fetch_json, ARTWORK, FORM_SUFFIX_MAP, NAME_CACHE_PATH, strip_form_suffix

GAMEMASTER_URL = "https://pvpoke.com/data/gamemaster.min.json"

# French type names, shared between GO-only composite moves (Weather Ball/Hidden Power/Techno
# Blast/Aura Wheel) and the Arceus/Silvally type-plate Pokemon forms below -- both need "<thing>
# <type>" suffixes and neither is modeled as a distinct PokeAPI species/move, just a bare type tag.
TYPE_FR = {
    "normal": "Normal", "fire": "Feu", "water": "Eau", "electric": "Électrik",
    "grass": "Plante", "ice": "Glace", "fighting": "Combat", "poison": "Poison",
    "ground": "Sol", "flying": "Vol", "psychic": "Psy", "bug": "Insecte",
    "rock": "Roche", "ghost": "Spectre", "dragon": "Dragon", "dark": "Ténèbres",
    "steel": "Acier", "fairy": "Fée",
}

GO_TYPE_VARIANTS = {
    "WEATHER_BALL_FIRE":     ("weather-ball", TYPE_FR["fire"]),
    "WEATHER_BALL_ICE":      ("weather-ball", TYPE_FR["ice"]),
    "WEATHER_BALL_ROCK":     ("weather-ball", TYPE_FR["rock"]),
    "WEATHER_BALL_WATER":    ("weather-ball", TYPE_FR["water"]),
    "WEATHER_BALL_NORMAL":   ("weather-ball", TYPE_FR["normal"]),
    "HIDDEN_POWER_ICE":      ("hidden-power", TYPE_FR["ice"]),
    "HIDDEN_POWER_FIRE":     ("hidden-power", TYPE_FR["fire"]),
    "HIDDEN_POWER_ELECTRIC": ("hidden-power", TYPE_FR["electric"]),
    "HIDDEN_POWER_GROUND":   ("hidden-power", TYPE_FR["ground"]),
    "HIDDEN_POWER_GRASS":    ("hidden-power", TYPE_FR["grass"]),
    "HIDDEN_POWER_ROCK":     ("hidden-power", TYPE_FR["rock"]),
    "HIDDEN_POWER_WATER":    ("hidden-power", TYPE_FR["water"]),
    "HIDDEN_POWER_FLYING":   ("hidden-power", TYPE_FR["flying"]),
    "HIDDEN_POWER_PSYCHIC":  ("hidden-power", TYPE_FR["psychic"]),
    "HIDDEN_POWER_FIGHTING": ("hidden-power", TYPE_FR["fighting"]),
    "HIDDEN_POWER_BUG":      ("hidden-power", TYPE_FR["bug"]),
    "HIDDEN_POWER_POISON":   ("hidden-power", TYPE_FR["poison"]),
    "HIDDEN_POWER_DARK":     ("hidden-power", TYPE_FR["dark"]),
    "HIDDEN_POWER_GHOST":    ("hidden-power", TYPE_FR["ghost"]),
    "HIDDEN_POWER_DRAGON":   ("hidden-power", TYPE_FR["dragon"]),
    "HIDDEN_POWER_STEEL":    ("hidden-power", TYPE_FR["steel"]),
    "HIDDEN_POWER_NORMAL":   ("hidden-power", TYPE_FR["normal"]),
    "AURA_WHEEL_DARK":       ("aura-wheel", TYPE_FR["dark"]),
    "AURA_WHEEL_ELECTRIC":   ("aura-wheel", TYPE_FR["electric"]),
    "TECHNO_BLAST_BURN":     ("techno-blast", TYPE_FR["fire"]),
    "TECHNO_BLAST_CHILL":    ("techno-blast", TYPE_FR["ice"]),
    "TECHNO_BLAST_DOUSE":    ("techno-blast", TYPE_FR["water"]),
    "TECHNO_BLAST_SHOCK":    ("techno-blast", TYPE_FR["electric"]),
    "TECHNO_BLAST_NORMAL":   ("techno-blast", TYPE_FR["normal"]),
}

MOVE_API_OVERRIDES = {
    "SUPER_POWER": "superpower",
    "ROLLOUT":     "rollout",
    # Mega-exclusive/engine-internal re-skins of an existing move (different power/energy, same
    # move name and PokeAPI identity) -- no type/flavor suffix, just point at the base move.
    "AEGISLASH_CHARGE_AIR_SLASH":  "air-slash",
    "AEGISLASH_CHARGE_PSYCHO_CUT": "psycho-cut",
    "HYDRO_PUMP_BLASTOISE":        "hydro-pump",
    "WATER_GUN_FAST_BLASTOISE":    "water-gun",
}

# Species (after strip_form_suffix) whose PvPoke ID doesn't naively convert to PokeAPI's real
# pokemon-species slug (Paradox Pokemon are two words hyphenated in PokeAPI but joined in PvPoke's
# ID; Nidoran's gender variants are their own species "nidoran-f"/"nidoran-m"). Overrides both the
# species-name lookup slug and, unless POKEMON_SPRITE_OVERRIDES says otherwise, the sprite slug.
POKEMON_SPECIES_OVERRIDES = {
    "nidoran_female": "nidoran-f",
    "nidoran_male":   "nidoran-m",
    "greattusk":    "great-tusk",
    "ironbundle":   "iron-bundle",
    "ironhands":    "iron-hands",
    "ironjugulis":  "iron-jugulis",
    "ironmoth":     "iron-moth",
    "ironthorns":   "iron-thorns",
    "irontreads":   "iron-treads",
    "ironvaliant":  "iron-valiant",
    "roaringmoon":  "roaring-moon",
    "sandyshocks":  "sandy-shocks",
    "screamtail":   "scream-tail",
    "slitherwing":  "slither-wing",
    "brutebonnet":  "brute-bonnet",
    "fluttermane":  "flutter-mane",
}

# Species (after strip_form_suffix) that need a specific PokeAPI pokemon-form slug -- these are
# alternate forms PokeAPI models as their own variety (different sprite, and the French name has
# to come from the form's own "names" localization since pokemon-species names don't vary per
# form). The fetched form name is used as the complete name (it already includes the species name,
# e.g. "Necrozma Crinière du Couchant"), with any shadow suffix from strip_form_suffix appended.
POKEMON_FORM_OVERRIDES = {
    "aegislash_blade": "aegislash-blade", "aegislash_shield": "aegislash-shield",
    "basculegion_male": "basculegion-male", "basculegion_female": "basculegion-female",
    "burmy_plant": "burmy-plant", "burmy_sandy": "burmy-sandy", "burmy_trash": "burmy-trash",
    "calyrex_ice_rider": "calyrex-ice",
    "castform_rainy": "castform-rainy", "castform_snowy": "castform-snowy", "castform_sunny": "castform-sunny",
    "cherrim_overcast": "cherrim-overcast", "cherrim_sunny": "cherrim-sunshine",
    "darmanitan_standard": "darmanitan-standard", "darmanitan_zen": "darmanitan-zen",
    "darmanitan_galarian_standard": "darmanitan-galar-standard", "darmanitan_galarian_zen": "darmanitan-galar-zen",
    "deoxys": "deoxys-normal", "deoxys_attack": "deoxys-attack",
    "deoxys_defense": "deoxys-defense", "deoxys_speed": "deoxys-speed",
    "dialga_origin": "dialga-origin",
    "eiscue": "eiscue-ice", "eiscue_ice": "eiscue-ice", "eiscue_noice": "eiscue-noice",
    "enamorus_incarnate": "enamorus-incarnate", "enamorus_therian": "enamorus-therian",
    "eternatus_eternamax": "eternatus-eternamax",
    "genesect_burn": "genesect-burn", "genesect_chill": "genesect-chill",
    "genesect_douse": "genesect-douse", "genesect_shock": "genesect-shock",
    "giratina_altered": "giratina-altered", "giratina_origin": "giratina-origin",
    "gourgeist_average": "gourgeist-average", "gourgeist_large": "gourgeist-large",
    "gourgeist_small": "gourgeist-small", "gourgeist_super": "gourgeist-super",
    "groudon_primal": "groudon-primal",
    "hoopa_confined": "hoopa", "hoopa_unbound": "hoopa-unbound",
    "indeedee_male": "indeedee-male", "indeedee_female": "indeedee-female",
    "keldeo_ordinary": "keldeo-ordinary", "keldeo_resolute": "keldeo-resolute",
    "kyogre_primal": "kyogre-primal",
    "kyurem_black": "kyurem-black", "kyurem_white": "kyurem-white",
    "landorus_incarnate": "landorus-incarnate", "landorus_therian": "landorus-therian",
    "lycanroc_dusk": "lycanroc-dusk", "lycanroc_midday": "lycanroc-midday", "lycanroc_midnight": "lycanroc-midnight",
    "maushold_family_of_four": "maushold-family-of-four", "maushold_family_of_three": "maushold-family-of-three",
    "meloetta_aria": "meloetta-aria", "meloetta_pirouette": "meloetta-pirouette",
    "meowstic": "meowstic-male", "meowstic_female": "meowstic-female",
    "mimikyu": "mimikyu-disguised", "mimikyu_busted": "mimikyu-busted",
    "morpeko_full_belly": "morpeko-full-belly", "morpeko_hangry": "morpeko-hangry",
    "necrozma_dawn_wings": "necrozma-dawn", "necrozma_dusk_mane": "necrozma-dusk", "necrozma_ultra": "necrozma-ultra",
    "oinkologne": "oinkologne-male", "oinkologne_female": "oinkologne-female",
    "oricorio_baile": "oricorio-baile", "oricorio_pau": "oricorio-pau",
    "oricorio_pom_pom": "oricorio-pom-pom", "oricorio_sensu": "oricorio-sensu",
    "palafin": "palafin-zero", "palafin_hero": "palafin-hero", "palafin_zero": "palafin-zero",
    "palkia_origin": "palkia-origin",
    "rotom_fan": "rotom-fan", "rotom_frost": "rotom-frost", "rotom_heat": "rotom-heat",
    "rotom_mow": "rotom-mow", "rotom_wash": "rotom-wash",
    "pumpkaboo_average": "pumpkaboo-average", "pumpkaboo_large": "pumpkaboo-large",
    "pumpkaboo_small": "pumpkaboo-small", "pumpkaboo_super": "pumpkaboo-super",
    "shaymin_land": "shaymin-land", "shaymin_sky": "shaymin-sky",
    "tatsugiri_curly": "tatsugiri-curly", "tatsugiri_droopy": "tatsugiri-droopy", "tatsugiri_stretchy": "tatsugiri-stretchy",
    "tauros_aqua": "tauros-paldea-aqua-breed", "tauros_blaze": "tauros-paldea-blaze-breed",
    "tauros_combat": "tauros-paldea-combat-breed",
    "thundurus_incarnate": "thundurus-incarnate", "thundurus_therian": "thundurus-therian",
    "tornadus_incarnate": "tornadus-incarnate", "tornadus_therian": "tornadus-therian",
    "toxtricity": "toxtricity-amped", "toxtricity_amped": "toxtricity-amped", "toxtricity_low_key": "toxtricity-low-key",
    "urshifu_rapid_strike": "urshifu-rapid-strike", "urshifu_single_strike": "urshifu-single-strike",
    "wishiwashi": "wishiwashi-solo", "wishiwashi_school": "wishiwashi-school", "wishiwashi_solo": "wishiwashi-solo",
    "wormadam_plant": "wormadam-plant", "wormadam_sandy": "wormadam-sandy", "wormadam_trash": "wormadam-trash",
    "zacian_crowned_sword": "zacian-crowned", "zacian_hero": "zacian",
    "zamazenta_crowned_shield": "zamazenta-crowned", "zamazenta_hero": "zamazenta",
    "zygarde": "zygarde-50", "zygarde_10": "zygarde-10", "zygarde_complete": "zygarde-complete",
    "charizard_mega_x": "charizard-mega-x", "charizard_mega_y": "charizard-mega-y",
    "mewtwo_mega_x": "mewtwo-mega-x", "mewtwo_mega_y": "mewtwo-mega-y",
    "raichu_mega_x": "raichu-mega-x", "raichu_mega_y": "raichu-mega-y",
}

# Species whose species-level/form name lookup is correct as normal, but whose default PvPoke ID
# has no bare "/pokemon/{slug}/" resource to fetch a sprite from (either because PokeAPI only
# exposes color/segment-specific varieties -- Basculin, Maushold, Squawkabilly, Dudunsparce -- or
# because the form is purely cosmetic and shares one pokemon resource with its base species --
# Arceus/Silvally type plates, Burmy/Cherrim/Genesect cosmetic forms).
POKEMON_SPRITE_OVERRIDES = {
    "basculin": "basculin-red-striped",
    "maushold": "maushold-family-of-four",
    "squawkabilly": "squawkabilly-green-plumage",
    "dudunsparce": "dudunsparce-two-segment",
    "minior_core": "minior-red",
    "minior_meteor": "minior-red-meteor",
    "frillish": "frillish-male", "jellicent": "jellicent-male", "pyroar": "pyroar-male",
    "arceus": "arceus", "silvally": "silvally",
    "burmy_plant": "burmy", "burmy_sandy": "burmy", "burmy_trash": "burmy",
    "cherrim_overcast": "cherrim", "cherrim_sunny": "cherrim",
    "genesect_burn": "genesect", "genesect_chill": "genesect",
    "genesect_douse": "genesect", "genesect_shock": "genesect",
}

# Species with no gameplay-relevant color (PvPoke tracks only "core" vs. "meteor" shape) -- hand
# composed rather than using one arbitrarily-colored PokeAPI form name (e.g. "Météno Noyau Rouge")
# that would misleadingly imply a specific color PvPoke doesn't actually distinguish.
POKEMON_NAME_TEXT_OVERRIDES = {
    "minior_core": "Météno (Noyau)",
    "minior_meteor": "Météno (Météore)",
}

# Arceus/Silvally type-plate forms are cosmetic-only (one shared PokeAPI pokemon resource, no
# stat/species difference per type) and PokeAPI's own translations are inconsistent (Arceus's
# happen to read "Arceus <Type>" but Silvally's are simply untranslated) -- compose by hand from
# TYPE_FR for both, uniformly.
ARCEUS_SILVALLY_BASES = {"arceus": "Arceus", "silvally": "Silvallié"}

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

def _fetch_sprite_url(pokemon_name):
    for attempt in range(2):
        time.sleep(0.3 * (attempt + 1))
        try:
            pdata = fetch_json(f"https://pokeapi.co/api/v2/pokemon/{pokemon_name}/")
            return ARTWORK.format(pdata["id"]), True
        except Exception as e:
            if attempt == 1:
                print(f"    [pokemon miss: {pokemon_name}] {e}")
    return None, False

def _fetch_form_fr_name(form_slug):
    time.sleep(0.25)
    try:
        fdata = fetch_json(f"https://pokeapi.co/api/v2/pokemon-form/{form_slug}/")
        for n in fdata.get("names", []):
            if n["language"]["name"] == "fr":
                return n["name"]
    except Exception as e:
        print(f"    [form miss: {form_slug}] {e}")
    return None

def _fetch_species_fr_name(species_name):
    time.sleep(0.25)
    try:
        sdata = fetch_json(f"https://pokeapi.co/api/v2/pokemon-species/{species_name}/")
        for n in sdata.get("names", []):
            if n["language"]["name"] == "fr":
                return n["name"]
    except Exception as e:
        print(f"    [species miss: {species_name}] {e}")
    return None

def get_pokemon_info(species_id):
    if species_id in _info_cache:
        return _info_cache[species_id]

    base, fr_suffix = strip_form_suffix(species_id)

    # Arceus/Silvally type-plate forms: cosmetic-only, one PokeAPI pokemon resource shared by all
    # 18 types, so name is hand-composed from the base species name + TYPE_FR rather than fetched
    # per-form (see ARCEUS_SILVALLY_BASES comment).
    for arceus_base, fr_base_name in ARCEUS_SILVALLY_BASES.items():
        prefix = arceus_base + "_"
        if base.startswith(prefix) and base[len(prefix):] in TYPE_FR:
            type_fr = TYPE_FR[base[len(prefix):]]
            sprite_url, sprite_ok = _fetch_sprite_url(arceus_base)
            result = (f"{fr_base_name} {type_fr}" + fr_suffix, sprite_url)
            _info_cache[species_id] = result
            if not sprite_ok:
                _info_cache_missing.add(species_id)
            return result

    if base in POKEMON_NAME_TEXT_OVERRIDES:
        sprite_slug = POKEMON_SPRITE_OVERRIDES.get(base, base.replace("_", "-"))
        sprite_url, sprite_ok = _fetch_sprite_url(sprite_slug)
        result = (POKEMON_NAME_TEXT_OVERRIDES[base] + fr_suffix, sprite_url)
        _info_cache[species_id] = result
        if not sprite_ok:
            _info_cache_missing.add(species_id)
        return result

    if base in POKEMON_FORM_OVERRIDES:
        form_slug = POKEMON_FORM_OVERRIDES[base]
        fr_name = _fetch_form_fr_name(form_slug)
        name_ok = fr_name is not None
        if not name_ok:
            fr_name = form_slug.replace("-", " ").title()
        sprite_slug = POKEMON_SPRITE_OVERRIDES.get(base, form_slug)
        sprite_url, sprite_ok = _fetch_sprite_url(sprite_slug)
        result = (fr_name + fr_suffix, sprite_url)
        _info_cache[species_id] = result
        if not name_ok:
            _info_cache_missing.add(species_id)
        return result

    base_h = base.replace("_", "-")
    species_name = POKEMON_SPECIES_OVERRIDES.get(base, base_h)
    pokemon_name = POKEMON_SPRITE_OVERRIDES.get(base, species_name)

    sprite_url, sprite_ok = _fetch_sprite_url(pokemon_name)
    fr_name = _fetch_species_fr_name(species_name)

    name_ok = fr_name is not None
    if not name_ok:
        fr_name = base_h.replace("-", " ").title()

    result = (fr_name + fr_suffix, sprite_url)
    _info_cache[species_id] = result
    # A missing sprite alone shouldn't discard an otherwise-resolved French name -- only a failed
    # name lookup means this entry isn't ready to be locked into the persisted cache yet.
    if not name_ok:
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
    # "duplicate"-tagged species (e.g. golisopodsh) are internal alt-ranking-variant aliases of an
    # existing species with no aliasId set, but their own speciesName already names the real
    # species directly -- same reason plain aliasId entries are skipped, just a different tag.
    species = [
        p["speciesId"] for p in gm["pokemon"]
        if not p.get("aliasId") and "duplicate" not in p.get("tags", [])
    ]
    move_ids = [m["moveId"] for m in gm["moves"]]

    print(f"Refreshing French names for {len(species)} Pokemon and {len(move_ids)} moves...")
    for sid in species:
        get_pokemon_info(sid)
    prefetch_moves(move_ids)

    save_name_cache()

if __name__ == "__main__":
    main()
