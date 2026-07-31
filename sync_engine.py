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

# The five ranking scenarios pvpoke rates every species under (gamemaster `rankingScenarios`).
# battle_fr.html's global rank simulates a custom build under all five and compares against these
# published per-scenario `rating` values -- our engine reproduces them exactly (verified 1141/1143
# in a full round-robin), so candidate and reference sit on the same scale. See CLAUDE.md.
SCENARIOS = ["leads", "closers", "switches", "chargers", "attackers"]
LEAGUE_CPS = [1500, 2500, 10000]


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


def sync_scenario_ratings():
    """Condense the 5 per-scenario ranking files per league into one compact lookup.

    The raw files are ~1 MB each (15 MB total) but we only need each species' per-scenario
    `rating`; movesets are identical to the already-vendored overall rankings (verified: 0/1143
    differ), so they aren't duplicated here. Output per league is ~50 KB.
    """
    for cp in LEAGUE_CPS:
        # Carry forward the normalisation constants build_scenario_norm.js computed on a previous
        # run. They need the JS engine so we can't recompute them here, and dropping them would
        # leave battle_fr.html's global rank broken on machines without Node.
        dest = os.path.join(VENDOR_DIR, f"data/scenario-ratings-{cp}.json")
        previous_highest = None
        if os.path.exists(dest):
            with open(dest) as f:
                previous_highest = json.load(f).get("highest")

        ratings = {}
        for idx, slug in enumerate(SCENARIOS):
            data = json.loads(fetch(f"https://pvpoke.com/data/rankings/all/{slug}/rankings-{cp}.json"))
            for entry in data:
                ratings.setdefault(entry["speciesId"], [None] * len(SCENARIOS))[idx] = entry["rating"]

        # Drop any species missing a scenario rather than carrying a null into the math.
        complete = {k: v for k, v in ratings.items() if all(r is not None for r in v)}
        dropped = len(ratings) - len(complete)
        if dropped:
            print(f"  note: dropped {dropped} species missing a per-scenario rating")

        payload = {
            "cp": cp,
            "scenarios": SCENARIOS,
            # Per-scenario max, used to normalise a rating onto a 0-100 scale (Ranker.js does the
            # same for its scores). Precomputed so the worker doesn't rescan on every request.
            "max": [max(v[i] for v in complete.values()) for i in range(len(SCENARIOS))],
            "ratings": complete,
        }
        if previous_highest:
            payload["highest"] = previous_highest

        write(f"data/scenario-ratings-{cp}.json",
              (json.dumps(payload, separators=(",", ":")) + "\n").encode())

    if not previous_highest:
        print("  note: no normalisation constants yet — run `node build_scenario_norm.js`")


def main():
    print("Syncing pvpoke battle engine...")
    for path in ENGINE_FILES:
        rel = "engine/" + os.path.basename(path)
        write(rel, fetch(f"{REPO_RAW}/{path}"))

    print("Syncing pvpoke live data...")
    for url, rel in DATA_FILES.items():
        write(rel, fetch(url))

    print("Condensing per-scenario ranking data...")
    sync_scenario_ratings()

    sha = latest_master_sha()
    write("VERSION", (sha + "\n").encode())
    print(f"\nSynced against pvpoke/pvpoke@{sha}")


if __name__ == "__main__":
    main()
