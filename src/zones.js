// Zones émergées tracées à la main.
//
// Le défaut central du modèle est connu et chiffré : le bateau sondeur de 2009 ne passe pas
// sur un haut-fond, donc celui-ci est un trou dans les données que la triangulation comble
// en reliant les fosses qui l'entourent. Des îlots qui découvrent réellement à la cote du
// jour sont affichés à 10-20 m d'eau. Une sonde ponctuelle relevée à pied corrige un
// caillou ; elle ne dit rien de l'**étendue** de la terre autour.
//
// D'où cette forme-ci : un contour fermé, tracé à la main sur la photo aérienne ou d'après
// ce qu'on voit depuis le bateau, dont tout l'intérieur est porté à une même altitude de
// fond. C'est la seule chose qu'on sache honnêtement dire d'une île sans l'avoir arpentée :
// « à partir d'ici, c'est de la terre ».
//
// Comme partout dans l'application, on ne stocke pas une hauteur d'eau — qui ne veut rien
// dire sur une retenue qui marne de plusieurs mètres — mais l'altitude du sol, invariante :
//
//   z_sol = cote_du_jour + hauteur_au-dessus_de_l'eau
//
// La zone se recolorie donc toute seule quand la cote bouge : émergée en étiage, submergée
// à la retenue normale, et le curseur du mode 🌊 montre le passage de l'une à l'autre.
//
// Local à l'appareil pour l'instant, comme les points témoins : une zone est une
// interprétation, pas une mesure, et le fichier partagé `data/corrections/<lac>.json` ne
// transporte que des points mesurés. L'export GeoJSON permet de la verser au modèle par
// la chaîne de préparation quand elle aura été confirmée sur le terrain.

const STORAGE_KEY = 'relieflac.zones.v1';

/** Largeur du fondu au-delà du bord, en mètres : une berge n'est pas une falaise. */
export const DEFAULT_FEATHER_M = 10;

export class Zones extends EventTarget {
  constructor() {
    super();
    this.records = load();
  }

  get count() {
    return this.records.length;
  }

  add({ ring, bedZ, height_m = null, cote_m = null, feather_m = DEFAULT_FEATHER_M }) {
    const entry = {
      id: crypto.randomUUID(), at: new Date().toISOString(),
      ring, bedZ, height_m, cote_m, feather_m,
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

  /**
   * Corrige une zone après coup. La hauteur se rectifie contre la cote **d'origine**,
   * celle qui avait été lue au tracé : c'est la même observation, seule son appréciation
   * change. La recaler sur la cote du jour déplacerait le sol chaque fois que le lac monte.
   */
  update(id, changes) {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    Object.assign(record, changes);
    if ('height_m' in changes && Number.isFinite(record.cote_m)) {
      record.bedZ = groundAltitude(record.cote_m, record.height_m);
    }
    this.#persist();
  }

  clear() {
    this.records = [];
    this.#persist();
  }

  /** Remplace tout le jeu de zones (import d'un profil, adoption d'une version partagée). */
  replaceAll(records) {
    this.records = Array.isArray(records) ? records : [];
    this.#persist();
  }

  toGeoJson() {
    return JSON.stringify({
      type: 'FeatureCollection',
      features: this.records.map((r) => ({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [closeRing(r.ring)] },
        properties: {
          ground_m_ngf: round2(r.bedZ),
          height_m: r.height_m,
          level_m_ngf: round2(r.cote_m),
          feather_m: r.feather_m,
          area_m2: Math.round(ringArea(r.ring)),
          time: r.at,
        },
      })),
    }, null, 2);
  }

  #persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records));
    } catch {
      // Navigation privée ou quota plein : les zones restent en mémoire pour la session.
    }
    this.dispatchEvent(new CustomEvent('change'));
  }
}

/** Altitude du sol d'une zone, depuis la cote du moment et sa hauteur hors d'eau. */
export function groundAltitude(level, height) {
  return level + (height ?? 0);
}

/** Le premier sommet répété en dernier : ce que GeoJSON exige d'un anneau fermé. */
export function closeRing(ring) {
  if (ring.length < 3) return ring;
  const [first] = ring;
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

/**
 * Aire au sol d'un contour, en m². Formule du lacet appliquée à une projection locale
 * (mètres est/nord autour du centre du contour) : à l'échelle d'un îlot, l'écart à la
 * vraie aire géodésique est très inférieur à celui du tracé à la main.
 */
export function ringArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const lat0 = ring.reduce((s, [, lat]) => s + lat, 0) / ring.length;
  const mPerDegLat = 111320;
  const mPerDegLon = mPerDegLat * Math.cos((lat0 * Math.PI) / 180);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = [ring[i][0] * mPerDegLon, ring[i][1] * mPerDegLat];
    const [xj, yj] = [ring[j][0] * mPerDegLon, ring[j][1] * mPerDegLat];
    sum += xj * yi - xi * yj;
  }
  return Math.abs(sum) / 2;
}

/**
 * Retire les sommets confondus d'un tracé.
 *
 * Le double-clic qui referme un contour émet aussi ses deux `click` : sans cela, la zone
 * finirait par un sommet posé deux ou trois fois au même endroit — inoffensif au rendu,
 * mais qui salit l'export et fausse le décompte affiché. Le dernier sommet retombé sur le
 * premier est retiré de même : l'anneau se referme tout seul, on ne le boucle pas à la main.
 */
export function dedupeRing(points, minGapM = 1) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && metresBetween(last, p) < minGapM) continue;
    out.push(p);
  }
  if (out.length > 2 && metresBetween(out[0], out[out.length - 1]) < minGapM) out.pop();
  return out;
}

function metresBetween([lon1, lat1], [lon2, lat2]) {
  const mPerDegLat = 111320;
  const mPerDegLon = mPerDegLat * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lon2 - lon1) * mPerDegLon, (lat2 - lat1) * mPerDegLat);
}

/** Centre du contour (moyenne des sommets), pour y ancrer une étiquette. */
export function ringCentre(ring) {
  const lon = ring.reduce((s, [x]) => s + x, 0) / ring.length;
  const lat = ring.reduce((s, [, y]) => s + y, 0) / ring.length;
  return [lon, lat];
}

/** « 1,2 ha » au-delà de l'hectare, « 3 400 m² » en dessous : lisible dans les deux cas. */
export function formatArea(m2) {
  return m2 >= 10000
    ? `${(m2 / 10000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ha`
    : `${Math.round(m2).toLocaleString('fr-FR')} m²`;
}

const round2 = (value) => (Number.isFinite(value) ? Math.round(value * 100) / 100 : null);

function load() {
  try {
    const records = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? [];
    return Array.isArray(records) ? records.filter((r) => Array.isArray(r.ring) && r.ring.length >= 3) : [];
  } catch {
    return [];
  }
}
