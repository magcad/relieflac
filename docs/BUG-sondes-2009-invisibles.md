# Résolu — Les « Traces du levé 2009 » ne s'affichaient pas sur la carte

> Post-mortem. Bug ouvert le 2026-08-12 (version `2026-08-12.8`), corrigé le même jour
> dans la version **`2026-08-12.9`**. Le document de passation d'origine est conservé
> plus bas, avec ce qu'il avait de juste et ce qui l'avait fait dérailler.

## Cause réelle

**Le worker de tuilage de MapLibre ne se chargeait pas — 404 — et aucune source `geojson`
n'a donc jamais été tuilée.**

`vendor/maplibre-gl.js` recompose l'URL de son worker à l'exécution, à partir de
`import.meta.url`, avec l'extension `.mjs` écrite en dur :

```js
function bi(){
  let e = import.meta.url;
  if (!/^https?:/.test(e)) return ``;
  let t = e.endsWith(`-dev.mjs`) ? `maplibre-gl-worker-dev.mjs` : `maplibre-gl-worker.mjs`;
  return new URL(`./${t}`, e).href;       // → vendor/maplibre-gl-worker.mjs
}
```

Or `tools/vendor_maplibre.py` renomme les modules `.mjs` → `.js` (pour échapper aux
serveurs qui servent `.mjs` en `text/plain`). Sa réécriture ne portait que sur la forme
`"./maplibre-gl-worker.mjs"` — avec le préfixe `./`. Ici le `./` est ajouté à l'exécution
par l'interpolation `` `./${t}` ``, si bien que le nom nu `maplibre-gl-worker.mjs` est
passé au travers. Le fichier livré s'appelle `maplibre-gl-worker.js` :

```
GET /vendor/maplibre-gl-worker.mjs → 404
GET /vendor/maplibre-gl-worker.js  → 200
```

`new Worker(…/maplibre-gl-worker.mjs, {type:'module'})` échouait, la promesse du pool de
workers ne se résolvait jamais, et `dispatcher.waitForInitComplete()` restait en attente
à vie.

### Pourquoi la carte avait l'air saine

Tout ce qui ne passe pas par le worker continuait de fonctionner, ce qui masquait la panne :

| Élément | Chemin | État |
|---|---|---|
| Fonds IGN (raster) | fil principal | ✅ s'affichait |
| Couche WebGL des profondeurs | fil principal, custom layer | ✅ s'affichait |
| Bateau, pastilles de sondes manuelles, points de simulation | marqueurs HTML | ✅ s'affichaient |
| `sondes-2009`, `trace`, `precision`, `reperes` | **worker geojson** | ❌ muettes à vie |

Et la panne était **silencieuse** : une promesse qui ne se résout jamais ne déclenche
aucun événement `error`, d'où le `err: aucune` qui semblait innocenter le style.

## La fausse piste qui a coûté la session précédente

Le document de passation posait comme acquis :

> **Une couche `circle`/`geojson` identique fonctionne** : `reperes` (mêmes type et source
> GeoJSON, pastilles cyan) s'affiche parfaitement. → Le rendu générique des couches
> `circle` n'est pas cassé. C'est spécifique à `sondes-2009`.

**C'était faux, et c'est ce qui a fait chercher au mauvais endroit.** Les pastilles cyan
de la capture ne sont pas la couche `reperes` : ce sont les marqueurs HTML `.probe-mark`
(`app.css:174`, fond `#22d3ee`), créés par `setProbes()` et qui ne passent pas du tout par
MapLibre. La couche `reperes`, elle, est verte `#22c55e` ou ambre `#f59e0b`
(`src/map.js`) — et elle ne s'affichait pas davantage que les sondes.

Mesure faite après coup sur les quatre sources, avant correction :

```
sondes-2009 | _data=objet | loaded=false | qs=0
reperes     | _data=objet | loaded=false | qs=0
trace       | _data=objet | loaded=false | qs=0
precision   | _data=objet | loaded=false | qs=0
styleLoaded=false
```

