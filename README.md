# ReliefLac — lac de Vassivière

Application web de navigation affichant, sur téléphone, la **profondeur d'eau réelle**
sous le bateau — recalculée en continu à partir de la cote du lac pilotée par EDF.

👉 **[magcad.github.io/relieflac](https://magcad.github.io/relieflac/)**

> ⚠️ Ce n'est **pas** un document nautique officiel et cela ne remplace ni un sondeur,
> ni la prudence. **37,8 % du lac n'a jamais été sondé** à moins de 60 m — voir
> « Ce que vaut le modèle » plus bas.

| | |
|---|---|
| Reprendre le travail | [ETAT.md](ETAT.md) |
| Spécification complète | [SPECIFICATION.md](SPECIFICATION.md) |
| Vérifications | [/test/](https://magcad.github.io/relieflac/test/) — 42 contrôles |

---

## Principe

```
z_fond     = Z_référence − profondeur_mesurée      (une fois, hors ligne)
profondeur = cote_du_jour − z_fond                 (en temps réel, sur le téléphone)
```

Le lac marne de plusieurs mètres dans l'année : une carte des profondeurs figée y est
fausse la plupart du temps. On stocke donc l'**altitude du fond** — invariante, en m NGF —
et la profondeur est recalculée à chaque instant depuis la cote publiée par EDF.

La grille d'altitude part une fois au GPU ; profondeur, bandes et contours sont recalculés
dans le fragment shader. Changer de cote, de préréglage ou de tirant d'eau ne coûte qu'une
mise à jour d'uniforme.

## Ce que fait l'application

- position GPS, cap, vitesse, cercle de précision et trace ;
- fonds coloriés en bandes selon les conventions des cartes marines, avec contour de
  sécurité à « tirant d'eau + marge » ;
- profondeur sous le bateau, hauteur sous quille, alarme haut-fond ;
- bascule Plan IGN / photo aérienne, sonde ponctuelle par appui sur la carte ;
- **hachurage des zones non sondées**, et provenance annoncée sous le bateau ;
- **mode Étalonnage** : comparer la lecture du sondeur au modèle pour lever l'inconnue
  de calage, avec verdict sur la dispersion des écarts ;
- paramètres complets, export/import de profil.

## Ce que vaut le modèle

Le levé OFB de 2009 est fait de transects espacés. Mesuré par `tools/check_coverage.py` :

| Distance à la sonde la plus proche | Part du lac |
|---|---|
| ≤ 25 m | **32,2 %** |
| ≤ 60 m | 62,2 % |
| **> 60 m** | **37,8 % — 354 ha** |
| maximum | **314 m** |

Entre deux transects, la triangulation relie des sondes éloignées. **Un haut-fond y est
invisible et hérite de la profondeur des fosses voisines** : des îlots réellement émergés
peuvent être affichés à 10-20 m d'eau. L'application hachure ces zones plutôt que de
présenter une interpolation avec l'aplomb d'une mesure.

Le correctif existe : un levé multifaisceaux à couverture totale a été réalisé en 2011 par
ENSTA Bretagne, Gand, la HCU Hamburg et le CIDCO pour EDF. Il reste à l'obtenir —
voir [`data/2011 ENSTA/ANALYSE.md`](data/2011%20ENSTA/ANALYSE.md).

## Données

| Donnée | Source | Licence |
|---|---|---|
| 8 118 sondes, levé du 22/04/2009 | [OFB — Bathymétrie plans d'eau](https://data.eaufrance.fr/jdd/c31746f7-311a-41c7-b995-6cb78a2ddc25) | Licence Ouverte 2.0 |
| Cote du lac, horaire, m NGF | EDF — [Ma Rivière et Moi](https://mariviereetmoi.edf.fr/#/map/place/PRACTICABILITY/31856100) | usage informatif |
| Contour du lac | IGN BD TOPO® V3 | Etalab 2.0 |
| Terrain et berges | IGN RGE ALTI® | Etalab 2.0 |
| Fonds de carte | IGN Géoplateforme | Etalab 2.0 |

L'API EDF ne renvoie **aucun en-tête CORS** : elle ne peut pas être appelée depuis la page
publiée. Un workflow GitHub Actions la relève toutes les heures et commite `data/level.json`.

## Chaîne de préparation

```bash
python tools/extract_ofb.py             # OFB → data/soundings/ofb2009.csv
python tools/fetch_lake_polygon.py      # IGN BD TOPO → data/lake.geojson
python tools/fetch_rge_alti.py          # IGN RGE ALTI → data/rge_alti.npy
python tools/build_shore_constraint.py  # → data/shore_constraint.csv
python tools/fetch_level.py             # EDF → data/level.json
python tools/build_grid.py              # tout → data/bed.png, bed.json, coverage.png
python tools/dump_reference.py          # → test/reference.json, requis par les tests
```

Dépendances : `pip install numpy scipy shapely pyproj Pillow`

Servir en local : `python tools/serve.py 8123` — et non `python -m http.server`, qui met
en cache et se trompe de type MIME sur les modules ES.

## Ajouter des sondes

Le modèle accepte d'autres relevés que celui de 2009 — notamment les enregistrements d'un
sondeur de bord, plus récents et bien plus denses. CSV, GPX (extension Garmin comprise),
GeoJSON et KML sont pris en charge : voir [`data/imports/README.md`](data/imports/README.md).

Une profondeur sans horodatage est inexploitable sur une retenue qui marne — l'importeur
la refuse plutôt que de produire une fausse précision.

## Structure

```
index.html app.css src/     application (modules ES natifs, aucun build)
vendor/                     MapLibre GL JS 6.3, vendorisé en .js
config/                     model.json (calage, grille) · palette.json (couleurs)
tools/                      chaîne de préparation et outils de diagnostic
data/                       grille, couverture, sondes, cote — versionnés
test/                       42 vérifications, dont le shader rendu hors MapLibre
.github/workflows/          relevé horaire de la cote, reconstruction du modèle
```
