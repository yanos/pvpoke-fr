// Client-side driver for battle_fr.html.
//
// Wires the vendored pvpoke engine (Battle/Pokemon) + gamemaster_shim.js together: pick a
// Pokemon, set its IVs/moveset, and for each league show its level/CP (auto-maxed to the
// highest level, given the chosen IVs, whose CP still fits under that league's cap) and its
// rank in pvpoke's precomputed "all"/"overall" ranking list. No live battles are simulated, so
// ActionLogic/TeamRanker/Timeline* aren't needed here. All three leagues are shown at once (no
// tab navigation) and re-run automatically whenever any control changes. Results are rendered
// with French names/sprites from i18n_fr.json; the underlying computation runs on English
// species/move IDs exactly as pvpoke's engine expects, so level/CP/rank match pvpoke.com exactly.

var LEAGUES = [
	{ id: "super", name: "Ligue Super", cp: 1500 },
	{ id: "hyper", name: "Ligue Hyper", cp: 2500 },
	{ id: "master", name: "Ligue Master", cp: 10000 },
];

var gm = GameMaster.getInstance();
var i18n = { pokemon: {}, moves: {} };

var state = {
	speciesId: null,
	ivs: { atk: 0, def: 0, hp: 0 },
	fastMove: null,
	chargedMove1: null,
	chargedMove2: null,
};

function frPokemonName(speciesId) {
	var e = i18n.pokemon[speciesId];
	return e ? e.name : speciesId;
}

function frSprite(speciesId) {
	var e = i18n.pokemon[speciesId];
	return e ? e.sprite : "";
}

function frMoveName(moveId) {
	return i18n.moves[moveId] || moveId;
}

function init() {
	Promise.all([
		gm.load(),
		fetch("vendor/pvpoke/data/i18n_fr.json").then(function (r) { return r.json(); }),
	]).then(function (results) {
		i18n = results[1];
		// globalRank() reads gm.rankings[key] synchronously, so all three leagues' ranking data
		// must be loaded up front.
		return Promise.all(LEAGUES.map(function (l) {
			return gm.loadRankingData(null, "overall", l.cp, "all");
		}));
	}).then(function () {
		wireAutoRun();
		populateSpeciesPicker(); // selects the first species, which triggers the first computation
	});
}

// Re-run whenever any input changes, instead of requiring an explicit button press. There's no
// live battle simulation anymore (just a level/CP/rank lookup), so no debouncing is needed.
function wireAutoRun() {
	["iv-atk", "iv-def", "iv-hp"].forEach(function (id) {
		var el = document.getElementById(id);
		el.addEventListener("input", function () { clampIv(el); runBattles(); });
	});
	["fast-move-select", "charged-move-1-select", "charged-move-2-select"].forEach(function (id) {
		document.getElementById(id).addEventListener("change", runBattles);
	});
}

// IVs top out at 15 (the max any Pokemon can roll); <input type=number max> only stops the
// spinner arrows, not typed values, so clamp explicitly.
function clampIv(el) {
	var v = parseInt(el.value, 10);
	if (isNaN(v)) return;
	if (v > 15) el.value = 15;
	if (v < 0) el.value = 0;
}

function hasTag(pokemonData, tag) {
	return !!(pokemonData.tags && pokemonData.tags.indexOf(tag) !== -1);
}

var pokemonList = []; // {speciesId, name}, sorted by French display name

function populateSpeciesPicker() {
	pokemonList = gm.data.pokemon
		// Skip duplicate/alias entries, and skip Shadow forms specifically - runBattles() always
		// shows a species' Shadow counterpart (if any) alongside it, so it doesn't need its own
		// picker entry too.
		.filter(function (p) { return !p.aliasId && !hasTag(p, "shadow"); })
		.map(function (p) { return { speciesId: p.speciesId, name: frPokemonName(p.speciesId) }; })
		.sort(function (a, b) { return a.name.localeCompare(b.name); });

	var search = document.getElementById("species-search");
	search.addEventListener("input", function () { renderSuggestions(search.value); });
	search.addEventListener("focus", function () { renderSuggestions(search.value); });
	search.addEventListener("keydown", onSpeciesSearchKeydown);
	document.addEventListener("click", function (e) {
		if (e.target !== search && !e.target.closest("#species-suggestions")) closeSuggestions();
	});

	selectSpecies(pokemonList[0].speciesId);
}

