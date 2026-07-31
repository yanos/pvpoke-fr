// Adds the per-scenario normalisation constants to vendor/pvpoke/data/scenario-ratings-<cp>.json.
// Run: node build_scenario_norm.js   (after sync_engine.py has written those files)
//
// Why
// ---
// battle_fr.html places a custom build on pvpoke's *actual published tier list* by computing the
// build's five per-scenario scores the way pvpoke's Ranker.js does, then combining them with
// RankerOverall.js's formula. Ranker.js's last step normalises each scenario's weighted score
// onto 0-100 by dividing by the highest weighted score in the field:
//
//     score = floor((weightedScore / highest) * 1000) / 10
//
// `highest` is a property of the field, not of any candidate, so it's IV-invariant and computed
// once here rather than in the browser. Finding it needs actual battle simulation (the weighted
// score of the field's best species), which is why this is a Node step and not part of
// sync_engine.py's pure-stdlib Python.
//
// What is and isn't reproducible
// ------------------------------
// Verified against pvpoke's published data: this engine reproduces their per-scenario `rating`
// EXACTLY (1141/1143 in a full CP1500 round-robin), and RankerOverall.js's combination formula
// reproduces all 1143 published overall scores exactly once the published `editorScore` overrides
// are applied. What is NOT reproducible is Ranker.js's weighting step: fed exactly-correct
// simulation inputs it reproduces only 9/1143 published per-scenario scores, and no variant of
// the exponent/cutoff/iteration count fits. pvpoke's published source is simply out of sync with
// whatever generated the live data there. So the weighted score computed here is close to but not
// identical with pvpoke's; a default-IV build lands within roughly a point of its published score.
// See CLAUDE.md for the full account.

const fs = require("fs");
const path = require("path");

const LEAGUE_CPS = [1500, 2500, 10000];
// Shield/energy setup per scenario, mirroring gamemaster `rankingScenarios` (same order as the
// `scenarios` array sync_engine.py writes into scenario-ratings-<cp>.json).
const SCENARIO_SETUP = [
	{ shields: [1, 1], energy: [0, 0] }, // leads
	{ shields: [0, 0], energy: [0, 0] }, // closers
	{ shields: [1, 1], energy: [4, 0] }, // switches
	{ shields: [1, 1], energy: [6, 0] }, // chargers
	{ shields: [0, 1], energy: [0, 0] }, // attackers
];
// The best-weighted species isn't always the best-rated one, so probe a few of the top-rated.
const NORM_CANDIDATES = 8;

global.fetch = async function (url) {
	const localPath = path.join(__dirname, url);
	return { json: async () => JSON.parse(fs.readFileSync(localPath, "utf-8")) };
};

// Single eval to match browser semantics — see test_engine.js for why.
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
// eslint-disable-next-line no-eval
eval.call(global, files.map((rel) => fs.readFileSync(path.join(__dirname, rel), "utf-8")).join("\n;\n"));

global.getDefaultMultiBattleSettings = function () {
	return {
		shields: 1, ivs: "original", bait: 1, levelCap: 50,
		startHp: 1, startEnergy: 0, startCooldown: 0, optimizeMoveTiming: true, startStatBuffs: [0, 0],
	};
};
global.settings = { defaultIVs: "gamemaster", matrixDirection: "row" };

// Kept byte-identical in battle_worker.js — the two run in different realms (Node vs Worker) with
// no module system, so they're duplicated deliberately. Change both together.
function scenarioSweep(battle, pokemon, field, setup) {
	const adj = new Float64Array(field.length);

	for (let j = 0; j < field.length; j++) {
		const opponent = field[j];

		battle.setNewPokemon(pokemon, 0, false);
		battle.setNewPokemon(opponent, 1, false);
		pokemon.reset();
		opponent.reset();
		pokemon.setShields(setup.shields[0]);
		opponent.setShields(setup.shields[1]);

		// Energy advantage, ported verbatim from Ranker.js — including its use of `energy[0]` and
		// the *candidate's* fast move cooldown when deriving the OPPONENT's start energy. That looks
		// like an upstream slip, but reproducing their numbers exactly means reproducing it too.
		if (setup.energy[0] === 0) {
			pokemon.startEnergy = 0;
		} else {
			const n = Math.floor((setup.energy[0] * 500) / pokemon.fastMove.cooldown) || 1;
			pokemon.startEnergy = Math.min(pokemon.fastMove.energyGain * n, 100);
		}
		if (setup.energy[1] === 0) {
			opponent.startEnergy = 0;
		} else {
			const n = Math.floor((setup.energy[0] * 500) / pokemon.fastMove.cooldown) || 1;
			opponent.startEnergy = Math.min(opponent.fastMove.energyGain * n, 100);
		}

		battle.simulate();

		const rating = Math.floor(((pokemon.hp / pokemon.stats.hp) +
			((opponent.stats.hp - opponent.hp) / opponent.stats.hp)) * 500);
		const opRating = Math.floor(((opponent.hp / opponent.stats.hp) +
			((pokemon.stats.hp - pokemon.hp) / pokemon.stats.hp)) * 500);

		// Shields burned/remaining only count for the winner.
		let winMultiplier = rating > opRating ? 1 : 0;
		if (rating === 500) winMultiplier = 0;

		adj[j] = rating + ((100 * (opponent.startingShields - opponent.shields) * winMultiplier) +
			(100 * pokemon.shields * winMultiplier));

		pokemon.reset();
		opponent.reset();
	}

	return adj;
}

