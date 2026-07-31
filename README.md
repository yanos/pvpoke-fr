# pvpoke-fr

Deux pages statiques en français pour le PvP Pokémon GO, générées à partir des données de
[pvpoke.com](https://pvpoke.com) et traduites avec [PokeAPI](https://pokeapi.co).

## Les pages

- **[Classements](https://yanos.github.io/pvpoke-fr/)** (`rankings_fr.html`) — les meilleurs
  Pokémon par ligue (Super, Hyper, Master), avec noms, sprites et attaques en français.
- **[Analyse de build](https://yanos.github.io/pvpoke-fr/battle_fr.html)** (`battle_fr.html`) —
  outil interactif : choisissez un Pokémon, ses IV et son moveset. Pour chaque ligue, la page
  calcule le niveau maximal sous le plafond de PC, les stats effectives (Att/Déf/PV), le produit
  de stats, le rang du spread d'IV et une estimation du rang global du build, en utilisant le
  moteur de combat de pvpoke directement dans le navigateur.

Le site est redéployé automatiquement chaque jour sur GitHub Pages.

## Génération locale

```bash
./generate.sh    # rafraîchit les données et régénère les deux pages
./serve.sh       # sert le dépôt en local et ouvre battle_fr.html
```

Détails de l'architecture et du pipeline : voir [CLAUDE.md](CLAUDE.md).

## Crédits

Données de classement et moteur de combat : [pvpoke/pvpoke](https://github.com/pvpoke/pvpoke).
Noms français et sprites : [PokeAPI](https://pokeapi.co). Voir [LICENSE](LICENSE).
