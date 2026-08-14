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
| Vérifications | [/test/](https://magcad.github.io/relieflac/test/) — 128 contrôles · [/test/interaction.html](https://magcad.github.io/relieflac/test/interaction.html) — 44 enchaînements |

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
- **mode Étalonnage** : comparer la lecture du sondeur au modèle pour lever l'inconnue
  de calage, avec verdict sur la dispersion des écarts ;
- **relevés qui corrigent la carte** : chaque sonde saisie aplanit un disque à sa valeur
  autour d'elle, puis se fond vers le levé de 2009 ; deux relevés voisins fusionnent au
  lieu de s'empiler, et le rayon se règle point par point ;
- **zones émergées** : tracer le contour d'un îlot que le levé de 2009 a comblé et le
  porter à sa hauteur hors d'eau — il découvre ou se noie ensuite avec la cote ;
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
**encadrement**, et on n'en retient que la borne qui rend le fond moins profond.

| | avant | après |
|---|---|---|
| lac encadré ou mesuré à moins de 60 m | 62,2 % | **97,6 %** |
| part aveugle | 37,8 % | **2,4 %** |

137 ha de fond ont été relevés, jusqu'à **19,3 m**, et le volume à la cote 647 passe de
80,6 à 77,5 hm³ : c'est le prix assumé du sens prudent. La carte distingue désormais trois
états — mesuré, encadré, interpolé — au lieu de deux.

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
publiée. Un workflow GitHub Actions la relève toutes les heures et commite `data/level.json`.

La ligne Quickdraw est la seule qui ne soit pas sous licence ouverte : la donnée appartient
à Garmin et à ses contributeurs, dont les CGU interdisent la redistribution. La grille
dérivée est publiée en connaissance de cause. Elle reste **identifiable cellule par
cellule** dans `data/coverage.png` (canaux vert et bleu), et `quickdraw_source.enabled:
false` dans `config/model.json` reconstruit le modèle sans elle.

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
test/                       128 vérifications (dont le shader rendu hors MapLibre)
                            et 44 enchaînements de l'interface
.github/workflows/          relevé horaire de la cote, reconstruction du modèle
```
