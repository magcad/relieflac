# Cartographie communautaire Quickdraw — analyse et calage

Travail du 14 août 2026. **Intégré au modèle le jour même (lot L5, § 10)** : les
deux mosaïques sont désormais une source à part entière de `tools/build_grid.py`,
au même titre que le levé de 2009 et le MNT. Ce document conserve la méthode, les
mesures et les produits intermédiaires ; ce qui a été décidé et mesuré à
l'intégration est au § 10.

Point de départ : accès à un compte ActiveCaptain donnant la couche
**Communauté Quickdraw** sur le lac, alimentée par les pêcheurs qui le
parcourent quotidiennement.

## 0. Deux campagnes, deux palettes

Une **campagne** est un dossier de captures et une palette, déclarés dans
[`palettes.json`](palettes.json). Les deux outils prennent le nom de la campagne
en argument obligatoire.

| Campagne | Dossier | Captures | Plage | Bandes |
|---|---|---|---|---|
| `0-12m` | `Carte_0-12m/` | 27 | 0 à 12 m | 10, dont 0,5 m sous 2 m |
| `12_30m` | `Carte_12_30m/` | 17 | 12 à 30 m | 6 |

La seconde comble le seul angle mort de la première : sa bande 12–30 m ne
contraignait rien, si bien que tout le bassin ouest — le plus profond — était
muet. Dans les captures profondes, tout ce qui est au-dessus de 12 m passe en
ombrage de relief, donc n'est pas une couleur plate et se trouve exclu tout
seul : les deux campagnes se complètent sans se recouvrir.

> **Piège, et il est silencieux.** Les couleurs se recyclent d'une campagne à
> l'autre. `(0,197,255)` vaut **12–30 m** dans `0-12m` et **12–14 m** dans
> `12_30m`. Décoder une capture avec la mauvaise palette produit une carte
> fausse sans le moindre signe extérieur — pas d'erreur, pas de pixel manquant,
> juste des profondeurs inventées. D'où `palettes.json`, et l'argument
> `campaign` obligatoire plutôt qu'une constante de module.

### Caler une campagne sur une autre quand aucune couleur n'est partagée

Une capture profonde ne peut pas se caler par ressemblance de bandes sur la
campagne fine : les deux palettes sont disjointes. Elle se cale sur un
**masque** commun — « plus profond que 12 m », qui est à la fois la dernière
bande de `0-12m` et la réunion de toutes les bandes de `12_30m`. C'est le seul
signal partagé, et il suffit. Voir `reference_from_mosaic` dans `qd_georef.py`.

Conséquence à connaître : sur un masque binaire, le NCC plafonne bien plus bas
que sur un motif de bandes — médiane **0,750** ici (0,600 à 0,923) au lieu de
0,96. **Ce n'est pas un mauvais calage** ; le seuil de 0,90 ne s'applique qu'au
mode « bandes ». Les preuves sont ailleurs, et elles sont trois :

| Contrôle | Résultat |
|---|---|
| dispersion des échelles trouvées indépendamment sur les 17 captures | **0,84 %** (0,6086 à 0,6310 m/px) |
| accord entre captures qui se recouvrent, campagne `12_30m` | **97,0 %** — contre 88,1 % pour `0-12m`, qui mêle des captures de résolutions très différentes |
| surface plus profonde que 12 m, vue par chaque campagne | **309 ha** selon `0-12m` (sa bande 12–30), **326 ha** selon `12_30m` (toutes bandes) |

Et le recoupement géométrique des deux : **91,1 %** de la couverture `12_30m`
tombe dans la zone « > 12 m » de `0-12m`, et **96,1 %** de cette zone est
couverte par `12_30m`. Deux palettes disjointes, deux modes de calage
différents, un accord au ras de la dizaine de mètres — c'est ce qui valide la
méthode du masque, bien mieux qu'un NCC.

Les 17 captures sont calées, `georef_12_30m.json` et `mosaique_12_30m.png`
écrits. Cette campagne décode **326 ha, soit 35 % du lac** — la part profonde,
et c'est exactement ce qu'on lui demande.

---

## 1. Il n'existe aucune référence verticale publiée

Quickdraw enregistre la **profondeur lue par le sondeur au moment du passage**,
corrigée seulement par ce que le contributeur avait réglé sur son propre
appareil. Garmin ne connaît pas la cote EDF et rien dans sa documentation ne
décrit une normalisation côté serveur. La preuve la plus nette est dans le
manuel lui-même : il existe **trois** décalages distincts, dont un réservé aux
cartes communautaires (*Comm. Display Offset*, « for maps downloaded from the
Garmin Quickdraw Community »). Ce réglage n'existerait pas si la donnée
communautaire avait une référence commune. Navionics, pourtant du même groupe,
fait l'inverse et estime l'offset de chaque flux avant de les fusionner.

