#!/usr/bin/env python3
"""Generate a French PvP ranking page for all three leagues from pvpoke.com.

French Pokemon/move names come from vendor/pvpoke/data/name_cache.json, read-only here (falling
back to a formatted slug for anything not yet in it) -- this script never queries PokeAPI itself.
Run update_name_cache.py first to actually refresh that cache.
"""

import json, math, time, re, urllib.request, urllib.parse
from html import escape

LEAGUES = [
    {"id": "super",  "name": "Ligue Super",  "cp": 1500, "pvpoke": "rankings-1500.json"},
    {"id": "hyper",  "name": "Ligue Hyper",  "cp": 2500, "pvpoke": "rankings-2500.json"},
    {"id": "master", "name": "Ligue Master", "cp": None, "pvpoke": "rankings-10000.json"},
]
TOP_N = 36

CPM_TABLE = [
    (1,0.09400000),(1.5,0.13513743),(2,0.16639787),(2.5,0.19265091),
    (3,0.21573247),(3.5,0.23657266),(4,0.25572005),(4.5,0.27353038),
    (5,0.29024988),(5.5,0.30605738),(6,0.32108760),(6.5,0.33544503),
    (7,0.34921268),(7.5,0.36245775),(8,0.37523559),(8.5,0.38759241),
    (9,0.39956728),(9.5,0.41119355),(10,0.42250001),(10.5,0.43292641),
    (11,0.44310755),(11.5,0.45305995),(12,0.46279839),(12.5,0.47233608),
    (13,0.48168495),(13.5,0.49085581),(14,0.49985844),(14.5,0.50870176),
    (15,0.51739395),(15.5,0.52594251),(16,0.53435433),(16.5,0.54263576),
    (17,0.55079269),(17.5,0.55883060),(18,0.56675452),(18.5,0.57456915),
    (19,0.58227891),(19.5,0.58988791),(20,0.59740001),(20.5,0.60482366),
    (21,0.61215729),(21.5,0.61940411),(22,0.62656713),(22.5,0.63364918),
    (23,0.64065295),(23.5,0.64758096),(24,0.65443563),(24.5,0.66121926),
    (25,0.66793400),(25.5,0.67458190),(26,0.68116492),(26.5,0.68768491),
    (27,0.69414365),(27.5,0.70054289),(28,0.70688421),(28.5,0.71316910),
    (29,0.71939909),(29.5,0.72557562),(30,0.73170000),(30.5,0.73474101),
    (31,0.73776948),(31.5,0.74078557),(32,0.74378943),(32.5,0.74678121),
    (33,0.74976104),(33.5,0.75272911),(34,0.75568551),(34.5,0.75863037),
    (35,0.76156384),(35.5,0.76448607),(36,0.76739717),(36.5,0.77029727),
    (37,0.77318650),(37.5,0.77606495),(38,0.77893275),(38.5,0.78179006),
    (39,0.78463697),(39.5,0.78747358),(40,0.79030001),(40.5,0.79280395),
    (41,0.79530001),(41.5,0.79780392),(42,0.80030000),(42.5,0.80280389),
    (43,0.80530000),(43.5,0.80780386),(44,0.81029999),(44.5,0.81280383),
    (45,0.81529999),(45.5,0.81780381),(46,0.82029998),(46.5,0.82280378),
    (47,0.82529998),(47.5,0.82780375),(48,0.83029997),(48.5,0.83280375),
    (49,0.83530003),(49.5,0.83780376),(50,0.84030002),(50.5,0.84280373),
    (51,0.84530002),
]

FORM_SUFFIX_MAP = [
    ("_shadow",   " (Obscur)", ""),
    ("_galarian", " de Galar", "-galar"),
    ("_alolan",   " d'Alola",  "-alola"),
    ("_hisuian",  " de Hisui", "-hisui"),
    ("_paldean",  " de Paldea","-paldea"),
    ("_mega",     " Méga",     "-mega"),
]

ARTWORK = ("https://raw.githubusercontent.com/PokeAPI/sprites/master"
           "/sprites/pokemon/other/official-artwork/{}.png")

