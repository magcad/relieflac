# État du projet — reprise de session

**Dernière mise à jour** : 14 août 2026
**Application en ligne** : <https://magcad.github.io/relieflac/>
**Vérifications** : <https://magcad.github.io/relieflac/test/> — 128 contrôles, tous passants
**Enchaînements** : <https://magcad.github.io/relieflac/test/interaction.html> — 44 gestes, tous passants
**Dépôt** : <https://github.com/magcad/relieflac> (public, branche `main`)

Ce document sert à reprendre le travail sans relire tout l'historique, **y compris depuis
une autre machine et un autre compte GitHub** : le § 4 part d'un dépôt fraîchement cloné et
dit ce qui dépend de l'identité du propriétaire — publication, workflows, jeton de
synchronisation — et ce qui n'en dépend pas, c'est-à-dire presque tout.

La spécification complète est dans [SPECIFICATION.md](SPECIFICATION.md) : le « pourquoi »
de chaque décision y est, avec les chiffres. Ce document-ci ne garde que l'état et les
pièges. Les deux se lisent dans cet ordre : ici d'abord, la spécification au besoin.

---

## 1. Où on en est

| Lot | Contenu | État |
|---|---|---|
| **L0** | Extraction du levé, contour, contrainte de bord, grille, cote horaire | ✅ terminé |
| **L1** | Carte, GPS, fonds coloriés en WebGL, mode Étalonnage, signalement des zones non sondées | ✅ terminé |
| **L2** | Page Paramètres | ✅ livrée avec L1 |
| **L3** | Hors ligne — Service Worker, pré-chargement des tuiles | ⬜ à faire |
| **L4** | Calage `Z_2009` confirmé, import des logs sondeur, isobathes étiquetées | 🟡 en cours |
| **L5** | Intégrer les mosaïques Quickdraw à `build_grid.py`, reconstruire, déployer | ✅ terminé le 14/08/2026 — voir § 3.5 |
| **L5 bis** | Corriger le décalage de 16 m de la mosaïque et ajouter la borne basse (trait de côte, ports) | ✅ terminé le 14/08/2026, après retour de terrain — voir § 1 |
| **L6** | Deuxième fond, **carte communautaire seule**, au choix dans l'application | ✅ terminé le 14/08/2026 — voir § 1 |
| **L6 bis** | Recalage de terrain de +2,72 m sur la carte communautaire, mesuré sur l'eau | ✅ appliqué le 14/08/2026, **non confirmé au sondeur** — voir § 1 |

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
3. **Zones émergées** (§ 4.2 quater). Contour fermé tracé au clic, dont l'intérieur est
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

**Refonte de l'interface** (14/08/2026) — l'habillage était dimensionné pour les gestes
rares (régler, corriger, étalonner) alors que barrer occupe 90 % du temps sur l'eau.
Mesuré sur un 375 × 812 : **29,4 % de la surface** occupée en permanence, dont une barre
d'actions de 56 px qui doublait le ruban de cap et une colonne de six FAB de 328 px mêlant
la caméra et l'édition. **20,3 % après.** Trois surfaces au lieu de cinq :

- **un bandeau haut** de 46 px — ruban de cap, cote à gauche en pastille compacte, état du
  GPS à droite. La cote ne montre son complément (`saisie`, l'âge d'un relevé périmé) que
  lorsqu'il change la lecture ; l'état complet est repris dans la feuille ;
- **un dock bas** de 76 px — la profondeur, sa provenance, puis sous quille et vitesse. La
  tuile « Cap » a disparu, le ruban la donnait déjà, et la place est passée dans le corps
  des deux valeurs restantes, jusque-là en 0,75 rem donc illisibles à bout de bras ;
- **un rail droit** qui ne porte plus que la caméra, et une **feuille « Outils »** à tuiles
  **libellées** pour tout le reste — ▲ et ◎ n'étaient interprétables par personne, et leur
  rendu changeait d'un appareil à l'autre.

Le **plein soleil sort renforcé** : le verre des surfaces posées sur la carte étant devenu
deux jetons (`--glass`, `--blur`), le mode se réduit à six variables surchargées au lieu
d'énumérer chaque composant — un composant ajouté demain le suivra tout seul. Les seize
emojis d'icône deviennent un sprite SVG au trait en `currentColor`, et le logo troque ses
bandes horizontales — un code-barres à 16 px — contre des isobathes concentriques
surmontées du chevron du bateau. Aucun identifiant du balisage n'a bougé : le banc d'essai
est passé sans retouche, ce qui est précisément ce qu'on lui demande.

**Le rail de caméra masquait la sortie** (14/08/2026) — signalé par l'utilisateur, capture
à l'appui : ouvrir « Relever » posait la barre de saisie par-dessus le bouton Outils, donc
par-dessus le seul moyen de ressortir du mode qu'on venait d'ouvrir. Le rail et les trois
panneaux de correction visaient le même ancrage, le dock. `stackBottomBars` mesurait déjà
la hauteur de la pile pour empiler les barres entre elles : elle la publie maintenant dans
`--stack`, que le rail ajoute à son ancrage. Quand la place manque au-dessus — petit écran
et panneau haut — le rail replie d'abord sa capsule de zoom plutôt que de glisser sous le
bandeau de cap : le pincement fait la même chose, alors que le bouton Outils n'a aucun
substitut. Vérifié à 520 px de haut : rail replié à 201 px, remonté de 179, sommet à 205 px.

