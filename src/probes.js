// Sondes saisies à la main, sur l'eau.
//
// Le sondeur Eagle du bord affiche une profondeur mais ne l'enregistre pas : on la relève
// à la main. Comme partout dans l'application, on ne stocke pas la profondeur — qui ne veut
// rien dire sur une retenue qui marne de plusieurs mètres — mais l'altitude du fond,
// invariante :
//
//   z_fond = cote_du_jour − profondeur_lue − immersion_sonde
//
// Une profondeur **négative** est admise, et c'est le cas le plus utile de tous : un
// haut-fond découvert par l'étiage, qu'on relève à pied. On saisit alors sa hauteur
// au-dessus de l'eau avec le signe moins (−0,4 = le caillou dépasse de 40 cm). Ce sont
// précisément les points que le levé 2009 ne pouvait pas mesurer — un bateau sondeur ne
// passe pas dessus — et où le modèle est le plus dangereusement faux.
//
// La profondeur affichée ensuite est recalculée depuis la cote courante, exactement comme
// pour le reste de la carte. À l'export, on ressort la profondeur brute et l'horodatage :
// tools/import_soundings.py retrouve la cote horaire d'archive et refait le calcul, pour
// cuire ces sondes dans la grille (reconstruction puis redéploiement).
//
// Différence avec l'étalonnage : là on cherchait un décalage constant, donc des relevés
// *sur* les traces de 2009. Ici on collecte de la mesure neuve, surtout *entre* les traces,
// là où le modèle est aveugle. Même geste de capture, intention opposée.

const STORAGE_KEY = 'relieflac.probes.v1';

export class Probes extends EventTarget {
  constructor() {
    super();
    this.records = load();
  }

  get count() {
    return this.records.length;
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

  get(id) {
    return this.records.find((r) => r.id === id) ?? null;
  }

  /**
   * Corrige une sonde après coup. Une profondeur mal lue se rectifie avec la cote et la
   * position d'origine : c'est la même mesure, au même instant, seul le chiffre saisi
   * change. On recalcule donc l'altitude de fond depuis le niveau enregistré, pas le niveau
   * courant.
   */
  update(id, changes) {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    Object.assign(record, changes);
    if ('sounderDepth' in changes || 'transducerDepth' in changes) {
      record.bedZ = bedAltitude(record.level, record.sounderDepth, record.transducerDepth);
    }
    this.#persist();
  }

  clear() {
    this.records = [];
    this.#persist();
  }

  /** Remplace tout le jeu de sondes (adoption d'une version partagée fusionnée). */
  replaceAll(records) {
    this.records = Array.isArray(records) ? records : [];
    this.#persist();
  }

  /**
   * Colonnes directement avalées par tools/import_soundings.py : il repère `depth` et
   * `time`, retrouve la cote à l'horodatage et applique l'immersion via --transducer-depth.
   * Les autres colonnes ne servent qu'à la traçabilité.
   */
  toCsv() {
    const columns = [
      'lon', 'lat', 'depth', 'time', 'accuracy_m',
      'level_m_ngf', 'transducer_m', 'bed_m_ngf', 'model_depth_m',
    ];
    const rows = this.records.map((r) => [
      r.lon?.toFixed(6), r.lat?.toFixed(6), fmt(r.sounderDepth, 2), r.at,
      fmt(r.accuracy, 1), fmt(r.level, 2), fmt(r.transducerDepth, 2),
      fmt(r.bedZ, 2), fmt(r.modelDepth, 2),
    ].join(','));
    return [columns.join(','), ...rows].join('\n');
  }

  toGeoJson() {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: this.records.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
        properties: {
          depth: round2(r.sounderDepth),
          time: r.at,
          bed_m_ngf: round2(r.bedZ),
          level_m_ngf: round2(r.level),
          transducer_m: r.transducerDepth,
          accuracy_m: r.accuracy,
        },
      })),
    }, null, 2);
  }

  #persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records));
    } catch {
      // Quota plein ou navigation privée : les sondes restent en mémoire pour la session.
    }
    this.dispatchEvent(new CustomEvent('change'));
  }
}

/**
 * Construit une sonde à partir de la position, de la cote du moment et de la profondeur
 * lue. `modelBedZ` est l'altitude brute du modèle au même point : conserver l'écart
 * modèle − mesure rend visible le défaut central (un haut-fond que le levé a comblé).
 */
export function makeProbe({ position, level, levelSource, sounderDepth, transducerDepth, modelBedZ }) {
  const bedZ = bedAltitude(level, sounderDepth, transducerDepth);
  return {
    lon: position.lon,
    lat: position.lat,
    accuracy: position.accuracy ?? null,
    level,
    levelSource,
    sounderDepth,
    transducerDepth,
    bedZ,
    modelBedZ: Number.isFinite(modelBedZ) ? modelBedZ : null,
    modelDepth: Number.isFinite(modelBedZ) ? level - modelBedZ : null,
  };
}

/**
 * Altitude de fond déduite d'une profondeur saisie à la main — la formule de référence,
 * partagée avec l'étalonnage (`src/calibration.js`) et avec la cuisson dans la grille
 * (`tools/import_soundings.py`).
 *
 * L'immersion du transducteur ne s'applique qu'à une sonde réellement dans l'eau. Sur un
 * haut-fond émergé, relevé à pied, il n'y a pas de sonde du tout : la retrancher
 * enfoncerait le point de sa valeur — 30 cm d'erreur systématique, toujours dans le sens
 * dangereux (fond annoncé plus bas qu'il n'est), et sur les seuls points qui comptent
 * vraiment pour la sécurité. D'où la règle, énoncée ici une fois pour toutes.
 *
 * L'immersion configurée reste stockée telle quelle dans le relevé : neutralisée au
 * calcul et non à l'enregistrement, elle revient d'elle-même si la saisie est corrigée
 * plus tard en une profondeur positive.
 */
export function bedAltitude(level, sounderDepth, transducerDepth) {
  const immersion = sounderDepth < 0 ? 0 : (transducerDepth ?? 0);
  return level - sounderDepth - immersion;
}

function fmt(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : '';
}

const round2 = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? [];
  } catch {
    return [];
  }
}