NAME_CACHE_PATH = "vendor/pvpoke/data/name_cache.json"

# ── Network ───────────────────────────────────────────────────────────────────

def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pvpoke-fr-script/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

# ── French name/sprite lookup (cache-only) ────────────────────────────────────
# All PokeAPI fetching lives in update_name_cache.py — this script only ever reads whatever it
# already resolved into vendor/pvpoke/data/name_cache.json, falling back to a formatted slug for
# anything not yet in there, so generating a page never triggers its own 30-45+ minute PokeAPI
# walk. Run update_name_cache.py first (generate.sh does) to get real translations instead of
# fallback slugs.

_name_cache = None

def _cached_names():
    global _name_cache
    if _name_cache is None:
        try:
            with open(NAME_CACHE_PATH, encoding="utf-8") as f:
                _name_cache = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            _name_cache = {"pokemon": {}, "moves": {}}
    return _name_cache

# Shadow is stripped independently of FORM_SUFFIX_MAP so a compound id like diglett_alolan_shadow
# yields both " d'Alola" and " (Obscur)" instead of just whichever suffix matched first.
def strip_form_suffix(species_id):
    base = species_id
    is_shadow = base.endswith("_shadow")
    if is_shadow:
        base = base[: -len("_shadow")]

    fr_suffix = ""
    for pvp, fr, _api in sorted(FORM_SUFFIX_MAP, key=lambda x: -len(x[0])):
        if pvp == "_shadow":
            continue
        if base.endswith(pvp):
            base = base[: -len(pvp)]
            fr_suffix = fr
            break

    if is_shadow:
        fr_suffix += " (Obscur)"
    return base, fr_suffix

def get_pokemon_info(species_id):
    cached = _cached_names()["pokemon"].get(species_id)
    if cached:
        return cached["name"], cached.get("sprite") or None

    base, fr_suffix = strip_form_suffix(species_id)
    return base.replace("_", " ").title() + fr_suffix, None

def get_move_fr(move_id):
    cached = _cached_names()["moves"].get(move_id)
    return cached if cached else move_id.replace("_", " ").title()

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
            best_ivs = {"atk": b["ia"], "def": b["id"], "hp": b["is"]}
        else:
            iv_str = "N/A"
            best_ivs = None
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
            "best_ivs": best_ivs,
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
        sim_href = ""
        sim_attrs = ""
        if r["best_ivs"]:
            iv = r["best_ivs"]
            sim_href = (
                "battle_fr.html?species=" + urllib.parse.quote(r["sid"])
                + f"&atk={iv['atk']}&def={iv['def']}&hp={iv['hp']}"
            )
            sim_attrs = (
                f' onclick="location.href=\'{sim_href}\'" role="link" tabindex="0"'
                f' style="cursor:pointer"'
                f' onkeydown="if(event.key===\'Enter\')location.href=\'{sim_href}\'"'
                f' title="Ouvrir dans le simulateur de combat avec les IV idéaux"'
            )
        cards += f"""
    <div class="card{shadow_cls}"{sim_attrs}>
      <div class="rank">#{r['rank']}</div>
      <div class="sprite-wrap">
        {img_tag}
        {shadow_badge}
      </div>
      <div class="info">
        <div class="name"><a href="https://www.pokepedia.fr/{urllib.parse.quote(r['fr_name'].replace(' ', '_'))}" target="_blank" rel="noopener" onclick="event.stopPropagation()">{escape(r['fr_name'])}</a></div>
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
    <p class="sub">Source : pvpoke.com  |  Limite : {cp_label}  |  Classement général<br>
       Attaque rapide . Attaques chargées . IVs idéaux (Atk/Def/End)  |  * = Attaque Élite</p>
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
    nav.site-nav{{text-align:center;margin-bottom:1.5rem;font-size:.85rem}}
    nav.site-nav a{{color:#7a9bbf;text-decoration:none;margin:0 .6rem}}
    nav.site-nav a:hover{{color:#fff;text-decoration:underline}}
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
    .name a{{color:inherit;text-decoration:none}}
    .name a:hover{{text-decoration:underline}}
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
  <nav class="site-nav"><a href="battle_fr.html">Simulateur de combat</a></nav>
  {tab_inputs_html}
  <div class="tab-row">
    {tab_labels_row}
  </div>
{panels}
  <footer>Données : pvpoke.com . Images &amp; noms : PokeAPI . Généré le {time.strftime('%d/%m/%Y')}</footer>
</body>
</html>"""

