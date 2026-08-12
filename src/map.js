// Carte : fonds IGN, position du bateau, sondes de 2009.
//
// Aucun label textuel n'est utilisé : les couches symboles de MapLibre exigent un
// serveur de glyphes, que l'application n'aurait plus hors ligne. Les fonds IGN portent
// déjà leur toponymie.

// MapLibre 6 n'expose plus d'export par défaut, seulement des exports nommés.
import { Map as MaplibreMap, Marker, ScaleControl } from '../vendor/maplibre-gl.js';

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

export class LakeMap extends EventTarget {
  constructor(container, bed) {
    super();
    this.bed = bed;
    this.trail = [];

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
    this.map.on('click', (event) => this.dispatchEvent(
      new CustomEvent('probe', { detail: event.lngLat }),
    ));
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

  /** Diagnostic : état réel du calque des sondes 2009 tel que MapLibre le voit. */
  soundingsDebug() {
    const m = this.map;
    const out = { vis: '?', source: -1, rendered: -1, order: '?' };
    try { out.vis = m.getLayoutProperty('sondes-2009', 'visibility') ?? 'visible'; } catch { /* */ }
    try { out.source = m.querySourceFeatures('sondes-2009').length; } catch { /* */ }
    try { out.rendered = m.queryRenderedFeatures({ layers: ['sondes-2009'] }).length; } catch { /* */ }
    try {
      const ids = m.getStyle().layers.map((l) => l.id);
      out.order = `${ids.indexOf('profondeurs')}<${ids.indexOf('sondes-2009')}`;
    } catch { /* */ }
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
   * colorié. Des marqueurs HTML plutôt qu'une couche symbole, car les labels de MapLibre
   * exigent un serveur de glyphes que l'application n'aurait plus hors ligne. Recréés en
   * bloc à chaque changement (ajout, suppression, ou recalcul après un mouvement de cote) ;
   * on ne les touche pas à chaque point GPS, donc le coût reste négligeable.
   */
  setProbes(points) {
    if (!this.probeMarkers) this.probeMarkers = [];
    for (const marker of this.probeMarkers) marker.remove();
    this.probeMarkers = points.map((p) => {
      const element = document.createElement('div');
      element.className = p.editing ? 'probe-mark is-editing' : 'probe-mark';
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

  setPosition(position, { follow }) {
    const { lon, lat, accuracy } = position;
    this.boatLngLat = [lon, lat];
    this.boat.setLngLat([lon, lat]);
    if (!this.boat._map) this.boat.addTo(this.map);
    this.#placeBigDepth();

    this.map.getSource('precision').setData(
      accuracy ? circlePolygon(lon, lat, accuracy) : EMPTY,
    );

    this.trail.push([lon, lat]);
    if (this.trail.length > 600) this.trail.shift();
    this.map.getSource('trace').setData({
      type: 'Feature', geometry: { type: 'LineString', coordinates: this.trail }, properties: {},
    });

    // Recentrage seul : le cap (aiguille + orientation de la carte) est piloté à part par
    // setHeading, depuis la même source que la barre-boussole.
    if (follow) this.map.easeTo({ center: [lon, lat], bearing: this.map.getBearing(), duration: 600 });
  }

  /**
   * Oriente l'aiguille du bateau et, en mode « cap en haut », la carte elle-même — à partir
   * du cap unifié (boussole de l'appareil en priorité, cap GPS en repli). Appelé bien plus
   * souvent qu'un point GPS : on utilise setBearing (instantané) plutôt qu'une animation,
   * le cap étant déjà lissé en amont, pour une rotation fluide sans empiler d'easeTo.
   */
  setHeading(heading, trackUp) {
    if (!Number.isFinite(heading)) return;
    this.boat.setRotation(heading);
    if (trackUp) this.map.setBearing(heading);
  }

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

  resetNorth() {
    this.map.easeTo({ bearing: 0, duration: 400 });
  }

  clearTrail() {
    this.trail = [];
    this.map.getSource('trace').setData(EMPTY);
  }
}
