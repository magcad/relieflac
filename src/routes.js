// Trajets de navigation : suites de points de passage, nommées et mémorisées.
//
// Un trajet est une liste de points [lon, lat] rangée en mémoire locale, comme les zones
// et les sondes. À la différence de celles-ci, il ne corrige pas la carte et ne dit rien
// du fond : c'est une intention de route, pas une mesure. Il n'est donc ni versé au modèle
// ni partagé — purement personnel, à cet appareil.
//
// On garde les coordonnées brutes ; la longueur et la durée se recalculent à l'affichage,
// jamais stockées : un chiffre dérivé rangé à côté de la donnée finit toujours par mentir
// dès qu'on retouche un point.

import { distanceMeters } from './geo.js';

const STORAGE_KEY = 'relieflac.routes.v1';

/** Vitesse de croisière retenue pour l'estimation de durée (km/h). */
export const CRUISE_KMH = 20;

export class Routes extends EventTarget {
  constructor() {
    super();
    this.records = load();
  }

  get count() {
    return this.records.length;
  }

  add({ name, points }) {
    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      name: (name && name.trim()) || defaultName(this.records.length),
      points: points.map((p) => [p[0], p[1]]),
    };
    this.records.push(entry);
    this.#persist();
    return entry;
  }

  update(id, changes) {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    Object.assign(record, changes);
    this.#persist();
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

  toGeoJson() {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: this.records.map((r) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: r.points },
        properties: {
          name: r.name,
          length_m: Math.round(routeLength(r.points)),
          waypoints: r.points.length,
          time: r.at,
        },
      })),
    }, null, 2);
  }

  #persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records));
    } catch {
      // Navigation privée ou quota plein : les trajets restent en mémoire pour la session.
    }
    this.dispatchEvent(new CustomEvent('change'));
  }
}

/** Longueur d'un trajet, en mètres, somme des segments géodésiques. */
export function routeLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += distanceMeters(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  return total;
}

/** Durée estimée d'un parcours, en secondes, à la vitesse de croisière donnée. */
export function estimatedDuration(metres, kmh = CRUISE_KMH) {
  return kmh > 0 ? (metres / 1000 / kmh) * 3600 : 0;
}

/** « 1,2 km » au-delà du kilomètre, « 640 m » en deçà : lisible dans les deux cas. */
export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '—';
  return metres >= 1000
    ? `${(metres / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} km`
    : `${Math.round(metres)} m`;
}

/** « 8 min », « 1 h 05 » : une durée de sortie se lit en minutes, pas en secondes. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
}

function defaultName(index) {
  return `Trajet ${index + 1}`;
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
