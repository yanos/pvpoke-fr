#!/usr/bin/env python3
"""Generate a French PvP ranking page for all three leagues from pvpoke.com."""

import json, math, time, re, urllib.request
from html import escape

LEAGUES = [
    {"id": "super",  "name": "Ligue Super",  "cp": 1500, "pvpoke": "rankings-1500.json"},
    {"id": "hyper",  "name": "Ligue Hyper",  "cp": 2500, "pvpoke": "rankings-2500.json"},
    {"id": "master", "name": "Ligue Master", "cp": None, "pvpoke": "rankings-10000.json"},
]
TOP_N = 36

CPM_TABLE = [
    (1,0.094),(1.5,0.135137432),(2,0.16639787),(2.5,0.192650919),
    (3,0.21573247),(3.5,0.236572661),(4,0.25572005),(4.5,0.273530381),
    (5,0.29024988),(5.5,0.306057377),(6,0.3210876),(6.5,0.335445036),
    (7,0.34921268),(7.5,0.362457751),(8,0.37523559),(8.5,0.387592406),
    (9,0.39956728),(9.5,0.411193551),(10,0.42250001),(10.5,0.432926419),
    (11,0.44310755),(11.5,0.453059958),(12,0.46279839),(12.5,0.472336083),
    (13,0.48168495),(13.5,0.491043235),(14,0.49985844),(14.5,0.508701765),
    (15,0.51739395),(15.5,0.525942511),(16,0.53435433),(16.5,0.542635767),
    (17,0.55079269),(17.5,0.558830576),(18,0.56664082),(18.5,0.574371948),
    (19,0.58192586),(19.5,0.589410033),(20,0.59670001),(20.5,0.604818814),
    (21,0.61279297),(21.5,0.620588717),(22,0.62824535),(22.5,0.635876965),
    (23,0.64339179),(23.5,0.650887059),(24,0.65824785),(24.5,0.665299535),
    (25,0.67155486),(25.5,0.677734089),(26,0.68329199),(26.5,0.689182449),
    (27,0.69446902),(27.5,0.699873234),(28,0.70417899),(28.5,0.708701765),
    (29,0.71297603),(29.5,0.717235338),(30,0.72153999),(30.5,0.725737953),
    (31,0.72993001),(31.5,0.734008669),(32,0.73800003),(32.5,0.742020428),
    (33,0.74600005),(33.5,0.749999979),(34,0.75400007),(34.5,0.758000073),
    (35,0.76200008),(35.5,0.765999991),(36,0.76999998),(36.5,0.773999989),
    (37,0.77800003),(37.5,0.781999977),(38,0.78600001),(38.5,0.789999962),
    (39,0.79400003),(39.5,0.797999969),(40,0.80000001),(40.5,0.801000027),
    (41,0.80200003),(41.5,0.803000033),(42,0.80400003),(42.5,0.804999949),
    (43,0.80600004),(43.5,0.806999922),(44,0.80800006),(44.5,0.809999959),
    (45,0.81000004),(45.5,0.810999907),(46,0.81199997),(46.5,0.812999884),
    (47,0.81399999),(47.5,0.814999819),(48,0.81600004),(48.5,0.816999717),
    (49,0.81800003),(49.5,0.819000089),(50,0.82000002),(50.5,0.820999949),
    (51,0.82200003),
]

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

FORM_SUFFIX_MAP = [
    ("_shadow",   " (Obscur)", ""),
    ("_galarian", " de Galar", "-galar"),
    ("_alolan",   " d'Alola",  "-alola"),
    ("_hisuian",  " de Hisui", "-hisui"),
    ("_paldean",  " de Paldea","-paldea"),
    ("_mega",     " Mega",     "-mega"),
]

ARTWORK = ("https://raw.githubusercontent.com/PokeAPI/sprites/master"
           "/sprites/pokemon/other/official-artwork/{}.png")

# ── Network ───────────────────────────────────────────────────────────────────

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pvpoke-fr-script/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

# ── Move name lookup via PokeAPI ──────────────────────────────────────────────

