// Client-side driver for battle_fr.html.
//
// Wires the vendored pvpoke engine (Battle/Pokemon) + gamemaster_shim.js together: pick a
// Pokemon, set its IVs/moveset, and for each league show its level/CP (auto-maxed to the
// highest level, given the chosen IVs, whose CP still fits under that league's cap), its effective
// Attack/Defense/HP at those IVs and that level (realStats()), their product (statProduct()),
// and its global rank - see
// dispatchGlobalRankRequests() (battle-simulated, computed off the main thread in
// battle_worker.js since it's comparatively expensive - see that file's own header comment).
// All three leagues are shown at once (no tab navigation) and re-run automatically whenever any
// control changes. Results are rendered with French
// names/sprites from i18n_fr.json; the underlying computation runs on English species/move IDs
// exactly as pvpoke's engine expects, so level, CP and the effective stats match pvpoke.com
// exactly. The global rank is an estimate of pvpoke's published tier position; see
// GLOBAL_RANK_TOOLTIP below.

var LEAGUES = [
	{ id: "super", name: "Ligue Super", cp: 1500 },
	{ id: "hyper", name: "Ligue Hyper", cp: 2500 },
	{ id: "master", name: "Ligue Master", cp: 10000 },
];

var gm = GameMaster.getInstance();
var i18n = { pokemon: {}, moves: {} };

// True global rank state - see dispatchGlobalRankRequests()/onGlobalRankMessage() below.
var globalRankWorker = null;
var globalRankGeneration = 0;
var globalRankRequestSeq = 0;

// This IS a position on pvpoke.com's own published tier list: battle_worker.js simulates the build
// under all five of pvpoke's ranking scenarios and combines them with their own formula. It's an
// approximation though - one stage of their pipeline (the opponent weighting) can't be reproduced
// from their published source, so a default-IV build lands within about a point of its published
// score rather than exactly on it. See battle_worker.js's header for the measurements.
function GLOBAL_RANK_TOOLTIP(count) {
	return "Ce Pokémon exact, avec ces IV et ce niveau, affronte en combat simulé " +
		"toutes les autres espèces de la ligue, chacune à son niveau et à ses IV optimaux. " +
		"Son rang est sa place parmi les " + (count ? count + " " : "") +
		"espèces classées : 1 = le meilleur. Estimation, à environ un point près.";
}

// Species whose reference score is mostly a hand-authored editorial rating (75% weight) barely
// move when IVs change; worth flagging so the user doesn't read a static number as a bug.
function editorialNote() {
	return " Pour cette espèce, le classement de référence est en grande partie fixé à la main : " +
		"les IV n'en déplacent qu'une petite part.";
}

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
	syncIvVisualSize();
	window.addEventListener("resize", syncIvVisualSize);

	// If this fails (e.g. Workers unavailable in this context), globalRankWorker stays null and
	// dispatchGlobalRankRequests() below becomes a no-op - the "Calcul..." placeholder just never
	// resolves, but nothing else on the page breaks.
	try {
		globalRankWorker = new Worker("battle_worker.js");
		globalRankWorker.onmessage = onGlobalRankMessage;
	} catch (e) {
		console.error("battle_worker.js unavailable, true global rank disabled:", e);
	}

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

// Re-run whenever any input changes, instead of requiring an explicit button press. The cheap
// level/CP/species-rank/IV-rank numbers (runBattles()) recompute on every event with no
// debouncing needed; the comparatively expensive true global rank (scheduleGlobalRankRequests(),
// called at the end of runBattles()) debounces itself separately - see there.
function wireAutoRun() {
	["iv-atk", "iv-def", "iv-hp"].forEach(function (id) {
		var el = document.getElementById(id);
		el.addEventListener("input", function () {
			clampIv(el);
			syncIvBars();
			// Mid-typing (a field cleared to retype, one still empty) isn't a real build yet -
			// don't churn through a battle computation for every keystroke, only once all three
			// IVs are actual 0-15 values.
			if (ivsValid()) runBattles();
		});
		// Select the existing value on focus so typing replaces it outright instead of appending.
		el.addEventListener("focus", function () { el.select(); });
	});
	["fast-move-select", "charged-move-1-select", "charged-move-2-select"].forEach(function (id) {
		document.getElementById(id).addEventListener("change", runBattles);
	});
}

// IVs top out at 15 (the max any Pokemon can roll) and must be whole numbers; <input type=number
// max/min> only stop the spinner arrows, not typed values (e.g. "1.5", "1e2", "-5" all pass
// straight through), so reject anything but plain digits and clamp explicitly.
function clampIv(el) {
	if (!/^\d*$/.test(el.value)) {
		el.value = el.dataset.lastValid || "";
		return;
	}
	var v = parseInt(el.value, 10);
	if (!isNaN(v) && v > 15) el.value = "15";
	el.dataset.lastValid = el.value;
}

