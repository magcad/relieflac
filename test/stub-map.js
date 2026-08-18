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
    this.map = { resize() {}, getZoom: () => 13, jumpTo() {}, setPitch() {} };
    this.ready = Promise.resolve(this);
    LakeMap.last = this;
  }

  addDepthLayer() {}
  setBasemap(key) { this.basemap = key; }
  setBoatIcon(kind) { this.boatIcon = kind; }
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

  // Cadrage (L21) : le bouton de recentrage ne vaut que s'il dit la vérité, donc le leurre
  // tient le même état que la vraie carte — suivi coupé, vue traînée, échelle quittée — et
  // prévient de la même façon, en n'annonçant que les changements.
  setFollow(on) {
    this.follow = on;
    if (on) this.dragged = false;
    this.reportFraming();
  }

  setFramingZoom(zoom) {
    this.framingZoom = Number.isFinite(zoom) ? zoom : null;
    this.reportFraming();
  }

  isOnBoat() { return this.follow !== false && !this.dragged; }

  /** Le glissement de doigt du banc : la vue quitte le bateau, comme sur l'eau. */
  dragAway() {
    this.dragged = true;
    this.reportFraming();
    this.dispatchEvent(new CustomEvent('userpan'));
  }

  reportFraming() {
    const on = this.isOnBoat();
    if (on === this.framingOn) return;
    this.framingOn = on;
    this.dispatchEvent(new CustomEvent('framing', { detail: on }));
  }

  recenter() { this.follow = true; this.dragged = false; this.reportFraming(); }
  setTrackUp(on) { this.trackUp = on; }
  setZoom(zoom) { this.zoom = zoom; }
  setVisibleWidth() {}
  zoomBy() {}
  getZoom() { return 13; }
  setBigDepth(state) { this.bigDepth = state; }
  clearTrail() {}

  // Trajets, navigation et ski : ce que le banc regarde ici, ce n'est jamais un dessin mais
  // le fait qu'un enchaînement soit allé jusqu'au bout — quel trajet affiché, quelle allure
  // de couloir, quelle caméra. On retient donc, on ne rend pas.
  setRoute(points) { this.route = points.map((p) => [p[0], p[1]]); }
  setRouteProgress(fromIndex, snapped, alongM) { this.progress = { fromIndex, snapped, alongM }; }
  clearRoute() { this.route = null; }
  setRouteDraft(points, opts = {}) {
    this.routeDraft = points.map((p) => [p[0], p[1]]);
    this.draftLoop = Boolean(opts.loop);
    this.draftEditing = opts.editingIndex ?? -1;
  }
  clearRouteDraft() { this.routeDraft = []; }
  setRouteMode(active) { this.routeMode = Boolean(active); }
  setRouteStyle(kind) { this.routeStyle = kind; }
  previewRoute(points) { this.preview = points.map((p) => [p[0], p[1]]); }
  setGoMode(active) { this.goMode = Boolean(active); }
  setBasemapDim(on) { this.dimmed = Boolean(on); }
  setGate(lngLat) { this.gate = lngLat ? [lngLat[0], lngLat[1]] : null; }
  enterNavCam(pitch) { this.navCam = pitch ?? 55; }
  exitNavCam() { this.navCam = null; }
  recenterNav(zoom) {
    this.recentered = zoom;
    this.follow = true;
    this.trackUp = true;
    this.dragged = false;
    this.reportFraming();
  }
  showTrip(points) { this.trip = points.map((p) => [p[0], p[1]]); }
  clearTrip() { this.trip = null; }
}
