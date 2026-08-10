# Dépôt des relevés à importer

Place ici les fichiers bruts, puis lance :

```bash
python tools/import_soundings.py data/imports/<ton-fichier>
python tools/build_grid.py
```

Le script normalise le fichier vers `data/soundings/<nom>.csv` et le modèle le prend
en compte à la reconstruction suivante. Les fichiers bruts ne sont pas versionnés
(voir `.gitignore`) — seule leur version normalisée l'est.

---

## Ce que le modèle a besoin de savoir

Une profondeur seule ne suffit pas. Sur une retenue qui marne de plusieurs mètres,
« 4,2 m de fond » ne veut rien dire sans savoir **quand** la mesure a été prise :
c'est la cote du lac à cet instant qui transforme la profondeur en altitude de fond.

Trois cas, par ordre de préférence :

| Cas | Ce qu'il faut | Précision atteignable |
|---|---|---|
| Sondes **horodatées** | date + heure de chaque point | ± 5 cm (cote EDF horaire archivée) |
| Sondes d'une **sortie datée** | la date de la sortie | ± 20 cm |
| Sondes **sans date** | rien — inexploitable au-delà du décimètre | ± 1 à 3 m |

L'historique horaire de la cote est dans `data/level-history.json` ; il démarre au
10/08/2026. Pour des relevés antérieurs, il faut fournir la cote à la main
(option `--reference-level`).

Autre point à ne pas oublier : la **profondeur d'immersion du transducteur** sous la
flottaison (20 à 50 cm en général). Elle se déclare avec `--transducer-depth` et se
mesure une fois pour toutes au mètre ruban.

---

## Formats acceptés

### CSV

N'importe quel CSV comportant longitude, latitude et profondeur. Le script détecte les
noms de colonnes usuels (`lon`/`lng`/`longitude`/`x`, `lat`/`latitude`/`y`,
`depth`/`prof`/`profondeur`/`sonde`, `time`/`date`/`timestamp`) ; sinon on les précise :

```bash
python tools/import_soundings.py data/imports/sortie.csv \
    --lon-col Longitude --lat-col Latitude --depth-col "Depth (m)" --time-col Time
```

### GPX

Traces ou points avec profondeur, y compris l'extension Garmin `<gpxx:Depth>` et
l'extension `<gpxtpx:depth>`. Les horodatages `<time>` sont repris automatiquement.

### GeoJSON / KML

Points portant un attribut de profondeur, ou **lignes de niveau** (isobathes) portant
une profondeur : chaque sommet devient une sonde.

---

## Garmin

Selon le modèle, plusieurs exports sont possibles. Par ordre d'utilité :

1. **Traces GPX avec profondeur** — l'idéal : horodatées, directement exploitables.
   Sur les traceurs récents : *Informations utilisateur → Gérer les données →
   Transfert de données → Enregistrer la carte mémoire*, puis récupérer le `.gpx`.

2. **Contours Quickdraw** exportés en GPX/shapefile — exploitables comme isobathes,
   **mais** attention : Quickdraw enregistre des profondeurs relatives au niveau du lac
   au moment du passage, et un décalage de niveau peut avoir été configuré sur
   l'appareil (*Quickdraw → Paramètres → Décalage niveau d'eau*). Il faut donc
   connaître **les dates des enregistrements** et **la valeur de ce décalage**, sinon
   les contours sont décalés d'une constante inconnue — exactement le problème qu'on
   cherche à éviter.

3. **Fichiers `.svy` Quickdraw bruts** (dossier `/Garmin/Quickdraw/` de la carte SD) —
   format propriétaire non documenté, non pris en charge. À convertir au préalable via
   Garmin ActiveCaptain ou HomePort.

4. **`.RSD`** (sonar brut) — format propriétaire, non pris en charge.

**À demander au propriétaire du traceur** : le modèle exact, si les traces sont
horodatées, les dates des enregistrements, la valeur du décalage de niveau d'eau
configuré, et la profondeur d'immersion de la sonde.

---

## Vérifier avant de reconstruire

```bash
python tools/import_soundings.py data/imports/<fichier> --dry-run
```

Affiche le nombre de points, l'emprise, la plage de profondeurs et les dates détectées,
sans rien écrire.
