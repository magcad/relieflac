// Chargement de la grille d'altitude de fond.
//
// bed.png encode l'altitude sur 24 bits (Terrain-RGB) ; l'alpha distingue le lac du
// hors-lac. On en fait deux choses :
//
//   • une ImageBitmap, passée telle quelle au GPU pour le rendu colorié ;
//   • un Float32Array côté processeur, pour lire la profondeur sous le bateau,
//     déclencher l'alarme et alimenter l'étalonnage.
//
// Le filtrage de la texture doit rester en NEAREST : interpoler des octets encodés
// donnerait des altitudes absurdes.

const EARTH_CIRCUMFERENCE = 40075016.685578488;
const ORIGIN_SHIFT = EARTH_CIRCUMFERENCE / 2; // 20037508.34

/** lon/lat → EPSG:3857, la projection dans laquelle la grille est calculée. */
export function toMercator(lon, lat) {
  const x = (lon / 360) * EARTH_CIRCUMFERENCE;
  const clamped = Math.max(Math.min(lat, 85.05112878), -85.05112878);
  const y = (Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) / Math.PI) * ORIGIN_SHIFT;
  return [x, y];
}

export class BedGrid {
  constructor(meta, bitmap, altitudes, alpha, coverage = null, coverageBitmap = null) {
    this.meta = meta;
    this.bitmap = bitmap;
    this.altitudes = altitudes; // Float32Array, NaN hors du lac
    this.alpha = alpha;
    // Distance en mètres à la sonde mesurée la plus proche, plafonnée à 255.
    this.coverage = coverage;
    this.coverageBitmap = coverageBitmap;
    [this.x0, this.y0, this.x1, this.y1] = meta.bbox_3857;
    this.width = meta.width;
    this.height = meta.height;
  }

  static async load(baseUrl = '.') {
    const meta = await fetch(`${baseUrl}/data/bed.json`, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`bed.json : HTTP ${r.status}`);
      return r.json();
    });

    const blob = await fetch(`${baseUrl}/data/bed.png`).then((r) => {
      if (!r.ok) throw new Error(`bed.png : HTTP ${r.status}`);
      return r.blob();
    });
    const bitmap = await createImageBitmap(blob);

    // Décodage processeur : un seul passage, à l'ouverture.
    const canvas = new OffscreenCanvas(meta.width, meta.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, meta.width, meta.height);

    const { base, interval } = meta.encoding;
    const count = meta.width * meta.height;
    const altitudes = new Float32Array(count);
    const alpha = new Uint8Array(count);

    for (let i = 0; i < count; i += 1) {
      const o = i * 4;
      alpha[i] = data[o + 3];
      altitudes[i] = data[o + 3] === 0
        ? NaN
        : base + (data[o] * 65536 + data[o + 1] * 256 + data[o + 2]) * interval;
    }

    // Carte de couverture : distance à la sonde mesurée la plus proche. Facultative —
    // l'application reste utilisable sans, elle perd seulement l'indication de fiabilité.
    let coverage = null;
    let coverageBitmap = null;
    try {
      const response = await fetch(`${baseUrl}/data/coverage.png`);
      if (response.ok) {
        coverageBitmap = await createImageBitmap(await response.blob());
        context.clearRect(0, 0, meta.width, meta.height);
        context.drawImage(coverageBitmap, 0, 0);
        const grey = context.getImageData(0, 0, meta.width, meta.height).data;
        coverage = new Uint8Array(count);
        for (let i = 0; i < count; i += 1) coverage[i] = grey[i * 4];
      }
    } catch {
      // Sans couverture, on n'affiche simplement aucune mise en garde.
    }

    return new BedGrid(meta, bitmap, altitudes, alpha, coverage, coverageBitmap);
  }

  /** Indice de cellule contenant ce point, ou -1 hors emprise. */
  indexAt(lon, lat) {
    const [mx, my] = toMercator(lon, lat);
    const col = Math.floor(((mx - this.x0) / (this.x1 - this.x0)) * this.width);
    const row = Math.floor(((this.y1 - my) / (this.y1 - this.y0)) * this.height);
    if (col < 0 || col >= this.width || row < 0 || row >= this.height) return -1;
    return row * this.width + col;
  }

  /** Altitude brute du fond en m NGF à la cellule contenant le point, ou NaN hors du lac. */
  rawAltitudeAt(lon, lat) {
    const index = this.indexAt(lon, lat);
    return index < 0 ? NaN : this.altitudes[index];
  }

  /**
   * Altitude brute interpolée bilinéairement — la même valeur que celle qu'affiche la
   * carte.
   *
   * Le shader interpole entre les quatre cellules voisines pour supprimer la maille de
   * 5 m ; lire ici la cellule la plus proche donnerait au bateau une profondeur
   * différente de celle sous ses pieds sur la carte, avec des sauts brusques au passage
   * d'une cellule à l'autre.
   *
   * Les cellules hors du lac sont exclues de la moyenne, sinon le fond plongerait
   * artificiellement le long des rives.
   */
  altitudeAt(lon, lat) {
    const [mx, my] = toMercator(lon, lat);
    const x = ((mx - this.x0) / (this.x1 - this.x0)) * this.width - 0.5;
    const y = ((this.y1 - my) / (this.y1 - this.y0)) * this.height - 0.5;

    const col = Math.floor(x);
    const row = Math.floor(y);
    const fx = x - col;
    const fy = y - row;

    let sum = 0;
    let total = 0;
    for (let dy = 0; dy <= 1; dy += 1) {
      for (let dx = 0; dx <= 1; dx += 1) {
        const c = col + dx;
        const r = row + dy;
        if (c < 0 || c >= this.width || r < 0 || r >= this.height) continue;
        const z = this.altitudes[r * this.width + c];
        if (!Number.isFinite(z)) continue;
        const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        sum += z * weight;
        total += weight;
      }
    }
    return total > 0.001 ? sum / total : NaN;
  }

  /**
   * Distance en mètres à la sonde mesurée la plus proche, ou NaN si inconnue.
   *
   * C'est le seul indicateur honnête de ce que vaut le modèle localement : au-delà de
   * quelques dizaines de mètres, la valeur affichée est interpolée entre des traces
   * éloignées et non mesurée. Un haut-fond y est invisible.
   */
  soundingDistanceAt(lon, lat) {
    if (!this.coverage) return NaN;
    const index = this.indexAt(lon, lat);
    return index < 0 ? NaN : this.coverage[index];
  }
}

/**
 * Altitude corrigée du décalage d'étalonnage.
 *
 * Le décalage ne concerne que ce qui dérive du levé de 2009, dont la cote de référence
 * reste à confirmer. Les cellules issues du MNT LiDAR et de la contrainte de bord sont
 * des altitudes absolues et ne doivent pas bouger. Elles se reconnaissent sans donnée
 * supplémentaire : par construction, la fusion ne les a relevées qu'au-dessus du plan
 * d'eau LiDAR.
 */
export function correctedAltitude(raw, offset, waterPlane) {
  if (!Number.isFinite(raw)) return NaN;
  return raw < waterPlane ? raw + offset : raw;
}
