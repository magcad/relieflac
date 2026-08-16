// Sorties : la trace réellement parcourue, enregistrée à la fin d'une navigation Go.
//
// À la différence d'un trajet (routes.js), qui est une intention modifiable, une sortie est
// un fait révolu : la trace GPS de ce qui a été parcouru, entre son instant de départ et
// son instant d'arrivée. On ne la retouche jamais — d'où le droit, ici, de ranger la trace
// brute et de laisser la distance se recalculer à l'affichage, comme pour les trajets. La
// durée, elle, ne se déduit pas de la géométrie : on garde les deux horodatages.
//
// Comme les trajets, une sortie est purement personnelle à cet appareil : ni versée au
// modèle, ni partagée.

import { routeLength } from './routes.js';

const STORAGE_KEY = 'relieflac.trips.v1';

export class Trips extends EventTarget {
  constructor() {
    super();
    this.records = load();
  }

  get count() {
    return this.records.length;
  }

  /**
   * Enregistre une sortie. `startedAt`/`endedAt` sont des ISO 8601 ; `points` la trace
   * parcourue [[lon, lat], …]. Le nom reprend celui du trajet suivi, à défaut la date.
   */
  add({ name, routeId = null, points, startedAt, endedAt }) {
    const at = startedAt || new Date().toISOString();
    const entry = {
      id: crypto.randomUUID(),
      at,
      endedAt: endedAt || new Date().toISOString(),
      name: (name && name.trim()) || defaultName(at),
      routeId,
      points: points.map((p) => [p[0], p[1]]),
    };
    this.records.push(entry);
    this.#persist();
    return entry;
  }

  remove(id) {
    this.records = this.records.filter((r) => r.id !== id);
    this.#persist();
  }

  get(id) {
    return this.records.find((r) => r.id === id) ?? null;
  }

  clear() {
    this.records = [];
    this.#persist();
  }

  /** Distance totale de toutes les sorties, en mètres. */
  get totalDistance() {
    return this.records.reduce((sum, r) => sum + routeLength(r.points), 0);
  }

  toGeoJson() {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: this.records.map((r) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: r.points },
        properties: {
          name: r.name,
          length_m: Math.round(routeLength(r.points)),
          duration_s: Math.round(tripDuration(r)),
          points: r.points.length,
          started_at: r.at,
          ended_at: r.endedAt,
        },
      })),
    }, null, 2);
  }

  #persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records));
    } catch {
      // Navigation privée ou quota plein : les sorties restent en mémoire pour la session.
    }
    this.dispatchEvent(new CustomEvent('change'));
  }
}

/** Durée d'une sortie, en secondes, du départ à l'arrivée (temps écoulé, arrêts compris). */
export function tripDuration(trip) {
  const start = Date.parse(trip.at);
  const end = Date.parse(trip.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 1000 : 0;
}

/** « 16 août, 14 h 30 » : une sortie se repère à sa date et son heure de départ. */
export function tripLabel(isoAt) {
  const d = new Date(isoAt);
  if (Number.isNaN(d.getTime())) return 'Sortie';
  return d.toLocaleString('fr-FR', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
}

function defaultName(isoAt) {
  return `Sortie du ${tripLabel(isoAt)}`;
}

function load() {
  try {
    const records = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? [];
    return Array.isArray(records)
      ? records.filter((r) => Array.isArray(r.points) && r.points.length >= 2)
      : [];
  } catch {
    return [];
  }
}