_move_cache = {}

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
            _move_cache[base_api] = _fetch_move_fr(base_api)
        base_fr = _move_cache[base_api]
        result = f"{base_fr} {type_suffix}" if base_fr else move_id.replace("_", " ").title()
        _move_cache[move_id] = result
        return result

    api_id = MOVE_API_OVERRIDES.get(move_id, move_id.lower().replace("_", "-"))
    fr = _fetch_move_fr(api_id)
    result = fr if fr else move_id.replace("_", " ").title()
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
    for attempt in range(2):
        time.sleep(0.3 * (attempt + 1))
        try:
            pdata = fetch_json(f"https://pokeapi.co/api/v2/pokemon/{pokemon_name}/")
            sprite_url = ARTWORK.format(pdata["id"])
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

    if fr_name is None:
        fr_name = base_h.replace("-", " ").title()

    result = (fr_name + fr_suffix, sprite_url)
    _info_cache[species_id] = result
    return result

# ── IV computation ────────────────────────────────────────────────────────────

def calc_cp(ba, bd, bs, ia, id_, is_, cpm):
    a = (ba + ia) * cpm
    d = (bd + id_) * cpm
    s = (bs + is_) * cpm
    return max(10, int(a * math.sqrt(d) * math.sqrt(s) / 10))

def find_best_ivs(ba, bd, bs, cp_limit):
    if cp_limit is None:
        return {"level": 51, "ia": 15, "id": 15, "is": 15}
    best_sp, best = -1, {"level": 1, "ia": 0, "id": 0, "is": 0}
    for ia in range(16):
        for id_ in range(16):
            for is_ in range(16):
                top_lvl, top_cpm = None, None
                for lvl, cpm in CPM_TABLE:
                    if calc_cp(ba, bd, bs, ia, id_, is_, cpm) <= cp_limit:
                        top_lvl, top_cpm = lvl, cpm
                    else:
                        break
                if top_lvl is None:
                    continue
                a = (ba + ia) * top_cpm
                d = (bd + id_) * top_cpm
                hp = math.floor((bs + is_) * top_cpm)
                sp = a * d * hp
                if sp > best_sp:
                    best_sp = sp
                    best = {"level": top_lvl, "ia": ia, "id": id_, "is": is_}
    return best

def fmt_level(lvl):
    return str(int(lvl)) if lvl == int(lvl) else str(lvl)

# ── Main ──────────────────────────────────────────────────────────────────────

def build_league_rows(rankings, league, stats_map, dex_map, elite_map):
    rows = []
    for rank, entry in enumerate(rankings, 1):
        sid = entry["speciesId"]
        moveset = entry.get("moveset", [])
        score = entry.get("score", 0)
        print(f"  [{rank:2d}] {entry['speciesName']}")

        fr_name, sprite_url = get_pokemon_info(sid)
        if not sprite_url:
            dex = dex_map.get(sid) or dex_map.get(re.sub(r"_shadow$", "", sid))
            if dex:
                sprite_url = ARTWORK.format(dex)

        base_sid = re.sub(r"_shadow$", "", sid)
        stats = stats_map.get(sid) or stats_map.get(base_sid)
        if stats:
            b = find_best_ivs(stats["atk"], stats["def"], stats["hp"], league["cp"])
            cpm = dict(CPM_TABLE)[b["level"]]
            cp = calc_cp(stats["atk"], stats["def"], stats["hp"], b["ia"], b["id"], b["is"], cpm)
            iv_str = f"Niv. {fmt_level(b['level'])}  {b['ia']}/{b['id']}/{b['is']}  •  {cp} PC"
        else:
            iv_str = "N/A"
            print(f"    WARNING: no stats for {sid}")

        elite = elite_map.get(sid) or elite_map.get(base_sid) or set()
        fast_id     = moveset[0] if moveset else ""
        charged_ids = moveset[1:] if len(moveset) > 1 else []

        rows.append({
            "rank": rank, "sid": sid, "fr_name": fr_name, "score": score,
            "sprite_url":    sprite_url or "",
            "fast":          get_move_fr(fast_id) if fast_id else "-",
            "fast_elite":    fast_id in elite,
            "charged":       [get_move_fr(m) for m in charged_ids],
            "charged_elite": [m in elite for m in charged_ids],
            "ivs": iv_str,
        })
    return rows