La cote de référence est donc une **inconnue à mesurer**, de même nature que
`Z_2009`. Le régime EDF joue en notre faveur : le lac est tenu à 647 m NGF du
1ᵉʳ avril au 31 août, période où les pêcheurs sont sur l'eau. Et l'erreur
résiduelle va dans le bon sens — une contribution prise en novembre à 643 m,
interprétée comme prise à 647, place le fond 4 m trop haut, donc annonce moins
d'eau qu'il n'y en a.

---

## 2. Géoréférencement

Méthode dans [`tools/qd_georef.py`](../../../tools/qd_georef.py), solution
conservée dans [`georef.json`](georef.json) — c'est le fichier coûteux à
reproduire (une trentaine de minutes de calcul).

La légende donne l'intervalle exact de chaque couleur, et les couleurs sont
plates : une capture est donc une **carte de bandes décodable sans ambiguïté**.

- **Vue d'ensemble** → calée sur le contour BD TOPO, échelle *et* translation
  ajustées sur les seuls pixels certains (kaki = terre, couleur de palette =
  eau). **98,3 % d'accord** sur 745 000 pixels. Surface du lac recalculée depuis
  la capture : 935 ha, cohérente avec le contour.
- **Vues de détail** → calées sur la vue d'ensemble par corrélation croisée
  normalisée masquée (FFT), l'échelle étant cherchée en même temps que la
  translation. **NCC 0,95 à 0,99** sur 25 captures.

Deux points de méthode qui comptent :

- la référence est toujours **une autre capture**, jamais le modèle
  bathymétrique : le calage reste indépendant de ce que la comparaison cherche
  à vérifier ;
- la **barre d'échelle n'est pas utilisée**. Elle s'est révélée juste à 0,2 %
  près, mais sa longueur en pixels est impossible à mesurer de façon fiable —
  le texte blanc des étiquettes de sonde pollue la détection, et deux captures
  ont ainsi reçu une amorce fausse.

### Le bleu nuit n'est pas de l'eau

Les calques **« Zones accès limité »** et **« Conduites et câbles sous-marins »**
sont dessinés en bleu nuit opaque, indifféremment sur la terre et sur l'eau.
Vérifié : dans la vue d'ensemble, 95 % de ces pixels tombent **hors** du contour
du lac. Ils sont classés « inconnu » et exclus. **À décocher avant toute
nouvelle campagne de captures** — ils masquent de la donnée.

### Deux captures non calées

`IMG_1144` et `IMG_1145` ne se calent ni par corrélation, ni sur le contour :
leur zoom intermédiaire tombe dans un angle mort de la recherche d'échelle, et
les deux méthodes butent sur un bord du domaine exploré. Ce ne sont pas de
mauvaises captures — `IMG_1144` est manifestement le bassin ouest, l'île en cœur
y est reconnaissable. Leur emprise étant déjà couverte, elles sont écartées
plutôt que forcées.

---

## 3. La cote de référence : **647,68 m NGF**

Mesurée sur les **frontières de bande**, où la profondeur vaut exactement la
valeur de la frontière — pas sur l'intérieur des bandes, dont la médiane est
biaisée par la répartition des surfaces. À chaque frontière `d` :
`Z_ac = z_modèle + d`.

Résultat au large (≥ 100 m du rivage), sur les neuf frontières de la palette
détaillée :

| isobathe | 1 m | 1,5 | 2 | 3 | 4 | 6 | 8 | 12 |
|---|---|---|---|---|---|---|---|---|
| `Z_ac` | 647,61 | 647,82 | 647,99 | 647,67 | 647,68 | 647,56 | 647,78 | 648,10 |

Médiane des isobathes ≥ 3 m : **647,68 m NGF**. Une première mesure, faite la
veille sur une palette à six bandes et cinq fois moins de résolution, donnait
647,7 — deux mesures indépendantes au même endroit.

```
z_fond = 647,68 − profondeur_Quickdraw
```

Sur le traceur, le *Comm. Display Offset* à saisir vaut `cote_du_jour − 647,68`.

Deux réserves inséparables du nombre :

- il est **solidaire de `Z_2009` = 648,0**, valeur non confirmée du modèle.
  L'énoncé invariant est : *la surface de la communauté Quickdraw se situe
  environ 0,3 m sous le plan d'eau du jour du levé OFB*. Si `Z_2009` est
  confirmé ailleurs, `Z_ac` se déplace d'autant ;
