// Carte : fonds IGN, position du bateau, sondes de 2009.
//
// Aucun label textuel n'est utilisé : les couches symboles de MapLibre exigent un
// serveur de glyphes, que l'application n'aurait plus hors ligne. Les fonds IGN portent
// déjà leur toponymie.

// MapLibre 6 n'expose plus d'export par défaut, seulement des exports nommés.
import { Map as MaplibreMap, Marker, ScaleControl, setWorkerUrl } from '../vendor/maplibre-gl.js';
import { angleDelta, BEARING_SETTLED_DEG, CameraFollow } from './camera.js';
import { distanceMeters } from './geo.js';

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
    this.map.on('click', (event) => this.dispatchEvent(
      new CustomEvent('probe', { detail: event.lngLat }),
    ));
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

    map.addSource('reperes', { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: 'reperes',
      type: 'circle',
      source: 'reperes',
      paint: {
        'circle-radius': 7,
        'circle-color': ['case', ['get', 'onTrack'], '#22c55e', '#f59e0b'],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#0f1417',
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
    // Sous les repères et le bateau, au-dessus des fonds de carte.
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

  setMarkers(records) {
    this.map.getSource('reperes').setData({
      type: 'FeatureCollection',
      features: records.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
        properties: { onTrack: Boolean(r.onTrack) },
      })),
    });
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
}
