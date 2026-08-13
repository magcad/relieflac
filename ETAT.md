# État du projet — reprise de session

**Dernière mise à jour** : 13 août 2026
**Application en ligne** : <https://magcad.github.io/relieflac/>
**Vérifications** : <https://magcad.github.io/relieflac/test/> — 124 contrôles, tous passants
**Enchaînements** : <https://magcad.github.io/relieflac/test/interaction.html> — 44 gestes, tous passants
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

**Hauts-fonds découverts, relevés à pied** (12/08/2026) : la saisie accepte désormais une
**valeur négative** — la hauteur du fond au-dessus de l'eau — sur les deux écrans, sonde et
étalonnage. Bouton « ± » parce que le pavé numérique d'iOS n'a pas de touche « moins ». Le
piège désamorcé au passage : **l'immersion du transducteur ne doit pas être retranchée**
quand rien n'est immergé, sinon 30 cm d'erreur systématique dans le sens dangereux, et
précisément sur les points où le modèle est déjà le plus faux (§ 2 ci-dessous). La règle
tient dans `bedAltitude()` ([`src/probes.js`](src/probes.js)), reprise par
`src/calibration.js` et par `tools/import_soundings.py` — qui conserve maintenant les
profondeurs négatives au lieu de les jeter, tout en continuant d'écarter le zéro exact
(signature d'un sondeur qui décroche). Doctrine au § 15.2 de la spécification.

**Immersion du transducteur attachée au relevé** (12/08/2026) : elle était écrite dans
`data/corrections/<lac>.json` depuis le **réglage courant**, la même valeur pour tous les
points, et n'était jamais relue — un relevé pris à 0,30 m se voyait réattribuer le 0,25 m
du jour. Sans effet tant que `z_fond` reste figé, faux dès qu'on le recalcule. Corrigé
dans `src/sync.js` (`toFile`/`fromFile`) et `src/main.js`
(`probesToRecords`/`recordsToProbes`) ; le réglage courant ne sert plus que de repli pour
les relevés antérieurs. Vérifié sur le fichier publié : les 4 sondes gardent leurs 0,30 m
et leur altitude se refait à 0,0000 m près. Préalable indispensable à toute correction
d'échelle du sondeur (§ 3.2 bis).

**Correction de la carte refondue, point posé sans GPS, zones émergées** (13/08/2026) —
trois changements liés, autour d'une même question : comment un relevé manuel doit
déformer la carte.

1. **Clic droit = point désigné.** `recordProbe` exigeait une position GPS, qu'un ordinateur
   de bureau n'a pas : l'application n'était manipulable que sur l'eau. Un clic droit (ou un
   appui long tactile) pose désormais un repère de visée à l'endroit montré et ouvre la
   saisie ; la sonde qui en sort est ordinaire et partagée, mais porte
   `position_source: "map"` jusque dans `data/corrections/vassiviere.json` — une position
   pointée ne vaut pas une position mesurée. Voir `placePin` dans `src/main.js`.
2. **Plateau, fondu, fusion** (§ 4.2 ter de la spécification). L'ancien `applyCorrections`
   appliquait la valeur au **seul centre** — chaque relevé devenait une pointe — et traitait
   les relevés **en séquence sur le résultat du précédent**, si bien que deux points voisins
   se corrigeaient mutuellement et que la carte dépendait de l'ordre de saisie. Désormais
   chaque relevé pose un plateau (moitié centrale de son rayon) où la carte vaut exactement
   la valeur relevée, puis un fondu ; les recouvrements se fusionnent par accumulation de
   poids, et un plateau n'est jamais entamé par le fondu d'un voisin. Le **rayon appartient
   au relevé**, comme l'immersion, et se règle point par point sur la carte.
   Profil mesuré sur la vraie grille, écart au levé 2009 (m), relevé +8 m :

   | distance (m) | 0 | 5 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 45 |
   |---|---|---|---|---|---|---|---|---|---|---|
   | point r=40 | 8,00 | 8,00 | 8,00 | 8,00 | 8,00 | 7,71 | 6,00 | 3,96 | 2,95 | 3,30 |
   | point r=20 | 8,00 | 8,00 | 8,00 | 6,76 | 1,82 | 1,32 | — | — | — | — |
   | 2 points à 25 m | 8,00 | 8,00 | 8,00 | 8,00 | 8,00 | 8,00 | 8,00 | 8,00 | 7,13 | 3,89 |
   | levé 2009 seul | 0,00 | 0,12 | 0,31 | 0,57 | 0,92 | 1,32 | 1,78 | 2,27 | 2,78 | 3,30 |

   La dernière ligne est la référence : le fondu y revient exactement.
3. **Zones émergées** ▲ (§ 4.2 quater). Contour fermé tracé au clic, dont l'intérieur est
   porté à `cote + hauteur hors d'eau` — l'altitude du sol, invariante, donc la zone découvre
   ou se noie toute seule quand la cote change. Une sonde corrige un caillou ; c'est cet
   outil-là qui corrige l'**étendue** d'un îlot que le levé a comblé. Local à l'appareil et
   **non synchronisé** : une zone est une interprétation, pas une mesure.
   [`src/zones.js`](src/zones.js), `wireZones` dans `src/main.js`.

**Suppression d'un point réparée** (13/08/2026) — signalée par l'utilisateur, reproduite,
et due à **deux** causes indépendantes qui donnaient le même symptôme :

1. **La fusion ressuscitait le relevé.** `mergeById` est une union — volontairement non
   destructive, pour que deux appareils s'additionnent au lieu de s'effacer — mais une
   union ne sait pas exprimer une suppression. Le relevé effacé était toujours dans
   `data/corrections/vassiviere.json`, et revenait à chaque ouverture. Sur localhost, où
   les 4 sondes publiées sont les seules présentes, la suppression paraissait donc
   totalement inopérante. Réparé par des **pierres tombales** (`Probes.deletedIds`,
   [`src/probes.js`](src/probes.js)) : un relevé distant plus ancien que sa propre
   suppression est écarté de la fusion ; plus récent, il repasse — c'est alors une mesure
   refaite depuis. Conservées six mois, largement de quoi couvrir le délai avant l'envoi
   qui les propage.
2. **`window.confirm` n'est pas fiable.** Toutes les suppressions passaient par lui. Or
   Chrome propose « Empêcher cette page de créer des boîtes de dialogue supplémentaires »
   dès la deuxième, et la case cochée, l'appel renvoie `false` en silence pour toute la vie
   de la page : le bouton paraît mort, sans le moindre message. Remplacé par un **bouton
   qui s'arme** — un premier appui le passe en rouge « Confirmer ? », un second exécute, et
   il se désarme seul au bout de 4 s (`wireArmed` dans `src/main.js`, sept boutons
   concernés). Plus aucune boîte de dialogue dans l'application.

**Zones : reprendre et supprimer** (13/08/2026) — signalé par l'utilisateur, « le tracé des
zones ne semble pas pouvoir être supprimé ». Le mode zone démarrait **en tracé** : le
premier toucher posait un sommet, et dès lors chaque clic en posait un autre, y compris sur
un contour existant. La zone ne pouvait plus être reprise, donc plus être supprimée, et
rien à l'écran ne l'expliquait — un seul sommet posé par mégarde suffisait à enfermer
l'utilisateur. Le panneau a désormais **trois états** (liste, tracé, réglage), il s'ouvre
sur la liste, et le tracé ne commence qu'au bouton « ✚ Nouvelle zone ». La liste des zones
figure dans le panneau lui-même, avec ✎ et ✕ par ligne : reprendre ou supprimer ne dépend
plus d'un toucher réussi sur un contour de quelques pixels. Doctrine au § 4.2 quater de la
spécification.

**Banc d'essai des enchaînements** (13/08/2026) : `test/interaction.html`. Il démarre la
**vraie** application avec une carte factice ([`test/stub-map.js`](test/stub-map.js))
substituée à MapLibre par une carte d'import, et provoque les mêmes événements que la vraie
carte. C'est ce banc qui a reproduit les deux défauts ci-dessus, qu'aucune vérification de
module ne pouvait voir : elles étaient dans le câblage, entre un bouton et un état.

L'application est utilisable sur l'eau. Son **rendu cartographique** n'a jamais été vu
fonctionner par l'assistant : l'environnement de test a une page masquée, où
`requestAnimationFrame` est suspendu et MapLibre ne s'initialise pas (revérifié le
13/08/2026 : 0 image en 2 s). Les enchaînements de l'interface, eux, sont désormais
vérifiables — reste à valider par l'utilisateur ce qui se voit à l'écran : dessin des
contours de zone, repère de visée, empilement des barres du bas.

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
spécification. **Sortie réalisée le 12/08/2026** : 22 relevés, tous sur trace, de 1,85 à
24,25 m, soit toute la gamme du lac. Résultat au § 3.2 bis — la valeur cherchée n'est pas
isolable tant que l'échelle du sondeur n'est pas réglée.