function ivsValid() {
	return ["iv-atk", "iv-def", "iv-hp"].every(function (id) {
		var v = document.getElementById(id).value;
		return /^\d+$/.test(v) && parseInt(v, 10) <= 15;
	});
}

// Mirrors each IV number input onto its Pokemon GO-style bar (width = value/15). Called on every
// IV input event and once at startup (including after applyUrlParams(), which sets input.value
// programmatically and so doesn't fire an "input" event on its own).
function syncIvBars() {
	["atk", "def", "hp"].forEach(function (key) {
		var v = parseInt(document.getElementById("iv-" + key).value, 10) || 0;
		var fill = document.getElementById("iv-" + key + "-fill");
		fill.style.width = (v / 15 * 100) + "%";
	});
}

// The IV bar graph's box has no natural height of its own (it's just 3 empty tracks) - CSS alone
// can't size it to "match the Pokemon field's height", since that height depends on font
// metrics, not a fixed value. So measure it. Width is left to flex:1 (fills the rest of the row).
function syncIvVisualSize() {
	var col = document.querySelector(".species-field");
	var visual = document.querySelector(".iv-visual");
	if (!col || !visual) return;
	visual.style.height = col.getBoundingClientRect().height + "px";
}

function hasTag(pokemonData, tag) {
	return !!(pokemonData.tags && pokemonData.tags.indexOf(tag) !== -1);
}