# ── French i18n data for the battle simulator ──────────────────────────────────
# Walks the vendored gamemaster (every Pokemon + move the engine can use) and emits
# vendor/pvpoke/data/i18n_fr.json, reusing the same PokeAPI lookups as the rankings page.
# Requires sync_engine.py to have already populated vendor/pvpoke/data/gamemaster.json.

def build_i18n_json():
    gm_path = "vendor/pvpoke/data/gamemaster.json"
    with open(gm_path, encoding="utf-8") as f:
        gmdata = json.load(f)

    print(f"Building French i18n data for {len(gmdata['pokemon'])} Pokemon and {len(gmdata['moves'])} moves...")

    pokemon_i18n = {}
    for p in gmdata["pokemon"]:
        if p.get("aliasId"):
            continue
        sid = p["speciesId"]
        fr_name, sprite_url = get_pokemon_info(sid)
        if not sprite_url and p.get("dex"):
            sprite_url = ARTWORK.format(p["dex"])
        pokemon_i18n[sid] = {"name": fr_name, "sprite": sprite_url or ""}

    move_ids = [m["moveId"] for m in gmdata["moves"]]
    moves_i18n = {mid: get_move_fr(mid) for mid in move_ids}

    out = "vendor/pvpoke/data/i18n_fr.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"pokemon": pokemon_i18n, "moves": moves_i18n}, f, ensure_ascii=False)
    print(f"Saved: {out}")

# ── Battle simulator page (client-side, vendored pvpoke engine) ───────────────

