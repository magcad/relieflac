# État du projet — reprise de session

**Dernière mise à jour** : 11 août 2026
**Application en ligne** : <https://magcad.github.io/relieflac/>
**Vérifications** : <https://magcad.github.io/relieflac/test/> — 49 contrôles, tous passants
**Dépôt** : <https://github.com/magcad/relieflac> (public, branche `main`)

Ce document sert à reprendre le travail sans relire tout l'historique.
La spécification complète est dans [SPECIFICATION.md](SPECIFICATION.md).

---

## 1. Où on en est

| Lot | Contenu | État |
|---|---|---|
| **L0** | Extraction du levé, contour, contrainte de bord, grille, cote horaire | ✅ terminé |
| **L1** | Carte, GPS, fonds coloriés en WebGL, mode Étalonnage, signalement des zones non sondées | ✅ terminé |
| **L2** | Page Paramètres | ✅ livrée avec L1 |
| **L3** | Hors ligne — Service Worker, pré-chargement des tuiles | ⬜ à faire |
| **L4** | Calage `Z_2009` confirmé, import des logs sondeur, isobathes étiquetées | 🟡 en cours |

Mode **« Sonde »** (saisie manuelle) livré le 11/08/2026 : le sondeur du bord est un
**Eagle** monochrome sans enregistrement ni GPS — on relève la profondeur à la main. Un
champ toujours présent sur la carte cale la lecture sur la cote du moment
(`z_fond = cote − profondeur − immersion`), pose une pastille chiffrée à la position GPS,
et exporte en CSV/GeoJSON directement avalés par `tools/import_soundings.py`. **Toucher une
pastille** la rouvre en correction (nouvelle valeur recalée sur la cote d'origine) ou en
suppression ; mêmes actions dans la liste des Paramètres. Code :
[`src/probes.js`](src/probes.js), câblé dans `src/main.js` (`wireProbes`/`recordProbe`/`beginProbeEdit`).

L'application est utilisable sur l'eau. Elle n'a **jamais été vue fonctionner par
l'assistant** : l'environnement de test a une page masquée, où `requestAnimationFrame`
est suspendu et MapLibre ne s'initialise pas. Tout ce qui est vérifiable hors carte l'est
par `test/` ; le rendu cartographique a été validé par retour de l'utilisateur.

---

## 2. Le problème central, chiffré

Le modèle repose sur le levé monofaisceau OFB de 2009. Sa couverture réelle, mesurée par
`tools/check_coverage.py` :

| Distance à la sonde mesurée la plus proche | Part du lac |
|---|---|
| ≤ 25 m | **32,2 %** |
| ≤ 60 m | 62,2 % |
| **> 60 m** | **37,8 %, soit 354 ha** |
| Maximum | **314 m** |

Ce ne sont pas des traces espacées de 100 m comme estimé au départ, mais des **transects
distants de plus de 150 m** dans les grands bassins.

**Conséquence, et c'est le défaut le plus grave du modèle :** le bateau sondeur ne passe
pas sur un haut-fond. Celui-ci est donc un trou dans les données, que la triangulation
comble en reliant les sondes profondes qui l'entourent — l'obstacle hérite de la
profondeur des fosses. Des îlots qui émergent réellement à la cote actuelle sont affichés
à 10-20 m d'eau. Signalé par l'utilisateur, reproduit et quantifié.

Le MNT LiDAR ne rattrape rien : **99 % de ces trous étaient sous l'eau** au moment du vol
IGN (plan d'eau à 648,80 m NGF).

**Traitement retenu, faute de mieux** : afficher l'ignorance plutôt que la masquer. Les
zones au-delà du seuil sont hachurées, et la profondeur sous le bateau annonce
« interpolé — sonde à N m ». Voir `data/coverage.png` et § 4.2 bis de la spécification.

---

## 3. Points ouverts, par priorité

### 3.1 Obtenir le levé multifaisceaux 2011 — le seul vrai correctif

Un levé **à couverture totale, Ordre 1 (S-44 OHI)**, TPU 15 cm, MNT au mètre, a été
réalisé en octobre 2011 par ENSTA Bretagne, l'Université de Gand, la HCU Hamburg et le
CIDCO, pour le compte d'EDF. Il supprimerait purement et simplement le problème du § 2.

Analyse complète, détenteurs et formats à demander : [`data/2011 ENSTA/ANALYSE.md`](data/2011%20ENSTA/ANALYSE.md).

Deux atouts décisifs : sa **référence verticale est connue** (646 m IGN69), ce qui lèverait
l'inconnue du § 3.2 ; et le levé s'est fait **à basse cote** (≈ 4 m sous la normale, année
de sécheresse), donc il couvre la frange qui découvre en étiage — la bande aveugle où se
trouvent justement les îlots problématiques.

Le paquet déposé dans `data/2011 ENSTA/` ne contient **que** la communication FIG et une
vignette de 418 px : ni MNT, ni nuage de sondes, ni vectoriel extractible. À demander à
EDF Unité de Production Centre et à ENSTA Bretagne.

**Action en attente** : rédiger la demande. L'utilisateur n'a pas encore tranché.

### 3.2 Confirmer `Z_2009`

La cote du lac le 22 avril 2009, jour du levé OFB, est inconnue. Elle décale **toutes** les
profondeurs d'une constante. Valeur provisoire retenue : **648,0 m NGF**, plage plausible
645–648,8 (établi : les 460 sondes les moins profondes tombent dans le plan d'eau LiDAR).

Le mode Étalonnage de l'application est fait pour la mesurer — protocole au § 15 de la
spécification. Une sortie avec sondeur suffit. **Non encore réalisé.**

Une fois la valeur stabilisée : la reporter dans `config/model.json`
(`reference_levels.ofb2009.value_m_ngf`), passer `confirmed` à `true`, relancer
`build_grid.py`, et remettre le décalage d'étalonnage à zéro dans l'application.

### 3.3 IGN69 ou NGF-Lallemand ?

Le rapport 2011 précise que le levé manipulait **deux systèmes altimétriques** : IGN69
(officiel actuel) et **NGF-Lallemand**, l'ancien système, *celui utilisé par EDF*.

L'API EDF annonce ses cotes en « m NGF » sans préciser lequel. Le RGE ALTI est en IGN69.
Si les deux diffèrent, le modèle porte un biais constant, du même ordre que celui que
l'étalonnage cherche à corriger — l'étalonnage l'absorbera sans qu'on sache le distinguer.

À poser explicitement dans la même demande qu'au § 3.1.

### 3.4 La bande aveugle

Entre la cote du jour (≈ 647 m) et le plan d'eau LiDAR (648,80 m), le terrain n'est couvert
par **aucune** source : sous l'eau lors du vol IGN, hors d'atteinte du bateau en 2009.
C'est précisément la zone qui découvre en étiage, donc celle qui compte pour la navigation.

Résolue par le levé 2011 (§ 3.1), ou par des traces de sondeur horodatées (§ 3.5).

### 3.5 Traces de sondeur

**Piste Garmin abandonnée pour cet usage.** ActiveCaptain / Quickdraw Community est une
impasse pour ce projet précis : (a) le format on-device (`ContoursLog.svy` + grilles
propriétaires) n'est décodé par aucun outil public, GPSBabel refuse ; (b) surtout, la
donnée appartient à Garmin/à la communauté, sous CGU interdisant la redistribution et sans
licence ouverte — **incompatible avec une appli libre et gratuite**. Le traceur de l'ami
n'a donc pas été sollicité.

Voie retenue à la place : **saisie manuelle** (§ L4 ci-dessus, `src/probes.js`), le sondeur
du bord étant un Eagle sans export. L'utilisateur collecte lui-même ses points, librement
rediffusables.

L'importeur reste écrit, testé et prêt : `tools/import_soundings.py` accepte CSV, GPX (y
compris l'extension Garmin `<gpxx:Depth>`), GeoJSON et KML, gère l'immersion du
transducteur et **refuse** un fichier non horodaté sans cote de référence explicite.
L'export CSV du mode Sonde est calibré sur ses colonnes. Détails :
[`data/imports/README.md`](data/imports/README.md).

### 3.6 Piste drone — combler la frange à basse cote

L'utilisateur possède un **DJI Mini 4 Pro**. Piste sérieuse pour la frange qui découvre :
photogrammétrie du fond exposé quand EDF marne, calée verticalement sur la ligne d'eau
(= cote EDF connue du jour). Cible exactement la bande aveugle (§ 3.4) et les îlots
fantômes (§ 2). **Fenêtre saisonnière** : le lac est tenu à **647 m NGF du 1ᵉʳ avril au
31 août** (rien à filmer en été), puis baisse 0,5–1 m/semaine dès le 1ᵉʳ septembre, avec
~2 m de plus en novembre → bas annuel ordinaire **~642–644**, atteint **fin nov.–février**.
Une **vidange de contrôle** (décennale) découvrirait bien plus, mais rare. À traiter en
WebODM, fusionner via `import_soundings.py`. Non commencé — dépend de la basse cote.

---

## 4. Reprendre le travail

### Outillage

Déjà installé sur la machine : Python 3.12, Node 24, gh 2.97, plus
`numpy scipy shapely pyproj Pillow pypdf pdfplumber`.

`gh` est authentifié en HTTPS. Le compte GitHub est **`magcad`**.

### Servir l'application en local

```bash
python tools/serve.py 8123
```

Ne **pas** utiliser `python -m http.server` : il met en cache, si bien qu'un module
corrigé continue d'être servi depuis le cache du navigateur, et il déduit les types MIME
du registre Windows où `.mjs` vaut `text/plain`. Les deux pièges ont déjà coûté du temps.

### Reconstruire les données

```bash
python tools/extract_ofb.py             # OFB → data/soundings/ofb2009.csv
python tools/fetch_lake_polygon.py      # IGN BD TOPO → data/lake.geojson
python tools/fetch_rge_alti.py          # IGN RGE ALTI → data/rge_alti.npy (non versionné)
python tools/build_shore_constraint.py  # → data/shore_constraint.csv
python tools/fetch_level.py             # EDF → data/level.json + level-history.json
python tools/build_grid.py              # tout → data/bed.png, bed.json, coverage.png
python tools/dump_reference.py          # → test/reference.json, requis par les tests
python tools/preview_grid.py            # contrôle visuel → data/preview.png
```

`data/rge_alti.npy` (4,9 Mo) n'est pas versionné : `fetch_rge_alti.py` le retélécharge.
`build_grid.py` échoue proprement sans lui, en signalant quoi lancer.

### Outils de diagnostic

| Script | Ce qu'il répond |
|---|---|
| `check_coverage.py` | Où le modèle interpole plutôt que de mesurer — carte + rapport par trou |
| `find_shoals.py` | Hauts-fonds mesurés par le LiDAR mais absents du levé |
| `check_shoreline_level.py` | À quelle cote correspond le trait de côte BD TOPO |
| `compare_palettes.py` | Rendu des préréglages côte à côte, à une cote donnée |

### Vérifications

Ouvrir `/test/`. 49 contrôles : table de couleurs comparée à la référence Python,
décodage de la grille sur 7 points, couverture, statistiques d'étalonnage, calage, export,
correction et suppression des sondes manuelles, index des sondes, géométrie, cote, et **le
shader rendu hors MapLibre dans un canvas WebGL2**.

Après toute modification de `config/palette.json` ou de la grille, relancer
`python tools/dump_reference.py`, sinon les tests comparent à une référence périmée.

---

## 5. Décisions arrêtées

| Sujet | Choix | Pourquoi |
|---|---|---|
| Grandeur stockée | Altitude du fond en m NGF, pas la profondeur | Le lac marne de plusieurs mètres ; une carte de profondeurs figée est fausse la plupart du temps |
| Cote du lac | Relais GitHub Actions horaire | L'API EDF ne renvoie **aucun** en-tête CORS : inappelable depuis la page publiée |
| Rendu | Bandes discrètes façon carte marine | Un dégradé cache par construction la transition qu'il faut voir |
| Contours | Analytiques, normalisés par `fwidth` | Épaisseur constante à l'écran à tous les zooms, sans vectorisation hors ligne |
| Interpolation | Bilinéaire sur les altitudes **décodées** | `NEAREST` obligatoire sur du Terrain-RGB, d'où le décodage avant mélange |
| Généralisation | Biaisée vers le haut-fond, rayon 15 m | Les erreurs vont toujours dans le sens prudent |
| Décalage d'étalonnage | Appliqué **seulement** sous le plan d'eau LiDAR | Au-dessus, la grille vient du MNT : ce sont des altitudes absolues |
| Dépendances | MapLibre vendorisé en `.js` | La vérification stricte du type MIME rejette `.mjs` sur certains serveurs |
| Build | Aucun — modules ES natifs | Le code lu est le code exécuté ; rien à casser entre les deux |

---

## 6. Pièges déjà rencontrés

À ne pas refaire.

- **`git push` silencieux.** Rediriger la sortie vers `Out-Null` a masqué un rejet : le
  workflow horaire avait commité entre-temps. Un déploiement a été cru fait alors que
  `src/` n'était jamais parti. Toujours lire la sortie de `push`, et vérifier les
  ressources en ligne après coup.
- **`.nojekyll` sans `index.html`.** Jekyll convertissait `README.md` en page d'accueil ;
  le désactiver a produit un 404 à la racine alors que les données restaient servies.
- **Arrondis divergents.** `round()` en Python arrondit au pair, `Math.round()` en
  JavaScript arrondit au-dessus. Une même table de couleurs était indexée de trois façons.
  Règle unique désormais : `floor(ratio × 256)`, celle du shader.
- **Backticks dans un commentaire de shader.** Le littéral gabarit JavaScript se terminait
  au milieu du GLSL, et le module ne se chargeait plus.
- **`load` de MapLibre.** Il exige une première image rendue ; dans un onglet masqué,
  `requestAnimationFrame` est suspendu et l'application restait bloquée sur
  « Chargement… ». On attend `style.load`, et la visibilité est attendue explicitement.
- **Collision de noms dans `build_grid.py`.** `coverage` désignait déjà le taux de
  cellules valides.

---

## 7. Sources et licences

| Donnée | Source | Licence |
|---|---|---|
| Bathymétrie | [OFB — Bathymétrie plans d'eau](https://data.eaufrance.fr/jdd/c31746f7-311a-41c7-b995-6cb78a2ddc25), levé du 22/04/2009, entité `L0115203` | Licence Ouverte 2.0 |
| Cote du lac | EDF — `https://mariviereetmoi.edf.fr/api/v5/practicabilities/31856100` | usage informatif, sans CORS |
| Contour | IGN BD TOPO® V3, WFS `data.geopf.fr`, `CQL_FILTER=toponyme LIKE '%Vassivi%'` | Etalab 2.0 |
| Altimétrie | IGN RGE ALTI®, WMS BIL float32 `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES` | Etalab 2.0 |
| Fonds de carte | IGN Géoplateforme WMTS — `PLANIGNV2` et `ORTHOIMAGERY.ORTHOPHOTOS` | Etalab 2.0 |

Seuils de navigation EDF : **interdite sous 642 m NGF**, délicate 642–643, retenue
normale 650, crête du barrage 652,90.