- la dispersion est réelle : σ robuste de 0,8 à 1,3 m par point au large, et
  1,9 m d'un bloc de 225 m à l'autre. Une constante unique est une valeur
  centrale, **pas une précision**. Ne pas en attendre mieux que ±1,5 m
  localement.

### L'artefact qui a failli tromper

La première mesure, prise sur tout le lac, donnait une dérive de `Z_ac` avec la
profondeur de −0,167 m/m, soit un écart d'échelle de 17 % entre le modèle et la
communauté. C'était un **artefact de la contrainte de bord** : `shore_constraint`
épingle une profondeur nulle sur le trait de côte BD TOPO, qui correspond à une
cote haute et non à 647.

| écart au rivage | pente `Z_ac(d)` | modèle / Quickdraw |
|---|---|---|
| tout | −0,167 m/m | 1,167 |
| ≥ 50 m | −0,055 | 1,055 |
| ≥ 100 m | −0,035 | 1,035 |
| ≥ 150 m | −0,016 | 1,016 |

Sur la palette détaillée, la pente au large ressort à **+0,054** — elle change de
signe selon le jeu de données. **Il n'y a pas d'écart d'échelle mesurable entre
le modèle et la communauté, à ±5 % près.**

Règle générale à retenir : toute comparaison d'isobathes avec ce modèle doit
écarter la frange côtière, sinon elle mesure la contrainte de bord.

### Effet de bord utile : la contrainte de bord est chiffrée

Près du rivage, le `Z_ac` implicite grimpe à 649,2 contre 647,7 au large : le
modèle place le fond **~1,5 m trop haut dans la frange côtière**. L'erreur va
dans le sens prudent, donc rien d'urgent, mais c'est la première fois qu'elle
est mesurée. `tools/check_shoreline_level.py` existe déjà pour attaquer le sujet.

---

## 4. Ce que ça tranche : le § 3.2 bis d'`ETAT.md` est réglé

La donnée communautaire vient de **dizaines de sondeurs indépendants**. Ils ne
peuvent pas partager le défaut d'étalonnage d'un Eagle. Ils s'accordent avec le
modèle à ±5 % près, alors que le Eagle en diffère de 12 %.

**Le sondeur du bord est bien seul en cause, le modèle est indemne.** Le *bar
check* reste souhaitable pour fixer le facteur, il n'est plus bloquant. Couple
estimé inchangé : facteur 1,098 sur le sondeur, `Z_2009` = 648,39 m NGF.

---

## 5. La mosaïque

[`mosaique.png`](mosaique.png) + [`mosaique.json`](mosaique.json), produites par
[`tools/qd_mosaic.py`](../../../tools/qd_mosaic.py).

**8 806 × 6 913 px à 1 m/px Mercator**, même emprise que `data/bed.png`. Le PNG
est sans perte et chaque pixel porte la couleur exacte de la palette : les
bandes se relisent telles quelles (vérifié, relecture identique au tableau
source). 1,3 Mo, contre 60 Mo pour le tableau numpy équivalent.

| | valeur |
|---|---|
| captures retenues | 25 / 27 |
| accord sur les recouvrements | **88,1 %** |
| lac décodé, avant rebouchage | 752 ha — 80,8 % |
| lac décodé, après rebouchage ≤ 10 m | **872 ha — 93,6 %** |
| lac dans l'emprise d'une capture fine (0,68 m/px) | **99 %** |

Le rebouchage ne comble que les trous d'étiquettes et de traits de contour :
une étiquette est toujours posée à l'intérieur d'une bande, donc le plus proche
voisin est légitime dans un petit rayon. Au-delà de 10 m, on laisse le trou.

Ce n'est **pas** un assemblage photo. Coller les captures entre elles par
ressemblance accumulerait les erreurs de proche en proche et ne dirait pas où se
trouve un pixel. Chaque capture étant calée indépendamment, les recouvrements
deviennent un contrôle de qualité plutôt que des coutures à masquer.

### La mosaïque profonde

[`mosaique_12_30m.png`](mosaique_12_30m.png) : même emprise, même résolution,
17 captures sur 17, **326 ha décodés — 35 % du lac**, la part profonde. Les trois
contrôles qui valident ce calage-là sont au § 0, puisqu'ils portent sur la
méthode du masque et non sur la mosaïque.

Les deux mosaïques ne se recouvrent pas en profondeur : c'est ce qui permet de
les fusionner sans arbitrage, au § 10.

---

## 6. Effet attendu sur le modèle

Règle retenue, conforme à la doctrine déjà appliquée à la fusion du MNT
(« la fusion ne peut que rendre le fond moins profond, jamais plus ») :

```
z_fond = max(z_modèle, 647,68 − profondeur_max_de_la_bande)
```

