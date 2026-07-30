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
		document.getElementById(id).addEventListener("input", runBattles);
	});
	["fast-move-select", "charged-move-1-select", "charged-move-2-select"].forEach(function (id) {
		document.getElementById(id).addEventListener("change", runBattles);
	});
}

var pokemonList = []; // {speciesId, name}, sorted by French display name

function populateSpeciesPicker() {
	pokemonList = gm.data.pokemon
		.filter(function (p) { return !p.aliasId; }) // skip duplicate entries, keep only the canonical species
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

	fillMoveSelect("fast-move-select", poke.fastMovePool, poke.fastMove);
	fillMoveSelect("charged-move-1-select", poke.chargedMovePool, poke.chargedMoves[0]);
	fillMoveSelect("charged-move-2-select", [{ moveId: "none", displayName: "Aucune" }].concat(poke.chargedMovePool), poke.chargedMoves[1]);

	runBattles();
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

function buildUserPokemon(battle) {
	var speciesId = document.getElementById("species-select").value;
	var ivAtk = parseInt(document.getElementById("iv-atk").value);
	var ivDef = parseInt(document.getElementById("iv-def").value);
	var ivHp = parseInt(document.getElementById("iv-hp").value);
	var fastMoveId = document.getElementById("fast-move-select").value;
	var chargedMove1Id = document.getElementById("charged-move-1-select").value;
	var chargedMove2Id = document.getElementById("charged-move-2-select").value;

	var poke = new Pokemon(speciesId, 0, battle);
	poke.ivs.atk = ivAtk;
	poke.ivs.def = ivDef;
	poke.ivs.hp = ivHp;
	poke.isCustom = true;

	maxLevelForCap(poke, battle.getCP(), battle.getLevelCap());
	poke.initialize(battle.getCP());

	poke.selectMove("fast", fastMoveId);
	poke.selectMove("charged", chargedMove1Id, 0);
	if (chargedMove2Id != "none") {
		poke.selectMove("charged", chargedMove2Id, 1);
	} else {
		poke.chargedMoves.splice(1, 1);
	}
	poke.resetMoves();

	return poke;
}

// Global (all Pokemon, all movesets) rank for a species within a league, from the same
// "all"/"overall" ranking data already loaded for opponent selection. Null if the species
// doesn't appear (e.g. filtered out as too weak to be ranked in that league).
function globalRank(league, speciesId) {
	var list = gm.rankings["all" + "overall" + league.cp];
	if (!list) return null;
	for (var i = 0; i < list.length; i++) {
		if (list[i].speciesId === speciesId) return i + 1;
	}
	return null;
}

function runBattles() {
	LEAGUES.forEach(runLeague);
}

function runLeague(league) {
	var battle = new Battle();
	battle.setCP(league.cp);
	battle.setCup("all");

	var poke = buildUserPokemon(battle);
	var rank = globalRank(league, poke.speciesId);

	renderLeagueResults(league, poke, rank);
}

function renderLeagueResults(league, poke, rank) {
	var panel = document.getElementById("panel-" + league.id);
	panel.innerHTML = "";

	var title = document.createElement("h2");
	title.className = "league-title";
	title.textContent = league.name;
	panel.appendChild(title);

	var header = document.createElement("div");
	header.className = "battle-summary";
	header.innerHTML =
		'<img class="poke-sprite" src="' + frSprite(poke.speciesId) + '" alt="">' +
		'<div><div class="poke-name">' + frPokemonName(poke.speciesId) + '</div>' +
		'<div class="poke-moves">' + frMoveName(poke.fastMove.moveId) + " / " +
		poke.chargedMoves.map(function (m) { return frMoveName(m.moveId); }).join(", ") + '</div>' +
		'<div class="poke-stats">Niveau ' + poke.level + ' &middot; PC ' + poke.cp +
		' &middot; Classement general : ' + (rank ? '<span class="poke-rank">#' + rank + '</span>' : 'non classe') +
		'</div></div>';
	panel.appendChild(header);
}

document.addEventListener("DOMContentLoaded", init);
