#!/bin/bash
# Regenerates both site pages from scratch: refreshes the French name cache, vendors the pvpoke
# engine + data, then generates rankings_fr.html, vendor/pvpoke/data/i18n_fr.json, and
# battle_fr.html. Requires internet access; update_name_cache.py is the one PokeAPI-rate-limited
# step (30-45+ minutes over the whole gamemaster, ~1700 species/~330 moves, on a cold
# vendor/pvpoke/data/name_cache.json) — pvpoke_fr.py itself just reuses whatever that leaves in
# the cache, so it's fast except for species/moves that are new or still missing there. This
# script is generation-only and never touches git — commit
# vendor/pvpoke/data/name_cache.json yourself if you want a refreshed cache persisted.
set -euo pipefail
cd "$(dirname "$0")"

echo "== Refreshing French name cache =="
#python3 update_name_cache.py

echo "== Syncing pvpoke engine + data =="
python3 sync_engine.py

echo "== Generating rankings_fr.html, i18n_fr.json, battle_fr.html =="
python3 pvpoke_fr.py

echo "Done: rankings_fr.html, battle_fr.html, vendor/pvpoke/data/i18n_fr.json"
