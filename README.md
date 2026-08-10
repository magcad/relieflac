# ReliefLac — lac de Vassivière

Application web de navigation affichant, sur téléphone, la **profondeur d'eau réelle**
sous le bateau — recalculée en continu à partir de la cote du lac pilotée par EDF.

👉 **[magcad.github.io/relieflac](https://magcad.github.io/relieflac/)**

> ⚠️ Ce n'est **pas** un document nautique officiel et cela ne remplace ni un sondeur,
> ni la prudence. Voir [SPECIFICATION.md § 11](SPECIFICATION.md).

---

## Principe

```
z_fond    = Z_référence − profondeur_mesurée      (une fois, hors ligne)
profondeur = cote_EDF_du_jour − z_fond            (en temps réel, sur le téléphone)
```

Le lac marne de plusieurs mètres dans l'année : une carte des profondeurs figée y est
fausse la plupart du temps. On stocke donc l'**altitude du fond** (invariante, en m NGF)
et la profondeur est recalculée à chaque instant depuis la cote publiée par EDF.

## Données

| Donnée | Source | Licence |
|---|---|---|
| 8 118 sondes, levé du 22/04/2009 | [OFB — Bathymétrie plans d'eau](https://data.eaufrance.fr/jdd/c31746f7-311a-41c7-b995-6cb78a2ddc25) | Licence Ouverte 2.0 |
| Cote du lac, horaire, m NGF | EDF — [Ma Rivière et Moi](https://mariviereetmoi.edf.fr/#/map/place/PRACTICABILITY/31856100) | usage informatif |
| Contour du lac | IGN BD TOPO® V3 | Etalab 2.0 |
| Altimétrie des berges | IGN RGE ALTI® | Etalab 2.0 |

## Chaîne de préparation des données

```bash
python tools/extract_ofb.py            # OFB → data/soundings/ofb2009.csv
python tools/fetch_lake_polygon.py     # IGN BD TOPO → data/lake.geojson
python tools/build_shore_constraint.py # IGN RGE ALTI → data/shore_constraint.csv
python tools/fetch_level.py            # EDF → data/level.json + level-history.json
python tools/build_grid.py             # tout ce qui précède → data/bed.png + bed.json
python tools/preview_grid.py           # contrôle visuel → data/preview.png
```

Dépendances : `pip install numpy scipy shapely pyproj Pillow`

`tools/fetch_level.py` tourne **toutes les heures dans GitHub Actions** : l'API EDF ne
renvoie aucun en-tête CORS et ne peut donc pas être appelée depuis la page publiée.

## Ajouter des sondes

Le modèle accepte d'autres relevés que le levé de 2009 — notamment les enregistrements
d'un sondeur de bord, qui sont plus récents et bien plus denses. Voir
[data/imports/README.md](data/imports/README.md).

## État

| Lot | Contenu | État |
|---|---|---|
| L0 | Extraction, contour, contrainte de bord, grille, cote horaire | ✅ |
| L1 | Carte, GPS, overlay coloré, mode Étalonnage | en cours |
| L2 | Page Paramètres (palette, tirant d'eau, unités, alarme) | à faire |
| L3 | Hors ligne (Service Worker, tuiles pré-chargées) | à faire |
| L4 | Calage `Z_2009`, import des logs sondeur, isobathes | à faire |

**Point ouvert principal** : la cote du lac le 22/04/2009 (`Z_2009`) n'est pas connue.
Elle décale toutes les profondeurs d'une constante. Valeur provisoire 648,0 m NGF,
plage plausible 645–648,8. Se cale par étalonnage au sondeur — voir
[SPECIFICATION.md § 15](SPECIFICATION.md).
