# Bug en cours — Les « Traces du levé 2009 » ne s'affichent pas sur la carte

> Document de passation. Objectif : permettre à une autre session (autre compte) de
> reprendre la résolution sans reconstruire le contexte. Rédigé le 2026-08-12,
> version déployée au moment de l'écriture : **`2026-08-12.8`**.

## Symptôme (mots de l'utilisateur)

Il coche « Traces du levé 2009 » dans les Paramètres, aucune autre couche active, et **aucune
pastille blanche n'apparaît sur le lac**. Sur sa capture : la carte des profondeurs colorée
s'affiche, les 4 pastilles cyan des relevés (`reperes`) sont visibles, **mais zéro sonde 2009**.

## Ce qui est CONFIRMÉ (ne pas re-tester)

- **Les données se chargent** : `app.soundings.count === 8118`. Le fetch de
  `data/soundings/ofb2009.csv` réussit sur GitHub Pages.
- **Le CSV est sain** : en-tête `lon,lat,depth_m,timestamp`, colonnes dans le bon ordre,
  valeurs `lon≈1.87 / lat≈45.79` → bien au centre du Lac de Vassivière, dans `maxBounds`.
  → **L'hypothèse « colonnes lon/lat inversées » est écartée.**
- **`toGeoJSON()` est correct** : renvoie un objet `{type:'FeatureCollection', features:[…8118…]}`
  (un objet, pas une chaîne ; géométries `Point` en `[lon,lat]`). Voir `src/soundings.js:68`.
- **La couche existe et est visible** : le diagnostic rapporte `couche visible`
  (`getLayoutProperty('sondes-2009','visibility') === 'visible'`).
- **Aucune erreur MapLibre** : `err: aucune` (un listener `map.on('error')` remonterait toute
  expression de style invalide ; la source/le style ne signalent rien). Voir `src/map.js:116`.
- **Le style n'est PAS rechargé au changement de fond** : `setBasemap()` ne fait que basculer la
  visibilité des couches `fond-*`, il ne rappelle pas `setStyle`. → **L'hypothèse « le changement
  de basemap efface la source » est écartée.**
- **Pas de course d'initialisation** : `#addOverlays()` (qui crée la source+couche `sondes-2009`)
  s'exécute sur `style.load` à l'intérieur de la promesse `lakeMap.ready` ; `setSoundings()` est
  appelé dans `loadSoundingsLazily()` APRÈS que le boot a `await lakeMap.ready`. La source existe
  donc quand `setData` est appelé.
- **Une couche `circle`/`geojson` identique fonctionne** : `reperes` (mêmes type et source
  GeoJSON, pastilles cyan) s'affiche parfaitement. → **Le rendu générique des couches `circle`
  n'est pas cassé.** C'est spécifique à `sondes-2009`.

## Le signal trompeur : `source -2`

Le dernier diagnostic affiche `source -2`. Ce `-2` vient de :

```js
out.data = m.getSource('sondes-2009')?._data?.features?.length ?? -2;   // src/map.js:204
```

**`-2` ≠ preuve que la source est vide.** Le MapLibre vendu (`vendor/maplibre-gl.js`) n'expose
probablement pas la donnée sous `_data` (champ interne, susceptible d'être renommé/minifié, ou
vidé après transfert au worker de tuilage). Le probe lit donc `undefined` → `-2`, **même si
`setData` a parfaitement fonctionné**. Ce diagnostic est à remplacer (voir plus bas).

Le signal FIABLE, lui, est `rendues 0` : `queryRenderedFeatures({layers:['sondes-2009']})`
renvoie 0. **Rien n'est effectivement peint.** C'est le vrai mystère.

## Prochaine étape n°1 — mesurer le VRAI contenu de la source

Remplacer le probe `_data` par une mesure fiable, puis redéployer et demander la ligne. Deux
sources de vérité MapLibre :

```js
// Nombre de features réellement stockées dans la source (indépendant du nom de champ interne) :
const src = m.getSource('sondes-2009');
let real = -3;
try { real = (src.serialize?.().data?.features?.length) ?? -4; } catch {}

// Nombre de features tuilées/parsées dans la vue courante (0 tant que le worker n'a pas fini) :
let tiled = -3;
try { tiled = m.querySourceFeatures('sondes-2009').length; } catch {}
```

Interprétation attendue :
- `serialize().data.features.length === 8118` → **`setData` a bien peuplé la source** → le bug
  est au **rendu/tuilage**, pas aux données. Passer à l'étape n°2.
- `serialize()` renvoie 0 / `EMPTY` → **`setData` n'a rien injecté** → enquêter sur pourquoi
  `getSource('sondes-2009').setData(obj)` échoue sur l'appareil (worker GeoJSON, taille de
  l'objet, etc.). Tester avec un sous-échantillon de 50 points.

## Prochaine étape n°2 — isoler rendu vs données

Test décisif : forcer un rendu trivial et voir s'il apparaît.

