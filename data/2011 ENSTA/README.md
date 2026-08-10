# Lac de Vassivière — base pour application de géopositionnement

## Ce qui est réellement disponible

Le document source décrit un levé hydrographique haute résolution réalisé en 2011
avec sondeur multifaisceaux Kongsberg EM3002 et LiDAR embarqué.

Le projet visait une couverture complète du lac. Le DTM était prévu à :
- 1 m de résolution pour les zones de navigation ;
- 0,5 m autour des infrastructures ;
- TPU de 15 cm à 95 % de confiance.

La carte nautique publiée est au 1:10 000 et référencée verticalement à 646 m
dans le système IGN69.

## Attention

Le fichier original de points bathymétriques / DTM n'est pas inclus dans les
documents publiquement retrouvés. Il ne faut donc PAS transformer la carte JPEG
en faux modèle numérique de profondeur : cela donnerait une précision artificielle.

Le fichier JPEG est fourni comme couche de visualisation/référence uniquement.

## Architecture recommandée pour l'application

Stocker le fond sous forme d'un raster bathymétrique :

    bottom_elevation_IGN69(x,y)

Puis obtenir la profondeur instantanée :

    depth = water_level_IGN69 - bottom_elevation_IGN69

Cela permet de corriger automatiquement la carte lorsque le niveau du lac varie.

### Cas où le niveau actuel est connu

Si le niveau est 648,2 m IGN69 et que le fond est à 640,0 m :

    profondeur = 648,2 - 640,0 = 8,2 m

### Cas où le niveau actuel n'est pas connu

Prévoir un mode « calibration » :
1. le bateau se place sur une zone connue ;
2. le sonar mesure la profondeur réelle ;
3. la différence entre profondeur mesurée et profondeur cartographique
   fournit un offset de niveau ;
4. cet offset est appliqué à toute la carte.

C'est préférable à un simple « zéro » GPS, car le GPS donne une altitude
ellipsoïdale et non directement le niveau d'eau IGN69.

## Format cible conseillé

Pour une application mobile :
- GeoTIFF / Cloud Optimized GeoTIFF pour le DTM ;
- ou tuiles raster XYZ/MBTiles pour l'affichage ;
- GeoJSON pour les obstacles, zones interdites et contours ;
- WGS84 (EPSG:4326) côté interface ;
- conversion vers un système métrique local pour les calculs si nécessaire.

## Prochaine étape

La vraie étape importante est d'obtenir auprès d'ENSTA Bretagne, d'EDF ou des
autorités du lac le DTM/nuage de sondages issu du levé 2011 (ou un levé plus
récent). Avec ce fichier, on pourra générer :
- un GeoTIFF bathymétrique ;
- des isobathes tous les 1 m ;
- une carte couleur du relief ;
- une vue 3D ;
- et une base directement exploitable par l'application.