function renderSuggestions(query) {
	var suggestions = document.getElementById("species-suggestions");
	var search = document.getElementById("species-search");
	var q = query.trim().toLowerCase();
	var matches = (q ? pokemonList.filter(function (p) { return p.name.toLowerCase().indexOf(q) !== -1; }) : pokemonList).slice(0, 30);

	suggestions.innerHTML = "";
	matches.forEach(function (p) {
		var item = document.createElement("div");
		item.className = "suggestion-item";
		item.setAttribute("role", "option");
		item.dataset.speciesId = p.speciesId;
		item.innerHTML = '<img src="' + frSprite(p.speciesId) + '" alt="">' + '<span>' + p.name + '</span>';
		// mousedown (not click) fires before the input's blur, so preventDefault keeps focus and
		// stops the document-level click-outside handler from closing the list first.
		item.addEventListener("mousedown", function (e) {
			e.preventDefault();
			selectSpecies(p.speciesId);
			closeSuggestions();
		});
		suggestions.appendChild(item);
	});

	suggestions.classList.toggle("open", matches.length > 0);
	search.setAttribute("aria-expanded", matches.length > 0 ? "true" : "false");
}

function closeSuggestions() {
	var suggestions = document.getElementById("species-suggestions");
	suggestions.classList.remove("open");
	document.getElementById("species-search").setAttribute("aria-expanded", "false");
}

function onSpeciesSearchKeydown(e) {
	var suggestions = document.getElementById("species-suggestions");
	var items = suggestions.querySelectorAll(".suggestion-item");
	if (e.key === "Escape") { closeSuggestions(); return; }
	if (!items.length) return;

	var active = suggestions.querySelector(".suggestion-item.active");
	var idx = active ? Array.prototype.indexOf.call(items, active) : -1;

	if (e.key === "ArrowDown") {
		e.preventDefault();
		idx = (idx + 1) % items.length;
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		idx = (idx - 1 + items.length) % items.length;
	} else if (e.key === "Enter") {
		e.preventDefault();
		if (active) { selectSpecies(active.dataset.speciesId); closeSuggestions(); }
		return;
	} else {
		return;
	}

	if (active) active.classList.remove("active");
	items[idx].classList.add("active");
	items[idx].scrollIntoView({ block: "nearest" });
}

function selectSpecies(speciesId) {
	document.getElementById("species-select").value = speciesId;
	document.getElementById("species-search").value = frPokemonName(speciesId);
	onSpeciesChange();
}

function onSpeciesChange() {
	var speciesId = document.getElementById("species-select").value;
	state.speciesId = speciesId;

	var battle = new Battle();
	battle.setCP(10000); // no cap while we read out the move pools
	var poke = new Pokemon(speciesId, 0, battle);

	// Default to the best-ranked moveset (fast + both charged attacks) for this species instead
	// of the engine's arbitrary default, preferring the format with the fullest movepool data
	// (Master has no CP cap) and falling back to whichever format actually ranks this species.
	var best = bestMoveset(speciesId);
	var fastSel = best ? { moveId: best[0] } : poke.fastMove;
	var charged1Sel = best ? { moveId: best[1] } : poke.chargedMoves[0];
	var charged2Sel = best && best[2] ? { moveId: best[2] } : (poke.chargedMoves[1] || { moveId: "none" });

	fillMoveSelect("fast-move-select", poke.fastMovePool, fastSel);
	fillMoveSelect("charged-move-1-select", poke.chargedMovePool, charged1Sel);
	fillMoveSelect("charged-move-2-select", [{ moveId: "none", displayName: "Aucune" }].concat(poke.chargedMovePool), charged2Sel);

	runBattles();
}

var MOVESET_PREFERENCE = ["master", "hyper", "super"];

// The pvpoke rankings entries already carry the moveset ([fast, charged1, charged2?]) used to
// compute that entry's score — reuse it as the "best attack set" default rather than
// re-deriving one, checking formats in order until one actually ranks this species.
function bestMoveset(speciesId) {
	for (var i = 0; i < MOVESET_PREFERENCE.length; i++) {
		var league = LEAGUES.filter(function (l) { return l.id === MOVESET_PREFERENCE[i]; })[0];
		var found = rankingEntry(league, speciesId);
		if (found && found.entry.moveset && found.entry.moveset.length) return found.entry.moveset;
	}
	return null;
}