**Cartographie communautaire Quickdraw exploitée** (14/08/2026) — accès à un compte
ActiveCaptain, 27 captures d'écran, et une chaîne qui les cale géographiquement sans jamais
s'appuyer sur le modèle qu'elles servent à vérifier. Trois résultats, dans l'ordre
d'importance :

1. **Le § 3.2 bis est réglé** : des dizaines de sondeurs indépendants s'accordent avec le
   modèle à ±5 % près. Le Eagle est seul à 12 %.
2. **La couverture change de nature** : 93,6 % du lac décodé à 1 m/px, contre 62,2 % à
   moins de 60 m d'une sonde en 2009. Les corrections se logent à 46 % au-delà de 60 m
   d'une sonde — soit exactement là où le levé est aveugle (§ 2).
3. **La contrainte de bord est chiffrée** : le modèle place le fond ~1,5 m trop haut dans
   la frange côtière. Sens prudent, mais mesuré pour la première fois.

**Lot L5 — l'encadrement communautaire est dans la grille** (14/08/2026). La campagne
profonde a été calée à son tour (17/17, échelles groupées à 0,84 %, accord 97 % sur les
recouvrements), sa mosaïque produite, et les deux sont devenues une **source à part entière
de `build_grid.py`** — `grid.quickdraw_source` dans `config/model.json`, pas une retouche
après coup. Règle appliquée, après le lissage comme la fusion du MNT :
`z_fond = max(z_modèle, 647,68 − dmax)`. Seule la borne basse de l'altitude sert, donc la
carte ne peut que devenir **moins profonde**, jamais plus, quelle que soit l'erreur de
calage résiduelle.

| | valeur |
|---|---|
| lac encadré | **884 ha — 94,3 %** |
| fond relevé | **128,1 ha**, dont 33,0 de plus de 3 m, maximum **17,7 m** |
| fond abaissé | **283 ha**, médiane 2,20 m — voir L5 bis, ce volet est arrivé après |
| part du lac restant aveugle | **2,2 %**, contre 37,8 % |
| volume à 647 m | 80,63 → **84,76 hm³** — le relèvement en retire, la borne basse en rend plus |

Trois décisions prises **sur mesure et non sur intuition** :

1. **La frange côtière n'est pas masquée.** On soupçonnait que le modèle y étant déjà
   ~1,5 m trop haut, le relèvement ne s'y déclencherait guère. Vérifié : la tranche 0-25 m
   du rivage est la **moins** relevée de toutes, 7,1 % de ses cellules encadrées contre 13
   à 18 % au large. Les 6,2 ha qui se relèvent quand même n'en sont que plus crédibles.
2. **La carte de fiabilité apprend un troisième état.** `coverage.png` passe en RGB :
   rouge = distance à la sonde de 2009, vert = borne communautaire, bleu = relèvement
   appliqué. Le shader et la lecture sous le bateau distinguent désormais *mesuré*,
   *encadré* et *interpolé*. Garder deux états rendait le hachurage trompeur dans l'autre
   sens — il aurait crié « non sondé » sur 94 % du lac ; l'effacer aurait menti à
   l'inverse, un encadrement n'étant pas une mesure. D'où une nuance intermédiaire :
   hachures atténuées, sans voile magenta, et « encadré — communauté ≤ N m » sans alerte.
3. **`Z_2009` et `z_ac` sont déclarés solidaires** dans `config/model.json`, chacun
   pointant sur l'autre, avec l'écart invariant (−0,32 m) et la marche à suivre le jour où
   l'un sera confirmé (§ 3.2). Sans quoi quelqu'un — nous, dans six mois — corrigerait
   l'un en oubliant l'autre, et fausserait le relèvement sans aucun signe extérieur.

**Lot L5 bis — la sortie du 14/08/2026 a trouvé deux défauts, corrigés le jour même.**
L'utilisateur a rapporté que les hauts-fonds ne tombaient pas où il les voyait, et que les
ports sortaient de l'eau. Les deux étaient fondés.

1. **La mosaïque était décalée d'environ 16 m vers l'ouest-nord-ouest.** Mesuré hors de la
   chaîne de corrélation, sur les 8 118 sondes brutes de 2009 : pour chaque sonde on lit la
   bande qui la recouvre et on vérifie que sa profondeur tombe dans l'intervalle annoncé.
   L'optimum est le même sur onze sous-ensembles disjoints, et **le gain croît avec la
   pente** — 26 % de réduction de l'écart sur fond plat, 66 % au-delà de 20 % de pente.
   Un biais vertical améliorerait tout pareillement ; du bruit n'aurait pas de direction ;
   seul un décalage horizontal fait cela. Origine probable : le calage de la vue d'ensemble
   sur le contour BD TOPO, le trait de côte du fond de carte Garmin n'étant pas celui de
   l'IGN. Correction appliquée au **mosaïquage** (`position_correction_merc` dans
   `palettes.json`), jamais au géoréférencement, pour rester rejouable sans double
   application. Résultat : écart moyen sur pente forte **0,63 → 0,33 m**, résidu nul dans
   toutes les directions, relèvement maximal ramené de 19,3 à 17,7 m.

   > Piège payé au passage : l'indice de ligne d'une image croît vers le **sud**, l'ordonnée
   > Mercator vers le **nord**. La première correction avait +15 au lieu de −15 en Y et
   > doublait l'erreur au lieu de l'annuler. Le contrôle sur les sondes l'a montré tout de
   > suite — le refaire après toute modification.