Aucune source `geojson` ne se chargeait. Le bug n'était donc pas « spécifique à
`sondes-2009` » — il était général, et l'unique contre-exemple invoqué n'en était pas un.

**Leçon :** avant de bâtir sur un « ça, ça marche », vérifier que l'élément qui marche est
bien celui qu'on croit. Ici, une couleur mal attribuée a écarté la bonne hypothèse.

## Le second signal trompeur : `source -2`

Le diagnostic lisait `getSource('sondes-2009')._data.features.length` et rapportait `-2`.
Le document soupçonnait à juste titre un champ interne renommé. Vérification faite,
MapLibre 6 enveloppe la donnée :

```js
this._data = typeof t.data === `string` ? { url: t.data } : { geojson: t.data };
```

`_data` vaut donc `{ geojson: <FeatureCollection> }` : `_data.features` est bien
`undefined`, et le `-2` ne disait rien de l'état réel de la source. `serialize()` renvoyait
`8118` depuis le début.

## Correctif

1. **`src/map.js`** — l'URL du worker est déclarée explicitement, avant toute création de
   carte, plutôt que déduite par le bundle :

   ```js
   import { …, setWorkerUrl } from '../vendor/maplibre-gl.js';
   setWorkerUrl(new URL('../vendor/maplibre-gl-worker.js', import.meta.url).href);
   ```

   Résolu relativement au module, donc valable aussi bien en local qu'au sous-chemin de
   GitHub Pages. Choisi plutôt qu'une réécriture de la chaîne dans le bundle minifié : la
   correction reste lisible et survit à une remise à jour de `vendor/`.

2. **`tools/vendor_maplibre.py`** — la réécriture couvre désormais les noms nus en plus des
   spécificateurs d'import (et `maplibre-gl-worker-dev.mjs`), et l'en-tête documente le
   piège, pour qu'une future revendorisation ne le réintroduise pas.