Seule la borne basse de l'altitude est utilisée. La carte ne peut donc que
devenir moins profonde — jamais plus — quelle que soit l'erreur résiduelle de
calage ou une contribution prise à basse cote.

Sur 592 ha réellement contraints (la bande 12–30 m ne contraint rien) :

| relèvement | surface |
|---|---|
| > 0 m | 90,6 ha |
| > 2 m | 37,2 ha |
| **> 3 m** | **25,6 ha** |
| > 5 m | 13,0 ha |
| > 8 m | 4,0 ha |
| maximum | **19,3 m** |

46 % de ces cellules sont à plus de 60 m d'une sonde de 2009, contre 37,8 % sur
l'ensemble du lac : **la correction se loge bien là où le levé est aveugle.**
C'est la confirmation du § 2 d'`ETAT.md` par une source indépendante.

Prix à payer, à connaître avant de publier : **2,24 hm³ retirés sur 79,8** à la
cote 647, soit 2,8 % du volume. C'est le coût assumé du sens prudent.

Les hauts-fonds fantômes identifiés sur la palette à six bandes sont listés dans
[`hauts_fonds_manquants.json`](hauts_fonds_manquants.json) (26 amas, 6,7 ha, tous
à plus de 40 m du rivage) et vérifiés visuellement dans
[`controle_hauts_fonds.png`](controle_hauts_fonds.png). Le pire : le modèle
annonce 22,1 m là où la communauté ne permet pas plus de 9,3 m, et localement
4,3 m.

---

## 7. Ce qui manque, par ordre d'importance

1. ~~La bande 12–30 m ne dit rien.~~ **Réglé et intégré** : campagne `12_30m`,
   17 captures, six bandes, mosaïque produite et fusionnée avec celle de `0-12m`
   dans `build_grid.py`. Elle ajoute 40 ha de fond relevé, dans le bassin ouest.
2. **12 ha sans capture fine**, en quatre zones :
   45,80844 / 1,85344 (7,5 ha) · 45,79287 / 1,91855 (1,2) ·
   45,80615 / 1,88989 (0,9) · 45,80560 / 1,90600 (0,6).
3. Les **étiquettes de sonde chiffrées** (« 14₆ », « 20₇ ») sont des mesures
   ponctuelles à 0,1 m près, aujourd'hui inexploitées. Leur lecture donnerait
   des points, pas des encadrements — surtout dans la bande profonde.
4. `IMG_1144` et `IMG_1145`, à recaler ou à refaire.

## 8. Protocole pour les prochaines captures

- décocher **« Zones accès limité »** et **« Conduites et câbles sous-marins »** ;
- garder **« Points de sonde »** décoché (le semis masque les bandes) ;
- unité en **mètres**, et *Comm. Display Offset* à **0** ;
- viser un recouvrement d'un tiers entre captures voisines : c'est ce
  recouvrement qui mesure la qualité du calage ;
- conserver **une vue d'ensemble du lac entier** par campagne : c'est elle qui
  sert de référence à toutes les autres ;
- **ne jamais changer la palette à l'intérieur d'une campagne.** Changer de
  plage de profondeur, c'est ouvrir une nouvelle campagne : un dossier neuf et
  une entrée neuve dans `palettes.json`. C'est la seule protection contre le
  décodage silencieusement faux décrit au § 0.

---

## 9. Licence — décision prise le 14/08/2026

L'utilisateur a tranché : **la grille corrigée sera publiée.** Ce qui supposait,
au moment de l'intégration et pas après, trois obligations — **honorées le
14/08/2026, en même temps que le code** :

- ✅ la ligne correspondante du tableau des sources porte « Communauté Quickdraw
  (Garmin / ActiveCaptain) — **usage dérivé, pas de licence ouverte** », et non
  Etalab ou Licence Ouverte comme les autres. Dans `README.md`, dans `ETAT.md`,
  au § 12 de `SPECIFICATION.md`, et dans la page « À propos » de l'application
  elle-même — c'est là que le lecteur la verra ;
- ✅ le § 3.5 d'`ETAT.md` est réécrit : la piste n'est plus une impasse, la voie
  retenue est la capture d'écran géoréférencée, et la restriction porte désormais
  sur la redistribution — que nous faisons, en connaissance de cause ;
- ✅ la couche est **identifiable cellule par cellule** : `data/coverage.png`
  porte la borne communautaire dans son canal vert et le relèvement effectivement
  appliqué dans son canal bleu. Retirer la couche est un seul geste —
  `grid.quickdraw_source.enabled: false` dans `config/model.json`, puis
  `build_grid.py` — et les deux canaux disent, sans recalcul, ce qu'elle a changé
  et de combien.