// Same "best moveset" preference as onSpeciesChange's defaults, but returning a plain
// {fast, charged1, charged2} object instead of populating DOM selects - used for the
// evolution/Shadow variants shown alongside the user's actual selection, which have no
// move controls of their own.
function defaultMoveset(speciesId) {
	var best = bestMoveset(speciesId);
	if (best) {
		return { fast: best[0], charged1: best[1], charged2: best[2] || "none" };
	}

	// A freshly-constructed Pokemon has no move selected yet (fastMove is null, chargedMoves is
	// empty) until selectMove() is called, so fall back to the movepool itself - same as what an
	// unpopulated <select> would default to (its first <option>).
	var battle = new Battle();
	battle.setCP(10000);
	var poke = new Pokemon(speciesId, 0, battle);
	return {
		fast: poke.fastMovePool[0].moveId,
		charged1: poke.chargedMovePool[0].moveId,
		charged2: "none",
	};
}

function fillMoveSelect(elId, movePool, selected) {
	var select = document.getElementById(elId);
	select.innerHTML = "";
	movePool.forEach(function (m) {
		var opt = document.createElement("option");
		opt.value = m.moveId;
		opt.textContent = m.moveId == "none" ? "Aucune" : frMoveName(m.moveId);
		if (selected && m.moveId == selected.moveId) opt.selected = true;
		select.appendChild(opt);
	});
}

// CP rises monotonically with level, so the highest level under the cap is found by walking
// half-levels upward until CP would exceed it, then backing off one step.
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

