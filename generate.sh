#!/bin/bash
# Regenerates both site pages from scratch: vendors the pvpoke engine + data,
# then generates rankings_fr.html, vendor/pvpoke/data/i18n_fr.json, and battle_fr.html.
# Requires internet access; the pvpoke_fr.py step alone is on the order of 30-45+ minutes
# (walks every Pokemon/move in the gamemaster through PokeAPI with rate-limiting sleeps).
set -euo pipefail
cd "$(dirname "$0")"

echo "== Syncing pvpoke engine + data =="
python3 sync_engine.py

echo "== Generating rankings_fr.html, i18n_fr.json, battle_fr.html =="
python3 pvpoke_fr.py

echo "Done: rankings_fr.html, battle_fr.html, vendor/pvpoke/data/i18n_fr.json"
