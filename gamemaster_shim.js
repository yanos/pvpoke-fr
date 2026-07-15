// Hand-written replacement for pvpoke's GameMaster.js.
//
// The vendored engine (Battle.js, Pokemon.js, ActionLogic.js, TeamRanker.js) only
// ever touches GameMaster through `GameMaster.getInstance()` and the methods below
// (getPokemonById, getMoveById, getCupById, getFormat, loadRankingData,
// generateFilteredPokemonList, .data, .data.settings, .rankings). Everything here
// is ported from pvpoke's GameMaster.js logic, minus jQuery/DOM/localStorage, and
// reading from the same-origin vendored JSON in vendor/pvpoke/data/ instead of
// pvpoke.com. Only the "all" cup / "overall" category is vendored, matching what
// this site needs.

var GameMaster = (function () {
	var instance;

	function createInstance(dataBaseUrl) {
		var object = {};

		object.data = {};
		object.rankings = {};
		object.pokemonMap = new Map();
		object.moveMap = new Map();
		object.loaded = false;

		object.load = function () {
			if (object._loadPromise) {
				return object._loadPromise;
			}

			object._loadPromise = fetch(dataBaseUrl + "gamemaster.json")
				.then(function (r) { return r.json(); })
				.then(function (data) {
					object.data = data;
					object.pokemonMap = new Map(data.pokemon.map(function (p) { return [p.speciesId, p]; }));
					object.moveMap = new Map(data.moves.map(function (m) { return [m.moveId, m]; }));
					object.loaded = true;
				});

			return object._loadPromise;
		};

		// Return a Pokemon data object given species ID

		object.getPokemonById = function (id) {
			id = id.replace("_xl", "");
			return object.pokemonMap.get(id);
		};

		// Return an enriched move object given move ID (mirrors pvpoke's GameMaster.getMoveById)

		object.getMoveById = function (id) {
			if (id == "none") {
				return;
			}

			var m = object.moveMap.get(id);

			if (m === undefined) {
				console.error(id + " missing");
				return;
			}

			var arr = m.moveId.split('_');
			var abbreviation = '';

			if (m.abbreviation) {
				abbreviation = m.abbreviation;
			} else {
				for (var i = 0; i < arr.length; i++) {
					abbreviation += arr[i].charAt(0);
				}
			}

			var move = {
				moveId: m.moveId,
				name: m.name,
				displayName: m.name,
				abbreviation: abbreviation,
				archetype: m.archetype || '',
				type: m.type,
				power: m.power,
				energy: m.energy,
				energyGain: m.energyGain,
				cooldown: m.cooldown,
				turns: m.turns,
				selfDebuffing: false,
				selfBuffing: false,
				selfAttackDebuffing: false,
				selfDefenseDebuffing: false,
				legacy: false,
				elite: false
			};

			if (move.moveId == "RETURN" || move.moveId == "FRUSTRATION") {
				move.legacy = true;
				move.displayName = move.displayName + "<sup>†</sup>";
			}

			if (m.buffs) {
				move.buffs = m.buffs;
				move.buffApplyChance = parseFloat(m.buffApplyChance);
				move.buffTarget = m.buffTarget;

				if (move.buffTarget == "both") {
					move.buffsSelf = m.buffsSelf;
					move.buffsOpponent = m.buffsOpponent;
				}

				if (move.buffTarget == "self" && move.buffApplyChance >= .5 && move.moveId != "DRAGON_ASCENT" && (move.buffs[0] < 0 || move.buffs[1] < 0)) {
					move.selfDebuffing = true;

					if (move.buffs[0] < 0) {
						move.selfAttackDebuffing = true;
					}
					if (move.buffs[1] < 0) {
						move.selfDefenseDebuffing = true;
					}
				}

				if (move.buffApplyChance == 1 && (move.buffTarget == "opponent" || (move.buffTarget == "self" && (move.buffs[0] > 0 || move.buffs[1] > 0)) || (move.buffTarget == "both" && (move.buffsSelf[0] > 0 || move.buffsSelf[1] > 0)))) {
					move.selfBuffing = true;
				}
			}

			if (m.formChange) {
				move.formChange = JSON.parse(JSON.stringify(m.formChange));
			}

			return move;
		};

		// Return a cup object given its name

		object.getCupById = function (id) {
			var cup;
			(object.data.cups || []).forEach(function (c) {
				if (c.name == id) {
					cup = c;
				}
			});
			return cup;
		};

		// Return a format object given a cup name + CP

		object.getFormat = function (cup, cp) {
			var format;
			(object.data.formats || []).forEach(function (f) {
				if (f.cup == cup && parseInt(f.cp) == cp) {
					format = f;
				}
			});
			return format;
		};

		// Load (and cache) ranking data. Only the "all" cup / "overall" category is vendored.

		object.loadRankingData = function (caller, category, league, cup) {
			var key = cup + "" + category + "" + league;

			if (object.rankings[key]) {
				if (caller && caller.displayRankingData) {
					caller.displayRankingData(object.rankings[key]);
				}
				return Promise.resolve(object.rankings[key]);
			}

			var file = dataBaseUrl + "rankings/rankings-" + league + ".json";

			return fetch(file)
				.then(function (r) { return r.json(); })
				.then(function (data) {
					object.rankings[key] = data;
					if (caller && caller.displayRankingData) {
						caller.displayRankingData(data);
					}
					return data;
				});
		};

		// Generate a filtered + initialized list of Pokemon objects for a given cup.
		// Ported verbatim from pvpoke's GameMaster.generateFilteredPokemonList (no DOM/jQuery in the original).

		object.generateFilteredPokemonList = function (battle, include, exclude, rankingData, overrides, excludeByStatProduct) {
			excludeByStatProduct = typeof excludeByStatProduct !== 'undefined' ? excludeByStatProduct : true;

			var minStats = 4900;

			if (battle.getCP() == 500) {
				minStats = 0;
			} else if (battle.getCP() == 1500) {
				minStats = 1370;
			} else if (battle.getCP() == 2500) {
				minStats = 2800;
			}

			if (!excludeByStatProduct) {
				minStats = 0;
			}

			var bannedList = object.data.greatLeagueIneligible || [];
			var filterLists = [include, exclude];
			var pokemonList = [];

			for (var i = 0; i < object.data.pokemon.length; i++) {
				var pokemon = new Pokemon(object.data.pokemon[i].speciesId, 0, battle);
				pokemon.initialize(battle.getCP());

				var stats = (pokemon.stats.hp * pokemon.stats.atk * pokemon.stats.def) / 1000;

				if (stats >= minStats || battle.getCup().includeLowStatProduct ||
					(battle.getCP() == 1500 && pokemon.hasTag("include1500")) ||
					(battle.getCP() == 2500 && pokemon.hasTag("include2500")) ||
					(battle.getCP() == 10000 && pokemon.hasTag("include10000")) ||
					pokemon.hasTag("mega")) {

					if (!pokemon.released) {
						continue;
					}

					if (battle.getCP() < 2500 && bannedList.indexOf(pokemon.speciesId) > -1) {
						continue;
					}

					if (pokemon.hasTag("duplicate1500") && (battle.getCP() != 1500 || (battle.getCup().name != "all" && battle.getCup().name != "retro" && battle.getCup().name != "halloween"))) {
						continue;
					}

					if (battle.getCP() == 500 && pokemon.hasTag("shadow") && pokemon.level < 8) {
						continue;
					}

					var allowed = false;
					var includeIDFilter = false;

					for (var n = 0; n < filterLists.length; n++) {
						var filters = filterLists[n];
						var isIncludeList = (n == 0);
						var filtersMatched = 0;
						var requiredFilters = filters.length;

						for (var j = 0; j < filters.length; j++) {
							var filter = filters[j];

							if (filter.leagues) {
								if (filter.leagues.indexOf(battle.getCP()) == -1) {
									requiredFilters--;
									continue;
								}
							}

							switch (filter.filterType) {
								case "type":
									if ((filter.values.indexOf(pokemon.types[0]) > -1) || (filter.values.indexOf(pokemon.types[1]) > -1)) {
										filtersMatched++;
									}
									break;

								case "dex":
									for (var k = 0; k < filter.values.length; k += 2) {
										if (k + 1 >= filter.values.length) {
											break;
										}
										if (pokemon.dex >= filter.values[k] && pokemon.dex <= filter.values[k + 1]) {
											filtersMatched++;
											break;
										}
									}
									break;

								case "tag":
									for (var k = 0; k < filter.values.length; k++) {
										if (pokemon.hasTag(filter.values[k])) {
											filtersMatched++;
										}
									}
									break;

								case "cost":
									if (filter.values.indexOf(pokemon.thirdMoveCost) > -1) {
										filtersMatched++;
									}
									break;

								case "distance":
									if (filter.values.indexOf(pokemon.buddyDistance) > -1) {
										filtersMatched++;
									}
									break;

								case "evolution":
									if (filter.values.indexOf(pokemon.getEvolutionStage()) > -1) {
										filtersMatched++;
									}
									break;

								case "id":
									if (isIncludeList && filters.length > 1) {
										requiredFilters--;
									}

									var testId = pokemon.speciesId;

									if (!isIncludeList || filter.includeShadows) {
										testId = testId.replace("_shadow", "");
										testId = testId.replace("_xs", "");
									}

									if (filter.values.indexOf(testId) > -1 || filter.values.indexOf(pokemon.speciesId) > -1) {
										filtersMatched += filters.length;

										if (isIncludeList) {
											includeIDFilter = true;
										}
									}
									break;

								case "move":
									for (var k = 0; k < filter.values.length; k++) {
										if (pokemon.knowsMove(filter.values[k])) {
											filtersMatched++;
										}
									}
									break;

								case "moveType":
									for (var k = 0; k < filter.values.length; k++) {
										if (pokemon.knowsMoveType(filter.values[k])) {
											filtersMatched++;
										}
									}
									break;
							}
						}

						if (isIncludeList && filtersMatched >= requiredFilters) {
							allowed = true;
						}

						if (!isIncludeList && filtersMatched > 0 && !includeIDFilter) {
							allowed = false;
						}
					}

					if (allowed) {
						pokemon.weightModifier = 1;

						if (rankingData) {
							var r = rankingData.find(function (ranking) { return ranking.speciesId == pokemon.speciesId; });

							if (r) {
								var fastMoves = r.moves.fastMoves.slice().sort(function (a, b) { return b.uses - a.uses; });
								var chargedMoves = r.moves.chargedMoves.slice().sort(function (a, b) { return b.uses - a.uses; });

								pokemon.selectMove("fast", fastMoves[0].moveId);
								pokemon.selectMove("charged", chargedMoves[0].moveId, 0);

								if (chargedMoves.length > 1) {
									pokemon.selectMove("charged", chargedMoves[1].moveId, 1);
								}
							}
						}

						pokemonList.push(pokemon);
					}
				}
			}

			return pokemonList;
		};

		return object;
	}

	return {
		getInstance: function (dataBaseUrl) {
			if (!instance) {
				instance = createInstance(dataBaseUrl || "vendor/pvpoke/data/");
			}
			return instance;
		}
	};
})();