def main():
    print("Fetching gamemaster...")
    gm = fetch_json("https://pvpoke.com/data/gamemaster/pokemon.json")
    stats_map = {p["speciesId"]: p["baseStats"] for p in gm}
    dex_map   = {p["speciesId"]: p.get("dex") for p in gm}
    elite_map = {p["speciesId"]: set(p.get("eliteMoves", [])) for p in gm}

    league_rows = {}
    for league in LEAGUES:
        print(f"\nFetching {league['name']} rankings...")
        url = f"https://pvpoke.com/data/rankings/all/overall/{league['pvpoke']}"
        rankings = fetch_json(url)[:TOP_N]

        all_move_ids = [mid for e in rankings for mid in e.get("moveset", [])]
        prefetch_moves(all_move_ids)

        league_rows[league["id"]] = build_league_rows(
            rankings, league, stats_map, dex_map, elite_map
        )

    html = build_html(league_rows)
    out = "rankings_fr.html"
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"\nSaved: {out}")

# ── HTML generation ───────────────────────────────────────────────────────────

def build_cards(rows):
    cards = ""
    for r in rows:
        star = '<sup class="elite">*</sup>'
        fast_star = star if r["fast_elite"] else ""
        charged_html = "".join(
            '<span class="move charged">' + escape(m)
            + (star if r["charged_elite"][i] else "")
            + '</span>'
            for i, m in enumerate(r["charged"])
        )
        is_shadow    = r["sid"].endswith("_shadow")
        shadow_cls   = " shadow" if is_shadow else ""
        shadow_badge = '<span class="badge">Obscur</span>' if is_shadow else ""
        img_tag = (
            f'<img src="{escape(r["sprite_url"])}" alt="{escape(r["fr_name"])}"'
            f' loading="lazy" onerror="this.style.opacity=\'0\'">'
            if r["sprite_url"] else ""
        )
        cards += f"""
    <div class="card{shadow_cls}">
      <div class="rank">#{r['rank']}</div>
      <div class="sprite-wrap">
        {img_tag}
        {shadow_badge}
      </div>
      <div class="info">
        <div class="name">{escape(r['fr_name'])}</div>
        <div class="score">Score : {r['score']:.1f}</div>
        <div class="moves">
          <span class="move fast">{escape(r['fast'])}{fast_star}</span>
          {charged_html}
        </div>
        <div class="ivs">{escape(r['ivs'])}</div>
      </div>
    </div>"""
    return cards

