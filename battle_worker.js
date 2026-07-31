// Web Worker for battle_fr.html: places a custom build (species + IVs + level + moveset) on
// pvpoke.com's published tier list by reproducing their ranking pipeline for that one build.
//
// How the number is produced
// --------------------------
// pvpoke rates every species under the five `rankingScenarios` in the gamemaster (leads, closers,
// switches, chargers, attackers), each a different shield/energy setup. For each scenario a
// species battles the whole eligible field; the results become a weighted average (Ranker.js),
// normalised onto 0-100. The five scenario scores are then combined into the final tier score by a
// weighted geometric mean plus a "consistency" term (RankerOverall.js). We do exactly that for the
// user's build, then look up where the resulting score falls in the published rankings.
//
// How faithful this actually is (measured, not assumed)
// ----------------------------------------------------
//   - Battle simulation -> per-scenario `rating`: EXACT. A full CP1500 round-robin reproduced
//     1141/1143 published ratings, and all 5 scenarios reproduce exactly for spot-checked species.
//   - `calculateConsistency`: EXACT (vendored Pokemon.js is pvpoke's own).
//   - RankerOverall.js's combination formula: EXACT — reproduces all 1143 published overall scores
//     once the published `editorScore` overrides are applied.
//   - Ranker.js's *weighting* step: NOT reproducible. Fed exactly-correct simulation inputs it
//     reproduces only 9/1143 published per-scenario scores, and no variant of the exponent, cutoff
//     or iteration count fits. pvpoke's published source is out of sync with whatever generated
//     the live data at that stage.
//
// So the score here is close to but not identical with pvpoke's: a default-IV build typically
// lands within about a point of its published score (mimikyu 96.0 vs 95.9, altaria 93.6 vs 92.2).
// That's good enough to rank a build against the real tier list, which is the point — but it is an
// approximation, and the UI says so. See CLAUDE.md for the full investigation.
//
// One consequence worth knowing: 94 of 1143 CP1500 entries carry a hand-authored `editorScore`
// weighted at 75% of the final score. We apply it (otherwise our score wouldn't sit on the same
// scale as the list we're ranking against), which means IV changes move only the remaining 25%
// for those species. Species without an override are fully IV-sensitive.
//
// Message protocol (see battle_driver.js's dispatchGlobalRankRequests/onGlobalRankMessage):
//   in:  { type: "computeGlobalRank", requestId, generation, speciesId, leagueId, ivs, moves, cp }
//   out: { type: "globalRankResult", requestId, generation, speciesId, leagueId,
//          result: {rank, count, score} }
//     or { type: "globalRankResult", requestId, generation, speciesId, leagueId, error: "..." }
//   generation/speciesId/leagueId are echoed back unchanged so the main thread can route/discard
//   the reply without keeping its own requestId -> context map.

importScripts(
	"vendor/pvpoke/engine/DamageCalculator.js",
	"vendor/pvpoke/engine/ActionLogic.js",
	"vendor/pvpoke/engine/TimelineEvent.js",
	"vendor/pvpoke/engine/TimelineAction.js",
	"vendor/pvpoke/engine/DecisionOption.js",
	"vendor/pvpoke/engine/Battle.js",
	"vendor/pvpoke/engine/Pokemon.js",
	"vendor/pvpoke/engine/TeamRanker.js",
	"gamemaster_shim.js"
);

// Bare globals the vendored engine reads directly - on pvpoke.com's real page they're inlined in
// the battle page's own <script>; hand-ported here the same way test_engine.js does it.
var settings = {
	defaultIVs: "gamemaster", animateTimeline: 1, matrixDirection: "row", gamemaster: "gamemaster",
	pokeboxId: 0, pokeboxLastDateTime: 0, xls: true, rankingDetails: "one-page", hardMovesetLinks: 0,
	colorblindMode: 0, performanceMode: 0, theme: "default",
};
function getDefaultMultiBattleSettings() {
	return {
		shields: 1, ivs: "original", bait: 1, levelCap: 50,
		startHp: 1, startEnergy: 0, startCooldown: 0, optimizeMoveTiming: true, startStatBuffs: [0, 0],
	};
}

// Shield/energy setup per scenario, in the same order as the `scenarios` array that
// sync_engine.py writes into scenario-ratings-<cp>.json.
var SCENARIO_SETUP = [
	{ shields: [1, 1], energy: [0, 0] }, // leads
	{ shields: [0, 0], energy: [0, 0] }, // closers
	{ shields: [1, 1], energy: [4, 0] }, // switches
	{ shields: [1, 1], energy: [6, 0] }, // chargers
	{ shields: [0, 1], energy: [0, 0] }, // attackers
];

