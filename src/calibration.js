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
// Un troisième cas se cache derrière le premier, et c'est le dangereux : un résidu
// **proportionnel à la profondeur**. Une erreur d'échelle du sondeur (vitesse du son mal
// réglée) produit exactement ça. Relevée en petit fond seulement, elle est indiscernable
// d'un décalage constant — les résidus se groupent tout aussi bien, l'écart interquartile
// est tout aussi rassurant — et la constante qu'on en tire fausse le large d'autant plus
// qu'il est profond. Séparer les deux exige des relevés à des profondeurs franchement
// différentes ; `stats()` le vérifie et refuse de conclure quand la bande sondée est trop
// étroite pour trancher.
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
    const sample = source
      .map((r) => ({ residual: r.residual, depth: r.sounderDepth + (r.transducerDepth ?? 0) }))
      .filter((r) => Number.isFinite(r.residual));
    const residuals = sample.map((r) => r.residual).sort((a, b) => a - b);
    if (residuals.length === 0) return null;

    const median = quantile(residuals, 0.5);
    const spread = quantile(residuals, 0.75) - quantile(residuals, 0.25);
    const shape = depthShape(sample, median);
    return {
      count: residuals.length,
      trustedCount: this.trusted.length,
      median,
      iqr: spread,
      min: residuals[0],
      max: residuals[residuals.length - 1],
      ...shape,
      // Un écart interquartile supérieur au mètre signale une dispersion telle qu'aucun
      // décalage constant ne rendra le modèle juste. Et si la forme du résidu suit la
      // profondeur, la constante est carrément le mauvais remède : on la refuse.
      usable: residuals.length >= 5 && spread <= 1.0 && shape.model !== 'proportionnel',
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

/**
 * Le résidu est-il une constante, ou une fraction de la profondeur ?
 *
 * On ajuste les deux modèles — `résidu = c` et `résidu = k × profondeur` — et on compare
 * ce qu'il reste d'écart après chacun. Médianes partout plutôt que moyennes : un relevé
 * aberrant ne doit pas désigner le vainqueur.
 *
 * Le point délicat est de savoir quand se taire. Les deux modèles se croisent à une
 * profondeur et ne divergent qu'en s'en éloignant ; sur une bande étroite, leur écart
 * reste sous le bruit de mesure et les départager n'a aucun sens. On exige donc que la
 * divergence entre les deux prédictions, sur les profondeurs réellement sondées, dépasse
 * nettement la dispersion résiduelle — faute de quoi le verdict est « indéterminé », et
 * la seule réponse utile est d'aller sonder plus creux.
 */
function depthShape(sample, median) {
  const unknown = {
    model: 'indetermine',
    depthMin: NaN,
    depthMax: NaN,
    slopePercent: NaN,
  };
  // Sous cinq relevés, les médianes sautent d'un point à l'autre et le verdict serait
  // dicté par le hasard de l'échantillon. Même seuil que le reste du module.
  const usable = sample.filter((r) => Number.isFinite(r.depth) && r.depth > 0.2);
  if (usable.length < 5) return unknown;

  const depths = usable.map((r) => r.depth);
  const ratios = usable.map((r) => r.residual / r.depth).sort((a, b) => a - b);
  const slope = quantile(ratios, 0.5);

  const typical = (errors) => quantile(errors.map(Math.abs).sort((a, b) => a - b), 0.5);
  const flatSpread = typical(usable.map((r) => r.residual - median));
  const slopedSpread = typical(usable.map((r) => r.residual - slope * r.depth));

  const divergence = Math.max(...usable.map((r) => Math.abs(median - slope * r.depth)));
  // Le bruit de mesure, c'est ce qui reste après le MEILLEUR des deux ajustements. Prendre
  // le pire reviendrait à mesurer le bruit avec le modèle faux, dont la dispersion est
  // grande précisément parce qu'il est faux — et à ne jamais rien pouvoir conclure.
  // Plancher : deux relevés ne tombent jamais exactement d'accord, et sans lui un
  // échantillon trop docile passerait pour concluant.
  const noise = Math.max(Math.min(flatSpread, slopedSpread), 0.05);

  let model = 'indetermine';
  if (divergence >= 3 * noise) {
    if (slopedSpread < flatSpread * 0.6) model = 'proportionnel';
    else if (flatSpread < slopedSpread * 0.6) model = 'constant';
  }

  return {
    model,
    depthMin: Math.min(...depths),
    depthMax: Math.max(...depths),
    slopePercent: slope * 100,
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