Les captures d'origine sont versionnées depuis le 14/08/2026 : ce sont les
données sources d'une mesure, pas des illustrations.

---

## 10. Le lot L5 — fait le 14/08/2026

Refaire les produits, si besoin (le calage est déjà dans `georef_*.json`, ces
commandes le recalculent — une trentaine de minutes chacune) :

```bash
python tools/qd_georef.py 0-12m
python tools/qd_mosaic.py 0-12m
python tools/qd_georef.py 12_30m --min-ncc 0.50
python tools/qd_mosaic.py 12_30m --min-ncc 0.50
```

L'intégration, point par point :

1. ✅ **les deux mosaïques sont fusionnées**, plages disjointes, la borne la plus
   haute gagnant en cas de recouvrement — c'est-à-dire le plus petit `dmax`.
   `load_quickdraw_codes` dans `build_grid.py`. Chaque mosaïque est décodée avec
   **sa** palette, lue dans son propre `.json` : c'est la seule protection contre
   le piège du § 0 ;
2. ✅ **source à part entière de `tools/build_grid.py`**, réglée dans
   `config/model.json` (`grid.quickdraw_source`), et non une retouche après coup ;
3. ✅ **relèvement seul**, `z = max(z_modèle, 647,68 − dmax)` ;
4. ✅ **après le lissage**, entre `terrain_source` et `shoal_bias` — trois maxima
   qui commutent, donc l'ordre entre eux n'a d'effet que sur les statistiques
   affichées, jamais sur la grille ;
5. ✅ **identifiable cellule par cellule** : canaux vert et bleu de
   `coverage.png` (§ 9) ;
6. ✅ les trois obligations de licence du § 9, honorées avant le déploiement ;
7. ✅ reconstruit, `dump_reference.py` rejoué, 128 vérifications et 44
   enchaînements passants, numéros de version montés.

### Ce que ça donne

| | valeur |
|---|---|
| lac encadré | **881 ha — 94,0 %** |
| fond relevé | **137,4 ha** (> 2 m : 53,1 · > 3 m : 36,0 · > 5 m : 17,3 · > 8 m : 5,1) |
| relèvement maximal | **19,26 m** |
| part du lac restant aveugle | **2,4 %**, contre 37,8 % avant |
| volume à 647 m | 80,63 → **77,48 hm³**, soit 3,15 retirés (3,9 %) |

Le § 6 prévoyait 90,6 ha relevés sur la seule campagne fine ; la mesure faite par
`build_grid.py` en donne 97,3 dans les mêmes conditions — l'écart vient de ce que
le relèvement s'applique désormais **avant** `shoal_bias`, sur une grille encore
un peu plus profonde. La campagne profonde ajoute les 40 ha restants.

### Les trois décisions, prises sur mesure et non sur intuition

**La frange côtière n'est pas masquée.** L'hypothèse était que le modèle y étant
déjà ~1,5 m trop haut (§ 3), le relèvement ne s'y déclencherait presque jamais.
Vérifié, et c'est exactement ce qui se passe — la tranche la plus proche du
rivage est la **moins** relevée de toutes :

| distance au rivage | encadré | relevé | médiane |
|---|---|---|---|
| 0–25 m | 87,2 ha | **7,1 %** | 2,06 m |
| 25–50 m | 118,0 ha | 13,2 % | 1,53 m |
| 50–100 m | 203,9 ha | 18,0 % | 1,74 m |
| > 100 m | 471,8 ha | 16,8 % | 1,19 m |

Les 6,2 ha qui se relèvent quand même dans la frange sont d'autant plus
crédibles : la communauté y dit moins d'eau que le modèle **alors que celui-ci
est déjà biaisé vers le haut**. Le réglage `min_shore_distance_m` existe et vaut
0 ; il n'est là que pour rendre la décision révisable.

**Le hachurage apprend un troisième état.** `coverage.png` passe en RGB : rouge =
distance à la sonde de 2009 (inchangé), vert = borne communautaire, bleu =
relèvement appliqué. Le shader et la lecture sous le bateau distinguent
désormais *mesuré*, *encadré* et *interpolé*. Garder deux états aurait rendu le
hachurage trompeur dans l'autre sens : il crierait « non sondé » sur 94 % du lac.
L'effacer aurait menti à l'inverse — un encadrement n'est pas une mesure. D'où
une nuance intermédiaire : hachures atténuées, sans le voile magenta, et
« encadré — communauté ≤ N m » sans alerte. Détail au § 6.1 bis de la
spécification.

