// Carte : fonds IGN, position du bateau, sondes de 2009.
//
// Aucun label textuel n'est utilisé : les couches symboles de MapLibre exigent un
// serveur de glyphes, que l'application n'aurait plus hors ligne. Les fonds IGN portent
// déjà leur toponymie.

// MapLibre 6 n'expose plus d'export par défaut, seulement des exports nommés.
import { Map as MaplibreMap, Marker, ScaleControl, setWorkerUrl } from '../vendor/maplibre-gl.js';
import { angleDelta, BEARING_SETTLED_DEG, CameraFollow } from './camera.js';
import { distanceMeters } from './geo.js';
import { routeChevrons, splitRoute } from './nav.js';

// Emplacement du worker de tuilage, déclaré explicitement.
//
// Laissé à lui-même, le bundle déduit cette URL de `import.meta.url` en y forçant
// l'extension `.mjs` — alors que tools/vendor_maplibre.py renomme les modules en `.js`
// (voir l'en-tête du script). Il demande donc `vendor/maplibre-gl-worker.mjs`, qui
// n'existe pas.
//
// Cette panne est silencieuse, et c'est ce qui la rend coûteuse : le 404 du worker ne
// remonte aucune erreur MapLibre, la promesse du pool de workers ne se résout jamais, et
// TOUTE source `geojson` reste muette à vie — sondes 2009, trace, cercle de précision,
// repères — pendant que les fonds raster, les marqueurs HTML et la couche WebGL des
// profondeurs s'affichent normalement, puisqu'eux ne passent pas par le worker.
// D'où une carte d'apparence saine où seuls les calques vectoriels manquent.
//
// Fixer l'URL ici plutôt que de réécrire la chaîne dans le bundle minifié : la
// correction reste visible et survit à une remise à jour de vendor/.
setWorkerUrl(new URL('../vendor/maplibre-gl-worker.js', import.meta.url).href);

const IGN_WMTS = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
  + '&LAYER={layer}&STYLE=normal&FORMAT={format}&TILEMATRIXSET=PM'
  + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

const ATTRIBUTION = '© IGN — Géoplateforme · Bathymétrie © OFB · Cote © EDF';

const BASEMAPS = {
  plan: { layer: 'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', format: 'image/png', maxzoom: 19 },
  ortho: { layer: 'ORTHOIMAGERY.ORTHOPHOTOS', format: 'image/jpeg', maxzoom: 20 },
};

const tileUrl = (key) => IGN_WMTS
  .replace('{layer}', BASEMAPS[key].layer)
  .replace('{format}', encodeURIComponent(BASEMAPS[key].format));

function buildStyle() {
  return {
    version: 8,
    sources: Object.fromEntries(Object.keys(BASEMAPS).map((key) => [key, {
      type: 'raster',
      tiles: [tileUrl(key)],
      tileSize: 256,
      maxzoom: BASEMAPS[key].maxzoom,
      attribution: ATTRIBUTION,
    }])),
    layers: Object.keys(BASEMAPS).map((key) => ({
      id: `fond-${key}`,
      type: 'raster',
      source: key,
      layout: { visibility: key === 'plan' ? 'visible' : 'none' },
    })),
  };
}

/** Cercle géodésique approché, pour que le rayon reste juste à tous les zooms. */
function circlePolygon(lon, lat, radiusMeters, sides = 64) {
  const mPerDegLat = 111320;
  const mPerDegLon = mPerDegLat * Math.cos(lat * (Math.PI / 180));
  const ring = Array.from({ length: sides + 1 }, (_, i) => {
    const angle = (i / sides) * 2 * Math.PI;
    return [lon + (radiusMeters * Math.cos(angle)) / mPerDegLon,
      lat + (radiusMeters * Math.sin(angle)) / mPerDegLat];
  });
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

const EMPTY = { type: 'FeatureCollection', features: [] };

/** Bleu de navigation : la couleur du mode, celle de la route et de son corridor. */
const ROUTE_COLOR = '#4c8dff';

/** Ambre des sorties passées : distingue une trace parcourue (révolue) d'une route à suivre. */
const TRIP_COLOR = '#ffb454';

/**
 * Vert de la portion déjà parcourue.
 *
 * La route se teint derrière le bateau : d'un coup d'œil, on voit ce qui est fait et ce
 * qui reste, sans lire un chiffre. Vert franc plutôt que gris : il ne s'agit pas d'éteindre
 * cette partie du trajet — elle reste un repère pour revenir — mais de dire qu'elle est
 * soldée.
 */
const DONE_COLOR = '#3ddc84';

/** Pas entre deux chevrons le long de la route (m). */
const CHEVRON_SPACING_M = 40;

/** Corail du couloir de ski nautique — la couleur du mode, reprise sur la carte. */
const SKI_ROUTE_COLOR = '#ff6a4c';

/** La route porte `done` : c'est ce booléen qui choisit la couleur, tronçon par tronçon. */
const routeColor = ['case', ['get', 'done'], DONE_COLOR, ROUTE_COLOR];

const tinted = (color) => ['case', ['get', 'done'], DONE_COLOR, color];

/**
 * Deux allures de trajet, parce que deux métiers ne demandent pas la même route.
 *
 * En navigation, la route est une ligne à SUIVRE : fine, précise, et l'écart s'affiche dès
 * huit mètres. En ski nautique, c'est un COULOIR dans lequel le bateau zigzague pour rendre
 * l'eau plate au skieur ou lui donner de la vague : le corridor y est trois fois plus large,
 * et sortir de l'axe n'est plus une faute mais le geste même. Le corail le distingue au
 * premier coup d'œil du bleu de navigation — on ne se trompe pas de mode sans le voir.
 */
const ROUTE_STYLES = {
  nav: {
    color: ROUTE_COLOR,
    glow: ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 26, 19, 40],
    glowOpacity: 0.32,
    line: ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 6, 19, 9],
  },
  ski: {
    color: SKI_ROUTE_COLOR,
    glow: ['interpolate', ['linear'], ['zoom'], 12, 20, 16, 52, 19, 80],
    glowOpacity: 0.26,
    line: ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 5, 19, 7.5],
  },
};