3. **`src/map.js` / `src/main.js`** — `soundingsDebug()` ne lit plus `_data`. Il rapporte
   trois mesures qui localisent la panne d'un coup d'œil :
   `source` (`serialize()`, côté page) · `tuilées` (`querySourceFeatures`, sortie du
   worker) · `rendues` (`queryRenderedFeatures`, à l'écran).
   Un `source` plein avec `tuilées 0` désigne le worker ; `tuilées` plein avec `rendues 0`
   désignerait le rendu.

## Vérification

Ligne de diagnostic des Paramètres, avant puis après :

```
avant : 8118 chargées · couche visible · source -2   · rendues 0    · err: aucune
après : 8118 chargées · couche visible · source 8118 · tuilées 12354 · rendues 8118 · err: aucune
```

(`tuilées` dépasse `source` : les points proches d'un bord de tuile sont comptés dans
chaque tuile qui les tamponne. C'est normal.)

Preuve au pixel, en lisant le tampon WebGL réellement dessiné (`gl.readPixels`), couche
masquée puis visible — le panneau navigateur ne composite pas d'image, la capture d'écran
y est impossible :

```
canvas 1280x720 · pixels quasi blancs : couche masquée = 97690 · couche visible = 108568
delta = +10878 pixels
```

Les pastilles sont donc bien peintes. Enfin, `GET /vendor/maplibre-gl-worker.js → 200`
remplace le `404` sur `.mjs`, et la suite de vérifications passe : **64 tests, 0 échec**.

> Note pour reproduire en local : dans le panneau navigateur, la page est `hidden`, le
> `requestAnimationFrame` est suspendu et le démarrage reste bloqué sur `whenVisible`.
> Poser un `rAF` de substitution sur `setTimeout`, forcer `document.hidden`/
> `visibilityState`, puis émettre `visibilitychange` suffit à faire démarrer la carte et à
> l'instrumenter.

---

# Document de passation d'origine (2026-08-12, version `2026-08-12.8`)

> Conservé tel quel pour mémoire. Attention : la section « Une couche `circle`/`geojson`
> identique fonctionne » est fausse (voir plus haut), et les hypothèses A, B et C sont
> toutes écartées — la panne était en amont, dans le chargement du worker.

## Symptôme (mots de l'utilisateur)

Il coche « Traces du levé 2009 » dans les Paramètres, aucune autre couche active, et **aucune
pastille blanche n'apparaît sur le lac**. Sur sa capture : la carte des profondeurs colorée
s'affiche, les 4 pastilles cyan des relevés (`reperes`) sont visibles, **mais zéro sonde 2009**.

## Ce qui était donné pour CONFIRMÉ

- **Les données se chargent** : `app.soundings.count === 8118`. ✅ exact.
- **Le CSV est sain**, colonnes non inversées. ✅ exact.
- **`toGeoJSON()` est correct**. ✅ exact.
- **La couche existe et est visible**. ✅ exact.
- **Aucune erreur MapLibre** (`err: aucune`). ✅ exact — mais c'était un symptôme, pas un
  blanc-seing : une promesse en attente éternelle ne lève rien.
- **Le style n'est PAS rechargé au changement de fond**. ✅ exact.
- **Pas de course d'initialisation**. ✅ exact.
- **Une couche `circle`/`geojson` identique fonctionne** (`reperes`). ❌ **FAUX** — les
  pastilles cyan étaient des marqueurs HTML ; `reperes` ne s'affichait pas non plus.

## Hypothèses d'alors

- **A. Ordre d'empilement** : la couche des profondeurs recouvrirait les sondes.
  ❌ Écartée : l'ordre était bien celui voulu, et rien n'était tuilé de toute façon.
- **B. `setData` n'a pas peuplé la source.**
  ❌ Écartée : `serialize()` rapportait `8118` dès le départ.
- **C. Expression de paint dégénérée.**
  ❌ Écartée : les pastilles apparaissent avec les expressions d'origine, inchangées.

## État des demandes de la sortie terrain (contexte)

- ✅ Hachures plus voyantes (voile magenta + hachures blanches denses).
- ✅ Correction live de la carte par les relevés (patch de grille + ré-upload GPU).
- ✅ Persistance serveur des relevés via jeton GitHub perso (modèle « propriétaire écrit /
  lecture publique »), format générique réutilisable pour d'autres plans d'eau
  (`data/corrections/vassiviere.json`).
- ✅ Anti-mise-en-veille (wake lock) quand l'app est visible.
- ✅ Service worker « réseau d'abord » (fin du cache iOS collant).
- ✅ **CE BUG** : affichage des traces du levé 2009.
- ⏳ Ensuite : reprendre l'**étalonnage à Port de Vauveix** (écran Étalonnage : sondes sur
  trace, ≥5, résidu médian, IQR ≤ 1,0 m, bouton « Appliquer la correction ». Près de
  Vauveix : 57 sondes dans 100 m, la plus proche à 17 m).

## Rituel de déploiement (rappel)

1. Servir en local : `/c/Users/as/AppData/Local/Programs/Python/Python312/python.exe tools/serve.py 8140`
   (JAMAIS `python -m http.server` ; le `python` du PATH est le stub Microsoft Store).
2. Bump `src/version.js` **et** `CACHE` dans `sw.js` (même chaîne, ex. `2026-08-12.9`).
3. `git` : rebaser sur `origin/main` avant push (le workflow horaire `level.yml` commite la cote).
4. Vérifier le déploiement en interrogeant GitHub Pages (curl sur `src/version.js`) jusqu'à voir
   le nouveau numéro.
5. La carte MapLibre **ne s'affiche pas dans le panneau navigateur intégré** (page `hidden`,
   rAF suspendu, boot bloqué à `whenVisible`/`lakeMap.ready`). Les tests passent via
   `import('/test/selftest.js')` sur `http://localhost:8140/test/`. Pas de Node en local.
