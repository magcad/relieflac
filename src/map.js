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
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1, 15, 2.5, 18, 5],
        'circle-color': '#ffffff',
        'circle-opacity': 0.75,
        'circle-stroke-width': 0.5,
        'circle-stroke-color': '#1a2833',
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

  setPosition(position, { follow, trackUp }) {
    const { lon, lat, accuracy, heading } = position;
    this.boat.setLngLat([lon, lat]);
    if (!this.boat._map) this.boat.addTo(this.map);
    if (Number.isFinite(heading)) this.boat.setRotation(heading);

    this.map.getSource('precision').setData(
      accuracy ? circlePolygon(lon, lat, accuracy) : EMPTY,
    );

    this.trail.push([lon, lat]);
    if (this.trail.length > 600) this.trail.shift();
    this.map.getSource('trace').setData({
      type: 'Feature', geometry: { type: 'LineString', coordinates: this.trail }, properties: {},
    });

    if (follow) {
      this.map.easeTo({
        center: [lon, lat],
        bearing: trackUp && Number.isFinite(heading) ? heading : this.map.getBearing(),
        duration: 600,
      });
    }
  }

  resetNorth() {
    this.map.easeTo({ bearing: 0, duration: 400 });
  }

  clearTrail() {
    this.trail = [];
    this.map.getSource('trace').setData(EMPTY);
  }
}