// speciesId/ivs/moves are explicit params (rather than read from the DOM) so this can build
// both the user's selected Pokemon and the evolution/Shadow variants shown alongside it, which
// share the same IVs but have their own species-appropriate moveset.
function buildPokemon(battle, speciesId, ivs, moves) {
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

function buildUserPokemon(battle) {
	var speciesId = document.getElementById("species-select").value;
	var ivs = {
		atk: parseInt(document.getElementById("iv-atk").value),
		def: parseInt(document.getElementById("iv-def").value),
		hp: parseInt(document.getElementById("iv-hp").value),
	};
	var moves = {
		fast: document.getElementById("fast-move-select").value,
		charged1: document.getElementById("charged-move-1-select").value,
		charged2: document.getElementById("charged-move-2-select").value,
	};

	return buildPokemon(battle, speciesId, ivs, moves);
}

// Forward evolution line only (not previous stages), walked breadth-first so branching lines
// (e.g. Eevee) are fully covered. Returns speciesId itself first.
function evolutionChain(speciesId) {
	var chain = [speciesId];
	var seen = {};
	seen[speciesId] = true;
	var queue = [speciesId];

	while (queue.length) {
		var id = queue.shift();
		var data = gm.pokemonMap.get(id);
		var evolutions = (data && data.family && data.family.evolutions) || [];
		evolutions.forEach(function (evoId) {
			// Guard against a dangling reference (e.g. a gamemaster typo) pointing at a speciesId
			// that doesn't actually exist - skip it rather than building a Pokemon for it later.
			if (!seen[evoId] && gm.pokemonMap.has(evoId)) {
				seen[evoId] = true;
				chain.push(evoId);
				queue.push(evoId);
			}
		});
	}

	return chain;
}

// Every variant to display for the selected species: itself, its Shadow form (if any), then
// each forward evolution paired with its own Shadow form (if any) - Shadow is always shown
// alongside its normal counterpart rather than being separately selectable (see
// populateSpeciesPicker).
function buildVariantList(speciesId) {
	var variants = [];

	function addWithShadow(id, kind, shadowKind) {
		variants.push({ speciesId: id, kind: kind });
		var shadowId = id + "_shadow";
		if (gm.pokemonMap.has(shadowId)) {
			variants.push({ speciesId: shadowId, kind: shadowKind });
		}
	}

	var chain = evolutionChain(speciesId);
	addWithShadow(chain[0], "selected", "shadow");
	chain.slice(1).forEach(function (evoId) {
		addWithShadow(evoId, "evolution", "evolution-shadow");
	});

	return variants;
}

// Ranking-list entry (and 1-based rank) for a species within a league, from the same
// "all"/"overall" ranking data already loaded for opponent selection. Null if the species
// doesn't appear (e.g. filtered out as too weak to be ranked in that league).
function rankingEntry(league, speciesId) {
	var list = gm.rankings["all" + "overall" + league.cp];
	if (!list) return null;
	for (var i = 0; i < list.length; i++) {
		if (list[i].speciesId === speciesId) return { rank: i + 1, entry: list[i] };
	}
	return null;
}

function globalRank(league, speciesId) {
	var found = rankingEntry(league, speciesId);
	return found ? found.rank : null;
}

function runBattles() {
	var ivs = {
		atk: parseInt(document.getElementById("iv-atk").value),
		def: parseInt(document.getElementById("iv-def").value),
		hp: parseInt(document.getElementById("iv-hp").value),
	};
	var userMoves = {
		fast: document.getElementById("fast-move-select").value,
		charged1: document.getElementById("charged-move-1-select").value,
		charged2: document.getElementById("charged-move-2-select").value,
	};

	var groups = buildVariantList(state.speciesId).map(function (variant) {
		// The selected species uses the user's own move picks; evolutions/Shadow forms (which have
		// no move controls of their own) fall back to their own best-ranked moveset, same IVs.
		var moves = variant.kind === "selected" ? userMoves : defaultMoveset(variant.speciesId);
		var results = LEAGUES.map(function (league) { return runLeague(league, variant.speciesId, ivs, moves); });
		return { kind: variant.kind, results: results };
	});

	renderResults(groups);
}

function runLeague(league, speciesId, ivs, moves) {
	var battle = new Battle();
	battle.setCP(league.cp);
	battle.setCup("all");

	var poke = buildPokemon(battle, speciesId, ivs, moves);

	// Two different rankings, not one: speciesRank is this species' position in the tier list
	// when played with its own best-possible IVs (same for any IV spread you enter); ivRank is
	// where this exact IV spread falls among the species' own 4096 possible combinations. See
	// getIVRank() in the vendored Pokemon.js - it's pvpoke's own per-IV rank calculation.
	var speciesRank = globalRank(league, poke.speciesId);
	var ivRank = poke.getIVRank("overall");

	return { league: league, poke: poke, speciesRank: speciesRank, ivRank: ivRank };
}

// Small badges labeling how each panel relates to the selected species - empty for the
// selection itself, since that one needs no explanation.
var VARIANT_BADGES = {
	selected: [],
	shadow: ["Obscur"],
	evolution: ["Evolution"],
	"evolution-shadow": ["Evolution", "Obscur"],
};

function badgeClass(label) {
	return "variant-badge " + (label === "Obscur" ? "shadow" : "evolution");
}

// One stacked panel per variant (selected species, its Shadow form, each forward evolution, and
// each evolution's Shadow form). Species/sprite/moveset are identical across leagues within a
// single variant, so they're shown once per panel; only level/CP/rank vary per league.
function renderResults(groups) {
	var panel = document.getElementById("result-panel");
	panel.innerHTML = "";
	groups.forEach(function (group) { panel.appendChild(renderVariantPanel(group)); });
}

function renderVariantPanel(group) {
	var results = group.results;
	var poke = results[0].poke;

	var wrapper = document.createElement("div");
	wrapper.className = "variant-panel";

	var badgeHtml = (VARIANT_BADGES[group.kind] || [])
		.map(function (label) { return '<span class="' + badgeClass(label) + '">' + label + '</span>'; })
		.join(" ");

	var header = document.createElement("div");
	header.className = "battle-summary";
	header.innerHTML =
		'<img class="poke-sprite" src="' + frSprite(poke.speciesId) + '" alt="">' +
		'<div><div class="poke-name">' + (badgeHtml ? badgeHtml + " " : "") + frPokemonName(poke.speciesId) + '</div>' +
		'<div class="poke-moves">' + frMoveName(poke.fastMove.moveId) + " / " +
		poke.chargedMoves.map(function (m) { return frMoveName(m.moveId); }).join(", ") + '</div></div>';
	wrapper.appendChild(header);

	var table = document.createElement("div");
	table.className = "league-stats";
	results.forEach(function (r) {
		var row = document.createElement("div");
		row.className = "league-stat-row";
		var ivRankHtml = r.ivRank.count
			? '<span class="poke-rank" title="Rang de cet IV parmi les ' + r.ivRank.count +
			  ' combinaisons possibles pour cette espece sous ce plafond de PC">IV #' + r.ivRank.rank + '/' + r.ivRank.count + '</span>'
			: 'non classe';
		var speciesRankHtml = r.speciesRank
			? '<span class="poke-rank" title="Classement de l\'espece dans le meta avec ses meilleurs IV possibles - pas de cet IV precis">Espece #' + r.speciesRank + '</span>'
			: 'non classe';
		row.innerHTML =
			'<div class="league-stat-name">' + r.league.name + '</div>' +
			'<div class="league-stat-value">Niveau ' + r.poke.level + '</div>' +
			'<div class="league-stat-value">PC ' + r.poke.cp + '</div>' +
			'<div class="league-stat-value">' + ivRankHtml + '</div>' +
			'<div class="league-stat-value">' + speciesRankHtml + '</div>';
		table.appendChild(row);
	});
	wrapper.appendChild(table);

	return wrapper;
}

document.addEventListener("DOMContentLoaded", init);