**`Z_2009` et `z_ac` sont déclarés solidaires.** Les deux cotes figurent
maintenant côte à côte dans `config/model.json`, chacune pointant sur l'autre,
avec l'écart invariant (−0,32 m) et la marche à suivre le jour où l'une sera
confirmée. C'était le seul moyen d'éviter que quelqu'un — nous, dans six mois —
corrige l'une en oubliant l'autre et fausse le relèvement sans aucun signe
extérieur.

### Ce qui reste ouvert

Le § 7 n'a pas bougé pour ses points 2 à 4 : 12 ha sans capture fine, les
étiquettes de sonde chiffrées inexploitées, `IMG_1144` et `IMG_1145` à recaler.
Et le rendu à l'écran des trois états n'a pas pu être vu par l'assistant — la
page de test est masquée, MapLibre ne s'y initialise pas. **Cela se valide sur
l'eau, comme la refonte de l'interface.**

---

## 11. Ce que la sortie du 14/08/2026 a corrigé

Deux défauts rapportés depuis l'eau, tous deux fondés. Ni l'un ni l'autre
n'était visible depuis le dépôt.

### 11.1 La mosaïque était décalée de 16 m

**Comment on le sait, sans repasser par la corrélation.** Les 8 118 sondes
brutes du levé OFB 2009 servent de juge : pour chacune, on lit la bande de
couleur qui la recouvre et on regarde si sa profondeur tombe dans l'intervalle
annoncé. On refait le compte en déplaçant la mosaïque. C'est une comparaison
entre deux jeux de données indépendants, sans modèle intermédiaire.

Ce n'est pas le gain brut qui démontre le décalage — il est modeste, les bandes
étant larges — mais **sa dépendance à la pente** :

| pente du fond | écart moyen sonde / bande | après déplacement |
|---|---|---|
| 0-2 % | 0,18 m | 0,13 m (−26 %) |
| 5-10 % | 0,39 m | 0,24 m (−38 %) |
| 10-20 % | 0,81 m | 0,46 m (−43 %) |
| > 20 % | 1,78 m | 0,61 m (**−66 %**) |

Un biais vertical améliorerait toutes les classes pareillement. Du bruit n'aurait
pas de direction constante. Seul un décalage horizontal produit ce profil — et
l'optimum est le même sur onze sous-ensembles disjoints (les deux bassins, les
deux moitiés, chaque tranche de profondeur, chaque tranche de distance au rivage,
les deux campagnes).

**Correction retenue : +18 / −15 m Mercator**, soit +12,6 m est et 10,5 m sud au
sol. Elle s'applique au **mosaïquage** et nulle part ailleurs : `georef_*.json`
garde les solutions de la corrélation brute, donc rejouables sans double
correction. `reference_from_mosaic` retire la correction de la mosaïque de
référence pour la même raison.

> **Piège de signe, payé une fois.** L'indice de ligne d'une image croît vers le
> sud, l'ordonnée Mercator vers le nord. Une première version avec +15 au lieu de
> −15 en Y a **doublé** l'erreur au lieu de l'annuler, sans que rien d'autre ne le
> signale. Refaire le contrôle ci-dessus après toute modification : le résidu doit
> être nul dans les deux axes.

Après correction : écart moyen sur pente forte **0,63 → 0,33 m**, accord dans la
bande 55 → 64 %, relèvement maximal ramené de 19,3 à 17,7 m.

Conséquence de méthode à assumer : la **position** de la couche communautaire est
désormais calée sur le levé de 2009, elle n'en est plus indépendante. Sa
**profondeur** le reste, et c'est elle qui sert de contrôle — le § 4 tient.

### 11.2 Une bande a deux bornes, et il en manquait une

Le lot L5 n'utilisait que `z >= z_ac − dmax`, « pas plus profond que ». Prudent,
mais **inopérant là où le modèle se trompe le plus** : sur les bords, il est trop
*haut*, pas trop bas.

Chiffré avant correction : fond médian **648,89 m NGF** sur les 12 premiers mètres
depuis le trait de côte, **113,7 ha émergés à la cote 647** — 12 % du masque du
lac. La cause est la `shore_constraint`, qui épingle une profondeur nulle sur le
contour BD TOPO, lequel est le trait de côte de la **retenue normale à 650 m**.
Les bassins portuaires, dragués, jamais sondés en 2009 et invisibles au LiDAR
sous l'eau, n'ont rien d'autre : ils sortaient de l'eau sur la carte.

L'autre borne le répare : `z <= z_ac − dmin`, « au moins `dmin` d'eau, puisqu'un
bateau a flotté ici ».

| | avant | après |
|---|---|---|
| émergé à la cote 648 | 67,2 ha | **17,1 ha** |
| émergé à la cote 647 | 113,7 ha | **49,4 ha** |
| fond médian de la frange de 12 m | 648,89 m | **646,18 m** |
| pente médiane de la frange 0-10 m | 79,1 % | **63,6 %** |