/**
 * Plafond de finesse de rendu.
 *
 * Un iPhone annonce `devicePixelRatio` 3 : la couche de profondeur, qui est un shader
 * évalué à chaque pixel de l'écran, coûte alors neuf fois le rendu d'un ratio 1. Sur un
 * bateau au soleil, GPS allumé et écran à fond, c'est ce qui fait chauffer le téléphone —
 * et la première parade d'iOS contre la chaleur est justement de baisser la luminosité,
 * sans que ni l'application ni le réglage de luminosité n'y puissent rien.
 * Plafonner à 2 (soit « retina », toujours net) supprime 55 % du travail par image.
 */
const MAX_PIXEL_RATIO = 2;

export class LakeMap extends EventTarget {
  constructor(container, bed) {
    super();
    this.bed = bed;
    this.trail = [];

    // État d'affichage du bateau et intention de caméra (calcul pur, voir camera.js).
    this.follow = new CameraFollow();
    // `held` : des doigts sont posés sur la carte, ils commandent — on suspend le suivi le
    // temps du geste plutôt que de tirer l'image dans l'autre sens.
    this.camera = { held: new Set(), raf: 0 };

    const { west, south, east, north } = bed.meta.bounds_wgs84;
    this.map = new MaplibreMap({
      container,
      style: buildStyle(),
      center: [(west + east) / 2, (south + north) / 2],
      zoom: 12.5,
      maxZoom: 19,
      minZoom: 9,
      maxBounds: [[west - 0.08, south - 0.06], [east + 0.08, north + 0.06]],
      attributionControl: { compact: true },
      dragRotate: true,
      pitchWithRotate: false,
      touchPitch: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
    });

    this.map.addControl(new ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');

    // Grand affichage de la profondeur, ancré sous le bateau pour ne pas masquer l'eau
    // devant l'étrave en navigation. C'est un simple calque HTML : il ne tourne pas avec la
    // carte (toujours lisible à l'endroit) et se repositionne à chaque déplacement.
    this.bigDepth = document.createElement('div');
    this.bigDepth.className = 'depth-under';
    this.bigDepth.hidden = true;
    this.bigDepth.title = 'Toucher pour replacer en bas';
    this.bigDepth.innerHTML = '<span class="depth-under__num">—</span>'
      + '<span class="depth-under__unit">m</span>'
      + '<span class="depth-under__label"></span>';
    this.bigNum = this.bigDepth.querySelector('.depth-under__num');
    this.bigLabel = this.bigDepth.querySelector('.depth-under__label');
    this.map.getContainer().appendChild(this.bigDepth);
    this.bigDepth.addEventListener('click', (event) => {
      event.stopPropagation();
      this.dispatchEvent(new CustomEvent('bigdepthtoggle'));
    });
    this.map.on('move', () => this.#placeBigDepth());

    // On attend `style.load` et non `load` : `load` exige en plus une première image
    // rendue, qui n'arrive jamais tant que la page est masquée — la boucle de rendu
    // repose sur requestAnimationFrame, suspendu dans un onglet en arrière-plan.
    // Ajouter des couches ne demande que le style.
    this.ready = new Promise((resolve) => {
      const finish = () => { this.#addOverlays(); resolve(this); };
      if (this.map.isStyleLoaded()) finish();
      else this.map.once('style.load', finish);
    });

    this.map.on('dragstart', () => this.dispatchEvent(new CustomEvent('userpan')));

    // Tant qu'un doigt touche la carte, la boucle de suivi se tait : chaque ordre de
    // caméra passe par `jumpTo`, qui interrompt les gestes en cours (`stop()` coupe aussi
    // les gestionnaires d'interaction). Sans cela, pincer pour zoomer avec le cap en haut
    // donne une carte qui colle au doigt. On compte les pointeurs : lâcher un doigt d'un
    // pincement à deux ne rend pas la main.
    // Un doigt sur la carte annule un zoom en cours : le pincement ne doit rien avoir à
    // combattre, et surtout rien à quoi la boucle le ramènerait au relâchement.
    const press = (event) => {
      this.camera.held.add(event.pointerId);
      this.follow.setZoom(null);
    };
    const release = (event) => {
      if (!this.camera.held.delete(event.pointerId)) return;
      if (this.camera.held.size === 0) { this.follow.resetClock(); this.#kick(); }
    };
    this.#wireZoomReport();
    this.map.getContainer().addEventListener('pointerdown', press, { passive: true });
    // Relâchement écouté sur la fenêtre, et non sur la carte : un doigt qui quitte la carte
    // avant de se lever n'y émet aucun `pointerup`, et le suivi resterait suspendu à vie.
    window.addEventListener('pointerup', release, { passive: true });
    window.addEventListener('pointercancel', release, { passive: true });
    // Hors mode zone, le clic reste ce qu'il a toujours été : une sonde ponctuelle. On ne
    // teste même pas les contours — une zone couvre parfois un hectare, et l'ouvrir en
    // édition au moindre toucher rendrait la lecture de profondeur inaccessible dessus.
    this.map.on('click', (event) => {
      if (this.goMode) return; // en navigation, la carte ne se touche pas
      if (this.zoneMode) {
        this.dispatchEvent(new CustomEvent('zonevertex', {
          detail: { lngLat: event.lngLat, zoneId: this.#zoneAt(event.point) },
        }));
        return;
      }
      if (this.routeMode) {
        this.dispatchEvent(new CustomEvent('routevertex', { detail: event.lngLat }));
        return;
      }
      this.dispatchEvent(new CustomEvent('probe', { detail: event.lngLat }));
    });

    /**
     * Clic droit : pose un point là où l'on montre, sans attendre le GPS.
     *
     * C'est ce qui rend l'application manipulable sur un ordinateur, où il n'y a pas de
     * position : on désigne l'endroit au lieu d'y aller. MapLibre émet aussi `contextmenu`
     * sur un appui long tactile, donc le geste existe également sur le téléphone.
     */
    this.map.on('contextmenu', (event) => {
      event.preventDefault?.();
      if (this.goMode || this.routeMode) return; // route et navigation gèrent la carte autrement
      if (this.tracing) { this.dispatchEvent(new CustomEvent('zoneclose')); return; }
      this.dispatchEvent(new CustomEvent('pinpoint', { detail: event.lngLat }));
    });
    // Le menu natif du navigateur s'ouvrirait par-dessus le point qu'on vient de poser :
    // sur cette carte, le clic droit appartient à l'application.
    this.map.getContainer().addEventListener('contextmenu', (event) => event.preventDefault());

    // Double-clic : referme la zone en cours de tracé. Le zoom au double-clic est neutralisé
    // pendant le tracé (voir setZoneMode), sinon fermer une zone la ferait sauter d'un niveau.
    this.map.on('dblclick', (event) => {
      if (!this.tracing) return;
      event.preventDefault();
      this.dispatchEvent(new CustomEvent('zoneclose'));
    });
    // Diagnostic : on retient la dernière erreur MapLibre (expression de style invalide,
    // tuile en échec…), pour la remonter à l'écran.
    this.map.on('error', (e) => { this.lastError = e?.error?.message || String(e?.error || e); });
  }

  #addOverlays() {
    const map = this.map;

    map.addSource('sondes-2009', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'sondes-2009',
      type: 'circle',
      source: 'sondes-2009',
      layout: { visibility: 'none' },
      paint: {
        // Pastilles blanches cerclées de sombre : lisibles à la fois sur le plan IGN clair
        // et sur les fonds colorés. Plus grosses et plus opaques qu'avant, où elles étaient
        // quasi invisibles. Le cercle sombre garantit le contraste sur fond clair.
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 13, 3.5, 16, 6, 19, 9],
        'circle-color': '#ffffff',
        'circle-opacity': 1,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 15, 1.8, 19, 2.6],
        'circle-stroke-color': '#0b1a2b',
      },
    });

    // Zones émergées tracées à la main. Le fond colorié dit déjà, par sa couleur, que le
    // terrain est hors d'eau : la zone n'a donc pas à le repeindre, seulement à montrer où
    // s'arrête ce qu'on a affirmé. D'où un contour franc et un remplissage presque nul,
    // renforcé sur la seule zone sélectionnée.
    map.addSource('zones', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'zones-fond',
      type: 'fill',
      source: 'zones',
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': ['case', ['get', 'selected'], 0.32, 0.12],
      },
    });
    map.addLayer({
      id: 'zones-bord',
      type: 'line',
      source: 'zones',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['get', 'selected'], 3, 2],
        'line-opacity': 0.95,
      },
    });

    // Tracé en cours : mêmes couleurs, mais en pointillé et sommets visibles — on doit voir
    // que rien n'est encore décidé, et pouvoir viser le sommet qu'on va reprendre.
    map.addSource('zone-trace', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'zone-trace-fond',
      type: 'fill',
      source: 'zone-trace',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#c8a165', 'fill-opacity': 0.2 },
    });
    map.addLayer({
      id: 'zone-trace-ligne',
      type: 'line',
      source: 'zone-trace',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#f5d9a8', 'line-width': 2, 'line-dasharray': [2, 2] },
    });
    map.addLayer({
      id: 'zone-trace-sommets',
      type: 'circle',
      source: 'zone-trace',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 5,
        'circle-color': '#f5d9a8',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#3a2606',
      },
    });

    map.addSource('trace', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'trace',
      type: 'line',
      source: 'trace',
      paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.6, 'line-dasharray': [2, 2] },
    });

    map.addSource('precision', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'precision-fond',
      type: 'fill',
      source: 'precision',
      paint: { 'fill-color': '#4db3ff', 'fill-opacity': 0.15 },
    });
    map.addLayer({
      id: 'precision-bord',
      type: 'line',
      source: 'precision',
      paint: { 'line-color': '#4db3ff', 'line-width': 1, 'line-opacity': 0.7 },
    });

    // Trajet suivi (mode Go) et trajet en construction. Deux sources : la route active,
    // dessinée en corridor lumineux façon piste de drone, et le brouillon du constructeur,
    // en pointillé. Les points de passage restent des marqueurs HTML (setRouteWaypoints) —
    // pas de couche symbole chiffrée, faute de serveur de glyphes hors ligne.
    this.#addChevronImages();
    map.addSource('route', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'route-glow',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-color': routeColor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 26, 19, 40],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 12, 6, 16, 16],
        'line-opacity': 0.32,
      },
    });
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-color': routeColor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 6, 19, 9],
        'line-opacity': 0.95,
      },
    });
    // Trait clair pointillé, animé (voir #startFlow) : donne le sens de la marche, comme le
    // fil lumineux qui « coule » sur une piste de drone.
    map.addLayer({
      id: 'route-flow',
      type: 'line',
      source: 'route',
      // Le fil ne coule que devant : derrière le bateau, il n'y a plus de marche à indiquer.
      filter: ['!', ['get', 'done']],
      layout: { 'line-cap': 'butt', visibility: 'none' },
      paint: {
        'line-color': '#eaf4ff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.6, 16, 3.2],
        'line-opacity': 0.9,
        'line-dasharray': [0, 4, 3],
      },
    });
    // Chevrons posés en POINTS, chacun tourné du relèvement de son segment (voir
    // `routeChevrons`). La pose sur ligne de MapLibre couche l'image comme une ligne de
    // texte — l'axe horizontal de l'icône suit la route — et sortait donc le chevron à 90°
    // de la marche. Une rotation explicite ne dépend d'aucune convention de rendu.
    map.addSource('route-marks', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'route-chevrons',
      type: 'symbol',
      source: 'route-marks',
      layout: {
        visibility: 'none',
        'icon-image': ['case', ['get', 'done'], 'route-chevron-done', 'route-chevron'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 0.85],
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        // Sans recouvrement : le pas est en mètres, donc les chevrons se resserrent à
        // l'écran quand on dézoome ; c'est la sélection de MapLibre qui les éclaircit alors,
        // au lieu d'en faire une file illisible.
        'icon-allow-overlap': false,
        'icon-ignore-placement': false,
        'icon-padding': 2,
      },
    });

    // Brouillon du constructeur : ligne pointillée bleue (les sommets sont des marqueurs HTML).
    map.addSource('route-draft', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'route-draft-line',
      type: 'line',
      source: 'route-draft',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ROUTE_COLOR, 'line-width': 2.5, 'line-dasharray': [2, 2], 'line-opacity': 0.9 },
    });

    // Sortie passée (revue dans l'Historique) : trait ambre plein, doublé d'un halo doux
    // pour rester lisible sur n'importe quel fond. Ambre et non bleu : c'est une trace
    // parcourue, un fait révolu, pas une route à suivre.
    map.addSource('trip', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'trip-glow',
      type: 'line',
      source: 'trip',
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-color': TRIP_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 6, 16, 16],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 12, 4, 16, 10],
        'line-opacity': 0.3,
      },
    });
    map.addLayer({
      id: 'trip-line',
      type: 'line',
      source: 'trip',
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-color': TRIP_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 5, 19, 7],
        'line-opacity': 0.95,
      },
    });

    const element = document.createElement('div');
    element.className = 'boat';
    element.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M12 2 L19 21 L12 17 L5 21 Z" fill="#ff2d55" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    this.boatElement = element;
    this.boat = new Marker({ element, rotationAlignment: 'map', pitchAlignment: 'map' });
  }

  addDepthLayer(layer) {
    // Sous les sondes et le bateau, au-dessus des fonds de carte.
    this.map.addLayer(layer, 'sondes-2009');
  }

  setBasemap(key) {
    Object.keys(BASEMAPS).forEach((name) => {
      this.map.setLayoutProperty(`fond-${name}`, 'visibility', name === key ? 'visible' : 'none');
    });
  }

  setSoundings(geojson, visible) {
    if (geojson) this.map.getSource('sondes-2009').setData(geojson);
    this.map.setLayoutProperty('sondes-2009', 'visibility', visible ? 'visible' : 'none');
  }

  /**
   * Diagnostic : état réel du calque des sondes 2009 tel que MapLibre le voit.
   *
   * Trois mesures, à lire dans cet ordre — c'est ce qui localise la panne d'un coup d'œil :
   *   `data`   : ce que la source détient côté page (`serialize()`, et non le champ interne
   *              `_data`, dont le nom change au gré des versions et de la minification —
   *              le lire donnait « source vide » alors que la source était pleine) ;
   *   `tiled`  : ce que le worker de tuilage a effectivement produit. À 0 avec `data` plein,
   *              le worker ne répond pas (voir setWorkerUrl en haut de ce fichier) ;
   *   `rendered` : ce qui est peint à l'écran. À 0 avec `tiled` plein, c'est le rendu.
   */
  soundingsDebug() {
    const m = this.map;
    const out = { vis: '?', data: -1, tiled: -1, rendered: -1, err: this.lastError || 'aucune' };
    try { out.vis = m.getLayoutProperty('sondes-2009', 'visibility') ?? 'visible'; } catch { /* */ }
    try { out.data = m.getSource('sondes-2009')?.serialize()?.data?.features?.length ?? -2; } catch { /* */ }
    try { out.tiled = m.querySourceFeatures('sondes-2009').length; } catch { /* */ }
    try { out.rendered = m.queryRenderedFeatures({ layers: ['sondes-2009'] }).length; } catch { /* */ }
    return out;
  }

  /**
   * Sondes saisies à la main : une pastille chiffrée par point, en surcouche du fond
   * colorié. Un haut-fond découvert prend la forme d'îlot des points de simulation — même
   * réalité, même signe, donc même symbole ; il doit se repérer sans lire le chiffre.
   * Des marqueurs HTML plutôt qu'une couche symbole, car les labels de MapLibre
   * exigent un serveur de glyphes que l'application n'aurait plus hors ligne. Recréés en
   * bloc à chaque changement (ajout, suppression, ou recalcul après un mouvement de cote) ;
   * on ne les touche pas à chaque point GPS, donc le coût reste négligeable.
   */
  setProbes(points) {
    if (!this.probeMarkers) this.probeMarkers = [];
    for (const marker of this.probeMarkers) marker.remove();
    this.probeMarkers = points.map((p) => {
      const element = document.createElement('div');
      element.className = p.emerged ? 'probe-mark is-emerged' : 'probe-mark';
      if (p.editing) element.classList.add('is-editing');
      element.textContent = p.label;
      // Toucher une pastille l'ouvre en correction. stopPropagation empêche que le clic
      // retombe sur la carte et déclenche la sonde ponctuelle.
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent('probeselect', { detail: p.id }));
      });
      return new Marker({ element, anchor: 'center' }).setLngLat([p.lon, p.lat]).addTo(this.map);
    });
  }

  /**
   * Points de simulation d'étiage. Même mécanique que setProbes, mais un rendu propre :
   * une goutte ambre quand le point est immergé, un pictogramme d'îlot quand la cote
   * simulée l'a fait émerger. Recréés en bloc à chaque changement de cote pour que le
   * basculement émergé/immergé suive le curseur de niveau.
   */
  setSimPoints(points) {
    if (!this.simMarkers) this.simMarkers = [];
    for (const marker of this.simMarkers) marker.remove();
    this.simMarkers = points.map((p) => {
      const element = document.createElement('div');
      element.className = p.emerged ? 'sim-mark is-emerged' : 'sim-mark';
      if (p.editing) element.classList.add('is-editing');
      element.textContent = p.label;
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent('simselect', { detail: p.id }));
      });
      return new Marker({ element, anchor: 'center' }).setLngLat([p.lon, p.lat]).addTo(this.map);
    });
  }

  /**
   * Point désigné à la main, en attente de sa profondeur.
   *
   * Il ne s'agit pas encore d'une sonde : tant que la valeur n'est pas saisie, ce repère ne
   * dit que « c'est ici ». On le distingue donc nettement des pastilles chiffrées, qui,
   * elles, portent une mesure.
   */
  setPin(lngLat) {
    if (!lngLat) { this.pinMarker?.remove(); this.pinMarker = null; return; }
    if (!this.pinMarker) {
      const element = document.createElement('div');
      element.className = 'pin-mark';
      element.title = 'Point posé à la main — saisissez la profondeur';
      this.pinMarker = new Marker({ element, anchor: 'center' });
    }
    this.pinMarker.setLngLat([lngLat.lng ?? lngLat.lon, lngLat.lat]).addTo(this.map);
  }

  /** Zones émergées enregistrées. Les anneaux sont attendus fermés (premier sommet répété). */
  setZones(zones, color = '#c8a165') {
    const source = this.map.getSource('zones');
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: zones.map((z) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [z.ring] },
        properties: { id: z.id, selected: Boolean(z.selected), color },
      })),
    });
  }

  /** Zone en cours de tracé : sommets posés, ligne, et remplissage dès trois points. */
  setZoneDraft(points) {
    const source = this.map.getSource('zone-trace');
    if (!source) return;
    const features = points.map((p) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {},
    }));
    if (points.length >= 2) {
      const line = points.length >= 3 ? [...points, points[0]] : points;
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} });
    }
    if (points.length >= 3) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[...points, points[0]]] },
        properties: {},
      });
    }
    source.setData({ type: 'FeatureCollection', features });
  }

  /**
   * Mode zone : le clic sert au tracé (et à la reprise d'un contour) au lieu de sonder.
   *
   * `tracing` distingue le tracé en cours de la simple sélection : c'est lui qui neutralise
   * le zoom au double-clic, sans quoi refermer un contour ferait sauter la carte d'un
   * niveau au moment précis où l'on vise.
   */
  setZoneMode(active, tracing) {
    this.zoneMode = Boolean(active);
    this.tracing = Boolean(tracing);
    if (this.tracing) this.map.doubleClickZoom.disable();
    else { this.map.doubleClickZoom.enable(); this.setZoneDraft([]); }
    this.map.getCanvas().style.cursor = this.zoneMode ? 'crosshair' : '';
  }

  /**
   * Zone sous le doigt, ou null. La boîte de tolérance vaut mieux qu'un point exact : sur
   * un écran tactile, viser l'intérieur d'un contour de quelques pixels est illusoire.
   */
  #zoneAt(point) {
    try {
      const box = [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]];
      return this.map.queryRenderedFeatures(box, { layers: ['zones-fond'] })[0]?.properties?.id ?? null;
    } catch {
      return null; // couche pas encore ajoutée : rien à sélectionner
    }
  }

  /**
   * Nouveau point GPS.
   *
   * Le bateau n'y saute pas : la position affichée est une estime continue, avancée à
   * chaque image et recalée en douceur sur ce point (voir camera.js). Ce qui suit ici,
   * en revanche, reste adossé au point vrai — la trace est un relevé de ce qu'on a
   * réellement parcouru, et le cercle de précision décrit l'incertitude de la **mesure**,
   * pas celle de l'interpolation. Les deux se contentent donc du rythme du GPS.
   */
  setPosition(position) {
    const { lon, lat, accuracy, speed, heading } = position;
    this.follow.setFix({ lon, lat, speed, heading, at: performance.now() });

    this.map.getSource('precision').setData(
      accuracy ? circlePolygon(lon, lat, accuracy) : EMPTY,
    );

    this.trail.push([lon, lat]);
    if (this.trail.length > 600) this.trail.shift();
    this.map.getSource('trace').setData({
      type: 'Feature', geometry: { type: 'LineString', coordinates: this.trail }, properties: {},
    });

    this.#kick();
  }

  /**
   * Cap mesuré (boussole de l'appareil en priorité, cap GPS en repli). Ni l'aiguille ni la
   * carte ne sont touchées ici : le cap affiché est amorti dans la boucle, sans quoi le
   * tremblement de la boussole ferait vibrer toute la carte en « cap en haut ».
   */
  setHeading(heading) {
    if (!Number.isFinite(heading)) return;
    this.follow.setHeading(heading);
    this.#kick();
  }

  /** Suivre le bateau : la carte le ramène au centre et l'y garde. */
  setFollow(on) {
    if (this.follow.follow === Boolean(on)) return;
    this.follow.setFollow(on);
    this.follow.resetClock();
    this.#kick();
  }

  /**
   * Cap en haut : la carte tourne pour que l'étrave pointe vers le haut de l'écran.
   *
   * En le relâchant, on revient au nord en douceur — c'est la boucle qui s'en charge, et
   * non un `easeTo`, qui serait annulé par le premier recentrage venu (voir camera.js).
   * À l'inverse du suivi, tourner la carte à la main ne désarme pas le cap en haut : le
   * bouton reste le seul maître du cap, sans quoi le moindre pincement le désactiverait.
   */
  setTrackUp(on) {
    if (this.follow.trackUp === Boolean(on)) return;
    this.follow.setTrackUp(on);
    this.follow.resetClock();
    this.#kick();
  }

  /**
   * Règle le zoom pour montrer environ `metres` de largeur à l'écran.
   *
   * Mesuré plutôt que calculé : on déprojette les deux bords de la carte pour connaître la
   * largeur réellement affichée, et on corrige le zoom du rapport. Aucune constante de
   * projection à maintenir, et le cadrage est le même sur tous les téléphones, quelle que
   * soit la largeur de leur écran.
   */
  /**
   * Zoom par paliers, depuis les boutons. On part du zoom déjà visé s'il y en a un, pour
   * que deux appuis rapides s'additionnent au lieu de se remplacer. Le résultat est borné
   * aux limites de la carte : viser un zoom inatteignable ferait tourner la boucle sans
   * jamais arriver.
   */
  zoomBy(delta) {
    const from = this.follow.zoomTarget ?? this.map.getZoom();
    const target = Math.min(Math.max(from + delta, this.map.getMinZoom()), this.map.getMaxZoom());
    this.follow.setZoom(target);
    this.#kick();
  }

  getZoom() {
    return this.map.getZoom();
  }

  setZoom(zoom) {
    if (Number.isFinite(zoom)) this.map.setZoom(zoom);
  }

  /**
   * Prévient d'un changement de zoom, une fois qu'il s'est calmé.
   *
   * Amorti parce que la boucle de caméra rend le zoom image par image : sans cela, un seul
   * appui sur « + » déclencherait une trentaine d'écritures de réglage.
   */
  #wireZoomReport() {
    let timer = 0;
    this.map.on('zoomend', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.dispatchEvent(new CustomEvent('zoomchange', { detail: this.map.getZoom() }));
      }, 800);
    });
  }

  setVisibleWidth(metres) {
    const container = this.map.getContainer();
    const width = container.clientWidth;
    if (!(width > 0) || !(metres > 0)) return;
    const y = container.clientHeight / 2;
    const left = this.map.unproject([0, y]);
    const right = this.map.unproject([width, y]);
    const shown = distanceMeters(left.lng, left.lat, right.lng, right.lat);
    if (!(shown > 0)) return;
    this.map.setZoom(this.map.getZoom() + Math.log2(shown / metres));
  }

  /** Demande une image de suivi, si une n'est pas déjà en attente. */
  #kick() {
    if (this.camera.raf || this.camera.held.size) return;
    this.camera.raf = requestAnimationFrame(this.#tick);
  }

  /**
   * Une image de suivi : on avance l'état d'affichage, on place le bateau, puis on commande
   * la carte — centre et cap dans un seul ordre, c'est ce qui empêche l'un d'annuler
   * l'autre. On ne redemande une image que s'il reste du mouvement : au mouillage, boussole
   * comprise, la boucle s'arrête complètement.
   */
  #tick = (now) => {
    this.camera.raf = 0;
    if (this.camera.held.size) return;

    const out = this.follow.step(now, {
      center: this.map.getCenter().toArray(),
      bearing: this.map.getBearing(),
      zoom: this.map.getZoom(),
    });

    if (out.position) {
      this.boatLngLat = out.position;
      this.boat.setLngLat(out.position);
      if (!this.boat._map) this.boat.addTo(this.map);
    }
    if (Number.isFinite(out.heading)) this.boat.setRotation(out.heading);

    const move = {};
    if (out.center) move.center = out.center;
    if (out.bearing !== null) move.bearing = out.bearing;
    if (out.zoom !== null) move.zoom = out.zoom;
    if (move.center || move.bearing !== null || move.zoom !== undefined) this.map.jumpTo(move);
    // Suivi coupé : la carte ne bouge pas, donc son événement `move` ne se déclenche pas —
    // c'est ici qu'il faut resituer le grand affichage sous le bateau qui, lui, avance.
    else if (out.position) this.#placeBigDepth();

    if (this.follow.toNorth
      && Math.abs(angleDelta(this.map.getBearing(), 0)) <= BEARING_SETTLED_DEG) {
      this.follow.toNorth = false; // arrivé au nord : la carte est rendue à l'utilisateur
    }

    if (out.done) this.follow.resetClock();
    else this.#kick();
  };

  /**
   * Grand affichage de profondeur sous le bateau. `state` = null pour masquer, sinon
   * { value, label, color, warning }. Le chiffre reprend la couleur de la plage.
   */
  setBigDepth(state) {
    if (!state) { this.bigDepth.hidden = true; return; }
    this.bigDepth.hidden = false;
    this.bigNum.textContent = state.value;
    this.bigLabel.textContent = state.label ?? '';
    this.bigDepth.style.color = state.color || '';
    this.bigDepth.classList.toggle('is-warning', Boolean(state.warning));
    this.#placeBigDepth();
  }

  #placeBigDepth() {
    if (this.bigDepth.hidden) return;
    // À défaut de position GPS, on l'ancre au centre visible pour éviter un saut au coin.
    const anchor = this.boatLngLat ?? this.map.getCenter().toArray();
    const p = this.map.project(anchor);
    // translate(-50%, …) centre horizontalement ; le décalage vertical dégage l'icône du
    // bateau pour placer le chiffre juste en dessous.
    this.bigDepth.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, 30px)`;
  }

  clearTrail() {
    this.trail = [];
    this.map.getSource('trace').setData(EMPTY);
  }

  // ------------------------------------------------------------------ trajets

  /**
   * Chevrons dessinés sur un canvas et versés en images de la carte.
   *
   * Deux images plutôt qu'une teintée : une couche symbole ne recolore que des icônes SDF,
   * qui exigeraient un champ de distance — pour deux couleurs fixes, deux dessins coûtent
   * moins cher qu'un format d'image à fabriquer.
   *
   * Le chevron pointe vers le HAUT du canvas, ce que `icon-rotate: 0` place au nord :
   * tourné du relèvement du segment, il pointe alors vers le point de passage suivant.
   */
  #addChevronImages() {
    for (const [name, color] of [['route-chevron', '#eaf4ff'], ['route-chevron-done', DONE_COLOR]]) {
      if (this.map.hasImage?.(name)) continue;
      const size = 28;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const g = canvas.getContext('2d');
      g.strokeStyle = color;
      g.lineWidth = 4.5;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(7, 18);
      g.lineTo(size / 2, 9);
      g.lineTo(size - 7, 18);
      g.stroke();
      const { data } = g.getImageData(0, 0, size, size);
      try {
        this.map.addImage(name, { width: size, height: size, data }, { pixelRatio: 2 });
      } catch { /* déjà présente (style rechargé) : sans conséquence */ }
    }
  }

  #showRouteLayers(on) {
    for (const id of ['route-glow', 'route-line', 'route-flow', 'route-chevrons']) {
      this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  }

  #renderWaypointMarkers(field, points, { active }) {
    if (!this[field]) this[field] = [];
    for (const m of this[field]) m.remove();
    const last = points.length - 1;
    this[field] = points.map((p, i) => {
      const el = document.createElement('div');
      el.className = 'wpt-mark';
      if (i === 0) el.classList.add('is-start');
      else if (i === last) el.classList.add('is-end');
      if (p.editing) el.classList.add('is-editing');
      el.textContent = i === 0 ? '⚑' : i === last ? '◎' : String(i + 1);
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent('wptselect', { detail: { index: i, active } }));
      });
      return new Marker({ element: el, anchor: 'center' })
        .setLngLat([p.lon ?? p[0], p.lat ?? p[1]]).addTo(this.map);
    });
  }

  /** Trajet actif (aperçu / navigation) : corridor lumineux + chevrons + points de passage. */
  setRoute(points, { waypoints = true } = {}) {
    const coords = points.map((p) => [p.lon ?? p[0], p.lat ?? p[1]]);
    this.routeCoords = coords;
    this.routeMarks = routeChevrons(coords, CHEVRON_SPACING_M);
    this.#drawRoute(null, null);
    this.#showRouteLayers(coords.length >= 2);
    this.#renderWaypointMarkers('routeMarkers', waypoints ? points : [], { active: true });
  }

  /**
   * Avancement sur le trajet suivi : la portion derrière le bateau passe au vert.
   *
   * Appelée à chaque point GPS, donc une fois par seconde : elle ne fait que réécrire deux
   * sources GeoJSON, sans toucher aux couches ni aux marqueurs.
   */
  setRouteProgress(fromIndex, snapped, alongM) {
    if (!this.routeCoords || this.routeCoords.length < 2) return;
    this.#drawRoute({ fromIndex, snapped }, alongM);
  }

  #drawRoute(progress, alongM) {
    const coords = this.routeCoords ?? [];
    if (coords.length < 2) {
      this.map.getSource('route')?.setData(EMPTY);
      this.map.getSource('route-marks')?.setData(EMPTY);
      return;
    }
    const { done, todo } = progress
      ? splitRoute(coords, progress.fromIndex, progress.snapped)
      : { done: [], todo: coords };
    const line = (path, isDone) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: path },
      properties: { done: isDone },
    });
    const features = [];
    if (todo.length >= 2) features.push(line(todo, false));
    if (done.length >= 2) features.push(line(done, true));
    this.map.getSource('route').setData({ type: 'FeatureCollection', features });

    const limit = Number.isFinite(alongM) ? alongM : -1;
    this.map.getSource('route-marks').setData({
      type: 'FeatureCollection',
      features: (this.routeMarks ?? []).map((m) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
        properties: { bearing: m.bearing, done: m.alongM <= limit },
      })),
    });
  }

  clearRoute() {
    this.routeCoords = null;
    this.routeMarks = null;
    this.map.getSource('route')?.setData(EMPTY);
    this.map.getSource('route-marks')?.setData(EMPTY);
    this.#showRouteLayers(false);
    this.#renderWaypointMarkers('routeMarkers', [], { active: true });
  }

  /** Trajet en construction : ligne pointillée + sommets numérotés (marqueurs HTML). */
  setRouteDraft(points, { editingIndex = -1 } = {}) {
    const coords = points.map((p) => [p[0], p[1]]);
    this.map.getSource('route-draft').setData(coords.length >= 2
      ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }
      : EMPTY);
    const marks = coords.map((c, i) => ({ 0: c[0], 1: c[1], editing: i === editingIndex }));
    this.#renderWaypointMarkers('draftMarkers', marks, { active: false });
  }

  clearRouteDraft() {
    this.map.getSource('route-draft')?.setData(EMPTY);
    this.#renderWaypointMarkers('draftMarkers', [], { active: false });
  }

  // -------------------------------------------------------------- sorties (Historique)

  /**
   * Affiche la trace d'une sortie passée et cadre la carte dessus. Départ et arrivée sont
   * marqués (⚑ / ◎), mais pas les points intermédiaires : une trace en compte des centaines,
   * les numéroter la rendrait illisible.
   */
  showTrip(points) {
    const coords = points.map((p) => [p[0], p[1]]);
    this.map.getSource('trip').setData(coords.length >= 2
      ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }
      : EMPTY);
    for (const id of ['trip-glow', 'trip-line']) {
      this.map.setLayoutProperty(id, 'visibility', coords.length >= 2 ? 'visible' : 'none');
    }
    const ends = coords.length >= 2 ? [coords[0], coords[coords.length - 1]] : [];
    this.#renderWaypointMarkers('tripMarkers', ends, { active: false });
    if (coords.length >= 2) this.#fitTo(coords);
  }

  clearTrip() {
    this.map.getSource('trip')?.setData(EMPTY);
    for (const id of ['trip-glow', 'trip-line']) {
      this.map.setLayoutProperty(id, 'visibility', 'none');
    }
    this.#renderWaypointMarkers('tripMarkers', [], { active: false });
  }

  /** Cadre la carte sur une suite de points, avec une marge, sans zoomer à l'excès. */
  #fitTo(coords) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lon, lat] of coords) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    if (!(e >= w) || !(n >= s)) return;
    this.map.fitBounds([[w, s], [e, n]], { padding: 56, maxZoom: 16, duration: 600 });
  }

  /**
   * Cadre le trajet entier, à plat, au départ d'une navigation : l'aperçu qui répond à
   * « est-ce bien celui-là ? ». La caméra de barre prend le relais ensuite (`enterNavCam`),
   * d'où le tangage remis à zéro ici — un `fitBounds` sur une vue inclinée cadre la
   * projection au sol, pas ce qu'on voit.
   */
  previewRoute(points) {
    const coords = points.map((p) => [p[0], p[1]]);
    this.map.setPitch(0);
    if (coords.length >= 2) this.#fitTo(coords);
    else if (coords.length === 1) this.map.jumpTo({ center: coords[0] });
  }

  /**
   * Allure du trajet affiché : `'nav'` (ligne à suivre) ou `'ski'` (couloir à occuper).
   *
   * Les couches ne sont pas dupliquées, seules leurs propriétés de peinture changent : une
   * seconde source de vérité pour la même route finirait par en montrer deux.
   */
  setRouteStyle(kind = 'nav') {
    const style = ROUTE_STYLES[kind] ?? ROUTE_STYLES.nav;
    try {
      this.map.setPaintProperty('route-glow', 'line-color', tinted(style.color));
      this.map.setPaintProperty('route-glow', 'line-width', style.glow);
      this.map.setPaintProperty('route-glow', 'line-opacity', style.glowOpacity);
      this.map.setPaintProperty('route-line', 'line-color', tinted(style.color));
      this.map.setPaintProperty('route-line', 'line-width', style.line);
    } catch { /* style rechargé entre-temps : le prochain passage remettra l'allure */ }
  }

  /** En mode construction, le clic pose un point de passage au lieu de sonder. */
  setRouteMode(active) {
    this.routeMode = Boolean(active);
    this.map.getCanvas().style.cursor = this.routeMode ? 'crosshair' : '';
  }

  // ----------------------------------------------------------- navigation (Go)

  /** En navigation, la carte ne répond plus au toucher : on la regarde, on ne la touche pas. */
  setGoMode(active) {
    this.goMode = Boolean(active);
  }

  /**
   * Caméra de navigation : vue inclinée façon chase-cam. Le pas de tangage est appliqué net
   * (`setPitch`), et non animé : la boucle de suivi commande centre, cap et zoom par
   * `jumpTo`, qui ne touche pas au tangage — un `easeTo` concurrent serait annulé image après
   * image et donnerait un pompage.
   */
  enterNavCam(pitch = 55) {
    this.map.setPitch(pitch);
    this.#startFlow();
  }

  /**
   * Retour au cadrage de navigation : bateau au centre, étrave en haut, zoom de route.
   *
   * En navigation le suivi est déjà forcé, mais le pincement, lui, reste rendu à la main
   * (`follow.setZoom(null)` au premier doigt posé) — c'est ce qui permet de dézoomer pour
   * embrasser tout le trajet. Sans ce bouton, rien ne ramenait ensuite à l'échelle de
   * barre : il faut une commande qui rende la vue de travail d'un seul geste.
   */
  recenterNav(zoom) {
    this.follow.setFollow(true);
    this.follow.setTrackUp(true);
    if (Number.isFinite(zoom)) this.follow.setZoom(zoom);
    this.follow.resetClock();
    this.#kick();
  }

  exitNavCam() {
    this.#stopFlow();
    this.map.setPitch(0);
  }

  /** Atténue le fond de carte : en navigation, la route passe devant, le fond recule. */
  setBasemapDim(on) {
    Object.keys(BASEMAPS).forEach((key) => {
      try { this.map.setPaintProperty(`fond-${key}`, 'raster-opacity', on ? 0.5 : 1); } catch { /* couche absente */ }
    });
  }

  /**
   * Fait « couler » le fil clair le long de la route, comme la piste lumineuse d'un drone.
   * On fait défiler le motif de pointillés — MapLibre n'a pas de décalage de tirets — à
   * cadence modérée : le rendu est de toute façon suspendu quand la page est masquée.
   */
  #startFlow() {
    if (this.flowTimer) return;
    const seq = [
      [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5],
      [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5],
    ];
    let i = 0;
    this.flowTimer = setInterval(() => {
      i = (i + 1) % seq.length;
      try { this.map.setPaintProperty('route-flow', 'line-dasharray', seq[i]); } catch { /* */ }
    }, 90);
  }

  #stopFlow() {
    if (this.flowTimer) { clearInterval(this.flowTimer); this.flowTimer = null; }
  }

  /** Prochaine « porte » à franchir : anneau qui pulse sur le point de passage visé. */
  setGate(lngLat) {
    if (!lngLat) { this.gateMarker?.remove(); this.gateMarker = null; return; }
    if (!this.gateMarker) {
      const el = document.createElement('div');
      el.className = 'go-gate';
      this.gateMarker = new Marker({ element: el, anchor: 'center' });
    }
    this.gateMarker.setLngLat([lngLat[0], lngLat[1]]).addTo(this.map);
  }
}
