// Trajets de navigation : suites de points de passage, nommées et mémorisées.
//
// Un trajet est une liste de points [lon, lat] rangée en mémoire locale, comme les zones
// et les sondes. À la différence de celles-ci, il ne corrige pas la carte et ne dit rien
// du fond : c'est une intention de route, pas une mesure.
//
// Il est en revanche PARTAGÉ, comme les relevés (16/08/2026) : une route sûre entre deux
// hauts-fonds vaut pour tout le monde, et la refaire point par point sur chaque téléphone
// n'avait aucun sens. Même mécanique que les sondes — fichier du dépôt, fusion par
// identifiant, pierres tombales pour que la suppression tienne (voir src/sync.js).
//
// On garde les coordonnées brutes ; la longueur et la durée se recalculent à l'affichage,
// jamais stockées : un chiffre dérivé rangé à côté de la donnée finit toujours par mentir
// dès qu'on retouche un point.

import { distanceMeters } from './geo.js';

const STORAGE_KEY = 'relieflac.routes.v1';
const TOMBSTONE_KEY = 'relieflac.routes.deleted.v1';

/** Conservation d'une suppression, en jours — même règle que les sondes (voir probes.js). */
const TOMBSTONE_DAYS = 180;

/** Vitesse de croisière retenue pour l'estimation de durée (km/h). */
export const CRUISE_KMH = 20;

/**
 * Métier auquel un trajet appartient : `'nav'` (route à suivre) ou `'ski'` (couloir de ski).
 *
 * Ce ne sont pas les mêmes objets. Une route de navigation relie deux points en évitant les
 * hauts-fonds ; un couloir de ski est un aller-retour en eau libre, choisi pour sa longueur
 * et son abri du vent. Les mélanger dans une seule liste obligeait à lire chaque nom pour
 * retrouver le sien — d'où un attribut, un filtre par mode, et une couleur par métier.
 *
 * Un trajet sans attribut est une route de navigation : c'est ce qu'étaient tous les trajets
 * avant que le ski n'existe, et la valeur par défaut ne doit pas réécrire l'histoire.
 */
export const ROUTE_KINDS = ['nav', 'ski'];

export function routeKind(route) {
  return route?.kind === 'ski' ? 'ski' : 'nav';
}

export class Routes extends EventTarget {
  constructor() {
    super();
    this.records = load();
  }

  get count() {
    return this.records.length;
  }

  add({ name, points, kind = 'nav' }) {
    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      name: (name && name.trim()) || defaultName(this.records.length, kind),
      kind: routeKind({ kind }),
      points: points.map((p) => [p[0], p[1]]),
    };
    this.records.push(entry);
    this.#persist();
    return entry;
  }

  /**
   * Retouche un trajet. L'horodatage repart à l'instant de la retouche, et ce n'est pas un
   * détail : c'est lui qui arbitre la fusion avec la version partagée. Sans cela, un trajet
   * corrigé ici perdait contre sa version d'origine restée dans le fichier, et la correction
   * disparaissait à la synchronisation suivante.
   */
  update(id, changes) {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    Object.assign(record, changes, { at: new Date().toISOString() });
    this.#persist();
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

  /**
   * Adopte un jeu de trajets fusionné avec le partage. Aucune pierre tombale, à la
   * différence de `clear()` : adopter n'est pas supprimer.
   */
  replaceAll(records) {
    this.records = Array.isArray(records) ? records : [];
    this.#persist();
  }

  /** Suppressions mémorisées : identifiant → horodatage. Voir `mergeById` dans main.js. */
  static deletedIds() {
    return new Map(Object.entries(readTombstones()));
  }

  toGeoJson() {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: this.records.map((r) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: r.points },
        properties: {
          name: r.name,
          kind: routeKind(r),
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

function defaultName(index, kind) {
  return kind === 'ski' ? `Couloir ${index + 1}` : `Trajet ${index + 1}`;
}

function load() {
  try {
    const records = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? [];
    // Le métier est normalisé au chargement, une fois pour toutes : ailleurs, chaque lecture
    // aurait à se demander si l'absence d'attribut vaut navigation — et une seule qui
    // l'oublierait ferait disparaître le trajet des deux listes.
    return Array.isArray(records)
      ? records
        .filter((r) => Array.isArray(r.points) && r.points.length >= 2)
        .map((r) => ({ ...r, kind: routeKind(r) }))
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

/** Note la suppression de ces trajets, et oublie au passage les plus anciennes. */
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
    // Stockage indisponible : la suppression tient pour la session, et le trajet
    // reviendra à la prochaine fusion. Mieux vaut cela que de perdre la suppression.
  }
}
