// Géolocalisation : suivi continu, filtrage, cap et vitesse.
//
// Le GPS d'un téléphone bruite fortement à basse vitesse : le cap renvoyé par
// l'appareil est souvent nul ou absent bateau à l'arrêt. On le recalcule alors depuis le
// déplacement, mais seulement au-delà d'un seuil de vitesse — sinon la flèche du bateau
// tournoie sur place, ce qui est pire que pas de cap du tout.

const MAX_ACCURACY_M = 50;
const HEADING_MIN_SPEED_MS = 0.7; // ~2,5 km/h
const SMOOTHING = 0.35;

export class Geolocator extends EventTarget {
  constructor() {
    super();
    this.watchId = null;
    this.position = null;   // { lon, lat, accuracy, speed, heading, timestamp }
    this.status = 'idle';   // idle | locating | active | denied | error | unsupported
    this.message = '';
    this.previous = null;
  }

  get available() {
    return 'geolocation' in navigator;
  }

  start() {
    if (!this.available) {
      this.#setStatus('unsupported', "Ce navigateur ne fournit pas la géolocalisation.");
      return;
    }
    if (this.watchId != null) return;

    this.#setStatus('locating', 'Recherche du signal GPS…');
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.#onPosition(pos),
      (err) => this.#onError(err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.#setStatus('idle', '');
  }

  #setStatus(status, message) {
    this.status = status;
    this.message = message;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, message } }));
  }

  #onPosition(pos) {
    const { longitude, latitude, accuracy, speed, heading } = pos.coords;

    // Une position à ±200 m ferait sauter le bateau d'une rive à l'autre.
    if (accuracy != null && accuracy > MAX_ACCURACY_M) {
      if (this.status !== 'active') {
        this.#setStatus('locating', `Signal imprécis (±${Math.round(accuracy)} m)…`);
      }
      return;
    }

    const speedMs = Number.isFinite(speed) && speed >= 0 ? speed : this.#speedFrom(longitude, latitude, pos.timestamp);
    let course = Number.isFinite(heading) ? heading : this.#courseFrom(longitude, latitude);
    if (speedMs != null && speedMs < HEADING_MIN_SPEED_MS) course = this.position?.heading ?? course;

    this.previous = { lon: longitude, lat: latitude, timestamp: pos.timestamp };
    this.position = {
      lon: longitude,
      lat: latitude,
      accuracy: accuracy ?? null,
      speed: speedMs,
      heading: course,
      timestamp: pos.timestamp,
    };

    if (this.status !== 'active') this.#setStatus('active', '');
    this.dispatchEvent(new CustomEvent('position', { detail: this.position }));
  }

  #onError(err) {
    const messages = {
      1: "Autorisation refusée. Activez la localisation pour cette page dans les réglages du navigateur.",
      2: 'Position indisponible. Essayez à ciel ouvert.',
      3: 'Délai dépassé en cherchant le signal GPS.',
    };
    this.#setStatus(err.code === 1 ? 'denied' : 'error', messages[err.code] ?? err.message);
  }

  #speedFrom(lon, lat, timestamp) {
    if (!this.previous) return null;
    const seconds = (timestamp - this.previous.timestamp) / 1000;
    if (seconds <= 0 || seconds > 30) return null;
    const raw = distanceMeters(this.previous.lon, this.previous.lat, lon, lat) / seconds;
    const before = this.position?.speed;
    return Number.isFinite(before) ? before + SMOOTHING * (raw - before) : raw;
  }

  #courseFrom(lon, lat) {
    if (!this.previous) return null;
    const d = distanceMeters(this.previous.lon, this.previous.lat, lon, lat);
    if (d < 3) return this.position?.heading ?? null;
    return bearing(this.previous.lon, this.previous.lat, lon, lat);
  }
}

export function distanceMeters(lon1, lat1, lon2, lat2) {
  const mPerDegLat = 111320;
  const mPerDegLon = mPerDegLat * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const dx = (lon2 - lon1) * mPerDegLon;
  const dy = (lat2 - lat1) * mPerDegLat;
  return Math.hypot(dx, dy);
}

export function bearing(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad)
    - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

export function formatSpeed(metersPerSecond, unit) {
  if (!Number.isFinite(metersPerSecond)) return '—';
  return unit === 'kn'
    ? `${(metersPerSecond * 1.943844).toFixed(1)} nd`
    : `${(metersPerSecond * 3.6).toFixed(1)} km/h`;
}