2. **La borne basse manquait, et c'est elle qui répare le trait de côte.** Une bande ne dit
   pas seulement « pas plus profond que `dmax` » : elle dit aussi « au moins `dmin` d'eau,
   puisqu'un bateau a flotté ici ». Sans elle, la couche ne pouvait rien réparer sur les
   bords, où le modèle est trop **haut** et non trop bas : la `shore_constraint` épingle une
   profondeur nulle sur le contour BD TOPO, qui est celui de la retenue normale à 650 m.
   Mesuré avant correction : fond médian **648,89 m NGF** sur les 12 premiers mètres,
   **113,7 ha émergés à la cote 647**, ports compris.

   | | avant | après |
   |---|---|---|
   | émergé à la cote 647 | 113,7 ha | **49,4 ha** |
   | émergé à la cote 648 | 67,2 ha | **17,1 ha** |
   | fond médian de la frange de 12 m | 648,89 m | **646,18 m** |
   | pente médiane de la frange 0-10 m | 79,1 % | **63,6 %** |
   | volume à 647 m | 80,63 hm³ | **84,76 hm³** |

   C'est le **seul mécanisme du modèle qui puisse annoncer plus d'eau qu'il n'y en a**, d'où
   deux garde-fous obligatoires : l'abaissement ne descend jamais sous une sonde réellement
   mesurée à moins de 25 m (le levé de 2009 garde le dernier mot là où il est passé), et il
   s'arrête 0,5 m au-dessus de la borne stricte, `z_ac` étant une valeur centrale à ±1,5 m
   et non une précision. 283 ha abaissés, médiane 2,20 m.

**Deux prix à connaître.** D'abord le **terrassement** : une source en bandes produit des
paliers plats, et la surface concernée passe de 121 à 404 ha — 20 altitudes couvrent 95,6 %
des zones abaissées. C'est la forme honnête de la donnée, pas un défaut de calcul, mais cela
se voit sur les courbes de niveau. Ensuite, **une vérification sur 128 échoue** :
« épaisseur des contours constante d'un zoom à l'autre », 1,55 d'écart pour un seuil de 1,5,
au point de sonde 45,79884 / 1,84400. Le shader n'a pas changé ; ce sont les isobathes qui
s'y resserrent depuis que la zone est terrassée, et la mesure fusionne des traits voisins.
Le seuil n'a **pas** été desserré pour faire passer le test.

**Ce que ces deux défauts enseignent.** Aucun n'était visible depuis le dépôt : le premier
demandait de confronter la couche à une source indépendante, le second de savoir à quoi
ressemble un port en août. Le relèvement seul avait été jugé « prudent » sans qu'on
remarque qu'il rendait la couche **inopérante là où le modèle se trompe le plus**. La leçon
n'est pas « il fallait mieux vérifier » mais : une doctrine de sécurité formulée dans un
seul sens ne protège que dans ce sens-là.

Le canal bleu rend la couche **retirable d'un seul geste** : `quickdraw_source.enabled` à
`false` reconstruit la grille sans elle, et les deux canaux disent, sans recalcul, ce
qu'elle avait changé et de combien. Il est devenu **signé** — 128 = aucun changement,
au-dessus relèvement, en dessous abaissement, par pas de 0,2 m — puisque la couche peut
désormais faire descendre le fond. C'est l'obligation de licence du § 3.5, honorée en même
temps que le code et non après. **Ce que ça donne à l'écran n'a pas pu être vu par
l'assistant** — page masquée, MapLibre ne s'initialise pas : cela se valide sur l'eau.

**Lot L6 — deux cartes, au choix** (14/08/2026, dans la foulée de L5 bis). Demande de
l'utilisateur, et elle vient du terrain : beaucoup de plaisanciers du lac naviguent **à la
carte Garmin seule** et se contentent de retrancher la baisse par rapport à la cote
normale. Ils n'ont aucune raison de faire confiance à un levé de 2009 qu'ils n'ont pas vu,
et le dépôt leur devait une carte qu'ils reconnaissent, où rien d'autre n'entre.

`tools/build_grid_quickdraw.py` produit donc un **second fond complet** — `bed_quickdraw.png`,
`bed_quickdraw.json`, `coverage_quickdraw.png` — sans une seule sonde de 2009 : ni
triangulation, ni contrainte de bord, ni `shoal_bias`. Le réglage « Source du fond » bascule
de l'un à l'autre, et **les relevés manuels s'appliquent sur celui qui est affiché**, ce qui
ne demande aucun travail supplémentaire : un relevé porte une altitude absolue.

*La difficulté n'est pas de décoder les bandes, c'est de choisir une valeur par cellule.*
Une bande ne donne jamais une profondeur, seulement un intervalle. Prendre le fond de
l'intervalle trahirait la doctrine du dépôt ; prendre le sommet partout donne un escalier de
plateaux, et un fond en marches **n'a plus de gradient** — le contour de sécurité, calculé
par `fwidth` dans le shader, disparaît dès que le seuil du bateau tombe entre deux paliers.
Une carte qui n'affiche plus sa limite de sécurité là où elle compte est pire que terrassée.

D'où la **détente sous contrainte** : partir du sommet de l'encadrement, lisser, replier
dans l'encadrement, recommencer. Quel que soit le nombre de passes, la sortie reste dans la
bande d'entrée — le lissage ne peut rien inventer, il choisit seulement, parmi les surfaces
que la communauté autorise, celle qui a un gradient. C'est la reconstruction classique d'un
relief à partir de ses isobathes, la contrainte étant ici un encadrement et non une courbe.
Zéro itération redonne l'escalier. Vérifié à la construction *et* dans `/test/` : aucune
cellule ne sort de sa bande.