Une fois la valeur stabilisée : la reporter dans `config/model.json`
(`reference_levels.ofb2009.value_m_ngf`), passer `confirmed` à `true`, relancer
`build_grid.py`, et remettre le décalage d'étalonnage à zéro dans l'application.

### 3.2 bis Le sondeur Eagle sous-lit d'environ 10 %

Découvert par la sortie du 12/08/2026 (`data/mesuresEtalonnage/etalonnage_12_08_2026.json`).
L'écart entre le modèle et le sondeur **n'est pas une constante** : il vaut 12 % de la
profondeur (pente 9,8 % ± 1,2, soit 8 σ ; bootstrap 6,8–12,3 % ; +13 %/m dans chacun des
deux bassins pris séparément, donc pas un effet de lieu).

Le coupable est l'instrument, pas le modèle :

- la grille reproduit les sondes 2009 brutes à 0,977 de pente près → `build_grid.py` hors de cause ;
- aucune cote ne redresse une pente : `Z_2009` reste à 11,8 % de résidu quelle qu'elle soit, et il faudrait 649,7 m NGF, au-dessus du plafond LiDAR de 648,8 ;
- contrôle de volume : la grille donne 106,3 hm³ et une fosse de 31,5 m à 650 m NGF, contre 106 hm³ et 32 m au registre CFBR. Un levé 12 % trop profond donnerait 94 hm³ et 28 m.

