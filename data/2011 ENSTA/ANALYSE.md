# Levé multifaisceaux 2011 — ENSTA Bretagne / Gand / HCU Hamburg / CIDCO

## Ce que contient ce dossier

Le rapport source (`vassiviere_survey_2011_source.pdf`) est la **communication FIG**
de Seube *et al.* sur le programme Erasmus Intensive « Hydrography and Geomatics »
(2011-2013). C'est un article sur la **pédagogie** du camp de levés, pas un article de
données. La carte JPEG jointe fait 418 px de large : c'est une vignette d'illustration.

**Le MNT et le nuage de sondes multifaisceaux n'y sont pas.** Ils ont été livrés à EDF
et aux autorités du lac. Toutes les figures du PDF sont des images matricielles — aucun
contour vectoriel n'en est extractible.

## Ce que le rapport établit sur le levé

| | |
|---|---|
| Dates | octobre 2011, campagnes reconduites jusqu'en 2013 |
| Matériel | MBES **Kongsberg EM3002** + LiDAR mobile **Leica HDS6200**, catamaran ENSTA |
| Couverture | **totale, Ordre 1 (S-44 OHI)** pour la bathymétrie |
| Incertitude | **TPU 15 cm à 95 %**, imposée par EDF |
| Maille du MNT | **1 m** en navigation, **0,5 m** sur les ouvrages |
| Carte produite | **S-57** via CARIS S-57 Composer, échelle de compilation 1:10 000 |
| Référence verticale de la carte | **646 m IGN69** |
| Trait de côte | issu des données LiDAR mobiles |
| Cote du lac pendant le levé | **≈ 4 m sous la retenue normale** (sécheresse 2011) |
| Commanditaire | EDF, Unité de Production Centre |

Le levé a aussi révélé les villages, routes et ponts submergés depuis 1951.

## Pourquoi c'est la donnée qu'il nous faut

Le modèle actuel repose sur le levé monofaisceau OFB de 2009 : des traces espacées de
plus de 150 m dans les grands bassins, **37,8 % du lac à plus de 60 m de toute sonde**.
Un multifaisceaux à couverture totale supprime purement et simplement ce problème.

Deux détails rendent la donnée 2011 particulièrement adaptée :

1. **Sa référence verticale est connue** — 646 m IGN69. Notre inconnue actuelle, la cote
   du levé de 2009, disparaîtrait : `z_fond = 646 − profondeur_carte`.
2. **Le levé s'est fait à basse cote**, environ 646 m. Le multifaisceaux a donc sondé la
   frange qui découvre en étiage — précisément la bande aveugle que ni le LiDAR IGN
   (survolé à 648,80 m) ni le bateau de 2009 ne couvrent, et qui porte les îlots qui
   émergent aujourd'hui.

## Où demander

| Détenteur | Pourquoi |
|---|---|
| **EDF, Unité de Production Centre** | commanditaire et destinataire des livrables |
| **ENSTA Bretagne**, Ocean Sensing and Mapping Lab | opérateur du levé — Nicolas Seube, Thomas Touzé, Nathalie Debese |
| **Ghent University**, 3D Data Acquisition Cluster | co-organisateur — `geoweb.ugent.be/data-acquisition-3d` |
| **Syndicat mixte du lac de Vassivière** | « autorités du lac » citées comme destinataires |

Formats utiles, par ordre de préférence :

1. **MNT maillé** (GeoTIFF, ASCII grid, XYZ) en altitude IGN69 — se branche directement
   sur la chaîne existante, qui stocke déjà `z_fond` en m NGF ;
2. **nuage de sondes** (XYZ, LAS) — même chose, avec l'interpolation à refaire ;
3. **ENC S-57 / S-63** — isobathes et zones de profondeur vectorielles, référencées
   646 m IGN69 ; excellent en complément, mais quantifié par paliers.

## Point de vigilance : IGN69 ou NGF-Lallemand ?

Le rapport précise que le levé a manipulé **deux systèmes altimétriques** : IGN69
(officiel actuel) et **NGF-Lallemand (ancien système, celui utilisé par EDF)**. L'API EDF
annonce ses cotes en « m NGF » sans préciser lequel.

Un écart entre les deux systèmes se traduirait par un biais constant sur toutes les
profondeurs affichées, du même ordre que celui que l'étalonnage au sondeur cherche à
corriger. À demander explicitement en même temps que les données, et à faire absorber
par l'étalonnage en attendant.
