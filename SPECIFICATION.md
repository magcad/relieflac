# ReliefLac — Application de navigation bathymétrique, lac de Vassivière

**Version** : 0.1 (spécification initiale)
**Date** : 10 août 2026
**Cible** : application web statique (PWA) hébergée sur GitHub Pages, utilisable sur iPhone et Android.

---

## 1. Objectif

Afficher, sur le téléphone d'un plaisancier naviguant sur le lac de Vassivière :

- sa position GPS en temps réel sur une carte du lac ;
- la **profondeur d'eau réelle sous la coque**, recalculée à partir du **niveau du lac du jour** (piloté par EDF, très variable) ;
- une **coloration continue des fonds** autour du bateau, paramétrable par l'utilisateur (ex. 1 m = rouge, 3 m = vert, ≥ 10 m = noir).

**Ce n'est pas une carte marine officielle.** Voir § 11 (limites et sécurité).

---

## 2. Verdict de faisabilité : **faisable**

Les quatre briques nécessaires existent, sont publiques et ont été **vérifiées en conditions réelles** le 10/08/2026 (téléchargements et appels API effectués, résultats reproduits ci-dessous).

| Brique | Source retenue | Statut |
|---|---|---|
| Relief des fonds | Jeu OFB / Eaufrance « Bathymétrie plans d'eau » | ✅ récupéré, 8 118 points sur Vassivière |
| Niveau d'eau temps réel | API JSON EDF « Ma Rivière et Moi » | ✅ testée, cote horaire en m NGF |
| Trait de côte / masque du lac | IGN BD TOPO® (WFS Géoplateforme) | ✅ testé, polygone 3 553 sommets |
| Altimétrie des berges | IGN RGE ALTI® (API altimétrie) | ✅ testée |

Un seul point dur subsiste : la **cote de référence du levé de 2009** (§ 4.4). Il induit un biais systématique constant sur toutes les profondeurs, et se résout par un unique paramètre de calage.

---

## 3. Sources de données — résultats de l'investigation

### 3.1 Bathymétrie (le « relief du lac » recherché)