Contrôle au mètre fait au port par 2,4 m : conforme — mais à cette profondeur les deux
hypothèses ne diffèrent que de 0,19 m, moins que l'immersion elle-même. **Non concluant par
construction.** Le contrôle qui tranche est le *bar check* : une plaque suspendue sous le
transducteur à 3, 5, 8 et 10 m de fil marqué — elle dérive avec le bateau, donc la stabilité
n'entre pas en jeu. Attendu si l'hypothèse tient : 2,50 / 4,32 / 7,05 / 8,87 m à l'affichage.

Conséquences tant que ce n'est pas réglé :

- **ne pas appuyer sur « Appliquer la correction »** : `usable` refuse le modèle `proportionnel` mais laisse passer `indetermine` ([`src/calibration.js`](src/calibration.js) l. 99), donc le bouton était actif et aurait appliqué +1,66 m de constante à une carte juste ;
- les sondes saisies au Eagle portent la même erreur d'échelle ; les relevés **à pied** sur haut-fond découvert, eux, sont indemnes ;
- couple estimé si l'hypothèse se confirme : facteur **1,098** et `Z_2009` = **648,39 m NGF** (résidu 0,38 m RMS).

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

Ouvrir `/test/`. 122 contrôles : table de couleurs comparée à la référence Python,
décodage de la grille sur 7 points, couverture, statistiques d'étalonnage, calage, export,
correction et suppression des sondes manuelles, **retouche de palette et points de
simulation**, **forme de la correction (plateau, fondu, indépendance à l'ordre) et zones
émergées**, index des sondes, géométrie, cote, **la caméra de suivi** (le rendu n'est pas
testable, la décision de caméra l'est), et **le shader rendu hors MapLibre dans un canvas
WebGL2**.

Piège des vérifications sur la grille : elle est en `Float32Array`, où une altitude vers
640 m ne tient qu'à 6·10⁻⁵ près — une tolérance de 10⁻⁶ fait échouer un calcul juste. Et
`rawAltitudeAt` lit la cellule la plus proche quand `baseAltitudeAt` interpole
bilinéairement : les comparer revient à comparer deux choses différentes.

Après toute modification de `config/palette.json` ou de la grille, relancer
`python tools/dump_reference.py`, sinon les tests comparent à une référence périmée.

Ouvrir aussi `/test/interaction.html`. 44 enchaînements : l'application entière démarre
avec [`test/stub-map.js`](test/stub-map.js) à la place de MapLibre — substitué par une
carte d'import, le reste du code ne voit pas la différence — et le banc provoque les mêmes
événements que la vraie carte (`pinpoint`, `probeselect`, `zonevertex`…). Le balisage est
chargé depuis `index.html` lui-même : rien à tenir à jour de ce côté. Couvre le point posé
sans GPS, les quatre chemins de suppression, le tracé et la reprise d'une zone, et la
survie d'une suppression à la synchronisation.

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
| Correction manuelle | Plateau + fondu, recouvrements fusionnés | Une mesure de haut-fond dit « au moins ça, sur une surface », pas « une pointe » ; et la carte ne doit pas dépendre de l'ordre de saisie |
| Rayon d'une correction | Attaché au relevé, pas au réglage | Comme l'immersion : c'est l'étendue sur laquelle son auteur a jugé sa mesure représentative |
| Zones émergées | Locales, jamais synchronisées | Une interprétation n'a pas à voyager dans un fichier de mesures |
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
- **Deux pilotes pour une seule caméra.** Le recentrage sur le bateau (`easeTo`, 600 ms) et
  le « cap en haut » (`setBearing`) commandaient la vue chacun de leur côté. Or
  `setBearing` passe par `jumpTo`, qui commence par `stop()` : chaque mesure de boussole —
  une par image — annulait l'animation de recentrage avant qu'elle n'ait parcouru 1 % de sa
  course. Cap en haut activé, le suivi ne rattrapait plus rien, et il fallait éteindre le
  cap pour que le recentrage aboutisse. Désormais un seul ordre de caméra porte le centre
  **et** le cap ([`src/camera.js`](src/camera.js), boucle dans `src/map.js`). Règle
  générale : ne jamais mêler une animation MapLibre à un `jumpTo` périodique.
- **Afficher le dernier point GPS.** Corollaire du précédent, découvert sur l'eau : même
  recentrage réparé, la carte sursautait une fois par seconde. Le GPS ne parle qu'à 1 Hz —
  accrocher le bateau au dernier point le fait sauter de trois mètres à chaque fois, et
  accrocher la caméra dessus la fait avancer par à-coups (elle arrive en sept dixièmes de
  seconde, puis attend, immobile). On affiche donc une **estime** : entre deux points, le
  bateau avance à son cap et à sa vitesse, à chaque image ; un nouveau point n'est pas un
  saut mais un écart absorbé, à vitesse plafonnée pour que le bruit du GPS ne se traduise
  jamais par un bond. Le cap de la carte est amorti à part, sinon le tremblement de la
  boussole (±1,5°) fait vibrer le monde entier. L'estime ne sert **qu'à l'affichage** :
  profondeur lue, sondes et étalonnage restent adossés au point GPS vrai.
- **Coordonnées absolues dans une couche WebGL personnalisée.** La carte des fonds
  tremblait dès que la carte tournait, alors que les sondes — couche MapLibre native —
  restaient parfaitement fixes : c'est ce contraste qui a désigné le coupable, puisque les
  couches natives dessinent en coordonnées **locales de tuile**. Nos sommets, eux, étaient
  en mercator absolu (~0,505) dans un `Float32Array`, et le vertex shader devait calculer
  `277 414 379 × 0,5052 − 140 156 818 = −8 627` : une différence de 8,6×10³ obtenue en
  soustrayant deux nombres de 1,4×10⁸. En simple précision l'ULP y vaut 16, soit, après
  division par `w`, **18 px d'amplitude sur un tour complet**. Correction dans
  [`src/depth-layer.js`](src/depth-layer.js) : sommets relatifs au centre de la grille, et
  translation recomposée en double précision par `anchoredMatrix` — `mainMatrix` est bien
  un `Float64Array`, vérifié et non supposé. Résiduel mesuré contre `map.project()` au zoom
  19 : 0,002 px. Règle : dans une couche personnalisée, ne jamais envoyer de coordonnées
  monde absolues à un shader ; toujours ancrer localement.
- **Corrections appliquées en séquence.** `applyCorrections` reportait chaque relevé sur le
  résultat du précédent : deux points voisins se corrigeaient l'un l'autre, leurs disques
  s'additionnaient dans le recouvrement, et la carte obtenue dépendait de l'**ordre du
  tableau** — donc de l'ordre de saisie, et du hasard de la fusion avec les relevés
  distants. Le défaut ne se voyait pas sur un point isolé, ce qui l'a laissé passer.
  Règle depuis : accumuler les contributions par cellule, écrire une seule fois.
- **`window.confirm` comme garde-fou.** Chrome permet de supprimer définitivement les
  boîtes de dialogue d'une page ; l'appel renvoie alors `false` sans rien afficher, et
  toute action qui en dépendait devient muette. Sur un outil de navigation, cela veut dire
  un bouton qui ne répond plus, sans explication, au milieu du lac. Ne rien confier à
  `confirm`, `alert` ou `prompt` : la confirmation doit vivre dans l'application.
- **Une union ne sait pas supprimer.** La fusion des relevés partagés est non destructive
  par construction — c'est ce qu'on veut entre deux appareils. Mais sans mémoire des
  suppressions, elle ramène à chaque ouverture ce qu'on vient d'effacer. Toute fusion par
  union appelle des pierres tombales, sinon la suppression n'est qu'un délai.
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