| | levé 2009 + apports | communauté seule |
|---|---|---|
| surface décrite | 100 % du lac | **94,3 %** encadrés, 45 ha laissés **vides** |
| cellules à fond plat | 25,1 % | **22,0 %** |
| altitudes distinctes | 3 312 | **2 485** |
| pente médiane du fond | 3,24 % | **3,26 %** |
| émergé à la cote 647, **avant** recalage | 49,4 ha | 29,1 ha |
| émergé à la cote 647, **après** recalage | 49,4 ha | **5,1 ha** |

**Telle que construite**, avant recalage, elle s'accordait avec le fond du levé à moins de
2 m sur **80 %** du lac, à moins d'1 m sur 54 %, et les deux se confondaient au-delà de 10 m
(médiane 0,00 m). Elles ne divergeaient que sur la frange, de ~0,8 m, la communautaire
n'ayant ni contrainte de bord ni généralisation vers le haut-fond. Seul recul net : la fosse
la plus profonde, lue 21 m au lieu de 28, la bande la plus profonde de la palette s'arrêtant
à 30 m.

**Recalage de terrain du 14/08/2026 : +2,72 m sur le fond issu des bandes.** Mesuré sur
l'eau par l'utilisateur, qui a comparé le trait de côte de cette carte à celui qu'il avait
sous les yeux. `quickdraw_only.datum_offset_m` dans `config/model.json`.

Le chiffre a un sens physique, et c'est ce qui le rend crédible : le plan d'eau de référence
passe de 647,68 à **650,40 m NGF**, soit la **cote de retenue normale du lac à 40 cm près**.
C'est exactement ce que l'utilisateur avait décrit en ouvrant le sujet — les plaisanciers qui
naviguent au traceur lisent la carte Garmin comme des profondeurs rapportées au niveau NGF
normal, dont ils retranchent la baisse du jour. La mesure de `z_ac` du § 3 d'`ANALYSE.md`,
elle, a été faite en comparant les isobathes communautaires au modèle de 2009 : elle hérite
donc de l'incertitude de `Z_2009`, non confirmée.

Le décalage entre **là où `z_ac` entre en jeu**, donc avant la détente et avant la fusion du
MNT. Les altitudes du MNT sont absolues, mesurées par avion, et n'ont rien à voir avec la
référence des sondeurs de la communauté : un îlot reste où il est, seul le fond issu des
bandes se déplace. Ne touche **que** cette carte, jamais le fond du levé.

| à la cote du jour (646,68 m) | levé 2009 | communauté, recalée |
|---|---|---|
| émergé | 69,8 ha | **136,7 ha** |
| surface en eau | 8,67 km² | 7,55 km² |
| profondeur maximale | 28,5 m | 18,3 m |
| écart médian, 10-20 m de fond | — | **+3,05 m** (moins d'eau) |

> **Ce que ce chiffre ne tranche pas.** Remonter le fond de 2,72 m et baisser la cote du lac
> de 2,72 m donnent à l'écran **exactement le même dessin**, et rien dans le dépôt ne
> distingue les deux. Ce qui plaide **pour** : 650,40 tombe sur la retenue normale, ce qui
> est une explication et non un ajustement libre. Ce qui plaide **contre** : au large, entre
> 10 et 20 m de fond, les deux cartes se confondaient **à 0,00 m près sur 267 ha** avant
> recalage — un décalage de datum aurait dû s'y voir dès le premier jour. Contre-épreuve
> d'une minute, sur l'eau : saisir la cote à la main, **−2,72 m** par rapport à celle d'EDF,
> et regarder si les **deux** cartes tombent alors juste. Si oui, l'erreur est sur la cote
> et le recalage doit être retiré d'ici pour être porté là, où il corrigera les deux cartes.
>
> Le recalage va cette fois dans le sens **prudent** — 2,5 m d'eau de moins que le levé —
> mais un excès de prudence cache de l'eau navigable, et la fosse principale tombe à 18 m au
> lieu de 28. La mise en garde est écrite dans les Paramètres et dans « À propos ».
>
> **Conséquence à examiner si le recalage se confirme** : la borne basse du lot L5 bis
> (`quickdraw_source.lower_bound`) est calée sur `z_ac` = 647,68. Si la bonne valeur est
> 650,40, elle a abaissé la frange du fond du levé d'environ 2,7 m de trop — et les 295 ha
> abaissés sont à reprendre.

**Banc d'essai des enchaînements** (13/08/2026) : `test/interaction.html`. Il démarre la
**vraie** application avec une carte factice ([`test/stub-map.js`](test/stub-map.js))
substituée à MapLibre par une carte d'import, et provoque les mêmes événements que la vraie
carte. C'est ce banc qui a reproduit les deux défauts ci-dessus, qu'aucune vérification de
module ne pouvait voir : elles étaient dans le câblage, entre un bouton et un état.

L'application est utilisable sur l'eau. Son **rendu cartographique** n'a toujours pas été
vu fonctionner par l'assistant : l'environnement de test a une page masquée, où
`requestAnimationFrame` est suspendu et MapLibre ne s'initialise pas (revérifié le
13/08/2026 : 0 image en 2 s). Les enchaînements de l'interface, eux, sont vérifiables sans
lui, et les positions le sont par mesure du DOM — c'est ainsi qu'a été contrôlé le
recouvrement du bouton Outils, dans les six états de la pile du bas.

La conséquence pratique tient en une phrase : **ce qui se voit à l'écran ne se valide
qu'auprès de l'utilisateur.** Une capture d'écran de sa part a suffi à désigner le défaut
du rail là où aucune vérification automatique ne l'aurait montré. Refonte de l'interface et
rail confirmés par lui le 14/08/2026, sur l'eau et sur iPhone.

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

