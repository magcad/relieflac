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
  constructor(meta, bitmap, altitudes, alpha) {
    this.meta = meta;
    this.bitmap = bitmap;
    this.altitudes = altitudes; // Float32Array, NaN hors du lac
    this.alpha = alpha;
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

    return new BedGrid(meta, bitmap, altitudes, alpha);
  }

  /** Indice de cellule contenant ce point, ou -1 hors emprise. */
  indexAt(lon, lat) {
    const [mx, my] = toMercator(lon, lat);
    const col = Math.floor(((mx - this.x0) / (this.x1 - this.x0)) * this.width);
    const row = Math.floor(((this.y1 - my) / (this.y1 - this.y0)) * this.height);
    if (col < 0 || col >= this.width || row < 0 || row >= this.height) return -1;
    return row * this.width + col;
  }

  /** Altitude brute du fond en m NGF, ou NaN hors du lac. */
  rawAltitudeAt(lon, lat) {
    const index = this.indexAt(lon, lat);
    return index < 0 ? NaN : this.altitudes[index];
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