def build_html(league_rows):
    # CSS-only tabs: inputs + labels interleaved as direct body children,
    # then panels as direct body children.
    # input immediately precedes its label → input:checked + label works.
    # input ~ panel (general sibling, same parent) works for all panels.
    # Inputs come first (hidden), then a visual row of labels.
    # All are direct <body> children so CSS ~ can reach the panels below.
    tab_inputs_html = "\n  ".join(
        '<input type="radio" name="tab" id="tab-{id}"{checked}>'.format(
            id=l["id"], checked=' checked' if i == 0 else ''
        )
        for i, l in enumerate(LEAGUES)
    )
    tab_labels_row = "\n    ".join(
        '<label for="tab-{id}" class="tab-label">{name}</label>'.format(
            id=l["id"], name=l["name"]
        )
        for l in LEAGUES
    )
    panel_css = "\n    ".join(
        f'#tab-{l["id"]}:checked ~ #panel-{l["id"]} {{ display: block; }}'
        for l in LEAGUES
    )
    # input:checked ~ .tab-row reaches labels inside .tab-row (descendant selector)
    active_label_css = ",\n    ".join(
        f'#tab-{l["id"]}:checked ~ .tab-row label[for="tab-{l["id"]}"]'
        for l in LEAGUES
    )

    panels = ""
    for league in LEAGUES:
        lid = league["id"]
        cp_label = f"{league['cp']} PC" if league["cp"] else "Sans limite"
        cards = build_cards(league_rows[lid])
        panels += f"""
  <div id="panel-{lid}" class="tab-panel">
    <p class="sub">Source : pvpoke.com  |  Limite : {cp_label}  |  Classement general<br>
       Attaque rapide . Attaques chargees . IVs ideaux (Atk/Def/End)  |  * = Attaque Elite</p>
    <div class="grid">
{cards}
    </div>
  </div>"""

    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Top {TOP_N} Ligues PvP - PvPoke FR</title>
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{font-family:'Segoe UI',sans-serif;background:#0d1b2a;color:#e0e6f0;padding:2rem 1rem}}
    h1{{text-align:center;font-size:2rem;font-weight:700;color:#fff;margin-bottom:1.5rem}}
    /* Tabs — inputs are hidden, labels act as buttons */
    input[name="tab"]{{display:none}}
    .tab-label{{padding:.5rem 1.5rem;border-radius:8px;cursor:pointer;font-weight:600;font-size:.9rem;
               background:#152033;border:2px solid #1e3350;color:#7a9bbf;transition:all .15s;
               display:inline-block;margin:.25rem}}
    {active_label_css},
    .tab-label:hover{{background:#1e3a5f;border-color:#3d7ae5;color:#fff}}
    .tab-panel{{display:none}}
    {panel_css}
    /* Layout helpers */
    .tab-row{{text-align:center;margin-bottom:2rem}}
    /* Cards */
    .sub{{text-align:center;color:#7a9bbf;font-size:.85rem;margin-bottom:2.5rem;line-height:1.6}}
    .grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem;max-width:1200px;margin:0 auto}}
    .card{{background:#152033;border:1px solid #1e3350;border-radius:14px;padding:1rem 1.2rem;
           display:flex;align-items:center;gap:1.1rem;transition:transform .15s,border-color .15s}}
    .card:hover{{transform:translateY(-3px);border-color:#3d7ae5}}
    .card.shadow{{border-color:#3d1a6e;background:#1a1030}}
    .card.shadow:hover{{border-color:#a060ff}}
    .rank{{font-size:1.5rem;font-weight:800;color:#3d7ae5;min-width:2.8rem;text-align:center}}
    .card.shadow .rank{{color:#a060ff}}
    .sprite-wrap{{position:relative;min-width:90px;width:90px;height:90px;flex-shrink:0}}
    .sprite-wrap img{{width:90px;height:90px;object-fit:contain;
                      filter:drop-shadow(0 2px 6px rgba(0,0,0,.5))}}
    .card.shadow .sprite-wrap img{{filter:drop-shadow(0 0 10px rgba(140,60,220,.7))
                                           drop-shadow(0 2px 6px rgba(0,0,0,.5))}}
    .badge{{position:absolute;bottom:-4px;left:50%;transform:translateX(-50%);
            font-size:.58rem;padding:2px 6px;border-radius:4px;
            background:#5b1a8a;color:#dbb8ff;white-space:nowrap;font-weight:600}}
    .info{{flex:1;min-width:0}}
    .name{{font-size:1.05rem;font-weight:700;margin-bottom:.15rem;
           white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
    .score{{font-size:.75rem;color:#7a9bbf;margin-bottom:.45rem}}
    .moves{{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:.5rem}}
    .move{{font-size:.68rem;padding:3px 9px;border-radius:20px;font-weight:600}}
    .move.fast{{background:#0e3256;color:#6bb8f5}}
    .move.charged{{background:#2d1650;color:#c59eff}}
    sup.elite{{color:#ffd700;font-size:.65em;vertical-align:super;margin-left:1px;font-weight:700}}
    .ivs{{font-size:.78rem;color:#f0c060;font-family:'Courier New',monospace}}
    footer{{text-align:center;margin-top:3rem;color:#3a5570;font-size:.72rem}}
    @media(max-width:540px){{.grid{{grid-template-columns:1fr}}
      .sprite-wrap{{min-width:70px;width:70px;height:70px}}
      .sprite-wrap img{{width:70px;height:70px}}}}
  </style>
</head>
<body>
  <h1>Top {TOP_N} Ligues PvP</h1>
  {tab_inputs_html}
  <div class="tab-row">
    {tab_labels_row}
  </div>
{panels}
  <footer>Donnees : pvpoke.com . Images &amp; noms : PokeAPI . Genere le {time.strftime('%d/%m/%Y')}</footer>
</body>
</html>"""

if __name__ == "__main__":
    main()