**Confirmé par une source indépendante, puis largement comblé, le 14/08/2026.** La
cartographie communautaire Quickdraw (§ 3.5) dit le fond plus haut que le modèle sur
**137,4 ha**, dont 36,0 ha de plus de 3 m et jusqu'à 19,3 m. Le défaut est bien là où le
levé ne voit rien — c'est mesuré, plus seulement déduit — et il est désormais **corrigé
dans la grille publiée** (lot L5).

Le tableau ci-dessus reste vrai : il décrit le levé de 2009, qui n'a pas changé. Ce qui a
changé est la part du lac où **aucune** source ne dit rien :

| | avant | après |
|---|---|---|
| mesuré à moins de 60 m d'une sonde, ou encadré par la communauté | 62,2 % | **97,6 %** |
| **aveugle** | **37,8 %** | **2,4 %** |

*Encadré n'est pas mesuré* : la communauté donne une bande (« entre 4 et 6 m »), pas une
profondeur au décimètre. C'est pourquoi la carte distingue maintenant trois états et non
deux — voir § 6.1 bis de la spécification.

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

**Et ne pas oublier `z_ac`.** La cote Quickdraw de 647,68 m (§ 3.5) a été mesurée en
comparant les isobathes communautaires à ce modèle-ci, donc à `Z_2009` = 648,0. Les deux
sont **solidaires** : les corriger séparément fausse le relèvement communautaire sans aucun
signe extérieur. L'énoncé invariant, lui, ne dépend de rien — *la surface Quickdraw est
0,32 m sous le plan d'eau du jour du levé OFB*. La règle et la marche à suivre sont écrites
dans `config/model.json` (`solidary_with`, `solidarity_note`, `confirmation_procedure`),
là où on les lira au moment de changer la valeur.

### 3.2 bis Le sondeur Eagle sous-lit d'environ 10 % — **tranché le 14/08/2026**

**Réglé par la cartographie communautaire Quickdraw** : elle vient de dizaines de
sondeurs indépendants, qui ne peuvent pas partager le défaut d'étalonnage d'un
Eagle. Comparée au modèle sur neuf isobathes, au large, elle s'accorde avec lui à
**±5 % près**, alors que le Eagle en diffère de 12 %. **Le sondeur du bord est
seul en cause, le modèle est indemne.** Le *bar check* reste souhaitable pour
fixer le facteur, il n'est plus bloquant. Analyse complète :
[`data/mesuresEtalonnage/Garmin/ANALYSE.md`](data/mesuresEtalonnage/Garmin/ANALYSE.md).

Piège à ne pas refaire : la première mesure, prise sur **tout** le lac, annonçait
17 % d'écart d'échelle et semblait accuser le modèle. C'était la contrainte de
bord — `shore_constraint` épingle une profondeur nulle sur un trait de côte de
cote haute. Toute comparaison d'isobathes avec ce modèle doit écarter la frange
côtière, sinon elle mesure la contrainte de bord et rien d'autre.

Historique de la découverte, ci-dessous.

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

**Piste Garmin rouverte le 14/08/2026, par un autre chemin, et intégrée le jour même.** Le
format on-device (`ContoursLog.svy` + grilles propriétaires) reste indécodable par tout
outil public, et c'est sans importance : la couche communautaire s'exploite par **capture
d'écran géoréférencée**. La légende donne l'intervalle exact de chaque couleur et les
couleurs sont plates, donc une capture est une carte de bandes décodable sans ambiguïté.
Ce n'est donc plus une impasse : c'est la troisième source du modèle.

Fait, **intégré à la grille**, en **deux campagnes** — un dossier de captures et une
palette chacune, déclarées dans `data/mesuresEtalonnage/Garmin/palettes.json` :

| Campagne | Captures | Plage | Ce qu'elle apporte |
|---|---|---|---|
| `0-12m` | 27 | 0 à 12 m, 10 bandes | 25 calées à NCC 0,95–0,99, mosaïque 8 806 × 6 913 px à 1 m/px, **93,6 % du lac** décodé — contre 62,2 % à moins de 60 m d'une sonde en 2009 |
| `12_30m` | 17 | 12 à 30 m, 6 bandes | comble le seul angle mort de la première : sa bande 12–30 m ne contraignait rien, donc tout le bassin ouest était muet. 17/17 calées, échelles groupées à 0,84 %, accord 97,0 %, 326 ha décodés |

Cote de référence mesurée : **647,68 m NGF**, solidaire de `Z_2009` (§ 3.2). Effet obtenu
sur la grille publiée : **137,4 ha relevés**, dont 36,0 de plus de 3 m, jusqu'à 19,3 m —
dont 40 ha apportés par la seule campagne profonde.

**Piège de conception** : les couleurs se recyclent d'une campagne à l'autre. `(0,197,255)`
vaut 12–30 m dans `0-12m` et 12–14 m dans `12_30m`. Décoder avec la mauvaise palette produit
une carte fausse **sans aucun signe extérieur** — d'où `palettes.json` et l'argument
`campaign` obligatoire sur les deux outils.

Méthode, mesures, produits et protocole de capture :
[`data/mesuresEtalonnage/Garmin/ANALYSE.md`](data/mesuresEtalonnage/Garmin/ANALYSE.md),
outils `tools/qd_georef.py` et `tools/qd_mosaic.py`.

**La licence, tranchée puis honorée** : la donnée appartient à Garmin et à sa communauté,
sous CGU interdisant la redistribution, sans licence ouverte. L'utilisateur a décidé le
14/08/2026 de **publier quand même la grille dérivée**. Les trois obligations qui en
découlaient sont remplies, en même temps que le code et non après :