La cartographie historique existe : elle provient des **campagnes bathymétriques Onema / Cemagref (aujourd'hui OFB / INRAE)** menées dans le cadre de la Directive Cadre sur l'Eau, selon le protocole *Alleaume et al., 2010 — « Bathymétrie des plans d'eau. Protocole d'échantillonnage et descripteurs morphométriques »*.

- **Jeu de données** : « Bathymétrie plans d'eau », Système d'Information sur l'Eau / OFB
- **Fiche** : <https://data.eaufrance.fr/jdd/c31746f7-311a-41c7-b995-6cb78a2ddc25>
- **Miroir** : <https://www.data.gouv.fr/datasets/bathymetrie-plans-deau>
- **Fichier** : `points_bruts_bathy_20161020.zip` (14,7 Mo) → `points_bathy_bruts_plans_d_eau_20161020.tab`
- **Licence** : Licence Ouverte / Open Licence 2.0 (réutilisation libre, y compris commerciale, avec mention de la source)
- **Format** : TSV UTF-8 BOM, séparateur décimal virgule, colonnes
  `code_gene | nom_bd_carthage | dtg_bathy | lon | lat | prof`

**Extraction Vassivière (mesurée) :**

| Caractéristique | Valeur |
|---|---|
| Code entité hydrographique | `L0115203` |
| Toponyme | `RETENUE DE VASSIVIERE` |
| Nombre de points | **8 118** |
| Date du levé | **22/04/2009** (unique) |
| Emprise | lon 1,84309 → 1,91812 ; lat 45,77732 → 45,81844 (WGS84) |
| Profondeur min / max / moyenne | 0,5 m / **30,9 m** / 8,57 m |
| Espacement le long des traces | ~10 m (médiane plus proche voisin : 8,9 m ; max 10,3 m) |
| Espacement entre traces | **plus de 150 m** dans les grands bassins — voir § 3.1 bis |

Répartition des profondeurs : 0–5 m : 3 403 pts · 5–10 m : 1 824 · 10–15 m : 1 286 · 15–20 m : 747 · 20–25 m : 578 · 25–30 m : 260 · 30–35 m : 20.

### 3.1 bis Couverture réelle du levé — le défaut central du modèle

Mesuré par `tools/check_coverage.py`, qui calcule pour chaque cellule du lac la distance à
la sonde de 2009 la plus proche :

| Distance à la sonde mesurée la plus proche | Part du lac |
|---|---|
| ≤ 25 m | **32,2 %** |
| ≤ 50 m | 55,1 % |
| ≤ 60 m | 62,2 % |
| **> 60 m** | **37,8 %, soit 354 ha** |
| médiane | 44 m |
| **maximum** | **314 m** |

Ce n'est donc pas un maillage fin mais un **quadrillage de transects** largement espacés.

> ⚠️ **Conséquence, et c'est le défaut le plus grave du modèle.** Le bateau sondeur ne
> passe pas sur un haut-fond : celui-ci est un **trou dans les données**, que la
> triangulation comble en reliant les sondes profondes qui l'entourent. L'obstacle
> **hérite de la profondeur des fosses voisines**. Des îlots qui émergent réellement à la
> cote du jour peuvent ainsi être affichés à 10–20 m d'eau — cas signalé par l'utilisateur,
> reproduit et quantifié.
>
> Les zones les plus dangereuses sont donc mécaniquement les plus fausses, et l'erreur va
> dans le mauvais sens : le modèle annonce plus d'eau qu'il n'y en a.

Le MNT LiDAR ne rattrape rien : **99 % de ces trous étaient sous l'eau** au moment du vol
IGN (plan d'eau à 648,80 m NGF).

Aucun correctif n'est possible avec les données disponibles. Le parti retenu est
d'**afficher l'ignorance plutôt que de la masquer** — § 6.1 bis. Le seul vrai correctif
serait le levé multifaisceaux 2011, § 3.5.

### 3.2 Niveau d'eau temps réel

EDF publie la cote de la retenue via son application **« Ma Rivière et Moi »**. Le front-end est une application Angular/JHipster qui interroge une **API JSON publique et non authentifiée** (endpoint identifié par analyse des bundles de l'application) :

```
GET https://mariviereetmoi.edf.fr/api/v5/practicabilities/31856100
```

`31856100` = point d'intérêt « Rampe de mise à l'eau d'Auphelle », rattaché à l'aménagement « Barrage de VASSIVIERE » (territoire « Vallée de la Vienne »).

Réponse (extrait réel du 10/08/2026) :

```json
{
  "id": 31856100,
  "title": "Rampe de mise à l'eau d'Auphelle",
  "longitude": 1.8451515649725094,
  "latitude": 45.79931770077153,
  "amenagement": { "id": 487, "title": "Barrage de VASSIVIERE" },
  "charts": [
    {
      "type": "WATER_LEVEL",
      "dataEntryType": "AUTOMATIC",
      "graph": {
        "periodicity": "ONE_DAY",
        "valueAxisUnit": "METER_NGF",
        "limits": [
          { "condition": "NOT_APPROPRIATE", "min": 0.0,   "max": 642.0 },
          { "condition": "DELICATE",        "min": 642.0, "max": 643.0 },
          { "condition": "APPROPRIATE",     "min": 643.0, "max": 650.0 },
          { "condition": "NOT_APPROPRIATE", "min": 650.0, "max": 1300.0 }
        ],
        "datas": [
          { "value": 647.12, "dateTime": "2026-08-09T15:00:00Z", "condition": "APPROPRIATE" },
          { "value": 647.08, "dateTime": "2026-08-10T14:00:00Z", "condition": "APPROPRIATE" }
        ],
        "lastData": { "value": 647.08, "dateTime": "2026-08-10T14:00:00Z" }
      }
    }
  ]
}
```

Points retenus :

- unité : **mètres NGF** (altitude absolue) — exactement ce qu'il faut ;
- pas de temps : **horaire**, historique glissant de 1 jour (`ONE_DAY`) ou 7 jours (`SEVEN_DAYS`) ;
- seuils officiels de navigation exploitables directement dans l'app :
  **< 642 m NGF navigation interdite** · 642–643 délicat · 643–650 normal ·
  la retenue normale est à **650 m NGF** (crête du barrage 652,90 m NGF).

> 🔴 **Contrainte technique confirmée** : la réponse ne contient **aucun en-tête `Access-Control-Allow-Origin`**. Un `fetch()` direct depuis une page GitHub Pages sera **bloqué par CORS**. → voir § 5.3, résolu par un relais GitHub Actions.

Source de repli / vérification humaine : <https://mariviereetmoi.edf.fr/#/map/place/PRACTICABILITY/31856100>
(relayée par le Club Nautique de Vassivière : <https://www.cnvassiviere.fr/niveau>).

### 3.3 Contour du lac (masque)

IGN **BD TOPO® V3**, couche `plan_d_eau`, via le WFS de la Géoplateforme :

```
https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature
  &TYPENAMES=BDTOPO_V3:plan_d_eau&SRSNAME=EPSG:4326
  &OUTPUTFORMAT=application/json&CQL_FILTER=toponyme LIKE '%Vassivi%'
```

Retourne 4 entités, dont la principale : `MultiPolygon`, nature `Retenue-barrage`, **3 553 sommets**. Licence ouverte Etalab 2.0.

### 3.5 Levé multifaisceaux 2011 — la donnée qui résoudrait tout

En octobre 2011, ENSTA Bretagne, l'Université de Gand, la HafenCity University Hamburg et
le CIDCO ont réalisé sur le lac, pour le compte d'EDF, un levé hydrographique dans le cadre
du programme Erasmus Intensive « Hydrography and Geomatics ».

| | |
|---|---|
| Matériel | MBES **Kongsberg EM3002** + LiDAR mobile **Leica HDS6200** |
| Couverture | **totale, Ordre 1 (S-44 OHI)** |
| Incertitude | **TPU 15 cm à 95 %**, imposée par EDF |
| Maille du MNT | **1 m** en navigation, **0,5 m** sur les ouvrages |
| Carte produite | **S-57** (CARIS S-57 Composer), 1:10 000 |
| Référence verticale | **646 m IGN69** |
| Cote pendant le levé | ≈ 4 m sous la retenue normale (sécheresse 2011) |

Deux atouts décisifs au-delà de la couverture : la **référence verticale est connue**, ce
qui lèverait l'inconnue du § 4.4 ; et le levé s'est fait **à basse cote**, donc il couvre la
frange qui découvre en étiage — la bande aveugle du § 11 où se trouvent les îlots
problématiques.

Les livrables sont chez **EDF Unité de Production Centre** et les autorités du lac ;
l'opérateur est le **Ocean Sensing and Mapping Lab d'ENSTA Bretagne**. Le paquet en notre
possession ne contient que la communication FIG et une vignette de 418 px : ni MNT, ni
nuage de sondes, ni vectoriel extractible. Détail dans `data/2011 ENSTA/ANALYSE.md`.

> **Point de vigilance** : le rapport indique que le levé manipulait **IGN69** et
> **NGF-Lallemand** — l'ancien système, celui utilisé par EDF. L'API EDF annonce ses cotes
> en « m NGF » sans préciser lequel, et le RGE ALTI est en IGN69. Un écart entre les deux
> serait un biais constant sur toutes les profondeurs, indiscernable de celui que
> l'étalonnage corrige. À poser explicitement lors de la demande.

### 3.4 Altimétrie des berges (RGE ALTI®)

API altimétrie IGN, testée :

```
https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json?lon=…&lat=…&resource=ign_rge_alti_wld&zonly=true
```

Résultat notable : au-dessus du plan d'eau, le MNT renvoie une valeur **constante de 648,80 m NGF** → c'est la **cote du lac au moment de l'acquisition LiDAR**. Les berges au-dessus de 648,80 m sont donc correctement modélisées et exploitables pour raccorder la bathymétrie au relief terrestre.

---

## 4. Modèle de calcul

### 4.1 Équation fondamentale

Toute la logique tient en deux lignes :

```
z_fond(x,y)  =  Z_2009  −  prof_2009(x,y)        (une fois pour toutes, hors ligne)
profondeur(x,y,t)  =  cote_lac(t)  −  z_fond(x,y)   (en temps réel, sur le téléphone)
```

avec
- `z_fond` : altitude du fond en m NGF (invariant, pré-calculé) ;
- `Z_2009` : cote du lac le 22/04/2009, jour du levé (m NGF) — **le paramètre à caler**, § 4.4 ;
- `cote_lac(t)` : cote courante EDF (m NGF) ;
- `profondeur ≤ 0` ⇒ le fond est **émergé** (zone à terre, à afficher comme telle).

### 4.2 Interpolation

Génération, **au moment du build** (GitHub Actions), d'une grille régulière d'altitude de fond :

- projection de travail : **EPSG:2154 (Lambert-93)**, métrique ;
- emprise : bbox du lac + 100 m de marge ;
- pas de grille : **5 m** (≈ 1 170 × 915 cellules) ;
- méthode : **interpolation linéaire barycentrique sur triangulation de Delaunay** des 8 118 points, puis lissage gaussien σ ≈ 15 m ;
  - rationnel : Delaunay respecte exactement les points mesurés et se comporte proprement sur des traces linéaires, là où un IDW brut crée des « yeux de bœuf » autour de chaque sonde ;
- **contrainte de bord** : injection de points virtuels de profondeur 0 le long du polygone BD TOPO (trait de côte à la retenue normale) → évite l'extrapolation aberrante près des rives ;
- **raccord des berges** : au-dessus de 648,80 m NGF, la grille est remplacée par le RGE ALTI (les berges découvertes à basse cote sont ainsi correctement représentées) ;
- **masquage** : tout ce qui est hors du polygone du lac (dilaté de 50 m) est marqué `nodata`.

> Le pas de 5 m est un choix d'affichage, **pas** une résolution réelle. La résolution effective transversale reste de l'ordre de **100 m** (§ 3.1). L'app doit le dire à l'utilisateur.

### 4.2 bis Généralisation biaisée vers le haut-fond

L'interpolation et le lissage **moyennent** : un haut-fond ponctuel s'y dilue et le modèle
annonce alors *plus* d'eau qu'il n'y en a. C'est la seule erreur réellement dangereuse —
l'inverse ne fait que rendre le modèle prudent. Les cartes marines traitent ce cas par une
généralisation asymétrique, qui retient la sonde la moins profonde plutôt que la moyenne.

Règle appliquée après le lissage :

> le modèle n'est **jamais plus profond** qu'une sonde réellement mesurée située à moins de
> `radius_m` (défaut **15 m**, couvrant l'incertitude de position cumulée du levé de 2009 et
> du GPS du téléphone).

Mise en œuvre : rastérisation des sondes mesurées (altitude de fond la moins profonde par
cellule), dilatation morphologique sur un disque de ce rayon, puis maximum avec la grille
interpolée. Rien n'est inventé : le résultat ne s'écarte du modèle que vers **moins d'eau**,
et uniquement à proximité d'une mesure réelle.

La contrainte de bord du § 4.2 en est **exclue** : c'est un artefact de modélisation, pas une
mesure, et la dilater ferait remonter artificiellement le fond sur 15 m au large des rives.

Effet mesuré sur le levé de 2009 : **10,6 %** des cellules relevées, de **0,92 m** en moyenne,
jusqu'à **9,46 m** au point le plus défavorable — un haut-fond que le lissage effaçait
complètement. Désactivable par `grid.shoal_bias.enabled`.

### 4.2 ter Corrections manuelles — forme d'un relevé sur la carte

Les relevés saisis dans l'application (sondes ✎, témoins 🌊, zones ▲) sont reportés sur la
grille du levé à chaque changement, pour produire la « carte 2009 corrigée » affichée en
navigation. La question n'est pas *si* la carte doit bouger — c'est la seule façon de
rattraper le défaut du § 3.1 bis — mais **sur quelle forme**.

Règle retenue : **plateau, puis fondu, et fusion des recouvrements**.

> Chaque relevé pose une surface où la carte vaut **exactement** la valeur relevée, entourée
> d'un fondu en cosinus qui rejoint le levé de 2009. Pour un point, le plateau occupe la
> moitié centrale de son rayon ; pour une zone, c'est l'intérieur du contour, et le rayon
> mesure la largeur du fondu au-delà du bord.

Le plateau n'est pas un ornement : une mesure de haut-fond ne dit pas « le fond est à
2,10 m en ce point et retombe à 18 m un mètre plus loin », elle dit « au moins ça, sur une
certaine surface ». La version précédente n'appliquait la valeur qu'au **centre exact** et
retombait vers 2009 dès le premier mètre : chaque relevé devenait une pointe, que
l'interpolation bilinéaire du rendu émoussait encore. Un îlot relevé à pied s'affichait
comme une aiguille, là où l'on voulait une plaque.

Les recouvrements se **fusionnent** au lieu de s'empiler :

| Cellule | Valeur retenue |
|---|---|
| couverte par un ou plusieurs plateaux | moyenne de **ces relevés-là seuls** |
| atteinte par des fondus seulement | moyenne pondérée par la distance, mêlée au levé selon la somme des poids, plafonnée à 1 |
| hors de portée | levé de 2009 intact |

Deux conséquences voulues. D'abord le résultat ne dépend plus de l'**ordre** des relevés :
ils étaient appliqués l'un après l'autre sur le résultat du précédent, si bien que deux
points voisins se corrigeaient mutuellement et que la carte changeait selon l'ordre de
saisie. Ensuite un plateau reste maître chez lui — le fondu d'un voisin ne déplace pas une
valeur mesurée ici, sans quoi une sonde afficherait autre chose que ce qu'on a saisi.

Le **rayon appartient au relevé**, comme l'immersion du transducteur (§ 15.2) : c'est
l'étendue sur laquelle son auteur a jugé sa mesure représentative. Il voyage avec lui dans
le fichier partagé ; le réglage général ne sert que de valeur initiale.

Enfin, la carte de couverture (§ 3.1 bis) est ramenée à la distance réelle au relevé : le
hachurage « non sondé » et la mise en garde d'interpolation disparaissent là où l'on vient
effectivement de mesurer.

Code : `BedGrid.applyCorrections` ([`src/bed.js`](src/bed.js)).

### 4.2 quater Zones émergées tracées à la main

Une sonde corrige un caillou ; elle ne dit rien de l'**étendue** de la terre autour. Or le
défaut du § 3.1 bis porte précisément sur des surfaces : le bateau sondeur ne passe pas sur
un haut-fond, l'îlot est un trou dans les données, et la triangulation le comble en reliant
les fosses voisines.

D'où un second outil : un **contour fermé**, tracé à la main sur la photo aérienne ou
d'après ce qu'on voit depuis le bateau, dont tout l'intérieur est porté à une même altitude
de sol. C'est la seule chose qu'on sache honnêtement dire d'une île sans l'avoir arpentée.

Comme partout, on stocke l'altitude et non la hauteur d'eau :

```
z_sol = cote_du_jour + hauteur_au-dessus_de_l'eau
```

La zone se recolorie donc d'elle-même quand la cote bouge — émergée en étiage, submergée à
la retenue normale — et le curseur du mode 🌊 montre le passage de l'une à l'autre.

Statut de la donnée : une zone est une **interprétation**, pas une mesure. Elle reste donc
locale à l'appareil et ne part pas dans `data/corrections/<lac>.json`, qui ne transporte que
des points mesurés. L'export GeoJSON permet de la verser au modèle par la chaîne de
préparation quand elle aura été confirmée sur le terrain.

Code : [`src/zones.js`](src/zones.js), tracé câblé dans `src/main.js` (`wireZones`).

### 4.3 Format de livraison de la grille

Encodage **Terrain-RGB** (altitude sur 24 bits) dans un PNG, servi statiquement :

```
altitude_m = -1000 + ( (R * 65536 + G * 256 + B) * 0.01 )
```

- fichier : `data/bed_5m.png` + `data/bed_5m.json` (bbox, taille, pas, encodage, `nodata`) ;
- taille attendue : **~1,5 à 2,5 Mo** (PNG palettisé/optimisé) — acceptable, mis en cache par le service worker après la première visite ;
- alternative si trop lourd : tuiles `z/x/y.png` en Terrain-RGB, chargées à la demande.

Le PNG est **décodé une fois** au démarrage dans un `Float32Array` ; ensuite tout changement de cote ou de palette est un simple recalcul de couleurs.

### 4.4 ⚠️ Point ouvert n°1 — cote de référence du levé 2009

Le fichier OFB donne des **profondeurs**, pas des altitudes. Sans `Z_2009`, toutes les profondeurs affichées sont décalées d'une constante.

**Ce qui a été établi :** les 460 points les moins profonds (≤ 0,8 m) du levé tombent tous, sauf une poignée de pixels de bord, à l'intérieur du plan d'eau LiDAR à 648,80 m NGF. Le lac était donc **au plus à ~648,8 m NGF** le 22/04/2009, et probablement en dessous. La plage plausible est **645–648,8 m NGF**.

**Plan de résolution, par ordre de préférence :**

1. **Demander la cote du 22/04/2009 à EDF Hydro** (Unité de Production Centre / exploitation de Vassivière). Donnée d'exploitation archivée, réponse binaire, résout le sujet définitivement. → *action à mener en parallèle du développement.*
2. **Calage hypsométrique** : ajuster `Z_2009` pour que la surface du modèle à 650 m NGF corresponde à la superficie officielle de la retenue (976 ha) et au polygone BD TOPO. Réalisable au build, sans intervention externe.
3. **Calage terrain** : comparer, à quelques points GPS connus, la profondeur affichée par l'app et celle du sondeur du bateau. Un seul relevé suffit à fixer la constante.

**Décision retenue (10/08/2026) : voie 3, l'étalonnage au sondeur de bord** — protocole détaillé au § 15. En attendant le premier étalonnage, `Z_2009 = 648.0 m NGF` (milieu haut de la plage plausible), exposé comme **paramètre de configuration** (`config/model.json`) et comme **réglage « calage » dans la page Paramètres**, avec un bandeau d'avertissement tant que la valeur n'est pas confirmée.

---

## 5. Architecture

### 5.1 Vue d'ensemble

```
  ┌─────────────────────── GitHub (dépôt public) ────────────────────────┐
  │                                                                      │
  │  Action « build-bathy »        Action « fetch-level »                │
  │  (manuelle / sur modif)        (cron, toutes les heures)             │
  │        │                              │                              │
  │        │ OFB .tab + BD TOPO + RGE ALTI│ API EDF /api/v5/…            │
  │        ▼                              ▼                              │
  │  data/bed_5m.png              data/level.json   ← commit automatique │
  │  data/bed_5m.json             data/level-history.json                │
  │  data/lake.geojson                                                   │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │  GitHub Pages (HTTPS, statique)
                                  ▼
                    ┌──────────────────────────┐
                    │  PWA (téléphone)         │
                    │  • MapLibre GL JS        │
                    │  • Geolocation API       │
                    │  • Canvas/WebGL overlay  │
                    │  • Service Worker (hors  │
                    │    ligne total)          │
                    └──────────────────────────┘
```

Aucun serveur, aucun coût, aucun secret. Tout est statique.

### 5.2 Stack technique

| Couche | Choix | Justification |
|---|---|---|
| Carte | **MapLibre GL JS** | WebGL, rendu fluide sur mobile, overlay raster coloré en shader = recoloration instantanée |
| Fond de carte | Tuiles IGN Plan/Ortho (Géoplateforme, libres) + fallback OSM | Contexte visuel des rives ; l'ortho aide à reconnaître le terrain |
| Build données | **Python 3** (numpy, scipy, rasterio/Pillow, shapely, pyproj) dans GitHub Actions | Aucun outil à installer en local |
| Relais niveau | GitHub Actions (`curl` + `jq`) | Contourne CORS, § 5.3 |
| PWA | Service Worker + manifest, `vite` pour le bundling | Installable, fonctionne sans réseau sur l'eau |
| Hébergement | GitHub Pages | HTTPS (obligatoire pour la géolocalisation), gratuit |

### 5.3 Relais du niveau d'eau (contournement CORS)

Workflow `.github/workflows/level.yml`, `schedule: cron: "7 * * * *"` (toutes les heures) :

1. `curl` sur `https://mariviereetmoi.edf.fr/api/v5/practicabilities/31856100` ;
2. extraction de `charts[type=WATER_LEVEL].graph.lastData` et de la série horaire ;
3. écriture de `data/level.json` et append dans `data/level-history.json` ;
4. commit uniquement si la valeur a changé (évite le bruit d'historique) ;
5. en cas d'échec de l'API : `level.json` conserve la dernière valeur et passe `"stale": true`.

Format `data/level.json` :

```json
{
  "level_m_ngf": 647.08,
  "measured_at": "2026-08-10T14:00:00Z",
  "fetched_at": "2026-08-10T15:07:12Z",
  "condition": "APPROPRIATE",
  "stale": false,
  "source": "EDF Ma Rivière et Moi — Barrage de Vassivière",
  "source_url": "https://mariviereetmoi.edf.fr/#/map/place/PRACTICABILITY/31856100",
  "thresholds": { "forbidden_below": 642.0, "delicate_below": 643.0, "normal_max": 650.0 },
  "recent": [
    { "t": "2026-08-10T13:00:00Z", "v": 647.08 },
    { "t": "2026-08-10T14:00:00Z", "v": 647.08 }
  ]
}
```

Le cron GitHub Actions n'est pas garanti à la minute près et peut être suspendu après 60 jours d'inactivité du dépôt : l'app doit donc **toujours afficher l'âge de la donnée** et permettre la **saisie manuelle de la cote** (§ 6.4). Le lac bougeant typiquement de quelques cm/jour (jusqu'à ~10 cm/jour en période de lâchers), une donnée vieille de quelques heures reste parfaitement exploitable.

### 5.4 Rendu de la coloration

Le shader de l'overlay raster reçoit la texture Terrain-RGB, la cote courante, le décalage
de calage, les bornes et couleurs de bandes, et une table de 256 entrées pour les
préréglages continus. Changement de palette, de cote ou de tirant d'eau = mise à jour
d'uniforme, donc **recoloration en moins d'une image**, sans rien retélécharger.

Deux points décident de la qualité visuelle, et le premier a dû être corrigé après essai
sur téléphone — le rendu apparaissait en gros carrés, inutilisable pour naviguer.

**Champ de profondeur continu.** L'échantillonnage matériel est en `NEAREST` et doit le
rester : interpoler les octets d'un encodage Terrain-RGB donnerait des altitudes absurdes.
Le shader **décode donc les quatre texels voisins puis interpole les altitudes**, ce qui
supprime la maille de 5 m. La pondération exclut les texels hors du lac, sinon le fond
plongerait le long des rives en se mélangeant à des cellules sans donnée ; la somme des
poids retenus sert au passage à antialiaser le trait de côte.

> `BedGrid.altitudeAt()` applique exactement la même interpolation côté processeur. Sans
> cela, la profondeur annoncée sous le bateau différerait de la couleur affichée au même
> endroit, avec des sauts au passage d'une cellule à l'autre.

**Contours à épaisseur constante.** Plutôt que de comparer les bandes de pixels voisins —
ce qui donne un trait dont l'épaisseur suit la maille et s'élargit au zoom — le trait est
tracé analytiquement :

```glsl
float distancePx = abs(profondeur - seuil) / max(fwidth(profondeur), 1e-7);
float trait = 1.0 - smoothstep(largeur * 0.5 - 0.5, largeur * 0.5 + 0.5, distancePx);
```

`fwidth` donne la variation de profondeur d'un pixel écran au suivant : diviser l'écart au
seuil par cette pente convertit des mètres d'eau en pixels. Le trait reste **fin, net et
antialiasé à tous les zooms** — c'est ce qui remplace une vectorisation, sans données
supplémentaires ni recalcul à chaque changement de cote.

Les aplats sont choisis analytiquement à partir des mêmes bornes que les traits, et non via
la table : la quantification de celle-ci (0,12 m) décalerait sinon les traits des aplats
d'un mince liseré.

**Vérification** — `test/shader.js` rend le shader hors MapLibre, dans un canvas WebGL2
piloté directement, et mesure les deux propriétés : le rendu s'accorde avec l'interpolation
bilinéaire calculée côté processeur (21 pixels sur 23, contre 2 sur 23 pour le plus proche
voisin, sur des pixels choisis pour départager les deux hypothèses), et l'épaisseur des
contours reste de 2 à 3 px pour un rapport de zoom de 5.

---

## 6. Spécifications fonctionnelles

### 6.1 Écran principal — Navigation

- Carte plein écran centrée sur la position GPS, overlay de profondeur colorée.
- **Marqueur bateau** : triangle orienté selon le cap (`GeolocationCoordinates.heading`, avec repli sur le cap calculé entre deux positions), cercle de précision GPS.
- **Bandeau supérieur** :
  - cote actuelle du lac (ex. `647,08 m NGF`) + âge de la donnée (`il y a 42 min`) ;
  - pastille de couleur selon le seuil EDF (vert / orange / rouge navigation interdite) ;
  - indicateur « donnée périmée » si > 6 h.
- **Bandeau inférieur** :
  - **profondeur sous le bateau** en très gros caractères, colorée selon la palette ;
  - vitesse (nœuds ou km/h, au choix) et cap.
- **Boutons** : recentrage / suivi auto · verrouillage nord ou cap en haut · plein écran · accès Paramètres.
- **Appui long sur la carte** : affiche la profondeur au point touché (« sonde ponctuelle »).
- **Clic droit sur la carte** : pose un point à l'endroit montré et ouvre la saisie de
  profondeur, **sans attendre le GPS**. C'est ce qui rend l'application manipulable sur un
  ordinateur, où il n'y a aucune position : on désigne l'endroit au lieu d'y aller. Le
  relevé qui en sort est une sonde ordinaire, partagée comme les autres, mais il porte la
  marque de sa provenance (`position_source: "map"`) jusque dans le fichier publié — une
  position pointée au doigt ne vaut pas une position mesurée, et sans cette marque plus
  rien ne permettrait d'arbitrer entre deux relevés qui se contredisent.
- **Maintien de l'écran allumé** (Screen Wake Lock API) tant que l'app est au premier plan.

### 6.1 bis Signalement des zones non sondées

Puisque 37,8 % du lac est à plus de 60 m de toute mesure (§ 3.1 bis) et qu'aucun correctif
n'est possible, l'application doit dire **où elle sait et où elle devine**. Présenter une
interpolation avec l'aplomb d'une mesure serait la faute la plus grave.

- `build_grid.py` produit `data/coverage.png` : image en niveaux de gris, même emprise et
  même taille que `bed.png`, où chaque cellule porte la **distance en mètres à la sonde
  mesurée la plus proche**, plafonnée à 255. Calculée dans le même passage que la grille,
  donc toujours cohérente avec elle.
- Le shader **hachure** les zones au-delà du seuil (défaut 60 m), avec une intensité
  croissante jusqu'à 2,5 fois le seuil. Les hachures sont calculées en coordonnées écran :
  leur pas reste constant au zoom, ce qui les distingue nettement du dessin des fonds.
  C'est la convention des cartes marines pour « non levé ».
- La profondeur sous le bateau annonce sa provenance : **« interpolé — sonde à N m »** en
  orange, au lieu de « sous le bateau ».
- Réglage « Hachurer les zones non sondées », actif par défaut.

`BedGrid.soundingDistanceAt()` expose la même donnée au reste de l'application.

### 6.1 ter Actions destructrices — aucune boîte de dialogue

Supprimer un relevé, une zone, ou vider une liste demande une confirmation. Elle ne passe
**jamais** par `window.confirm` : Chrome propose « Empêcher cette page de créer des boîtes
de dialogue supplémentaires » dès la deuxième, et la case une fois cochée, l'appel renvoie
`false` en silence pour toute la vie de la page. Le bouton paraît alors mort, sans message
— exactement le genre de panne qu'on découvre au milieu du lac, et qui s'est effectivement
produite.

Le bouton s'arme à la place : un premier appui le passe en rouge et change son libellé en
« Confirmer ? », un second exécute, et il se désarme seul au bout de 4 secondes ou dès
qu'on change d'écran. Aucune dépendance au navigateur, l'état se lit d'un coup d'œil, et le
geste reste faisable d'une main sur un bateau qui bouge. `wireArmed` dans `src/main.js`.

Corollaire pour les relevés partagés : une suppression doit **survivre à la fusion**. Celle-ci
est une union — deux appareils qui relèvent chacun de leur côté doivent additionner leurs
sondes, jamais s'effacer l'un l'autre — mais une union ne sait pas exprimer une suppression,
et ramenait à chaque ouverture le relevé qu'on venait d'effacer. L'appareil retient donc les
identifiants supprimés avec leur horodatage (`Probes.deletedIds`, six mois) : un relevé
distant plus ancien que sa propre suppression est écarté ; plus récent, il repasse, car
c'est alors qu'il a été mesuré à nouveau.

### 6.2 Page Paramètres — Couleurs des fonds (exigence n°4)

Tout est dans `config/palette.json`, éditable dans l'application et rechargeable aux
valeurs par défaut.

#### Principe : des bandes, pas un dégradé

Le premier schéma retenu était un dégradé continu rouge → vert → noir. Il a été
abandonné comme défaut après contrôle visuel : **un dégradé cache par construction la
transition qu'on a besoin de voir**. L'œil détecte un bord instantanément et une
variation progressive très mal.

Les cartes marines — norme S-52 des cartes électroniques officielles, Garmin BlueChart,
Navionics — reposent toutes sur trois règles reprises ici :

1. **Bandes discrètes** de couleur uniforme, séparées par des contours.
2. **Contour de sécurité** tracé en gras à `tirant d'eau + marge`, objet central de la
   carte, qui sépare le navigable du reste. C'est le *shallow water shading* des Garmin :
   un seuil franc, pas une nuance.
3. **Familles de couleurs porteuses de sens** : beige pour la terre et les zones
   découvertes, jamais confondable avec de l'eau ; rouge et orange réservés au danger ;
   bleus pour l'eau navigable, le **plus foncé pour le moins profond** afin que l'eau
   profonde reste claire et lisible au soleil.

#### Préréglage par défaut : « Carte marine »

| Profondeur | Couleur | Rôle |
|---|---|---|
| ≤ 0 m | `#c8a165` beige | **fond émergé** — îlots découverts |
| 0 → 1 m | `#ff1f1f` rouge | danger |
| 1 → 2 m | `#ff8a3d` orange | marge |
| 2 → 5 m | `#1f6fb2` bleu soutenu | peu profond |
| 5 → 10 m | `#4b9fd5` bleu moyen | moyen |
| 10 → 20 m | `#9fcbe8` bleu clair | profond |
| > 20 m | `#e8f3fb` quasi blanc | très profond |

Contour de bande `#182028`, contour de sécurité `#ff00d0` sur 2 px.

> Le contour de sécurité est tracé sur la limite **interne** de la zone peu profonde, et
> non sur le rivage. Sans cette distinction il suit tout le trait de côte, où la
> profondeur est de toute façon inférieure à la cote de sécurité — il devient alors un
> simple liseré décoratif au lieu d'une information.

#### Autres préréglages fournis

- **« Rouge / vert, en bandes »** — la sémantique demandée à l'origine, mais en bandes.
  Réserve : le vert couvre 3 à 12 m, donc 6 m et 20 m restent difficiles à distinguer ; et
  le rouge-vert est la forme de daltonisme la plus répandue (~8 % des hommes).
- **« Dégradé continu »** — le premier schéma, conservé pour comparaison. Toute la
  discrimination visuelle s'y joue entre 3 et 15 m ; au-delà, du vert très sombre puis du
  noir, indistinguables sur un téléphone en plein soleil.

`tools/compare_palettes.py` rend les trois côte à côte sur un extrait du lac, à une cote
donnée, pour trancher sur pièces plutôt que sur intuition.

#### Mise en œuvre

Les deux modes passent par la **même table de correspondance de 256 entrées** couvrant
0 → `lut_max_depth_m` (30 m) : un préréglage en bandes produit une table en marches, un
préréglage continu une table lissée. Le shader de l'application est donc identique dans
les deux cas, et changer de préréglage ne coûte qu'une régénération de table.

Les dégradés sont interpolés dans l'espace perceptuel **OKLab** et non en RVB brut, pour
éviter les virages de teinte parasites — un rouge → vert en RVB passe par un brun sale.
`tools/palette.py` est la référence de calcul ; l'application en porte l'équivalent en
JavaScript.

Les contours de bande sont obtenus dans le shader en comparant l'indice de bande des
pixels voisins — pas de géométrie vectorielle à produire.

#### Réglages complémentaires de la page

- **opacité** de l'overlay (0–100 %) ;
- **mode lignes de sonde** : superposer les isobathes (1, 2, 3, 5, 10, 15, 20 m) avec étiquettes ;
- **tirant d'eau du bateau** (m) : soustrait de la profondeur affichée pour donner la *hauteur d'eau sous quille* ;
- **marge de sécurité** (m) ;
- **alarme haut-fond** : seuil (défaut 1,5 m) + vibration + son ;
- **unités** : m / pieds, km/h / nœuds ;
- **calage bathymétrique** (`Z_2009` + offset manuel), avec explication et avertissement — § 4.4 ;
- **cote manuelle** : forcer une cote saisie à la main (§ 6.4) ;
- **réinitialiser aux valeurs par défaut**.

Persistance en `localStorage`, avec **export / import du profil en JSON** (partage entre le téléphone et celui d'un ami).

### 6.3 Géolocalisation

- `navigator.geolocation.watchPosition` avec `enableHighAccuracy: true`, `maximumAge: 1000`, `timeout: 10000`.
- **HTTPS obligatoire** : GitHub Pages le fournit nativement.
- iOS : l'autorisation est demandée au premier usage ; l'orientation (`DeviceOrientationEvent.requestPermission`) exige un **geste utilisateur explicite** → bouton « Activer le cap ».
- Écran de garde si permission refusée, avec instructions par plateforme.
- Filtrage : rejet des positions de précision > 50 m, lissage exponentiel léger de la trace.

### 6.4 Fonctionnement dégradé / hors ligne

Le lac est en zone de couverture réseau inégale. L'application doit rester utile sans réseau :

- **Service Worker** : mise en cache de l'app, de la grille bathymétrique, du polygone du lac et des tuiles du fond de carte sur l'emprise du lac (pré-chargement proposé au premier lancement, ~20–40 Mo pour les niveaux de zoom 12–16).
- `level.json` est mis en cache ; hors ligne, l'app utilise la **dernière cote connue** en l'affichant explicitement comme telle.
- **Saisie manuelle de la cote** toujours disponible (le plaisancier peut lire l'échelle limnimétrique au port avant de partir).
- La géolocalisation GPS fonctionne **sans réseau** sur les deux plateformes.

### 6.5 Page « À propos / Données »

Sources, dates de levé, licences, méthode de calcul, limites connues, et un **avertissement de sécurité** non escamotable au premier lancement (§ 11).

---

## 7. Structure du dépôt

```
ReliefLac/
├─ .github/workflows/
│   ├─ level.yml           # cron horaire → data/level.json
│   ├─ build-bathy.yml     # manuel → data/bed_5m.png, lake.geojson
│   └─ deploy.yml          # build vite + déploiement Pages
├─ tools/
│   ├─ extract_vassiviere.py   # .tab OFB → points.csv (filtre L0115203)
│   ├─ fetch_lake_polygon.py   # WFS BD TOPO → lake.geojson
│   ├─ build_grid.py           # Delaunay + berges RGE ALTI → bed_5m.png/.json
│   └─ fetch_level.py          # API EDF → level.json
├─ src/
│   ├─ main.ts             # bootstrap, routeur
│   ├─ map.ts              # MapLibre, couches, marqueur bateau
│   ├─ depth-layer.ts      # décodage Terrain-RGB, shader, LUT
│   ├─ palette.ts          # paliers, interpolation OKLab, LUT 256px
│   ├─ level.ts            # chargement level.json, fraîcheur, saisie manuelle
│   ├─ geo.ts              # watchPosition, filtrage, cap, vitesse
│   ├─ settings.ts         # état + persistance localStorage
│   └─ ui/                 # écrans Navigation, Paramètres, À propos
├─ data/                   # généré, versionné
├─ public/                 # manifest.webmanifest, icônes, sw.js
└─ SPECIFICATION.md
```

---

## 8. Exigences non fonctionnelles

| Critère | Cible |
|---|---|
| Premier chargement (4G) | < 5 s jusqu'à la carte utilisable |
| Chargement ultérieur (cache) | < 1,5 s |
| Rendu de l'overlay | 60 fps au pan/zoom ; recoloration < 16 ms |
| Poids total mis en cache | < 50 Mo tuiles comprises |
| Compatibilité | iOS 16+ (Safari), Android 10+ (Chrome) ; WebGL2 requis, repli Canvas 2D |
| Lisibilité au soleil | contrastes forts, gros caractères, mode « haute luminosité » |
| Consommation | usage continu 3 h sans surchauffe notable (pas de re-rendu inutile) |
| Accessibilité | cibles tactiles ≥ 48 px, utilisable d'une main, gants marins tolérés |

---

## 9. Lots de livraison

> **État au 11 août 2026 : L0, L1 et L2 sont livrés et en ligne.** Suivi détaillé,
> points ouverts et pièges rencontrés dans [ETAT.md](ETAT.md).

| Lot | Contenu | Résultat vérifiable |
|---|---|---|
| **L0 — Données** ✅ | Scripts d'extraction, grille 5 m, polygone du lac, `level.json` + cron | Carte de profondeur générée, vérifiable visuellement contre les cartes halieutiques existantes |
| **L1 — Carte + GPS** ✅ | PWA, MapLibre, position du bateau, overlay coloré, cote EDF affichée, bascule Plan/Ortho, **mode Étalonnage** (§ 15.3), couche « traces 2009 », **signalement des zones non sondées** (§ 6.1 bis) | Utilisable sur l'eau : je me vois, je vois les fonds, je sais où le modèle devine, et je peux étalonner dès la première sortie |
| **L2 — Paramètres** ✅ | Page palette complète, tirant d'eau, unités (m/km/h ↔ m/nœuds), alarme haut-fond, sonde ponctuelle, export/import de profil | Exigence n°4 satisfaite |
| **L3 — Hors ligne** | Service Worker, pré-chargement des tuiles, cote manuelle | Fonctionne sans réseau au milieu du lac |
| **L4 — Calage & densification** | `Z_2009` confirmé par l'étalonnage, **levé multifaisceaux 2011** (§ 3.5), import des logs sondeur (§ 15.4), isobathes étiquetées | Profondeurs validées sondeur en main, couverture complète du lac |

---

## 10. Vérifications à mener

1. **Contrôle croisé de la bathymétrie** : superposer la grille générée à la carto Navionics / Fish Deeper du lac, vérifier la cohérence des fosses (la fosse maximale doit ressortir à ~31 m au levé, ~33 m à la retenue normale).
2. **Contrôle du modèle sur le terrain** : 10 points GPS avec sondeur, à des profondeurs de 1 à 20 m, répartis entre traces et sur traces → mesure du biais et de la dispersion.
3. **Robustesse de l'API EDF** : surveiller le workflow horaire pendant 2 semaines (changement d'ID, de schéma, rate-limiting).
4. **Test batterie et GPS** : session de 3 h en navigation réelle.
5. **iOS vs Android** : permissions, cap, wake lock, installation PWA.

---

## 11. Limites et sécurité — à afficher dans l'application

> **Cette application n'est pas un document nautique officiel et ne remplace ni un sondeur, ni la prudence.**
>
> - La bathymétrie repose sur un levé du **22 avril 2009**. Les fonds ont pu évoluer (sédiments, souches, dépôts, aménagements).
> - **37,8 % du lac est à plus de 60 m de toute sonde**, jusqu'à 314 m. Dans ces zones — hachurées dans l'application — la profondeur est interpolée entre des transects éloignés. **Un haut-fond y est invisible et hérite de la profondeur des fosses voisines** : un îlot réellement émergé peut être affiché à 10-20 m d'eau. **Ne s'y fier qu'au sondeur.**
> - Une **bande aveugle** subsiste entre la cote du jour et 648,80 m : ce terrain était sous l'eau lors du vol LiDAR et hors d'atteinte du bateau en 2009. C'est précisément la frange qui découvre en étiage.
> - La profondeur affichée dépend de la **cote fournie par EDF**, qui peut être périmée ou indisponible, et d'une **cote de référence du levé encore à confirmer**.
> - EDF peut faire varier le niveau **rapidement** (jusqu'à ~10 cm/jour en période de soutien d'étiage).
> - **La navigation est interdite en dessous de 642 m NGF** (seuil EDF). L'application affiche l'alerte mais la responsabilité reste au pilote.
>
> Marge de sécurité recommandée : **≥ 1 m** en plus du tirant d'eau.

---

## 12. Licences et attributions (à faire figurer dans l'app)

- Bathymétrie : **OFB / Système d'Information sur l'Eau — « Bathymétrie plans d'eau »**, Licence Ouverte 2.0. Protocole Onema/Cemagref (Alleaume et al., 2010).
- Cote du lac : **EDF Hydro — « Ma Rivière et Moi »** (usage informatif, mention de la source ; § 13).
- Contour du lac et altimétrie : **IGN — BD TOPO® / RGE ALTI®**, Licence Ouverte Etalab 2.0.
- Fond de carte : **IGN Géoplateforme** et/ou **© contributeurs OpenStreetMap** (ODbL).

## 13. Point ouvert n°2 — usage de l'API EDF

L'endpoint est public et non authentifié, mais **non documenté** comme API ouverte. Conséquences assumées :

- appel **une fois par heure** depuis GitHub Actions (charge négligeable, comparable à un utilisateur de l'app EDF) ;
- attribution visible et lien vers la source officielle dans l'application ;
- l'endpoint peut changer sans préavis → le workflow doit échouer **proprement** (dernière valeur conservée, `stale: true`) et la saisie manuelle de la cote reste toujours disponible ;
- recommandation : **informer EDF Hydro** de l'usage lors de la demande sur la cote 2009 (§ 4.4), ce qui traite les deux sujets d'un même courrier.

---

## 14. Décisions arrêtées (10/08/2026)

1. **Palette par défaut** : validée telle que définie au § 6.2.
2. **Fond de carte** : **bascule** entre IGN Plan v2 et ortho-photo, bouton dédié sur l'écran de navigation, choix mémorisé.
3. **Unités** : **mètres + km/h** par défaut, **basculable en mètres + nœuds** dans les Paramètres.
4. **Calage** : par **étalonnage au sondeur de bord** (§ 15), et non par demande à EDF. La demande EDF reste un recours secondaire.
5. **Dépôt GitHub** : **`magcad`**, public (requis pour GitHub Pages en offre gratuite).

---

## 15. Protocole d'étalonnage au sondeur

L'étalonnage terrain remplace avantageusement la demande de la cote 2009 : il ne corrige pas seulement le décalage de référence `Z_2009`, il **valide le modèle dans son ensemble** — envasement depuis 2009, erreurs d'interpolation, décalage de la sonde.

### 15.1 Ce que l'on mesure

Pour chaque relevé, l'écart entre modèle et réalité vaut :

```
résidu  =  ( cote_EDF(t) − prof_sondeur − tirant_sonde )  −  z_fond_modèle(x,y)
```

où `tirant_sonde` est la profondeur d'immersion du transducteur sous la flottaison (typiquement 0,2–0,5 m — **à mesurer au mètre ruban une fois pour toutes**, sinon il pollue tout l'étalonnage).

- Si les résidus sont **groupés autour d'une même valeur** → c'est bien un décalage de référence : `Z_2009 corrigé = 648,0 + médiane(résidus)`.
- Si les résidus sont **dispersés sans biais commun** → le problème est l'interpolation, pas la référence.
- Si les résidus **dérivent avec la profondeur** → erreur d'échelle (célérité du son mal réglée sur le sondeur, ou différence de calage entre les deux campagnes).

### 15.2 Où mesurer — le point qui décide de la qualité

Les traces du levé 2009 sont espacées de ~100 m. Un relevé pris **entre** deux traces mesure surtout l'erreur d'interpolation, pas le décalage recherché.

Règles :

1. **Se placer sur les traces de 2009.** L'application affichera une couche « traces du levé 2009 » activable : il suffit de naviguer dessus.
2. **Privilégier les zones plates et profondes** (plateaux à 10–20 m), où une erreur horizontale de 20 m ne change presque rien à la profondeur. Les pentes sont à proscrire pour l'étalonnage.
3. **Éviter les 3 premiers mètres** près des rives : forte pente, forte incertitude.
4. **Répartir sur le lac** — au moins 4 secteurs éloignés, pour détecter une éventuelle bascule du plan de référence.
5. **Bateau à l'arrêt ou très lente vitesse** au moment du relevé (le GPS et le sondeur ne réagissent pas à la même vitesse).
6. **Les hauts-fonds découverts se relèvent à pied**, en saisissant leur hauteur au-dessus de l'eau **en négatif** (−0,4 = le caillou dépasse de 40 cm ; bouton « ± » sur les deux écrans de saisie). Trois conséquences, toutes voulues :
   - l'**immersion du transducteur n'est pas retranchée** — il n'y a pas de sonde dans l'eau. La règle est énoncée une seule fois, dans `bedAltitude()` (`src/probes.js`), et reprise à l'identique par `tools/import_soundings.py` ;
   - le résidu reste valide pour l'étalonnage, et il est même le plus propre du lot : le plan d'eau est une référence directement visible et **aucune célérité du son n'entre en jeu** ;
   - en revanche un point émergé **ne peut pas trancher la forme du résidu** (§ 15.1) — constante et proportionnelle se rejoignent à profondeur nulle. `depthShape()` l'écarte de ce verdict tout en le gardant dans la médiane.

   Ce sont, au regard du § 4.2bis, les points les plus précieux du lot : le bateau sondeur de 2009 ne pouvait pas passer dessus, c'est là que le modèle est le plus gravement faux, et une hauteur relevée à pied le corrige **dans le sens sûr**.

**Volume utile** : ~20 relevés donnent déjà une médiane solide ; 40 permettent en plus de quantifier la dispersion. Une seule sortie suffit.

### 15.3 Mode « Étalonnage » dans l'application (avancé au lot L1)

Écran dédié, conçu pour être utilisable seul à la barre :

- gros bouton **« Relever »** : capture en un geste `timestamp`, `lat`, `lon`, `précision GPS`, `cote EDF du moment`, `z_fond modèle`, et ouvre un pavé numérique pour saisir la profondeur lue au sondeur ;
- bouton **« ± »** accolé au champ : le pavé numérique d'iOS n'a pas de touche « moins », et sans lui un haut-fond émergé serait impossible à saisir là où on le rencontre. Il inverse la valeur affichée plutôt que d'armer un mode — sur un outil de navigation, ce qui est lu doit être ce qui est enregistré — et s'allume tant qu'elle est négative ;
- affichage immédiat du **résidu** du point et de la **médiane courante** — on voit la convergence en direct ;
- code couleur : vert si le point tombe sur une trace 2009 et en zone plate, orange sinon ;
- liste des relevés, suppression d'un point aberrant ;
- **export CSV / JSON** et **application en un clic** de la correction calculée ;
- fonctionne **entièrement hors ligne** (les relevés sont stockés localement, la cote EDF prise est celle du cache avec son horodatage).

### 15.4 Bonus : réutiliser les enregistrements du sondeur

Si le sondeur enregistre ses traces avec position et profondeur (Lowrance `.sl2`/`.sl3`, Garmin `.gpx`/`.rsd`, Humminbird `.dat`, ou toute sortie NMEA 0183 `SDDBT`/`SDDPT` loggée), une seule journée de navigation produit **des milliers de sondes horodatées**. Comme la cote EDF est archivée heure par heure dans `data/level-history.json`, chaque sonde devient directement un point d'altitude de fond en m NGF.

Deux gains :

1. étalonnage massif et statistiquement robuste, au lieu de 20 points ;
2. **densification de la bathymétrie elle-même** — les zones parcourues régulièrement (chenaux, abords des ports, routes habituelles) passeraient d'une résolution de ~100 m à quelques mètres, en données de 2026 plutôt que de 2009.

Un script `tools/import_sounder_log.py` est prévu au lot L4 pour fusionner ces relevés avec le levé OFB (pondération par ancienneté et par densité).
