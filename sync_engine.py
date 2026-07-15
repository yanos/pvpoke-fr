#!/usr/bin/env python3
"""Vendor pvpoke's battle engine (JS) and live data into vendor/pvpoke/.

The engine core (Battle/Pokemon/DamageCalculator/ActionLogic/Timeline/TeamRanker) has
no jQuery/DOM coupling and is vendored verbatim. Only GameMaster.js is coupled to
the browser -- it is NOT vendored; gamemaster_shim.js replaces it.

Run periodically (see .github/workflows/rankings.yml). Safe to re-run: every file
is overwritten from upstream, nothing here is hand-edited.
"""

import json, os, urllib.request

REPO_RAW = "https://raw.githubusercontent.com/pvpoke/pvpoke/master"
REPO_API = "https://api.github.com/repos/pvpoke/pvpoke"
VENDOR_DIR = "vendor/pvpoke"

ENGINE_FILES = [
    "src/js/battle/DamageCalculator.js",
    "src/js/battle/Battle.js",
    "src/js/battle/actions/ActionLogic.js",
    "src/js/battle/timeline/TimelineAction.js",
    "src/js/battle/timeline/TimelineEvent.js",
    "src/js/battle/rankers/TeamRanker.js",
    "src/js/pokemon/Pokemon.js",
    "src/js/training/DecisionOption.js",
]

DATA_FILES = {
    "https://pvpoke.com/data/gamemaster.min.json": "data/gamemaster.json",
    "https://pvpoke.com/data/rankings/all/overall/rankings-1500.json":  "data/rankings/rankings-1500.json",
    "https://pvpoke.com/data/rankings/all/overall/rankings-2500.json":  "data/rankings/rankings-2500.json",
    "https://pvpoke.com/data/rankings/all/overall/rankings-10000.json": "data/rankings/rankings-10000.json",
}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pvpoke-fr-sync/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


def write(rel_path, content_bytes):
    dest = os.path.join(VENDOR_DIR, rel_path)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(content_bytes)
    print(f"  wrote {dest} ({len(content_bytes)} bytes)")


def latest_master_sha():
    data = json.loads(fetch(f"{REPO_API}/commits/master"))
    return data["sha"]


def main():
    print("Syncing pvpoke battle engine...")
    for path in ENGINE_FILES:
        rel = "engine/" + os.path.basename(path)
        write(rel, fetch(f"{REPO_RAW}/{path}"))

    print("Syncing pvpoke live data...")
    for url, rel in DATA_FILES.items():
        write(rel, fetch(url))

    sha = latest_master_sha()
    write("VERSION", (sha + "\n").encode())
    print(f"\nSynced against pvpoke/pvpoke@{sha}")


if __name__ == "__main__":
    main()