C'est le seul mécanisme du modèle qui puisse annoncer **plus** d'eau qu'il n'y en
a. D'où deux garde-fous, tous deux obligatoires et tous deux mesurés avant d'être
activés :

- l'abaissement ne descend **jamais** sous l'altitude d'une sonde réellement
  mesurée à moins de 25 m — 30 % des cellules candidates en avaient une, le
  garde-fou mord donc réellement ;
- il s'arrête **0,5 m au-dessus** de la borne stricte, `z_ac` = 647,68 étant une
  valeur centrale à ±1,5 m près (§ 3) et non une précision.

283 ha abaissés, médiane 2,20 m, maximum 20,4 m.

### 11.3 Le prix : le terrassement

Une source en bandes produit des paliers plats. La surface concernée passe de
121 à **404 ha**, et 20 altitudes distinctes y couvrent 95,6 % des cellules. Ce
n'est pas un défaut de calcul mais la forme honnête de la donnée : lisser
inventerait un relief que Quickdraw ne contient pas. Cela se voit néanmoins sur
les courbes de niveau, et c'est ce qui fait échouer une vérification sur 128 —
« épaisseur des contours constante d'un zoom à l'autre », 1,55 d'écart pour un
seuil de 1,5. Le shader n'a pas changé ; ce sont les isobathes qui se resserrent.
**Le seuil n'a pas été desserré pour faire passer le test.**

### 11.4 Ce qui reste à corriger, et qui n'est pas Quickdraw

Le modèle est systématiquement **au-dessus** des sondes de 2009 : écart médian
**+0,56 m**, 30 % des sondes dépassées de plus de 1 m. La couche communautaire
n'y est pour presque rien — c'est `shoal_bias`, qui impose au fond de ne jamais
être plus profond que la sonde la moins profonde dans un rayon de 15 m. Sur une
pente à 10 %, cela vaut mécaniquement +1,5 m. C'est délibéré, c'est la
généralisation biaisée vers le haut-fond des cartes marines, et c'est ce que
l'utilisateur constate quand son sondeur lit plus creux que la carte — d'autant
que le Eagle du bord **sous-lit d'environ 11 %**. Réduire le rayon est une
décision ouverte, pas un correctif évident.

---

## 12. La carte communautaire seule — lot L6, 14/08/2026

Jusqu'ici Quickdraw ne servait qu'à **corriger** le modèle du levé de 2009.
L'utilisateur a demandé qu'elle puisse aussi le **remplacer** : beaucoup de
plaisanciers du lac naviguent à la carte Garmin seule, en retranchant simplement
la baisse par rapport à la cote normale, et n'ont pas de raison de faire
confiance à un levé qu'ils n'ont pas vu. `tools/build_grid_quickdraw.py` produit
donc un second fond complet, autonome, interchangeable — sans une seule sonde de
2009, sans triangulation, sans contrainte de bord, sans `shoal_bias`.

### 12.1 Le vrai problème : quelle valeur donner à une cellule

Une bande ne donne jamais une profondeur, seulement un intervalle `[dmin, dmax]`.
Trois façons d'en tirer une carte, et deux sont mauvaises.

- **Le fond de l'intervalle** (le plus profond) trahit la doctrine du dépôt :
  l'erreur doit toujours aller vers le haut-fond.
- **Le sommet partout** (le moins profond) donne un escalier de plateaux. Le
  défaut n'est pas esthétique : un fond en marches **n'a plus de gradient**, et le
  contour de sécurité de l'application est calculé par `fwidth` dans le shader. Il
  **disparaît** dès que le seuil du bateau tombe entre deux paliers — 1,7 m dans
  une bande 1,5–2 m ne trace plus rien. Une carte qui n'affiche plus sa limite de
  sécurité là où elle compte est pire que terrassée.
- **La détente sous contrainte**, retenue. On part du sommet — la valeur prudente
  — on lisse doucement, et l'on **replie** la valeur dans son encadrement après
  chaque passe. Chaque lissage fait descendre les cellules voisines d'une bande
  plus profonde ; le repli les empêche d'aller plus bas que leur propre bande ne
  l'autorise. Au bout de quelques passes, chaque bande porte une rampe qui va de
  son sommet à son plancher au contact de la suivante, et les isobathes tombent
  exactement sur les frontières de couleur. C'est la reconstruction classique d'un
  relief à partir de ses isobathes, à ceci près que la contrainte est un
  encadrement et non une courbe.