- la ligne de source porte « Communauté Quickdraw (Garmin / ActiveCaptain) — **usage
  dérivé, pas de licence ouverte** », dans `README.md`, au § 7 ci-dessous, au § 12 de la
  spécification, et dans la page « À propos » de l'application — c'est là que le lecteur la
  verra ;
- le présent § est réécrit : la piste n'est plus une impasse, la voie retenue est la
  capture d'écran géoréférencée, et la restriction porte sur la redistribution — que nous
  faisons, en connaissance de cause ;
- la couche est **identifiable cellule par cellule** dans `data/coverage.png` (canal vert :
  la borne ; canal bleu : le relèvement appliqué), donc retirable d'un seul geste —
  `quickdraw_source.enabled: false`, puis `build_grid.py`.

Voie complémentaire, inchangée : **saisie manuelle** (§ L4 ci-dessus, `src/probes.js`), le
sondeur du bord étant un Eagle sans export. Ces points-là sont librement rediffusables.

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

### Reprise à froid, sur une autre machine

Le dépôt se suffit à lui-même : la grille bathymétrique (`data/bed.png`, `bed.json`,
`coverage.png`), le levé, le contour et la cote sont **versionnés**. Un clone et un serveur
statique suffisent à voir l'application marcher — rien à reconstruire, rien à générer.

```bash
git clone https://github.com/magcad/relieflac.git
cd relieflac
python tools/serve.py 8123
```

Puis ouvrir <http://localhost:8123>. Il faut **du réseau** : les fonds de carte viennent du
WMTS de l'IGN et ne sont pas embarqués.

Prérequis réels, par usage :

| Pour | Il faut |
|---|---|
| Faire tourner l'application et les vérifications | Python 3 (pour `tools/serve.py`) et un navigateur récent |
| Reconstruire le modèle bathymétrique | Python 3.12 + `numpy scipy shapely pyproj Pillow` |
| Lire les PDF de source (levé 2011, rapports) | en plus : `pypdf pdfplumber` |
| Remettre à jour MapLibre dans `vendor/` | Node (`npm install`, puis `tools/vendor_maplibre.py`) |
| Piloter le dépôt en ligne d'action | `gh`, authentifié — sinon `git` seul suffit |

Ce qui **n'est pas** dans le dépôt et se retélécharge : `data/rge_alti.npy` (4,9 Mo,
`tools/fetch_rge_alti.py`), `.cache/` (archives sources, 14 Mo pour le seul fichier OFB),
`node_modules/`. Aucun n'est nécessaire pour faire tourner l'application.

Il n'y a **aucune étape de construction** : ce sont des modules ES natifs, le code lu est
le code exécuté.

### Comptes et droits — ce qui change si ce n'est pas `magcad`

Le compte GitHub d'origine est **`magcad`**, propriétaire de `magcad/relieflac` (public,
branche `main`, publié par GitHub Pages sous `https://magcad.github.io/relieflac/`).
Rien dans l'application ne dépend d'une identité : tout est public en lecture. Ce qui
change avec un autre compte tient en trois points.

**1. Publier le site.** Pousser sur `main` déclenche le déploiement Pages. Sans droit
d'écriture sur `magcad/relieflac`, il faut un **fork** ou un dépôt neuf, puis activer Pages
dessus (source : branche `main`, dossier racine). Le fichier `.nojekyll` à la racine est
indispensable — sans lui, Jekyll réécrit le site et renvoie un 404.

**2. Les deux workflows** (`.github/workflows/`) tournent avec le `GITHUB_TOKEN` fourni
automatiquement par Actions : rien à configurer, ils suivent le fork.

| Workflow | Déclenchement | Ce qu'il fait |
|---|---|---|
| `level.yml` | horaire (`7 * * * *`) + manuel | relève la cote EDF côté serveur — l'API n'a **aucun** en-tête CORS, donc inappelable depuis la page — et commite `data/level.json` |
| `build-bathy.yml` | manuel | reconstruit la grille et commite `data/` |

Conséquence pratique : `main` reçoit des commits tout seul, toutes les heures. **Toujours
`git pull --rebase` avant de pousser**, et lire la sortie de `push` (voir § 6).

**3. La synchronisation des relevés.** Les sondes saisies dans l'application sont
publiées dans `data/corrections/vassiviere.json` par l'API GitHub, depuis le navigateur.
Modèle « le propriétaire écrit, tout le monde lit » : le jeton d'écriture ne peut pas être
partagé, puisque le code est lisible par tous.

- **Sans jeton** — le cas de tout visiteur — l'application lit les relevés publiés et
  fonctionne normalement. Les sondes saisies restent locales, et l'écran de synchronisation
  affiche « lecture seule ».
- **Avec jeton**, l'appareil peut publier. Créer un *fine-grained personal access token*
  limité au seul dépôt, permission **Contents : read and write**, puis le coller dans
  Paramètres → Synchronisation. Il est rangé sous `relieflac.token.v1` dans le stockage
  local du navigateur, n'est **jamais** exporté avec le profil, et n'apparaît nulle part
  dans le dépôt.
