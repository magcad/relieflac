// Sorties : la trace réellement parcourue, enregistrée à la fin d'une navigation Go.
//
// À la différence d'un trajet (routes.js), qui est une intention modifiable, une sortie est
// un fait révolu : la trace GPS de ce qui a été parcouru, entre son instant de départ et
// son instant d'arrivée. On ne la retouche jamais — d'où le droit, ici, de ranger la trace
// brute et de laisser la distance se recalculer à l'affichage, comme pour les trajets. La
// durée, elle, ne se déduit pas de la géométrie : on garde les deux horodatages.
//
// Les sorties sont partagées depuis le 16/08/2026, mais à part des trajets : un fichier par
// trace dans le dépôt, plus un catalogue (voir `TripsSync` dans src/sync.js). D'où un
// enregistrement à deux visages :
//
//   — complet  : la trace est là, on peut la revoir sur la carte ;
//   — résumé   : venu du catalogue partagé (`remote`), il n'en connaît que le nom, les
//                dates et la longueur. La trace descend au moment où l'on demande à la
//                revoir, et `setTrack` le change alors en enregistrement complet.
//
// C'est ce qui permet de lister la saison entière de tout l'équipage sans télécharger des
// centaines de milliers de points dont on ne regardera qu'une poignée.

import { routeLength } from './routes.js';

const STORAGE_KEY = 'relieflac.trips.v1';
const TOMBSTONE_KEY = 'relieflac.trips.deleted.v1';

/** Conservation d'une suppression, en jours — même règle que les sondes (voir probes.js). */
const TOMBSTONE_DAYS = 180;

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
   *
   * `ski` est la synthèse d'une session de ski nautique quand la sortie en était une
   * (activité, personne, plage tenue, chrono, chutes — voir `skiSummary` dans ski.js).
   * Elle est rangée telle quelle : une synthèse est un fait révolu, comme la trace, et se
   * recalculer serait impossible — la vitesse instantanée n'est pas dans la trace, qui ne
   * garde que des positions.
   */
  add({ name, routeId = null, points, startedAt, endedAt, ski = null }) {
    const at = startedAt || new Date().toISOString();
    const entry = {
      id: crypto.randomUUID(),
      at,
      endedAt: endedAt || new Date().toISOString(),
      name: (name && name.trim()) || defaultName(at),
      routeId,
      points: points.map((p) => [p[0], p[1]]),
      ...(ski ? { ski } : {}),
    };
    this.records.push(entry);
    this.#persist();
    return entry;
  }

  remove(id) {
    this.records = this.records.filter((r) => r.id !== id);
    bury([id]);
    this.#persist();
  }

  get(id) {
    return this.records.find((r) => r.id === id) ?? null;
  }

  clear() {
    bury(this.records.map((r) => r.id));
    this.records = [];
    this.#persist();
  }

  /** Adopte un jeu de sorties fusionné avec le partage — sans enterrer quoi que ce soit. */
  replaceAll(records) {
    this.records = Array.isArray(records) ? records : [];
    this.#persist();
  }

  /** La trace d'une sortie résumée vient d'arriver : l'enregistrement devient complet. */
  setTrack(id, points) {
    const record = this.records.find((r) => r.id === id);
    if (!record || !Array.isArray(points) || points.length < 2) return null;
    record.points = points.map((p) => [p[0], p[1]]);
    record.remote = false;
    this.#persist();
    return record;
  }

  /** Marque les sorties déjà publiées : elles n'ont plus à remonter à chaque démarrage. */
  markShared(ids) {
    let changed = false;
    for (const record of this.records) {
      if (ids.includes(record.id) && !record.shared) { record.shared = true; changed = true; }
    }
    if (changed) this.#persist();
  }

  /** Suppressions mémorisées : identifiant → horodatage. Voir `mergeById` dans main.js. */
  static deletedIds() {
    return new Map(Object.entries(readTombstones()));
  }

  /** Distance totale de toutes les sorties, en mètres. */
  get totalDistance() {
    return this.records.reduce((sum, r) => sum + tripDistance(r), 0);
  }

  toGeoJson() {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: this.records.filter(hasTrack).map((r) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: r.points },
        properties: {
          name: r.name,
          length_m: Math.round(routeLength(r.points)),
          duration_s: Math.round(tripDuration(r)),
          points: r.points.length,
          started_at: r.at,
          ended_at: r.endedAt,
          ...(r.ski ? { ski: r.ski } : {}),
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

/** Une sortie dont la trace est là, par opposition au résumé venu du catalogue partagé. */
export function hasTrack(trip) {
  return Array.isArray(trip?.points) && trip.points.length >= 2;
}

/**
 * Distance d'une sortie, en mètres : recalculée sur la trace quand on l'a, reprise du
 * catalogue sinon. Le résumé ne ment pas — c'est le même calcul, fait par celui qui a
 * publié la trace — mais il ne se recalcule pas, d'où la distinction.
 */
export function tripDistance(trip) {
  if (hasTrack(trip)) return routeLength(trip.points);
  return Number.isFinite(trip?.length_m) ? trip.length_m : 0;
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
    // Une sortie sans trace n'est gardée que si elle est le résumé d'une sortie partagée :
    // ailleurs, c'est un enregistrement abîmé, et l'afficher promettrait un tracé qui
    // n'existe nulle part.
    return Array.isArray(records)
      ? records.filter((r) => hasTrack(r) || (r.remote && r.id))
      : [];
  } catch {
    return [];
  }
}

function readTombstones() {
  try {
    const graves = JSON.parse(localStorage.getItem(TOMBSTONE_KEY)) ?? {};
    return graves && typeof graves === 'object' ? graves : {};
  } catch {
    return {};
  }
}

/** Note la suppression de ces sorties, et oublie au passage les plus anciennes. */
function bury(ids) {
  const graves = readTombstones();
  const now = new Date();
  const oldest = new Date(now.getTime() - TOMBSTONE_DAYS * 86400e3).toISOString();
  for (const [id, at] of Object.entries(graves)) {
    if (at < oldest) delete graves[id];
  }
  for (const id of ids) {
    if (id) graves[id] = now.toISOString();
  }
  try {
    localStorage.setItem(TOMBSTONE_KEY, JSON.stringify(graves));
  } catch {
    // Stockage indisponible : la suppression tient pour la session, et la sortie
    // reviendra à la prochaine fusion. Mieux vaut cela que de perdre la suppression.
  }
}
