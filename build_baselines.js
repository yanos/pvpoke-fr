// Offline generator for vendor/pvpoke/data/baselines/baseline-<cp>.json.
// Run: node build_baselines.js
//
// Why this exists
// ---------------
// battle_worker.js rates a user's custom build by simulating it against the whole opponent
// field and then asking "where does that rating land?". It used to answer that by splicing
// into the `rating` values from vendor/pvpoke/data/rankings/rankings-*.json — pvpoke.com's
// own published numbers. That comparison was invalid on two counts:
//
//   1. Those published ratings come from pvpoke's Ranker.js/RankerOverall.js, which run all
//      five gamemaster `rankingScenarios` (leads/closers/switches/chargers/attackers) with
//      rank-weighted opponents. battle_worker.js runs a single flat, unweighted
//      shieldMode:"average" pass. Re-simulating a *published* build here reproduces its
//      published rating only to within ~70-95 points, and the error is not constant — so it
//      can't be corrected with an offset. The practical effect was that the best rating this
//      engine can emit was beaten by ~22 published entries, making rank 1 unreachable for
//      every possible build.
//   2. rankings-*.json is sorted by `score`, not `rating`. Splicing into a re-sorted `rating`
//      array answers "Nth-highest average battle rating", which tracks tier rank poorly
//      (zweilous_shadow holds the 4th-highest rating in the file at tier rank 152).
//
// The fix is to compare like with like: rate the reference field with the *same* simulator
// that rates the candidate. This script does that offline (it's far too slow to do in the
// browser — a top-150 sweep is ~150 x field-size x 2 battles per league) and writes a
// rating-sorted baseline list that battle_worker.js splices into instead.
//
// The output is therefore a rank under *this tool's* methodology, not pvpoke.com's published
// tier rank. See CLAUDE.md for the caveat and the plan for closing that gap properly.

const fs = require("fs");
const path = require("path");

const LEAGUE_CPS = [1500, 2500, 10000];
const TOP_N = 150; // ranks past this aren't interesting; a full round-robin would be ~1.3M battles
const OUT_DIR = path.join(__dirname, "vendor/pvpoke/data/baselines");

global.fetch = async function (url) {
	const localPath = path.join(__dirname, url);
	const data = fs.readFileSync(localPath, "utf-8");
	return { json: async () => JSON.parse(data) };
};

// Browsers share one global lexical environment across <script> tags, so class/var
// declarations in each vendored file are visible to the next. Node's indirect eval does
// not do this per-call, so concatenate everything into a single eval to match browser
// semantics. (Same bootstrap as test_engine.js — kept self-contained rather than shared,
// matching how battle_worker.js also hand-ports the two bare globals below.)
const files = [
	"vendor/pvpoke/engine/DamageCalculator.js",
	"vendor/pvpoke/engine/ActionLogic.js",
	"vendor/pvpoke/engine/TimelineEvent.js",
	"vendor/pvpoke/engine/TimelineAction.js",
	"vendor/pvpoke/engine/DecisionOption.js",
	"vendor/pvpoke/engine/Battle.js",
	"vendor/pvpoke/engine/Pokemon.js",
	"vendor/pvpoke/engine/TeamRanker.js",
	"gamemaster_shim.js",
];
const bundle = files.map((rel) => fs.readFileSync(path.join(__dirname, rel), "utf-8")).join("\n;\n");
// eslint-disable-next-line no-eval
eval.call(global, bundle);

// Bare globals TeamRanker.js reads directly — on pvpoke.com's real page these are inlined in
// the battle page's own <script>. Values copied verbatim from that page, same as test_engine.js.
global.getDefaultMultiBattleSettings = function () {
	return {
		shields: 1, ivs: "original", bait: 1, levelCap: 50,
		startHp: 1, startEnergy: 0, startCooldown: 0, optimizeMoveTiming: true, startStatBuffs: [0, 0],
	};
};

