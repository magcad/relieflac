# Cartographie communautaire Quickdraw — analyse et calage

Travail du 14 août 2026. **Rien n'est encore intégré au modèle** : ce document et
les fichiers de ce dossier conservent la méthode, les mesures et les produits
intermédiaires pour que l'intégration se fasse dans une session dédiée.

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

1. ~~La bande 12–30 m ne dit rien.~~ **Réglé** par la campagne `12_30m` du même
   jour : 17 captures, six bandes de 12 à 30 m. Reste à en produire la mosaïque
   et à la fusionner avec celle de `0-12m`, les deux plages étant disjointes.
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

L'utilisateur a tranché : **la grille corrigée sera publiée.** Ce qui suppose,
au moment de l'intégration, et pas après :

- la ligne correspondante du tableau des sources, dans `README.md` et `ETAT.md`,
  doit porter « Communauté Quickdraw (Garmin) — **usage dérivé, pas de licence
  ouverte** », et non Etalab ou Licence Ouverte comme les autres ;
- le § 3.5 d'`ETAT.md` doit être réécrit : la piste n'est plus une impasse, la
  voie retenue est la capture d'écran géoréférencée, et la restriction porte
  désormais sur la redistribution — que nous faisons, en connaissance de cause ;
- la couche doit rester **identifiable cellule par cellule** dans la grille, pour
  pouvoir être retirée d'un seul geste si Garmin le demandait.

Les captures d'origine sont versionnées depuis le 14/08/2026 : ce sont les
données sources d'une mesure, pas des illustrations.

---

## 10. Reprendre — le lot L5

Refaire les produits, si besoin (le calage est déjà dans `georef_*.json`, ces
commandes le recalculent — une trentaine de minutes chacune) :

```bash
python tools/qd_georef.py 0-12m
python tools/qd_mosaic.py 0-12m
python tools/qd_georef.py 12_30m --min-ncc 0.50
python tools/qd_mosaic.py 12_30m --min-ncc 0.50
```

Puis l'intégration proprement dite :

1. **fusionner les deux mosaïques.** Les plages sont disjointes : une cellule
   contrainte par `12_30m` l'est entre 12 et 30 m, une cellule contrainte par
   `0-12m` l'est entre 0 et 12 m. Aucune ne contredit l'autre ; en cas de
   recouvrement, la borne la plus haute gagne, comme partout ailleurs ;
2. **source à part entière dans `tools/build_grid.py`**, pas une retouche après
   coup — la grille doit rester reproductible depuis les scripts ;
3. **relèvement seul** : `z = max(z_modèle, 647,68 − dmax)`. Voir § 6 ;
4. **après le lissage**, comme `terrain_source`, jamais avant : un σ de 15 m
   étale les hauts-fonds et efface précisément ce qu'on ajoute ;
5. couche **identifiable cellule par cellule**, pour pouvoir être retirée ;
6. les trois obligations de licence du § 9, **avant** de déployer ;
7. reconstruire, `python tools/dump_reference.py`, vérifier `/test/` et
   `/test/interaction.html`, monter les deux numéros de version, déployer.

Trois décisions à prendre en connaissance de cause :

- **la frange côtière.** Le § 3 dit de l'exclure *pour mesurer*. Pour
  *corriger*, c'est autre chose : le modèle y est déjà ~1,5 m trop haut, donc le
  relèvement ne devrait presque jamais se déclencher — à vérifier plutôt qu'à
  supposer, puis décider si on laisse faire ou si on masque la frange ;
- **le hachurage du § 2 d'`ETAT.md`.** Il marque aujourd'hui ce qui est à plus
  de 60 m d'une sonde de 2009. Après intégration, une bonne part de ces zones
  sera renseignée — mais par un **encadrement**, pas par une mesure ponctuelle.
  Soit on garde le hachurage et il devient trompeur dans l'autre sens, soit
  `coverage.png` apprend à distinguer trois états : mesuré, encadré, interpolé ;
- **`Z_2009`.** Le calage à 647,68 lui est solidaire (§ 3). Si on le confirme un
  jour, les deux se déplacent ensemble : le noter dans `config/model.json` pour
  que personne ne corrige l'un en oubliant l'autre.
