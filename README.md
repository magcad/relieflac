# ReliefLac — lac de Vassivière

Application web de navigation affichant, sur téléphone, la **profondeur d'eau réelle**
sous le bateau — recalculée en continu à partir de la cote du lac pilotée par EDF.

👉 **[magcad.github.io/relieflac](https://magcad.github.io/relieflac/)**

> ⚠️ Ce n'est **pas** un document nautique officiel et cela ne remplace ni un sondeur,
> ni la prudence. **37,8 % du lac n'a jamais été sondé** à moins de 60 m par le levé de
> référence ; l'essentiel est aujourd'hui *encadré* par la cartographie communautaire —
> ce qui n'est pas la même chose que mesuré. Voir « Ce que vaut le modèle » plus bas.

| | |
|---|---|
| Reprendre le travail | [ETAT.md](ETAT.md) |
| Spécification complète | [SPECIFICATION.md](SPECIFICATION.md) |
| Vérifications | [/test/](https://magcad.github.io/relieflac/test/) — 208 contrôles · [/test/interaction.html](https://magcad.github.io/relieflac/test/interaction.html) — 108 enchaînements |

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
- **interface taillée pour barrer** : un bandeau de cap de 46 px qui porte aussi la cote
  et l'état du GPS, un dock de 76 px pour la profondeur et le sous-quille, un rail de
  caméra, et tout le reste sous une feuille « Outils » à tuiles libellées — 20 % de
  l'écran occupé en permanence au lieu de 29 % ;
- **mode plein soleil** : contraste maximal de l'habillage, sans toucher aux couleurs des
  fonds, parce qu'aucune API du web ne commande la luminosité de la dalle ;
- **hachurage des zones non sondées**, et provenance annoncée sous le bateau ;
- **avertissement d'ouverture** (français / anglais) : ce n'est pas un document nautique
  officiel, la couverture est incomplète, on navigue au sondeur ;
- **relevés qui corrigent la carte** : chaque sonde saisie aplanit un disque à sa valeur
  autour d'elle, puis se fond vers le levé de 2009 ; deux relevés voisins fusionnent au
  lieu de s'empiler, et le rayon se règle point par point ;
- **zones émergées** : tracer le contour d'un îlot que le levé de 2009 a comblé et le
  porter à sa hauteur hors d'eau — il découvre ou se noie ensuite avec la cote ; sondes et
  zones partent ensemble dans le fichier partagé `data/corrections/<lac>.json`, rangées à
  part l'une de l'autre ;
- **courbe de la cote** dans « Étiage » : l'évolution du niveau du lac sur un jour, une
  semaine (par défaut), un mois ou un an, avec les extrêmes de la période en pointillés et
  la valeur lue au doigt. La cote se règle toujours à la main, mais derrière un crayon —
  c'est le geste rare, et celui qui fausse toutes les profondeurs quand on l'oublie ;
- **mode Navigation** : construire un **trajet** (suite de points de passage), le suivre en
  plein écran — carte inclinée, gros compteur de vitesse, cadran de gouverne, chevrons
  pointés vers le point suivant et portion déjà parcourue en vert — puis retrouver la
  **sortie** dans l'Historique. Le trajet n'est pas un rail : couper au plus court et
  rejoindre la route plus loin solde les points de passage laissés de côté. Trajets et
  sorties se partagent comme les relevés (`data/routes/<lac>.json` pour les trajets, un
  fichier par trace dans `data/trips/<lac>/` pour les sorties, avec un catalogue) ;
- **clic droit** : poser un point à l'endroit montré, sans signal GPS (essais au bureau) ;
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

**Depuis le 14/08/2026, ces trous sont largement comblés** par la cartographie
communautaire Quickdraw (Garmin), décodée depuis des captures d'écran géoréférencées : là
où le levé n'a qu'une interpolation, des dizaines de sondeurs de pêcheurs sont passés. Ce
n'est pas une mesure au décimètre — une bande dit « entre 4 et 6 m » — mais un
**encadrement**, et une bande porte **deux** bornes : elle interdit au fond d'être plus bas
(« pas plus de 6 m ici ») comme d'être plus haut (« un bateau a flotté ici, donc au moins
4 m d'eau »). La seconde ne descend jamais sous une sonde réellement mesurée du voisinage.

| | avant | après |
|---|---|---|
| lac encadré ou mesuré à moins de 60 m | 62,2 % | **97,8 %** |
| part aveugle | 37,8 % | **2,2 %** |

128 ha de fond ont été relevés, jusqu'à **17,7 m**, et 295 ha abaissés : c'est la borne
haute qui remet le trait de côte et **les ports dans l'eau** — 64 ha récupérés à la cote
647. La carte distingue trois états — mesuré, encadré, interpolé — au lieu de deux.

### Deux cartes, au choix

L'application affiche, au choix, le fond du **levé de 2009** (mesuré au décimètre le long
de ses traces, relevé par le MNT, encadré par la communauté, biaisé vers le haut-fond) ou
la **carte communautaire seule** — rien que les bandes Quickdraw, sans une sonde de 2009,
sans triangulation, sans contrainte de rive. Celle-ci décrit 94 % du lac et laisse les
45 ha restants **vides** plutôt que de les inventer. Les deux fonds partagent la maille, la
bascule est instantanée, et les relevés que vous saisissez s'appliquent à celui qui est
affiché. Telles que construites, elles s'accordent à moins de 2 m sur 80 % du lac.

**La carte communautaire est celle qui s'ouvre par défaut** depuis le 16/08/2026 : c'est
celle que la plupart des plaisanciers du lac ont déjà sous les yeux au traceur. Elle porte un
**recalage de terrain de +1,72 m** (réglage `quickdrawDatum_m`), mesuré sur l'eau le
15/08/2026 sur le trait de côte, cote du lac vérifiée — la première mesure, +2,72 m, avait
été prise contre une cote de simulation restée en place, et c'est elle qui est encore inscrite
dans `quickdraw_only.datum_offset_m`. Le recalage place le plan d'eau de référence des bandes
à **649,40 m NGF**. Il n'est pas confirmé au sondeur, et remonter le fond ou baisser la cote
du lac d'autant donnent le même dessin à l'écran :
voir `data/mesuresEtalonnage/Garmin/ANALYSE.md` § 12.5.

Le champ « Recalage de la carte » des Paramètres corrige **la carte affichée** : le plan d'eau
des bandes sur la communautaire, la cote du jour du levé sur celle de 2009. Chaque carte garde
le sien, **un seul agit à la fois**, et ils ne s'additionnent jamais — celui de la carte qu'on
n'affiche pas est signalé en toutes lettres sous le champ. Vos relevés, eux, ne bougent pas
avec : ils portent une altitude mesurée, et c'est la carte qui se déplace autour d'eux. C'est
ce qui permet de juger un recalage à l'œil.

Le bouton du rail de la carte — **COM** ou **2009** — dit en permanence quelle carte est
affichée, et bascule de l'une à l'autre d'un appui : comparer les deux au-dessus d'un
haut-fond est une manœuvre de navigation, pas un réglage.

Le correctif complet existe : un levé multifaisceaux à couverture totale a été réalisé en
2011 par ENSTA Bretagne, Gand, la HCU Hamburg et le CIDCO pour EDF. Il reste à l'obtenir —
voir [`data/2011 ENSTA/ANALYSE.md`](data/2011%20ENSTA/ANALYSE.md).

## Données

| Donnée | Source | Licence |
|---|---|---|
| 8 118 sondes, levé du 22/04/2009 | [OFB — Bathymétrie plans d'eau](https://data.eaufrance.fr/jdd/c31746f7-311a-41c7-b995-6cb78a2ddc25) | Licence Ouverte 2.0 |
| Encadrement des fonds, 42 captures calées sur 44 | Communauté **Quickdraw** (Garmin / ActiveCaptain) | **usage dérivé, pas de licence ouverte** |
| Cote du lac, horaire, m NGF | EDF — [Ma Rivière et Moi](https://mariviereetmoi.edf.fr/#/map/place/PRACTICABILITY/31856100) | usage informatif |
| Contour du lac | IGN BD TOPO® V3 | Etalab 2.0 |
| Terrain et berges | IGN RGE ALTI® | Etalab 2.0 |
| Fonds de carte | IGN Géoplateforme | Etalab 2.0 |

L'API EDF ne renvoie **aucun en-tête CORS** : elle ne peut pas être appelée depuis la page
publiée. Un workflow GitHub Actions la relève toutes les heures et commite `data/level.json`,
en ajoutant chaque mesure à `data/level-history.json` — c'est cet historique que trace la
courbe d'étiage.

L'appareil complète : à chaque ouverture, l'application inscrit dans sa propre réserve
(`relieflac.levelhist.v1`) la cote qu'elle vient de lire, puis fusionne les deux séries sur
l'instant de mesure. La courbe continue donc d'avancer quand le workflow ne tourne pas —
GitHub suspend les tâches planifiées d'un dépôt resté inactif — et une sortie faite hors
ligne laisse quand même sa trace. Ce que le dépôt finit par savoir est retiré de la réserve
locale, qui ne garde que son avance.

La ligne Quickdraw est la seule qui ne soit pas sous licence ouverte : la donnée appartient
à Garmin et à ses contributeurs, dont les CGU interdisent la redistribution. La grille
dérivée est publiée en connaissance de cause. Elle reste **identifiable cellule par
cellule** dans `data/coverage.png` (canaux vert et bleu), et `quickdraw_source.enabled:
false` dans `config/model.json` reconstruit le modèle sans elle — le second fond,
`data/bed_quickdraw.*`, en dérive entièrement et se retire en supprimant ces fichiers.

## Chaîne de préparation

```bash
python tools/extract_ofb.py             # OFB → data/soundings/ofb2009.csv
python tools/fetch_lake_polygon.py      # IGN BD TOPO → data/lake.geojson
python tools/fetch_rge_alti.py          # IGN RGE ALTI → data/rge_alti.npy
python tools/build_shore_constraint.py  # → data/shore_constraint.csv
python tools/fetch_level.py             # EDF → data/level.json
python tools/qd_georef.py 0-12m         # captures Quickdraw → georef_0-12m.json (~30 min)
python tools/qd_mosaic.py 0-12m         # → mosaique_0-12m.png
python tools/qd_georef.py 12_30m --min-ncc 0.50   # campagne profonde (~30 min)
python tools/qd_mosaic.py 12_30m --min-ncc 0.50
python tools/build_grid.py              # tout → data/bed.png, bed.json, coverage.png
python tools/build_grid_quickdraw.py    # fond communautaire seul → data/bed_quickdraw.*
python tools/build_lake_outline.py      # silhouette des vignettes → src/lake-outline.js
python tools/dump_reference.py          # → test/reference.json, requis par les tests
```

Les quatre étapes `qd_*` sont facultatives : leur résultat est versionné et coûte une
demi-heure de calcul chacune pour le géoréférencement. Le nom de campagne est obligatoire —
les couleurs se recyclent d'une palette à l'autre et décoder avec la mauvaise produit une
carte fausse sans aucun signe extérieur.

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
test/                       208 vérifications (dont le shader rendu hors MapLibre)
                            et 108 enchaînements de l'interface
.github/workflows/          relevé horaire de la cote, reconstruction du modèle
```
