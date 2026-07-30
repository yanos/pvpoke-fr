#!/bin/bash
# Serves the repo over HTTP and opens battle_fr.html, for testing the battle
# simulator locally without waiting on sync_engine.py / pvpoke_fr.py.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8934}"

lsof -ti:"$PORT" -sTCP:LISTEN | xargs -r kill || true

python3 -m http.server "$PORT" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT

until curl -sf "http://localhost:$PORT/battle_fr.html" >/dev/null 2>&1; do
	sleep 0.2
done

URL="http://localhost:$PORT/battle_fr.html"
echo "Serving at $URL (Ctrl+C to stop)"
open "$URL" 2>/dev/null || xdg-open "$URL" 2>/dev/null || echo "Open $URL in your browser"

wait "$SERVER_PID"
