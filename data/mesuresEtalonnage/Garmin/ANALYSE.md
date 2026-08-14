# Cartographie communautaire Quickdraw — analyse et calage

Travail du 14 août 2026. **Rien n'est encore intégré au modèle** : ce document et
les fichiers de ce dossier conservent la méthode, les mesures et les produits
intermédiaires pour que l'intégration se fasse dans une session dédiée.

Point de départ : accès à un compte ActiveCaptain donnant la couche
**Communauté Quickdraw** sur le lac, alimentée par les pêcheurs qui le
parcourent quotidiennement. 27 captures d'écran d'iPad, dans
`IMG_1143.PNG` … `IMG_1170.PNG`.

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

1. **La bande 12–30 m ne dit rien.** Tout le bassin ouest — le plus profond — est
   d'un seul bleu clair et ne contribue à aucune contrainte. **Ajouter des
   portées au-dessus de 12 m** (12-15, 15-18, 18-22, 22-26, 26-30) et refaire une
   passe sur l'ouest. Meilleur rapport effort/résultat qui reste, et de loin.
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
- ne pas changer la palette en cours de campagne — ou signaler le changement,
  car la palette est lue une fois pour toutes dans `qd_georef.py`.

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

Les 27 captures d'origine sont dans ce dossier et **ne sont pas encore
versionnées** : leur mise sous git est une décision distincte de celle de
publier la grille dérivée.