global.settings = {
	defaultIVs: "gamemaster", animateTimeline: 1, matrixDirection: "row", gamemaster: "gamemaster",
	pokeboxId: 0, pokeboxLastDateTime: 0, xls: true, rankingDetails: "one-page", hardMovesetLinks: 0,
	colorblindMode: 0, performanceMode: 0, theme: "default",
};

// Build a reference Pokemon the way pvpoke's own rankings assume it's played: its best IV
// spread for the cap (maximizeStat("overall") is what the site's "Maximize / Overall / Auto
// Level" button calls) running the moveset its ranking entry lists.
function buildReference(battle, entry) {
	const poke = new Pokemon(entry.speciesId, 0, battle);
	poke.maximizeStat("overall"); // also sets isCustom, so initialize() won't override the IVs
	poke.initialize(battle.getCP());

	poke.selectMove("fast", entry.moveset[0]);
	poke.selectMove("charged", entry.moveset[1], 0);
	if (entry.moveset.length > 2) {
		poke.selectMove("charged", entry.moveset[2], 1);
	} else {
		poke.chargedMoves.splice(1, 1);
	}
	poke.resetMoves();

	return poke;
}

async function buildLeague(gm, cp) {
	const rankingData = await gm.loadRankingData(null, "overall", cp, "all");

	const battle = new Battle();
	battle.setCP(cp);
	battle.setCup("all");
	const cup = gm.getCupById("all");

	// The opponent field, built exactly as battle_worker.js's getField() builds it so both
	// sides of the eventual comparison see the same opposition.
	const field = gm.generateFilteredPokemonList(battle, cup.include || [], cup.exclude || []);

	const ranker = RankerMaster.getInstance();
	ranker.setShieldMode("average"); // must match battle_worker.js
	const s = {
		shields: 1, ivs: "original", bait: 1, levelCap: battle.getLevelCap(),
		startHp: 1, startEnergy: 0, startCooldown: 0, optimizeMoveTiming: true, startStatBuffs: [0, 0],
	};
	ranker.applySettings(s, 0);
	ranker.applySettings(s, 1);

	// rankings-*.json is already sorted by `score`, so the first TOP_N entries are the
	// strongest species — the only ones a meaningful rank number needs to distinguish between.
	const entries = rankingData.slice(0, TOP_N);
	const results = [];

	process.stdout.write(`  CP${cp}: field=${field.length}, rating ${entries.length} species `);

	for (let i = 0; i < entries.length; i++) {
		const refBattle = new Battle();
		refBattle.setCP(cp);
		refBattle.setCup("all");

		const poke = buildReference(refBattle, entries[i]);
		ranker.setTargets([poke]);

		const data = ranker.rank(field, cp, cup);
		results.push({ speciesId: entries[i].speciesId, rating: data.rankings[0].rating });

		if ((i + 1) % 25 === 0) process.stdout.write(".");
	}

	process.stdout.write(" done\n");

	results.sort((a, b) => b.rating - a.rating);
	return results;
}

async function main() {
	const gm = GameMaster.getInstance("vendor/pvpoke/data/");
	await gm.load();

	fs.mkdirSync(OUT_DIR, { recursive: true });

	console.log("Building baseline ratings (this takes a few minutes per league)...");

	for (const cp of LEAGUE_CPS) {
		const started = Date.now();
		const results = await buildLeague(gm, cp);

		const out = {
			cp: cp,
			// Recorded so a stale baseline is diagnosable after an engine re-sync.
			engineVersion: fs.readFileSync(path.join(__dirname, "vendor/pvpoke/VERSION"), "utf-8").trim(),
			generated: new Date().toISOString(),
			shieldMode: "average",
			count: results.length,
			ratings: results,
		};

		const outPath = path.join(OUT_DIR, `baseline-${cp}.json`);
		fs.writeFileSync(outPath, JSON.stringify(out, null, "\t") + "\n");

		const secs = ((Date.now() - started) / 1000).toFixed(1);
		console.log(`  wrote ${path.relative(__dirname, outPath)} ` +
			`(top=${results[0].speciesId} ${results[0].rating}, ` +
			`floor=${results[results.length - 1].rating}, ${secs}s)`);
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