def build_battle_html():
    # Only what's needed to build a Pokemon and compute its level/CP/moves - no live battle
    # simulation runs anymore, so ActionLogic/Timeline*/DecisionOption/TeamRanker aren't loaded.
    engine_scripts = "\n  ".join(
        f'<script src="vendor/pvpoke/engine/{f}"></script>'
        for f in ["DamageCalculator.js", "Battle.js", "Pokemon.js"]
    )

    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Simulateur de combat PvP - PvPoke FR</title>
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{font-family:'Segoe UI',sans-serif;background:#0d1b2a;color:#e0e6f0;padding:2rem 1rem}}
    h1{{text-align:center;font-size:2rem;font-weight:700;color:#fff;margin-bottom:1.5rem}}
    nav.site-nav{{text-align:center;margin-bottom:1.5rem;font-size:.85rem}}
    nav.site-nav a{{color:#7a9bbf;text-decoration:none;margin:0 .6rem}}
    nav.site-nav a:hover{{color:#fff;text-decoration:underline}}
    .result-panel{{max-width:900px;margin:0 auto 2.5rem}}
    .controls{{max-width:900px;margin:0 auto 2.5rem;background:#152033;border:1px solid #1e3350;
               border-radius:14px;padding:1.5rem;display:flex;flex-wrap:wrap;gap:1rem}}
    .controls label{{display:block;font-size:.75rem;color:#7a9bbf;margin-bottom:.3rem;font-weight:600}}
    .controls select,.controls input{{width:100%;padding:.45rem;border-radius:6px;border:1px solid #1e3350;
                                       background:#0d1b2a;color:#e0e6f0;font-size:.85rem}}
    .controls > div{{flex:1 1 180px}}
    .controls .field-group{{flex:2 1 320px}}
    .inline-fields{{display:flex;gap:.5rem}}
    .inline-fields input,.inline-fields select{{width:auto;flex:1;min-width:0}}
    .controls > .top-row{{flex:0 0 100%;width:100%;display:flex;align-items:flex-end;gap:1rem}}
    .species-field{{position:relative;flex:0 0 auto;width:14rem}}
    .top-row .field-group.iv-group{{flex:0 0 auto}}
    .iv-inline{{display:flex;align-items:center;gap:.3rem}}
    .iv-inline input{{width:2.3rem;text-align:center}}
    .iv-sep{{color:#7a9bbf;font-weight:600}}
    .iv-visual{{flex:1;display:flex;flex-direction:column;gap:.3rem;min-height:2.4rem;margin-left:1.5rem}}
    .iv-bar-track{{position:relative;flex:1;min-height:0;border-radius:4px;background:#0d1b2a;
                   border:1px solid #1e3350;overflow:hidden}}
    .iv-bar-fill{{position:absolute;top:0;left:0;height:100%;border-radius:3px 0 0 3px;
                 transition:width .15s ease}}
    .iv-bar-fill.atk,.iv-bar-fill.def,.iv-bar-fill.hp{{background-image:linear-gradient(180deg,#ffd699,#ffb347)}}
    .iv-bar-ticks{{position:absolute;inset:0;pointer-events:none;
                  background-image:repeating-linear-gradient(90deg,rgba(13,27,42,.6) 0,
                  rgba(13,27,42,.6) 1px,transparent 1px,transparent calc(100%/3))}}
    .suggestions{{display:none;position:absolute;top:100%;left:0;right:0;margin-top:.2rem;
                  background:#0d1b2a;border:1px solid #1e3350;border-radius:8px;max-height:280px;
                  overflow-y:auto;z-index:20}}
    .suggestions.open{{display:block}}
    .suggestion-item{{display:flex;align-items:center;gap:.5rem;padding:.4rem .6rem;cursor:pointer;font-size:.85rem}}
    .suggestion-item img{{width:24px;height:24px;object-fit:contain}}
    .suggestion-item:hover,.suggestion-item.active{{background:#1e3a5f}}
    #loading{{text-align:center;color:#7a9bbf;margin-bottom:1.5rem;display:none}}
    .variant-panel{{margin-bottom:1.5rem}}
    .variant-panel:last-child{{margin-bottom:0}}
    .variant-badge{{display:inline-block;font-size:.65rem;font-weight:700;text-transform:uppercase;
                    letter-spacing:.03em;border-radius:4px;padding:.15rem .4rem;margin-right:.3rem;
                    vertical-align:middle}}
    .variant-badge.shadow{{color:#a060ff;background:#1a1030;border:1px solid #3d1a6e}}
    .variant-badge.evolution{{color:#5b9bd5;background:#0f2438;border:1px solid #1e3350}}
    .battle-summary{{display:flex;align-items:center;gap:1rem;background:#152033;border:1px solid #1e3350;
                     border-radius:14px 14px 0 0;padding:1rem;border-bottom:1px solid #1e3350}}
    .battle-summary .poke-sprite{{width:70px;height:70px;object-fit:contain}}
    .battle-summary .poke-name{{font-size:1.2rem;font-weight:700}}
    .battle-summary .poke-moves{{font-size:.8rem;color:#7a9bbf;margin-top:.2rem}}
    .league-stats{{background:#152033;border:1px solid #1e3350;border-top:none;border-radius:0 0 14px 14px;
                   overflow:hidden}}
    /* Columns: league, Niveau, PC, Att/Déf/PV (wider - three numbers in one cell), Produit, Classement. */
    .league-stat-row{{display:grid;
                      grid-template-columns:minmax(0,1.2fr) minmax(0,.7fr) minmax(0,.8fr) minmax(0,1.9fr)
                                            minmax(0,1.1fr) minmax(0,1.1fr);
                      align-items:center;padding:.7rem .8rem;gap:.3rem;border-top:1px solid #1e3350}}
    .league-stat-row:first-child{{border-top:none}}
    .league-stat-header{{padding-bottom:.3rem}}
    .league-stat-header .league-stat-value{{font-weight:700;color:#4a6d94;font-size:.7rem;
                                             text-transform:uppercase;letter-spacing:.03em}}
    .league-stat-name{{font-weight:700;color:#fff;font-size:.85rem;overflow:hidden;
                       text-overflow:ellipsis;white-space:nowrap}}
    .league-stat-value{{font-size:.85rem;color:#7a9bbf;text-align:center;overflow:hidden;
                        text-overflow:ellipsis;white-space:nowrap}}
    @media(max-width:480px){{
      .league-stat-row{{grid-template-columns:minmax(0,.9fr) minmax(0,.5fr) minmax(0,.6fr) minmax(0,1.5fr)
                                              minmax(0,.9fr) minmax(0,.8fr);
                        gap:.15rem;padding:.6rem .4rem}}
      .league-stat-name{{font-size:.72rem}}
      .league-stat-value{{font-size:.72rem}}
      .league-stat-header .league-stat-value{{font-size:.58rem}}
    }}
    .poke-rank{{font-weight:700}}
    .poke-rank-pending{{font-weight:400;color:#7a9bbf;font-style:italic}}
    footer{{text-align:center;margin-top:3rem;color:#3a5570;font-size:.72rem}}
  </style>
</head>
<body>
  <h1>Simulateur de combat PvP</h1>
  <nav class="site-nav"><a href="rankings_fr.html">Classements</a></nav>
  <div class="controls">
    <div class="top-row">
      <div class="species-field">
        <label for="species-search">Pokémon</label>
        <input type="text" id="species-search" autocomplete="off" placeholder="Rechercher un Pokémon..." role="combobox" aria-expanded="false" aria-autocomplete="list">
        <input type="hidden" id="species-select">
        <div id="species-suggestions" class="suggestions" role="listbox"></div>
      </div>
      <div class="field-group iv-group">
        <label>IVs (Attaque / Défense / PV)</label>
        <div class="iv-inline">
          <input type="text" inputmode="numeric" id="iv-atk" value="15" aria-label="IV Attaque" title="IV Attaque">
          <span class="iv-sep">/</span>
          <input type="text" inputmode="numeric" id="iv-def" value="15" aria-label="IV Défense" title="IV Défense">
          <span class="iv-sep">/</span>
          <input type="text" inputmode="numeric" id="iv-hp" value="15" aria-label="IV PV" title="IV PV">
        </div>
      </div>
      <div class="iv-visual">
        <div class="iv-bar-track atk" title="Attaque">
          <div class="iv-bar-fill atk" id="iv-atk-fill"></div>
          <div class="iv-bar-ticks"></div>
        </div>
        <div class="iv-bar-track def" title="Défense">
          <div class="iv-bar-fill def" id="iv-def-fill"></div>
          <div class="iv-bar-ticks"></div>
        </div>
        <div class="iv-bar-track hp" title="PV">
          <div class="iv-bar-fill hp" id="iv-hp-fill"></div>
          <div class="iv-bar-ticks"></div>
        </div>
      </div>
    </div>
    <div class="field-group">
      <label>Attaques (rapide / chargée 1 / chargée 2)</label>
      <div class="inline-fields">
        <select id="fast-move-select" aria-label="Attaque rapide" title="Attaque rapide"></select>
        <select id="charged-move-1-select" aria-label="Attaque chargée 1" title="Attaque chargée 1"></select>
        <select id="charged-move-2-select" aria-label="Attaque chargée 2" title="Attaque chargée 2"></select>
      </div>
    </div>
  </div>
  <div id="loading">Chargement...</div>
  <div id="result-panel" class="result-panel"></div>
  <footer>Moteur : pvpoke.com (vendu localement) . Données &amp; noms : PokeAPI . Généré le {time.strftime('%d/%m/%Y')}</footer>
  {engine_scripts}
  <script src="gamemaster_shim.js"></script>
  <script src="battle_driver.js"></script>
</body>
</html>"""

if __name__ == "__main__":
    main()
    build_i18n_json()
    with open("battle_fr.html", "w", encoding="utf-8") as f:
        f.write(build_battle_html())
    print("Saved: battle_fr.html")
