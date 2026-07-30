// Client-side driver for battle_fr.html.
//
// Wires the vendored pvpoke engine (Battle/Pokemon/TeamRanker/ActionLogic) + gamemaster_shim.js
// together to reproduce pvpoke's own "multi battle" feature: pick a Pokemon, set its IVs/level/
// moveset/shields, and rank it against every eligible Pokemon in each league ("all" cup), using
// pvpoke's own recommended moveset + full shield/bait AI for opponents. Results are rendered with
// French names/sprites from i18n_fr.json; the underlying simulation runs on English species/move IDs
// exactly as pvpoke's engine expects, so scores match pvpoke.com exactly.

// TeamRanker.js (and Pokemon.js's URL-string helpers) reference this bare global directly —
// on pvpoke's real page it's inlined in the battle page's own <script>, not in any engine file.
// Values copied verbatim from that page's default settings object.
var settings = {
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

// TeamRanker.js calls this global directly (ported verbatim from pvpoke's PokeMultiSelect.js) —
// it's not part of the engine files, so it must be defined before TeamRanker's module runs.
function getDefaultMultiBattleSettings() {
	return {
		shields: 1,
		ivs: "original",
		bait: 1,
		levelCap: 50,
		startHp: 1,
		startEnergy: 0,
		startCooldown: 0,
		optimizeMoveTiming: true,
		startStatBuffs: [0, 0],
	};
}

var LEAGUES = [
	{ id: "super", name: "Ligue Super", cp: 1500 },
	{ id: "hyper", name: "Ligue Hyper", cp: 2500 },
	{ id: "master", name: "Ligue Master", cp: 10000 },
];

var gm = GameMaster.getInstance();
var ranker = RankerMaster.getInstance();
var i18n = { pokemon: {}, moves: {} };

var state = {
	speciesId: null,
	level: 20,
	ivs: { atk: 0, def: 0, hp: 0 },
	fastMove: null,
	chargedMove1: null,
	chargedMove2: null,
	shields: 1,
	bait: 1,
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
		// selectRecommendedMoveset() (used for every opponent) reads gm.rankings[key] synchronously,
		// so all three leagues' ranking data must be loaded before any battle can run.
		return Promise.all(LEAGUES.map(function (l) {
			return gm.loadRankingData(null, "overall", l.cp, "all");
		}));
	}).then(function () {
		populateSpeciesPicker();
		document.getElementById("run-battle").disabled = false;
		document.getElementById("loading").style.display = "none";
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

function buildUserPokemon(battle) {
	var speciesId = document.getElementById("species-select").value;
	var level = parseFloat(document.getElementById("level-input").value);
	var ivAtk = parseInt(document.getElementById("iv-atk").value);
	var ivDef = parseInt(document.getElementById("iv-def").value);
	var ivHp = parseInt(document.getElementById("iv-hp").value);
	var fastMoveId = document.getElementById("fast-move-select").value;
	var chargedMove1Id = document.getElementById("charged-move-1-select").value;
	var chargedMove2Id = document.getElementById("charged-move-2-select").value;
	var shields = parseInt(document.getElementById("shield-select").value);
	var bait = parseInt(document.getElementById("bait-select").value);

	var poke = new Pokemon(speciesId, 0, battle);
	poke.ivs.atk = ivAtk;
	poke.ivs.def = ivDef;
	poke.ivs.hp = ivHp;
	poke.isCustom = true;
	poke.setLevel(level, false);
	poke.initialize(battle.getCP());

	poke.selectMove("fast", fastMoveId);
	poke.selectMove("charged", chargedMove1Id, 0);
	if (chargedMove2Id != "none") {
		poke.selectMove("charged", chargedMove2Id, 1);
	} else {
		poke.chargedMoves.splice(1, 1);
	}
	poke.resetMoves();

	poke.startingShields = shields;
	poke.baitShields = bait;

	return poke;
}

function runBattles() {
	document.getElementById("loading").style.display = "block";
	LEAGUES.forEach(function (l) { document.getElementById("panel-" + l.id).innerHTML = ""; });

	// Let the loading indicator paint before the (synchronous, CPU-heavy) sim runs.
	setTimeout(function () {
		LEAGUES.forEach(runLeague);
		document.getElementById("loading").style.display = "none";
	}, 30);
}

function runLeague(league) {
	var battle = new Battle();
	battle.setCP(league.cp);
	battle.setCup("all");

	var poke = buildUserPokemon(battle);

	var settings = {
		shields: poke.startingShields,
		ivs: "original",
		bait: poke.baitShields,
		levelCap: battle.getLevelCap(),
		startHp: 1,
		startEnergy: 0,
		startCooldown: 0,
		optimizeMoveTiming: true,
		startStatBuffs: [0, 0],
	};
	var opponentSettings = {
		shields: 1,
		ivs: "original",
		bait: 1,
		levelCap: battle.getLevelCap(),
		startHp: 1,
		startEnergy: 0,
		startCooldown: 0,
		optimizeMoveTiming: true,
		startStatBuffs: [0, 0],
	};

	ranker.applySettings(settings, 0);
	ranker.applySettings(opponentSettings, 1);
	ranker.setTargets([]); // empty -> gm.generateFilteredPokemonList() against the "all" cup, same as pvpoke's "all" filter mode

	var data = ranker.rank([poke], battle.getCP(), battle.getCup());
	var rankings = data.rankings.slice().sort(function (a, b) { return a.opRating - b.opRating; }); // worst-for-opponent-first == pvpoke's default multi-battle order

	renderLeagueResults(league, poke, rankings);
}

function renderLeagueResults(league, poke, rankings) {
	var panel = document.getElementById("panel-" + league.id);
	var header = document.createElement("div");
	header.className = "battle-summary";
	header.innerHTML =
		'<img class="poke-sprite" src="' + frSprite(poke.speciesId) + '" alt="">' +
		'<div><div class="poke-name">' + frPokemonName(poke.speciesId) + '</div>' +
		'<div class="poke-moves">' + frMoveName(poke.fastMove.moveId) + " / " +
		poke.chargedMoves.map(function (m) { return frMoveName(m.moveId); }).join(", ") + '</div></div>';
	panel.appendChild(header);

	var list = document.createElement("div");
	list.className = "matchup-list";

	rankings.forEach(function (r, i) {
		var row = document.createElement("div");
		row.className = "matchup-row" + (r.opRating >= 500 ? " win" : " loss");
		row.innerHTML =
			'<span class="matchup-rank">#' + (i + 1) + '</span>' +
			'<img class="matchup-sprite" src="' + frSprite(r.speciesId) + '" alt="">' +
			'<span class="matchup-name">' + frPokemonName(r.speciesId) + '</span>' +
			'<span class="matchup-rating">' + r.opRating + '</span>';
		list.appendChild(row);
	});

	panel.appendChild(list);
}

document.addEventListener("DOMContentLoaded", function () {
	init();
	document.getElementById("run-battle").addEventListener("click", runBattles);
});