Le repli est ce qui rend l'opération sûre : **quel que soit le nombre
d'itérations, la sortie reste dans l'encadrement d'entrée.** Le lissage ne peut
donc rien inventer, il choisit seulement, parmi les surfaces que la communauté
autorise, celle qui a un gradient. Vérifié à la construction (le script s'arrête
sinon) et dans `/test/` : aucune cellule ne sort de sa bande. Zéro itération
redonne l'escalier prudent — c'est un réglage, pas une réécriture.

Mesuré : 24 passes à σ = 10 m descendent 683 des 884 ha encadrés sous la valeur
prudente, de **1,00 m** en médiane, pour un encadrement large de 2,0 m en médiane.

### 12.2 Le résultat, comparé au fond du levé

| | levé 2009 + apports | communauté seule |
|---|---|---|
| surface décrite | 100 % du lac | **94,3 %** encadrés, 45 ha laissés vides |
| émergé à la cote 647 | 49,4 ha | **29,1 ha** |
| émergé à la cote 646 | 113,5 ha | **43,7 ha** |
| cellules à fond plat | 25,1 % | **22,0 %** |
| altitudes distinctes | 3 312 | **2 485** |
| pente médiane du fond | 3,24 % | **3,26 %** |
| profondeur maximale à 647 | 28,5 m | 21,3 m |

Deux choses valent d'être notées. D'abord, **la carte communautaire est moins
terrassée que celle du levé** — 22,0 % de cellules plates contre 25,1 %, et 2 485
altitudes distinctes contre 3 312 : la détente fait mieux que compenser le pas des
bandes, là où l'empilement de bornes sur le fond du levé, lui, fabrique des
paliers (§ 11.3). Ensuite, les pentes médianes sont **identiques à 0,02 % près**,
ce qui est la mesure honnête de « le contour de sécurité se comportera pareil ».

Écart entre les deux cartes, par tranche de profondeur (positif = la communauté
annonce moins d'eau) :

| profondeur | surface | écart médian | part où la communauté est plus haute |
|---|---|---|---|
| 0–2 m | 49,8 ha | −0,91 m | 4,3 % |
| 2–5 m | 167,5 ha | −0,77 m | 14,7 % |
| 5–10 m | 314,4 ha | −0,12 m | 41,6 % |
| 10–20 m | 268,4 ha | +0,00 m | 49,6 % |
| 20–40 m | 63,0 ha | +0,46 m | 55,5 % |

Elles s'accordent **à moins de 2 m sur 80 % du lac**, à moins d'1 m sur 54 %, et
se confondent au-delà de 10 m. Elles divergent exactement là où c'était prévisible
— sur la frange, où le fond du levé porte encore la contrainte de bord et
`shoal_bias`. Le seul recul net est la fosse la plus profonde, lue 21 m au lieu de
28 : la bande la plus profonde de la palette s'arrête à 30 m et l'agrégation
retient la moins profonde de la cellule.

### 12.3 Ce que cette carte ne sait pas faire

Elle n'a **aucune sonde à quoi se raccrocher**. Sa prudence tient au seul choix de
la bande la moins profonde de chaque cellule de 5 m, ce qui dilate un haut-fond
d'environ une maille — mais un caillou plus étroit que la résolution du traceur
peut lui échapper là où `shoal_bias` l'aurait retenu à 15 m. C'est le prix à payer
pour une carte qui décrit 94 % du lac au lieu des 62 % couverts par le levé, et
qui laisse le reste **vide** plutôt que de l'inventer.

Une seule entorse au « rien que la communauté » : le terrain émergé du MNT RGE
ALTI au-dessus de 648,80 m, qui **comble** les trous en plus de relever — les
îlots sont précisément là où aucun bateau ne passe. Mesure aéroportée indépendante
de l'IGN, et non le levé de 2009 ; commutateur `quickdraw_only.terrain_source`
pour s'en passer. 3 410 cellules comblées, 8 173 relevées.

### 12.4 Ce que la carte de fiabilité devient

`coverage_quickdraw.png` garde les canaux de `coverage.png` — l'application n'a
qu'un décodeur — mais leur **sens suit la source** :

- **R** = 0 partout où la carte existe. Chaque cellule visible porte le passage
  d'un sondeur : il n'y a pas de zone interpolée à hachurer. 255 ailleurs, où
  l'alpha est de toute façon nul.
- **G** = la borne de profondeur de la bande, en mètres arrondis au-dessus. Elle
  vaut pour toute la carte, et c'est ce qui rappelle qu'on lit un encadrement et
  non une sonde : l'étiquette sous le bateau affiche « communauté — bande ≤ N m ».
- **B** = la largeur de l'encadrement en décimètres, seule mesure locale de ce que
  la carte ignore encore.
