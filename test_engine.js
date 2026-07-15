// Headless Node smoke test for the vendored engine + gamemaster_shim.js.
// Not part of the shipped site — verifies the Lickilicky example from the pvpoke URL
// (battle/multi/1500/all/lickilicky/11/1-1-4/2-1/160/0/) produces sane output.
// Run: node test_engine.js

const fs = require("fs");
const path = require("path");

global.fetch = async function (url) {
	const localPath = path.join(__dirname, url);
	const data = fs.readFileSync(localPath, "utf-8");
	return { json: async () => JSON.parse(data) };
};

// Browsers share one global lexical environment across <script> tags, so class/var
// declarations in each vendored file are visible to the next. Node's indirect eval does
// not do this per-call, so concatenate everything into a single eval to match browser semantics.
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

global.getDefaultMultiBattleSettings = function () {
	return {
		shields: 1, ivs: "original", bait: 1, levelCap: 50,
		startHp: 1, startEnergy: 0, startCooldown: 0, optimizeMoveTiming: true, startStatBuffs: [0, 0],
	};
};

// Bare global TeamRanker.js reads directly (settings.matrixDirection) — on pvpoke's real page
// this is inlined in the battle page's own <script>. Values copied verbatim from that page.
global.settings = {
	defaultIVs: "gamemaster",
	animateTimeline: 1,
	matrixDirection: "row",
	gamemaster: "gamemaster",
	pokeboxId: 0,
	pokeboxLastDateTime: 0,
	xls: true,
	rankingDetails: "one-page",
	hardMovesetLinks: 0,
	colorblindMode: 0,
	performanceMode: 0,
	theme: "default",
};

async function main() {
	const gm = GameMaster.getInstance("vendor/pvpoke/data/");
	await gm.load();
	await gm.loadRankingData(null, "overall", 1500, "all");

	const battle = new Battle();
	battle.setCP(1500);
	battle.setCup("all");

	// Lickilicky, level 11, IVs 1/1/4, Lick + Body Slam + Rock Slide, 1 shield, bait selective (from example URL).
	const poke = new Pokemon("lickilicky", 0, battle);
	poke.ivs.atk = 1;
	poke.ivs.def = 1;
	poke.ivs.hp = 4;
	poke.isCustom = true;
	poke.setLevel(11, false);
	poke.initialize(battle.getCP());
	poke.selectMove("fast", "LICK");
	poke.selectMove("charged", "BODY_SLAM", 0);
	poke.selectMove("charged", "ROCK_SLIDE", 1);
	poke.resetMoves();
	poke.startingShields = 1;
	poke.baitShields = 1;

	console.log("CP:", poke.cp, "stats:", poke.stats);

	const settings = {
		shields: 1, ivs: "original", bait: 1, levelCap: battle.getLevelCap(),
		startHp: 1, startEnergy: 0, startCooldown: 0, optimizeMoveTiming: true, startStatBuffs: [0, 0],
	};
	const opponentSettings = { ...settings, bait: 1 };

	const ranker = RankerMaster.getInstance();
	ranker.applySettings(settings, 0);
	ranker.applySettings(opponentSettings, 1);
	ranker.setTargets([]);

	const data = ranker.rank([poke], battle.getCP(), battle.getCup());
	console.log("Total ranked opponents:", data.rankings.length);

	const sorted = data.rankings.slice().sort((a, b) => a.opRating - b.opRating);
	console.log("Worst 5 matchups (lowest opRating for opponent = best for us):");
	sorted.slice(0, 5).forEach((r, i) => console.log(`  #${i + 1} ${r.speciesName} opRating=${r.opRating}`));

	console.log("Best 5 matchups (highest opRating for opponent = worst for us):");
	sorted.slice(-5).reverse().forEach((r, i) => console.log(`  #${i + 1} ${r.speciesName} opRating=${r.opRating}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