```js
// À injecter temporairement (console de debug ou build jetable) :
m.setPaintProperty('sondes-2009', 'circle-radius', 8);
m.setPaintProperty('sondes-2009', 'circle-color', '#ff0000');
m.setPaintProperty('sondes-2009', 'circle-stroke-width', 0);
m.setLayoutProperty('sondes-2009', 'visibility', 'visible');
```

- Des points rouges apparaissent → le problème venait d'une **expression de paint** (peu probable,
  elles sont simples : `circle-radius` interpolé zoom 10→19 = 2→9 px, voir `src/map.js:132`) ou du
  **z-order** (voir hypothèse A).
- Toujours rien → le problème est **en amont du paint** : source vide, ou couche masquée par une
  autre couche opaque au-dessus.

## Hypothèses classées (la plus probable en premier)

### A. Ordre d'empilement : la couche custom des profondeurs recouvre les sondes
`addDepthLayer()` insère la couche WebGL2 des profondeurs avec
`this.map.addLayer(layer, 'sondes-2009')` (`src/map.js:185`) — donc **juste avant** `sondes-2009`,
ce qui met les profondeurs DESSOUS et les sondes DESSUS. C'est l'intention. **MAIS** : vérifier
que, sur l'appareil, `sondes-2009` existe bien au moment où `addDepthLayer` est appelé. Si la
couche cible n'existe pas encore, MapLibre **ajoute au sommet** au lieu d'insérer → la couche
custom des profondeurs se retrouve **au-dessus** et **peint tout le lac en couleur, masquant les
sondes**. Ce serait cohérent avec la capture (couleurs partout, sondes invisibles, `reperes` —
ajoutées encore après — visibles).
- **Vérifier** : `m.getStyle().layers.map(l=>l.id)` et regarder la position de `sondes-2009`
  vs l'id de la couche de profondeurs custom. Confirmer l'ordre réel d'empilement.
- **Note** : `queryRenderedFeatures` peut renvoyer 0 pour des features masquées par une couche
  opaque au-dessus, selon les versions — donc `rendues 0` est compatible avec cette hypothèse.

### B. `setData` n'a pas peuplé la source
Écartée en apparence (le code est correct, pas d'erreur), mais non prouvée tant que
`serialize()` (étape n°1) n'a pas confirmé 8118. À trancher en premier car c'est binaire.

### C. Expression de paint dégénérée à ce zoom
Peu probable : les expressions sont triviales et `reperes` (rayon fixe) marche. Le test de
l'étape n°2 (rayon fixe 8) l'élimine d'un coup.

## Fichiers concernés

- `src/map.js` — `#addOverlays()` (création source+couche `sondes-2009`, `map.js:122`),
  `addDepthLayer()` (`map.js:183`, insertion beforeId), `setSoundings()` (`map.js:194`),
  `soundingsDebug()` (`map.js:200`, **le probe à corriger**), listener `error` (`map.js:116`).
- `src/soundings.js` — `Soundings.load()` et `toGeoJSON()` (confirmés corrects).
- `src/main.js` — `loadSoundingsLazily()` (`main.js:133`), `refreshSoundingsDiag()`
  (`main.js:148`, format de la ligne de diagnostic).

## Rituel de déploiement (rappel)

1. Servir en local : `/c/Users/as/AppData/Local/Programs/Python/Python312/python.exe tools/serve.py 8140`
   (JAMAIS `python -m http.server` ; le `python` du PATH est le stub Microsoft Store).
2. Bump `src/version.js` **et** `CACHE` dans `sw.js` (même chaîne, ex. `2026-08-12.9`).
3. `git` : rebaser sur `origin/main` avant push (le workflow horaire `level.yml` commite la cote).
   Message de commit terminé par `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
4. Vérifier le déploiement en interrogeant GitHub Pages (curl sur `src/version.js`) jusqu'à voir
   le nouveau numéro.
5. La carte MapLibre **ne s'affiche pas dans le panneau navigateur intégré** (page `hidden`,
   rAF suspendu, boot bloqué à `whenVisible`/`lakeMap.ready`). Les tests passent via
   `import('/test/selftest.js')` sur `http://localhost:8140/test/`. Pas de Node en local.

## État des demandes de la sortie terrain (contexte)

- ✅ Hachures plus voyantes (voile magenta + hachures blanches denses).
- ✅ Correction live de la carte par les relevés (patch de grille + ré-upload GPU).
- ✅ Persistance serveur des relevés via jeton GitHub perso (modèle « propriétaire écrit / lecture
  publique »), format générique réutilisable pour d'autres plans d'eau
  (`data/corrections/vassiviere.json`).
- ✅ Anti-mise-en-veille (wake lock) quand l'app est visible.
- ✅ Service worker « réseau d'abord » (fin du cache iOS collant).
- ⏳ **CE BUG** : affichage des traces du levé 2009.
- ⏳ Ensuite : reprendre l'**étalonnage à Port de Vauveix** (écran Étalonnage : sondes sur trace,
  ≥5, résidu médian, IQR ≤ 1,0 m, bouton « Appliquer la correction ». Près de Vauveix : 57 sondes
  dans 100 m, la plus proche à 17 m).
