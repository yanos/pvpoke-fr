// Web Worker for battle_fr.html: computes a battle-simulated "true global rank" for a custom
// build (species + IVs + level + moveset) against the full opponent field for a league, using
// the vendored TeamRanker/ActionLogic/Battle engine - the same machinery pvpoke.com itself uses
// to produce the `rating` field in vendor/pvpoke/data/rankings/rankings-*.json.
//
// This runs off the main thread because it's genuinely expensive relative to the rest of
// battle_driver.js's synchronous IV-rank/species-rank/level/CP computation: simulating one
// candidate against ~400-1100 opponents (2 shield scenarios each) takes on the order of
// 100-250ms per league. Keeping it here means typing in battle_fr.html's IV fields stays
// responsive - the cheap numbers update instantly, and this fills in a moment later per league,
// per panel.
//
// Message protocol (see battle_driver.js's dispatchGlobalRankRequests/onGlobalRankMessage):
//   in:  { type: "computeGlobalRank", requestId, generation, speciesId, leagueId, ivs, moves, cp }
//   out: { type: "globalRankResult", requestId, generation, speciesId, leagueId,
//          result: {rank, count, rating} }
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

// TeamRanker.js reads these as bare globals - on pvpoke.com's real page they're inlined in the
// battle page's own <script>; hand-ported here the same way test_engine.js does it.
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

var gm = GameMaster.getInstance();
var ranker = RankerMaster.getInstance();
ranker.setShieldMode("average"); // matches how rankings-*.json's own `rating` field is generated

var loaded = null; // Promise, memoized
var fieldCache = {}; // cp -> { field: Pokemon[], ratings: number[] sorted desc } - IV-invariant, built once

function ensureLoaded() {
	if (!loaded) loaded = gm.load();
	return loaded;
}

// The opponent field (every viable species at its own best IVs) and the known rating list it's
// spliced into don't depend on the candidate's IVs at all - build once per league, reuse for
// every subsequent request instead of rebuilding on each IV change.
//
// The baseline ratings deliberately come from baselines/baseline-<cp>.json (generated offline by
// build_baselines.js) rather than from rankings-*.json's own `rating` field. Splicing into the
// published ratings was wrong twice over: this engine reproduces them only to within ~70-95
// points (pvpoke generates them from all five rankingScenarios with rank-weighted opponents; we
// run one flat shieldMode:"average" pass), and rankings-*.json is sorted by `score` anyway, not
// by `rating`. The baseline file rates the top species with *this* simulator, so both sides of
// the comparison are finally on one scale. See build_baselines.js's header for the full story.
function getField(cp) {
	if (fieldCache[cp]) return Promise.resolve(fieldCache[cp]);

	var baselineUrl = "vendor/pvpoke/data/baselines/baseline-" + cp + ".json";

	return Promise.all([
		gm.loadRankingData(null, "overall", cp, "all"),
		fetch(baselineUrl).then(function (r) {
			if (!r.ok) throw new Error("baseline data missing (" + baselineUrl + ") - run build_baselines.js");
			return r.json();
		}),
	]).then(function (results) {
		var baseline = results[1];

		var battle = new Battle();
		battle.setCP(cp);
		battle.setCup("all");
		var cup = gm.getCupById("all");

		var field = gm.generateFilteredPokemonList(battle, cup.include || [], cup.exclude || []);
		// Already sorted descending by build_baselines.js, but don't rely on that.
		var ratings = baseline.ratings.map(function (e) { return e.rating; }).sort(function (a, b) { return b - a; });

		fieldCache[cp] = { field: field, ratings: ratings };
		return fieldCache[cp];
	});
}

// Same level-maxing rule as battle_driver.js's maxLevelForCap - duplicated here rather than
// shared since this file runs in a separate worker realm with no module system.
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
		return getField(cp);
	}).then(function (cached) {
		var battle = new Battle();
		battle.setCP(cp);
		battle.setCup("all");

		var candidate = buildCandidate(battle, speciesId, ivs, moves);

		var s = {
			shields: 1, ivs: "original", bait: 1, levelCap: battle.getLevelCap(),
			startHp: 1, startEnergy: 0, startCooldown: 0, optimizeMoveTiming: true, startStatBuffs: [0, 0],
		};
		ranker.applySettings(s, 0);
		ranker.applySettings(s, 1);
		ranker.setTargets([candidate]);

		var cup = gm.getCupById("all");
		var data = ranker.rank(cached.field, cp, cup);
		var rating = data.rankings[0].rating;

		// Splice this candidate's rating into the baseline ratings (sorted desc) to find its
		// position among them. The baseline only covers the top N species, so a candidate that
		// beats none of them is reported as "beyond" rather than given a precise number we
		// haven't actually computed.
		var ratings = cached.ratings;
		var idx = ratings.findIndex(function (r) { return r <= rating; });
		var beyond = idx === -1;

		return {
			rank: beyond ? ratings.length : idx + 1,
			beyond: beyond,
			count: ratings.length,
			rating: rating,
		};
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
