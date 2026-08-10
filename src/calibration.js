// Étalonnage au sondeur de bord.
//
// La cote du lac le 22 avril 2009, jour du levé bathymétrique, n'est pas connue. Elle
// décale toutes les profondeurs affichées d'une constante. Plutôt que de la demander à
// EDF, on la mesure : comparer la profondeur lue au sondeur et celle du modèle, en
// quelques points, donne directement la correction.
//
//   résidu = (cote − profondeur_sondeur − immersion_sonde) − altitude_modèle
//
// Si les résidus se groupent autour d'une même valeur, c'est bien un décalage de
// référence et la médiane est la correction cherchée. S'ils se dispersent sans biais
// commun, le problème est l'interpolation et non la référence : aucune constante ne le
// corrigera.
//
// La médiane est préférée à la moyenne : un relevé aberrant — sondeur qui accroche une
// thermocline, position GPS partie à la dérive — ne doit pas déplacer le résultat.

const STORAGE_KEY = 'relieflac.calibration.v1';

// Au-delà, le relevé tombe entre deux traces du levé : il mesure surtout l'erreur
// d'interpolation, pas le décalage de référence.
export const ON_TRACK_RADIUS_M = 25;

export class Calibration extends EventTarget {
  constructor() {
    super();
    this.records = load();
  }

  add(record) {
    const entry = { id: crypto.randomUUID(), at: new Date().toISOString(), ...record };
    this.records.push(entry);
    this.#persist();
    return entry;
  }

  remove(id) {
    this.records = this.records.filter((r) => r.id !== id);
    this.#persist();
  }

  clear() {
    this.records = [];
    this.#persist();
  }

  /** Relevés fiables : sur une trace de 2009 et position GPS correcte. */
  get trusted() {
    return this.records.filter((r) => r.onTrack && (r.accuracy ?? 99) <= 15);
  }

  /**
   * Statistiques sur les résidus. `usable` indique si la dispersion est assez faible
   * pour qu'une constante ait un sens.
   */
  stats(useTrustedOnly = true) {
    const source = useTrustedOnly && this.trusted.length >= 3 ? this.trusted : this.records;
    const residuals = source.map((r) => r.residual).filter(Number.isFinite).sort((a, b) => a - b);
    if (residuals.length === 0) return null;

    const median = quantile(residuals, 0.5);
    const spread = quantile(residuals, 0.75) - quantile(residuals, 0.25);
    return {
      count: residuals.length,
      trustedCount: this.trusted.length,
      median,
      iqr: spread,
      min: residuals[0],
      max: residuals[residuals.length - 1],
      // Un écart interquartile supérieur au mètre signale une dispersion telle qu'aucun
      // décalage constant ne rendra le modèle juste.
      usable: residuals.length >= 5 && spread <= 1.0,
    };
  }

  toCsv() {
    const columns = [
      'at', 'lon', 'lat', 'accuracy_m', 'level_m_ngf', 'level_source',
      'sounder_depth_m', 'transducer_depth_m', 'model_depth_m', 'model_bed_m_ngf',
      'residual_m', 'on_track', 'nearest_sounding_m',
    ];
    const rows = this.records.map((r) => [
      r.at, r.lon?.toFixed(6), r.lat?.toFixed(6), fmt(r.accuracy, 1), fmt(r.level, 2),
      r.levelSource, fmt(r.sounderDepth, 2), fmt(r.transducerDepth, 2),
      fmt(r.modelDepth, 2), fmt(r.modelBedZ, 2), fmt(r.residual, 3),
      r.onTrack ? 'oui' : 'non', fmt(r.nearestSounding, 1),
    ].join(','));
    return [columns.join(','), ...rows].join('\n');
  }

  toJson() {
    return JSON.stringify({ version: 1, records: this.records, stats: this.stats(false) }, null, 2);
  }

  #persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records));
    } catch {
      // Quota plein : les relevés restent en mémoire pour la session.
    }
    this.dispatchEvent(new CustomEvent('change'));
  }
}

/**
 * Construit un relevé à partir de la position, de la cote et de la lecture du sondeur.
 * `modelBedZ` est l'altitude **brute** du modèle : le décalage cherché est justement
 * celui qu'on lui appliquera ensuite.
 */
export function makeRecord({ position, level, levelSource, modelBedZ, sounderDepth, transducerDepth, nearestSounding }) {
  const trueBedZ = level - sounderDepth - transducerDepth;
  return {
    lon: position.lon,
    lat: position.lat,
    accuracy: position.accuracy,
    level,
    levelSource,
    sounderDepth,
    transducerDepth,
    modelBedZ,
    modelDepth: level - modelBedZ,
    residual: trueBedZ - modelBedZ,
    nearestSounding,
    onTrack: nearestSounding <= ON_TRACK_RADIUS_M,
  };
}

function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return low === high ? sorted[low] : sorted[low] + (position - low) * (sorted[high] - sorted[low]);
}

function fmt(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : '';
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? [];
  } catch {
    return [];
  }
}
