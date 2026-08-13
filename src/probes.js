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
const TOMBSTONE_KEY = 'relieflac.probes.deleted.v1';

/**
 * Durée de conservation d'une suppression, en jours.
 *
 * Une sonde supprimée doit le rester, y compris après la synchronisation qui la retrouve
 * dans le fichier partagé : sans mémoire de la suppression, la fusion — qui est une union,
 * volontairement non destructive — la ressuscite à chaque ouverture. C'est exactement ce
 * qui se passait, et cela donnait une suppression qui « ne marche pas ».
 *
 * Six mois : bien plus que le délai qui sépare la suppression de l'envoi qui la propage
 * (quelques secondes dès qu'il y a du réseau et un jeton), et assez court pour que la liste
 * ne grossisse pas indéfiniment. Passé ce délai, le fichier partagé ne contient de toute
 * façon plus la sonde, et la pierre tombale n'a plus rien à retenir.
 */
const TOMBSTONE_DAYS = 180;

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
    bury([id]);
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

  /** Rayon d'influence d'une sonde sur la carte, ou le réglage courant si elle n'en porte pas. */
  static radiusOf(record, fallback) {
    return Number.isFinite(record?.radius_m) && record.radius_m > 0 ? record.radius_m : fallback;
  }

  clear() {
    bury(this.records.map((r) => r.id));
    this.records = [];
    this.#persist();
  }

  /**
   * Remplace tout le jeu de sondes (adoption d'une version partagée fusionnée).
   *
   * Aucune pierre tombale ici, à la différence de `clear()` : adopter n'est pas supprimer.
   * En poser reviendrait à enterrer, à chaque démarrage, tout ce que l'appareil détenait.
   */
  replaceAll(records) {
    this.records = Array.isArray(records) ? records : [];
    this.#persist();
  }

  /**
   * Suppressions mémorisées : identifiant → horodatage de la suppression.
   *
   * Sert à la fusion (`mergeById` dans `src/main.js`) : un relevé distant plus ancien que
   * sa propre suppression est écarté. Plus récent, il repasse — c'est alors une mesure
   * refaite depuis, et la règle « l'horodatage le plus récent gagne » doit valoir aussi ici.
   */
  static deletedIds() {
    return new Map(Object.entries(readTombstones()));
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
      'radius_m', 'fix',
    ];
    const rows = this.records.map((r) => [
      r.lon?.toFixed(6), r.lat?.toFixed(6), fmt(r.sounderDepth, 2), r.at,
      fmt(r.accuracy, 1), fmt(r.level, 2), fmt(r.transducerDepth, 2),
      fmt(r.bedZ, 2), fmt(r.modelDepth, 2),
      fmt(r.radius_m, 0), r.fixSource ?? 'gps',
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
          radius_m: r.radius_m ?? null,
          fix: r.fixSource ?? 'gps',
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
 *
 * `fixSource` dit d'où vient la position : `gps` quand le relevé a été pris sur place,
 * `map` quand le point a été désigné à la main sur la carte. La distinction doit survivre
 * à l'export et au partage : une position pointée au doigt ne vaut pas une position
 * mesurée, et une sonde dont on ignore la provenance ne peut plus être arbitrée.
 */
export function makeProbe({
  position, level, levelSource, sounderDepth, transducerDepth, modelBedZ,
  radius_m = null, fixSource = 'gps',
}) {
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
    radius_m: Number.isFinite(radius_m) && radius_m > 0 ? radius_m : null,
    fixSource,
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

function readTombstones() {
  try {
    const graves = JSON.parse(localStorage.getItem(TOMBSTONE_KEY)) ?? {};
    return graves && typeof graves === 'object' ? graves : {};
  } catch {
    return {};
  }
}

/** Note la suppression de ces relevés, et oublie au passage les plus anciennes. */
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
    // Stockage indisponible : la suppression tient pour la session, et la sonde
    // reviendra à la prochaine fusion. Mieux vaut cela que de perdre la suppression.
  }
}