// Lets rankings_fr.html cards link straight into the simulator with a species and its ideal IVs
// pre-filled (?species=<id>&atk=<n>&def=<n>&hp=<n>), instead of always landing on the default
// species with 15/15/15. Applied once at startup by populateSpeciesPicker(); absent/invalid
// params are ignored and the usual defaults apply.
function applyUrlParams() {
	var params = new URLSearchParams(window.location.search);
	var speciesId = params.get("species");
	if (!speciesId || !gm.pokemonMap.has(speciesId)) return null;

	["atk", "def", "hp"].forEach(function (key) {
		var v = parseInt(params.get(key), 10);
		if (isNaN(v)) return;
		v = Math.max(0, Math.min(15, v));
		document.getElementById("iv-" + key).value = v;
	});

	return speciesId;
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
	search.addEventListener("focus", function () { renderSuggestions(search.value); search.select(); });
	search.addEventListener("keydown", onSpeciesSearchKeydown);
	document.addEventListener("click", function (e) {
		if (e.target !== search && !e.target.closest("#species-suggestions")) closeSuggestions();
	});

	var initialSpeciesId = applyUrlParams() || pokemonList[0].speciesId;
	syncIvBars();
	selectSpecies(initialSpeciesId);
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

// Shared by runBattles() (sync, cheap numbers) and dispatchGlobalRankRequests() (debounced,
// worker-based true global rank) so both read the same form state the same way.
function currentIvsAndMoves() {
	return {
		ivs: {
			atk: parseInt(document.getElementById("iv-atk").value),
			def: parseInt(document.getElementById("iv-def").value),
			hp: parseInt(document.getElementById("iv-hp").value),
		},
		userMoves: {
			fast: document.getElementById("fast-move-select").value,
			charged1: document.getElementById("charged-move-1-select").value,
			charged2: document.getElementById("charged-move-2-select").value,
		},
	};
}

function runBattles() {
	var current = currentIvsAndMoves();

	var groups = buildVariantList(state.speciesId).map(function (variant) {
		// The selected species uses the user's own move picks; evolutions/Shadow forms (which have
		// no move controls of their own) fall back to their own best-ranked moveset, same IVs.
		var moves = variant.kind === "selected" ? current.userMoves : defaultMoveset(variant.speciesId);
		var results = LEAGUES.map(function (league) { return runLeague(league, variant.speciesId, current.ivs, moves); });
		return { kind: variant.kind, results: results };
	});

	renderResults(groups);
	scheduleGlobalRankRequests();
}

// Debounced: the true global rank is comparatively expensive (a few hundred ms per league, per
// variant - see battle_worker.js), so only kick off a fresh batch of worker requests once input
// has settled for a moment, rather than on every keystroke. The cheap numbers above still update
// instantly on every input event.
var scheduleGlobalRankRequests = debounce(dispatchGlobalRankRequests, 350);

function debounce(fn, wait) {
	var timer = null;
	return function () {
		clearTimeout(timer);
		timer = setTimeout(fn, wait);
	};
}

function globalRankKey(speciesId, leagueId) {
	return speciesId + "__" + leagueId;
}

function dispatchGlobalRankRequests() {
	if (!globalRankWorker) return;

	globalRankGeneration++;
	var generation = globalRankGeneration;
	var current = currentIvsAndMoves();

	buildVariantList(state.speciesId).forEach(function (variant) {
		var moves = variant.kind === "selected" ? current.userMoves : defaultMoveset(variant.speciesId);
		LEAGUES.forEach(function (league) {
			globalRankRequestSeq++;
			globalRankWorker.postMessage({
				type: "computeGlobalRank",
				requestId: globalRankRequestSeq,
				generation: generation,
				speciesId: variant.speciesId,
				leagueId: league.id,
				ivs: current.ivs,
				moves: moves,
				cp: league.cp,
			});
		});
	});
}

// A reply only matters if it's still for the current generation (a later IV/species change
// would have bumped globalRankGeneration and re-rendered fresh placeholder cells already) - and
// the cell is looked up fresh by speciesId+league rather than held as a stale DOM reference, so
// this is safe even if runBattles() re-rendered in between dispatch and reply.
function onGlobalRankMessage(e) {
	var msg = e.data;
	if (msg.type !== "globalRankResult" || msg.generation !== globalRankGeneration) return;

	var cell = document.querySelector('[data-global-rank="' + globalRankKey(msg.speciesId, msg.leagueId) + '"]');
	if (!cell) return;

	if (msg.error) {
		cell.textContent = "—";
		return;
	}

	var r = msg.result;
	var title = GLOBAL_RANK_TOOLTIP(r.count) + (r.editorial ? editorialNote() : "");
	cell.innerHTML = '<span class="poke-rank" title="' + title + '">' + r.rank + '</span>';
}

function runLeague(league, speciesId, ivs, moves) {
	var battle = new Battle();
	battle.setCP(league.cp);
	battle.setCup("all");

	var poke = buildPokemon(battle, speciesId, ivs, moves);

	return { league: league, poke: poke };
}

// Small badges labeling how each panel relates to the selected species - empty for the
// selection itself, since that one needs no explanation.
var VARIANT_BADGES = {
	selected: [],
	shadow: ["Obscur"],
	evolution: ["Évolution"],
	"evolution-shadow": ["Évolution", "Obscur"],
};

// Effective stats at the IVs entered and the level maxLevelForCap() settled on -- i.e. what this
// exact build actually fights with, rather than the species' base stats. Attack/Defense are the
// engine's own floats (they feed the damage formula unrounded, so a decimal is meaningful);
// HP is already an integer.
function realStats(poke) {
	return poke.stats.atk.toFixed(1) + " / " + poke.stats.def.toFixed(1) + " / " + poke.stats.hp;
}

// Stat product: Attack x Defense x HP, multiplied (not summed) - it's the quantity find_best_ivs()
// in pvpoke_fr.py maximizes to pick an IV spread, and the reason a low Attack IV can beat a perfect
// one under a CP cap. Raw values run into the millions, so it's shown in thousands.
function statProduct(poke) {
	var product = poke.stats.atk * poke.stats.def * poke.stats.hp;
	return Math.round(product / 1000).toLocaleString("fr-FR") + " k";
}

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

	var headerRow = document.createElement("div");
	headerRow.className = "league-stat-row league-stat-header";
	headerRow.innerHTML =
		'<div class="league-stat-name"></div>' +
		'<div class="league-stat-value" title="Niveau maximal atteignable avec ces IV sans dépasser le plafond de PC de cette ligue">Niveau</div>' +
		'<div class="league-stat-value" title="Points de Combat à ce niveau">PC</div>' +
		'<div class="league-stat-value" title="Statistiques réelles (Attaque / Défense / PV) à ces IV et à ce niveau">Att / Déf / PV</div>' +
		'<div class="league-stat-value" title="Attaque × Défense × PV, en milliers. Plus ce produit est élevé, plus le Pokémon est solide globalement — c\'est ce qu\'on maximise pour trouver les meilleurs IV.">Produit</div>' +
		'<div class="league-stat-value" title="' + GLOBAL_RANK_TOOLTIP() + '">Classement</div>';
	table.appendChild(headerRow);

	results.forEach(function (r) {
		var row = document.createElement("div");
		row.className = "league-stat-row";
		row.innerHTML =
			'<div class="league-stat-name">' + r.league.name + '</div>' +
			'<div class="league-stat-value">' + r.poke.level + '</div>' +
			'<div class="league-stat-value">' + r.poke.cp + '</div>' +
			'<div class="league-stat-value">' + realStats(r.poke) + '</div>' +
			'<div class="league-stat-value">' + statProduct(r.poke) + '</div>' +
			'<div class="league-stat-value" data-global-rank="' + globalRankKey(r.poke.speciesId, r.league.id) + '">' +
			'<span class="poke-rank poke-rank-pending">Calcul...</span></div>';
		table.appendChild(row);
	});
	wrapper.appendChild(table);

	return wrapper;
}

document.addEventListener("DOMContentLoaded", init);