// Ranker.js's weighted average: opponents count in proportion to how good they themselves are, so
// beating a top-tier Pokemon is worth far more than beating a weak one.
function weightedScore(adj, field, weights, selfSpeciesId, slug) {
	let score = 0;
	let weightSum = 0;

	for (let j = 0; j < field.length; j++) {
		let a = adj[j];
		let w = weights[j];

		if (field[j].speciesId === selfSpeciesId) w = 0; // no mirror match

		// Soften blowout wins (volatile Pokemon shouldn't be rewarded for hard win/hard loss)...
		if (a > 700) a = 700 + Math.pow(a - 700, 0.5);
		// ...and punish hard losses harder.
		if (a < 300) a = Math.pow(300, (300 + a) / 600);
		// Switches specifically penalise hard losses: the point is to find *safe* switches.
		if (slug === "switches" && a < 500) w *= (1 + (Math.pow(500 - a, 2) / 20000));

		score += a * w;
		weightSum += w;
	}

	return score / weightSum;
}

// Opponent weights come straight from pvpoke's published per-scenario ratings — no simulation
// needed, and it keeps our weights identical to the ones their own run used.
function scenarioWeights(field, scenarioRatings, idx) {
	return field.map(function (p) {
		const r = scenarioRatings.ratings[p.speciesId];
		if (!r) return 0;
		return Math.pow(Math.max((r[idx] / scenarioRatings.max[idx]) - 0.1, 0), 1.65);
	});
}

function buildField(gm, battle, rankingData) {
	const cup = gm.getCupById("all");
	const field = gm.generateFilteredPokemonList(battle, cup.include || [], cup.exclude || [], rankingData, []);
	const byId = new Map(rankingData.map((e) => [e.speciesId, e]));

	// Force each opponent's published moveset. generateFilteredPokemonList picks moves by usage
	// share instead, which disagrees with the published `moveset` for a handful of species
	// (tinkaton gets PLAY_ROUGH rather than BULLDOZE) because pvpoke's own run is self-referential
	// — it feeds the *previous* rankings' usage in. Forcing the published moveset is what makes
	// our per-scenario ratings match theirs exactly.
	for (const p of field) {
		const e = byId.get(p.speciesId);
		if (!e) continue;
		p.selectMove("fast", e.moveset[0]);
		p.selectMove("charged", e.moveset[1], 0);
		if (e.moveset.length > 2) p.selectMove("charged", e.moveset[2], 1);
		else p.chargedMoves.splice(1, 1);
		p.resetMoves();
	}

	return field;
}

async function main() {
	const gm = GameMaster.getInstance("vendor/pvpoke/data/");
	await gm.load();

	for (const cp of LEAGUE_CPS) {
		const started = Date.now();
		const file = path.join(__dirname, `vendor/pvpoke/data/scenario-ratings-${cp}.json`);
		const sr = JSON.parse(fs.readFileSync(file, "utf-8"));

		const rankingData = await gm.loadRankingData(null, "overall", cp, "all");
		const battle = new Battle();
		battle.setCP(cp);
		battle.setCup("all");
		const field = buildField(gm, battle, rankingData);

		const highest = [];
		for (let s = 0; s < sr.scenarios.length; s++) {
			const weights = scenarioWeights(field, sr, s);
			const probes = Object.keys(sr.ratings)
				.sort((a, b) => sr.ratings[b][s] - sr.ratings[a][s])
				.slice(0, NORM_CANDIDATES);

			let hi = -1;
			for (const sid of probes) {
				const p = field.find((x) => x.speciesId === sid);
				if (!p) continue;
				hi = Math.max(hi, weightedScore(scenarioSweep(battle, p, field, SCENARIO_SETUP[s]),
					field, weights, sid, sr.scenarios[s]));
			}
			highest.push(hi);
		}

		sr.highest = highest;
		fs.writeFileSync(file, JSON.stringify(sr, null, 0) + "\n");
		console.log(`  CP${cp}: field=${field.length} highest=[${highest.map((h) => h.toFixed(1)).join(", ")}] ` +
			`(${((Date.now() - started) / 1000).toFixed(1)}s)`);
	}
}

main().catch((e) => { console.error(e); process.exit(1); });