var gm = GameMaster.getInstance();
var loaded = null;      // Promise, memoized
var leagueCache = {};   // cp -> { field, weights, scenarioRatings, rankings, byId } - IV-invariant

function ensureLoaded() {
	if (!loaded) loaded = gm.load();
	return loaded;
}

// Everything here depends only on the league, never on the candidate's IVs, so it's built once and
// reused for every subsequent request rather than rebuilt on each IV change.
function getLeague(cp) {
	if (leagueCache[cp]) return Promise.resolve(leagueCache[cp]);

	var url = "vendor/pvpoke/data/scenario-ratings-" + cp + ".json";

	return Promise.all([
		gm.loadRankingData(null, "overall", cp, "all"),
		fetch(url).then(function (r) {
			if (!r.ok) throw new Error("scenario data missing (" + url + ") - run sync_engine.py");
			return r.json();
		}),
	]).then(function (results) {
		var rankings = results[0];
		var sr = results[1];

		if (!sr.highest) {
			throw new Error("scenario data has no normalisation constants - run build_scenario_norm.js");
		}

		var battle = new Battle();
		battle.setCP(cp);
		battle.setCup("all");
		var cup = gm.getCupById("all");

		var field = gm.generateFilteredPokemonList(battle, cup.include || [], cup.exclude || [], rankings, []);
		var byId = {};
		rankings.forEach(function (e) { byId[e.speciesId] = e; });

		// Force each opponent's published moveset. generateFilteredPokemonList picks moves by usage
		// share instead, which disagrees with the published `moveset` for a handful of species
		// (tinkaton gets PLAY_ROUGH rather than BULLDOZE) because pvpoke's own run is
		// self-referential - it feeds the *previous* rankings' usage in. Forcing the published
		// moveset is what makes our per-scenario ratings match theirs exactly.
		field.forEach(function (p) {
			var e = byId[p.speciesId];
			if (!e) return;
			p.selectMove("fast", e.moveset[0]);
			p.selectMove("charged", e.moveset[1], 0);
			if (e.moveset.length > 2) p.selectMove("charged", e.moveset[2], 1);
			else p.chargedMoves.splice(1, 1);
			p.resetMoves();
		});

		// Opponent weights come straight from pvpoke's published per-scenario ratings, so they're
		// identical to the ones their own ranking run used - no simulation needed to derive them.
		var weights = sr.scenarios.map(function (_, idx) {
			return field.map(function (p) {
				var r = sr.ratings[p.speciesId];
				if (!r) return 0;
				return Math.pow(Math.max((r[idx] / sr.max[idx]) - 0.1, 0), 1.65);
			});
		});

		leagueCache[cp] = {
			field: field, weights: weights, scenarioRatings: sr, rankings: rankings, byId: byId,
			// Published scores, descending, for the final rank lookup.
			scores: rankings.map(function (e) { return e.score; }).sort(function (a, b) { return b - a; }),
		};
		return leagueCache[cp];
	});
}