- Pour viser **un autre dépôt** (fork, autre plan d'eau), changer les valeurs par défaut
  `syncRepo`, `syncPath` et `syncWaterbody` dans [`src/settings.js`](src/settings.js). Le
  format de fichier est générique (`schema`, `waterbody`, `datum`) et resservira tel quel.

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
python tools/qd_georef.py 0-12m         # captures Quickdraw → georef_0-12m.json (~30 min)
python tools/qd_mosaic.py 0-12m         # → mosaique_0-12m.png
python tools/qd_georef.py 12_30m --min-ncc 0.50   # campagne profonde (~30 min)
python tools/qd_mosaic.py 12_30m --min-ncc 0.50
python tools/build_grid.py              # tout → data/bed.png, bed.json, coverage.png
python tools/build_grid_quickdraw.py    # fond communautaire seul → data/bed_quickdraw.*
python tools/dump_reference.py          # → test/reference.json, requis par les tests
python tools/preview_grid.py            # contrôle visuel → data/preview.png
python tools/preview_grid.py --quickdraw  # le même, pour le fond communautaire
```

`build_grid_quickdraw.py` doit tourner **après** `build_grid.py` — non pour lui emprunter
sa grille, dont il refait la géométrie par la même fonction, mais pour pouvoir chiffrer
l'écart entre les deux cartes, qui est le seul chiffre utile à qui bascule de l'une à
l'autre. Les deux fonds **doivent partager la maille au pixel près** : l'application les
échange tableau contre tableau, et un pixel d'écart ne se verrait sur aucune image tout en
décalant toutes les profondeurs. `BedGrid.useSource` le vérifie plutôt que de le supposer.

`data/rge_alti.npy` (4,9 Mo) n'est pas versionné : `fetch_rge_alti.py` le retélécharge.
`build_grid.py` échoue proprement sans lui, en signalant quoi lancer. Les quatre étapes
`qd_*` sont facultatives — leurs produits sont versionnés — et le **nom de campagne y est
obligatoire** : les couleurs se recyclent d'une palette à l'autre, et décoder avec la
mauvaise donne une carte fausse sans aucun signe extérieur (§ 3.5).

### Outils de diagnostic

| Script | Ce qu'il répond |
|---|---|
| `check_coverage.py` | Où le modèle interpole plutôt que de mesurer — carte + rapport par trou |
| `find_shoals.py` | Hauts-fonds mesurés par le LiDAR mais absents du levé |
| `check_shoreline_level.py` | À quelle cote correspond le trait de côte BD TOPO |
| `compare_palettes.py` | Rendu des préréglages côte à côte, à une cote donnée |

### Vérifications

Ouvrir `/test/`. 138 contrôles : table de couleurs comparée à la référence Python,
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

Ouvrir aussi `/test/interaction.html`. 47 enchaînements : l'application entière démarre
avec [`test/stub-map.js`](test/stub-map.js) à la place de MapLibre — substitué par une
carte d'import, le reste du code ne voit pas la différence — et le banc provoque les mêmes
événements que la vraie carte (`pinpoint`, `probeselect`, `zonevertex`…). Le balisage est
chargé depuis `index.html` lui-même : rien à tenir à jour de ce côté. Couvre le point posé
sans GPS, les quatre chemins de suppression, le tracé et la reprise d'une zone, la survie
d'une suppression à la synchronisation, et la **bascule d'un fond à l'autre** — prouvée non
par le libellé affiché mais en posant deux fois la même sonde au même point et en comparant
l'altitude que le modèle annonce dessous (642,65 m NGF sur le levé, 645,33 sur la carte
communautaire — le point de contrôle a dû être déplacé, le précédent étant tombé, le temps
d'une version, à 3 cm près sur les deux cartes).

Ce banc tourne sur la **même origine** que l'application, donc sur ses vraies données : il
met de côté toutes les clés `relieflac.*` du stockage local — jeton compris, sans quoi une
sonde d'essai partirait vers le dépôt comme une vraie — et les restitue à la fin, même en
cas d'échec ou de page quittée en route. Le rapport le confirme en dernière ligne.

### Déployer

Pousser sur `main` **est** le déploiement : GitHub Pages reconstruit le site dans la
minute. Trois gestes, dans cet ordre, et aucun n'est facultatif :

```bash
git pull --rebase          # le workflow horaire a commité entre-temps
git push origin main       # LIRE la sortie : un rejet est silencieux si on la masque
gh run list --limit 1      # attendre « completed success »
```

Avant de pousser, **monter les deux numéros de version** — `VERSION` dans
[`src/version.js`](src/version.js) et `CACHE` dans [`sw.js`](sw.js). C'est le seul moyen de
savoir, depuis le téléphone, si la version installée est bien la nouvelle : le numéro
s'affiche dans Paramètres, et le bouton « Recharger la dernière version » purge les caches.
Sans cette montée, un iPhone peut resservir l'ancienne version indéfiniment.

Contrôles après déploiement, qui prennent trente secondes :

```bash
curl -s https://magcad.github.io/relieflac/src/version.js | tail -1
```

puis ouvrir <https://magcad.github.io/relieflac/test/> et
<https://magcad.github.io/relieflac/test/interaction.html> — les deux doivent afficher le
même compte qu'en local.

**Piège du préfixe** : le site est servi à la **racine** en local et sous **`/relieflac/`**
sur Pages. Toute adresse absolue (`/src/...`) marche ici et casse là-bas. C'est ce qui a
mis le banc d'essai hors service à sa première mise en ligne ; il utilise désormais une
base relative (`<base href="../">`), y compris pour les clés de sa carte d'import.

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
| Encadrement communautaire | Relèvement seul, `max(z_modèle, 647,68 − dmax)` | On n'utilise que la borne basse de l'altitude : une erreur de calage ou une contribution prise à basse cote ne peut alors que remplir le lac, jamais le creuser |
| Agrégation des bandes Quickdraw | Le minimum du bloc de 5 m, pas la médiane | Le désaccord entre captures se loge aux frontières de bande : prendre le minimum dilate le haut-fond d'une cellule, ce que la généralisation fait déjà volontairement à 15 m |
| La couche communautaire peut **abaisser** le fond | Oui, partout, avec deux garde-fous | Décision de l'utilisateur le 14/08/2026, après une sortie où les ports apparaissaient à sec. Le relèvement seul ne pouvait rien réparer sur les bords, où le modèle est trop haut : la couche y était inopérante par construction. Garde-fous : jamais sous une sonde mesurée à moins de 25 m, et arrêt 0,5 m au-dessus de la borne stricte |
| Position de la couche communautaire calée sur le levé de 2009 | Oui, translation unique mesurée sur les 8 118 sondes | Le calage sur le contour BD TOPO laissait 16 m d'erreur. Conséquence assumée : la **position** de la couche n'est plus indépendante du modèle ; sa **profondeur**, elle, le reste, et c'est elle qui sert de contrôle |
| Carte de fiabilité | Trois états — mesuré, encadré, interpolé | Un encadrement n'est pas une mesure, mais ce n'est plus une interpolation : les deux mensonges opposés sont également graves |
| Deux fonds au lieu d'un | Levé 2009 **ou** carte communautaire seule, au choix dans l'application | Demande de l'utilisateur le 14/08/2026 : beaucoup naviguent à la carte Garmin seule et n'ont pas de raison de croire un levé qu'ils n'ont pas vu. Aucune des deux ne remplace l'autre — l'une mesure au décimètre le long de ses traces, l'autre encadre 94 % du lac. Les deux partagent la maille, d'où une bascule instantanée et des relevés manuels valables pour les deux |
| Valeur d'une cellule sur le fond communautaire | Détente sous contrainte, départ au sommet de l'encadrement | Une bande donne un intervalle, pas une profondeur. L'escalier de plateaux fait **disparaître le contour de sécurité** (plus de gradient à donner à `fwidth`) ; la détente rend un gradient partout sans jamais sortir de l'encadrement d'entrée |
| Trous de la carte communautaire | Laissés vides, jamais extrapolés | 45 ha où personne n'est passé. C'est le seul endroit où cette carte est inconfortable, et c'est aussi le seul où elle est parfaitement honnête |
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
- **Deux surfaces flottantes, un seul ancrage.** Le rail de caméra et les trois panneaux de
  correction se calaient tous sur le bas du dock. Chacun était juste ; ensemble, la barre
  de saisie recouvrait le bouton Outils — c'est-à-dire le seul moyen de quitter le mode
  qu'on venait d'ouvrir. Le défaut ne se voit sur aucun écran isolé, seulement dans la
  combinaison, et il enferme l'utilisateur au lieu de le gêner. Règle depuis : dès que deux
  éléments flottants partagent un bord d'écran, **une seule mesure** commande leur pile
  (ici `stackBottomBars` → `--stack`), et l'on prévoit ce qui cède quand la place manque —
  un contrôle qui a un substitut (le zoom, remplacé par le pincement) cède avant un
  contrôle qui n'en a pas.
- **Une transition sur `bottom`.** Elle n'est pas accélérée, saccade sur téléphone, et fige
  à sa valeur de départ dans une page masquée — donc la mesure de position depuis le banc
  d'essai lisait l'ancien emplacement et donnait un correctif pour mort. Sur un geste qui
  doit être franc, pas d'animation.
- **Un canal ajouté à une texture, et un écrivain resté sourd.** `coverage.png` porte
  désormais trois grandeurs au lieu d'une. Le chargement les lisait bien, mais
  `#uploadCoverage` — appelé à chaque correction manuelle pour renvoyer la texture au GPU —
  recopiait toujours la distance dans les trois canaux, écrasant la borne communautaire. Le
  défaut ne se voyait pas au démarrage, puisque la texture initiale vient du fichier : il
  n'apparaissait qu'**après la première correction**, où le hachurage revenait à deux
  états. Règle : quand une donnée existe en deux exemplaires — le fichier et le tampon
  réécrit — tout canal ajouté à l'un doit l'être à l'autre dans le même geste.
- **Collision de noms dans `build_grid.py`.** `coverage` désignait déjà le taux de
  cellules valides.

---

## 7. Sources et licences

| Donnée | Source | Licence |
|---|---|---|
| Bathymétrie | [OFB — Bathymétrie plans d'eau](https://data.eaufrance.fr/jdd/c31746f7-311a-41c7-b995-6cb78a2ddc25), levé du 22/04/2009, entité `L0115203` | Licence Ouverte 2.0 |
| Encadrement des fonds | Communauté **Quickdraw** (Garmin / ActiveCaptain), 42 captures calées sur 44 | **usage dérivé, pas de licence ouverte** — voir § 3.5 |
| Cote du lac | EDF — `https://mariviereetmoi.edf.fr/api/v5/practicabilities/31856100` | usage informatif, sans CORS |
| Contour | IGN BD TOPO® V3, WFS `data.geopf.fr`, `CQL_FILTER=toponyme LIKE '%Vassivi%'` | Etalab 2.0 |
| Altimétrie | IGN RGE ALTI®, WMS BIL float32 `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES` | Etalab 2.0 |
| Fonds de carte | IGN Géoplateforme WMTS — `PLANIGNV2` et `ORTHOIMAGERY.ORTHOPHOTOS` | Etalab 2.0 |

Seuils de navigation EDF : **interdite sous 642 m NGF**, délicate 642–643, retenue
normale 650, crête du barrage 652,90.
