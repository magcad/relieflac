// Carte factice, substituée à src/map.js par la carte d'import de test/interaction.html.
//
// Raison d'être : MapLibre s'initialise depuis `requestAnimationFrame`, suspendu dans une
// page masquée — c'est ce qui a rendu tout l'enchaînement de l'interface invérifiable
// jusqu'ici, alors que la logique métier l'était depuis le début. Or les pannes qu'on a
// rencontrées ne sont pas dans les modules de données : elles sont dans le câblage, entre
// un bouton et un état.
//
// Cette classe expose exactement la même surface que `LakeMap` et retient ce qu'on lui
// demande d'afficher, sans rien dessiner. Le reste de l'application ne voit pas la
// différence, et le banc d'essai peut alors provoquer les mêmes événements que la vraie
// carte (`probeselect`, `pinpoint`, `zonevertex`…) puis vérifier ce qui en résulte.

export class LakeMap extends EventTarget {
  constructor(container, bed) {
    super();
    this.bed = bed;
    this.probes = [];
    this.simPoints = [];
    this.zones = [];
    this.zoneDraft = [];
    this.pin = null;
    this.zoneMode = false;
    this.tracing = false;
    this.map = { resize() {}, getZoom: () => 13 };
    this.ready = Promise.resolve(this);
    LakeMap.last = this;
  }

  addDepthLayer() {}
  setBasemap(key) { this.basemap = key; }
  setSoundings() {}
  soundingsDebug() { return { vis: '—', data: 0, tiled: 0, rendered: 0, err: 'aucune' }; }
  setMarkers(records) { this.markers = records; }
  setProbes(points) { this.probes = points; }
  setSimPoints(points) { this.simPoints = points; }
  setPin(lngLat) {
    this.pin = lngLat ? { lng: lngLat.lng ?? lngLat.lon, lat: lngLat.lat } : null;
  }
  setZones(zones) { this.zones = zones; }
  setZoneDraft(points) { this.zoneDraft = points; }
  setZoneMode(active, tracing) { this.zoneMode = Boolean(active); this.tracing = Boolean(tracing); }
  setPosition(position) { this.position = position; }
  setHeading() {}
  setFollow(on) { this.follow = on; }
  setTrackUp(on) { this.trackUp = on; }
  setZoom(zoom) { this.zoom = zoom; }
  setVisibleWidth() {}
  zoomBy() {}
  getZoom() { return 13; }
  setBigDepth(state) { this.bigDepth = state; }
  clearTrail() {}
}