// Battle `pokemon` against the whole field under one scenario. Kept byte-identical to
// build_scenario_norm.js's copy - they run in different realms (Worker vs Node) with no module
// system between them, so they're duplicated deliberately. Change both together.
function scenarioSweep(battle, pokemon, field, setup) {
	var adj = new Float64Array(field.length);

	for (var j = 0; j < field.length; j++) {
		var opponent = field[j];

		battle.setNewPokemon(pokemon, 0, false);
		battle.setNewPokemon(opponent, 1, false);
		pokemon.reset();
		opponent.reset();
		pokemon.setShields(setup.shields[0]);
		opponent.setShields(setup.shields[1]);

		// Energy advantage, ported verbatim from Ranker.js - including its use of `energy[0]` and
		// the *candidate's* fast move cooldown when deriving the OPPONENT's start energy. That looks
		// like an upstream slip, but reproducing their numbers exactly means reproducing it too.
		if (setup.energy[0] === 0) {
			pokemon.startEnergy = 0;
		} else {
			var n0 = Math.floor((setup.energy[0] * 500) / pokemon.fastMove.cooldown) || 1;
			pokemon.startEnergy = Math.min(pokemon.fastMove.energyGain * n0, 100);
		}
		if (setup.energy[1] === 0) {
			opponent.startEnergy = 0;
		} else {
			var n1 = Math.floor((setup.energy[0] * 500) / pokemon.fastMove.cooldown) || 1;
			opponent.startEnergy = Math.min(opponent.fastMove.energyGain * n1, 100);
		}

		battle.simulate();

		var rating = Math.floor(((pokemon.hp / pokemon.stats.hp) +
			((opponent.stats.hp - opponent.hp) / opponent.stats.hp)) * 500);
		var opRating = Math.floor(((opponent.hp / opponent.stats.hp) +
			((pokemon.stats.hp - pokemon.hp) / pokemon.stats.hp)) * 500);

		// Shields burned/remaining only count for the winner.
		var winMultiplier = rating > opRating ? 1 : 0;
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
	var score = 0;
	var weightSum = 0;

	for (var j = 0; j < field.length; j++) {
		var a = adj[j];
		var w = weights[j];

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

// RankerOverall.js's combination, verbatim: the best scenarios dominate (so a specialist isn't
// punished for being mediocre elsewhere), tempered by the consistency term.
function combineScenarioScores(norm, consistency) {
	var sorted = [norm[0], norm[1], Math.max(norm[2], norm[3]), norm[4]]
		.sort(function (a, b) { return b - a; });

	var score = Math.pow(
		Math.pow(sorted[0], 12) * Math.pow(sorted[1], 6) * Math.pow(sorted[2], 4) *
		Math.pow(sorted[3], 2) * Math.pow(consistency, 2), 1 / 26);

	// Pokemon that are weak as attackers *and* inconsistent get pulled down further.
	if (norm[4] <= 75 && consistency <= 75) {
		score = Math.pow(Math.pow(score, 14) * norm[4] * consistency, 1 / 16);
	}

	return score;
}

function maxLevelForCap(poke, cpCap, levelCap) {
	var best = 1;
	for (var lvl = 1; lvl <= levelCap; lvl += 0.5) {
		poke.setLevel(lvl, false);
		if (poke.calculateCP() > cpCap) break;
		best = lvl;
	}
	poke.setLevel(best, false);
	return best;
}

function buildCandidate(battle, speciesId, ivs, moves) {
	var poke = new Pokemon(speciesId, 0, battle);
	poke.ivs.atk = ivs.atk;
	poke.ivs.def = ivs.def;
	poke.ivs.hp = ivs.hp;
	poke.isCustom = true;

	maxLevelForCap(poke, battle.getCP(), battle.getLevelCap());
	poke.initialize(battle.getCP());

	poke.selectMove("fast", moves.fast);
	poke.selectMove("charged", moves.charged1, 0);
	if (moves.charged2 && moves.charged2 != "none") {
		poke.selectMove("charged", moves.charged2, 1);
	} else {
		poke.chargedMoves.splice(1, 1);
	}
	poke.resetMoves();

	return poke;
}

function computeGlobalRank(speciesId, ivs, moves, cp) {
	return ensureLoaded().then(function () {
		return getLeague(cp);
	}).then(function (league) {
		var sr = league.scenarioRatings;

		var battle = new Battle();
		battle.setCP(cp);
		battle.setCup("all");

		var candidate = buildCandidate(battle, speciesId, ivs, moves);

		// One full sweep of the field per scenario, normalised onto pvpoke's 0-100 scale.
		var norm = sr.scenarios.map(function (slug, i) {
			var adj = scenarioSweep(battle, candidate, league.field, SCENARIO_SETUP[i]);
			var w = weightedScore(adj, league.field, league.weights[i], speciesId, slug);
			return (w / sr.highest[i]) * 100;
		});

		var score = combineScenarioScores(norm, candidate.calculateConsistency());

		// The published list bakes in hand-authored editor scores at 75% weight for some species.
		// Apply the same adjustment, otherwise this score wouldn't sit on the scale we're about to
		// rank it against. (It does mean IVs only move the remaining 25% for those species.)
		var published = league.byId[speciesId];
		var editorial = !!(published && published.editorScore !== undefined);
		if (editorial) {
			score = (score * 0.25) + (published.editorScore * 0.75);
		}
		score = Math.floor(score * 10) / 10;

		// Position among pvpoke's own published tier scores.
		var scores = league.scores;
		var idx = scores.findIndex(function (s) { return s <= score; });
		var rank = idx === -1 ? scores.length + 1 : idx + 1;

		return { rank: rank, count: scores.length, score: score, editorial: editorial };
	});
}

self.onmessage = function (e) {
	var msg = e.data;
	if (msg.type !== "computeGlobalRank") return;

	// Echo back everything the main thread needs to route this reply (generation, speciesId,
	// leagueId) rather than making it track a requestId -> context map itself.
	computeGlobalRank(msg.speciesId, msg.ivs, msg.moves, msg.cp).then(function (result) {
		self.postMessage({
			type: "globalRankResult", requestId: msg.requestId, generation: msg.generation,
			speciesId: msg.speciesId, leagueId: msg.leagueId, result: result,
		});
	}).catch(function (err) {
		self.postMessage({
			type: "globalRankResult", requestId: msg.requestId, generation: msg.generation,
			speciesId: msg.speciesId, leagueId: msg.leagueId, error: String(err),
		});
	});
};
