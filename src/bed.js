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
  constructor(meta, bitmap, altitudes, alpha, coverage = null, coverageBitmap = null, bound = null) {
    this.meta = meta;
    this.bitmap = bitmap;
    // Grille brute du levé 2009 (invariante) et grille de travail affichée : elles ne
    // diffèrent que là où des relevés manuels corrigent le fond. `altitudes` et `coverage`
    // pointent sur la brute tant qu'aucune correction n'est appliquée.
    this.baseAltitudes = altitudes; // Float32Array, NaN hors du lac
    this.altitudes = altitudes;
    this.alpha = alpha;
    // Distance en mètres à la sonde mesurée la plus proche, plafonnée à 255.
    this.baseCoverage = coverage;
    this.coverage = coverage;
    this.coverageBitmap = coverageBitmap;
    // Borne de profondeur de la cartographie communautaire, en mètres ; 0 = aucune.
    // Elle ne bouge pas avec les corrections manuelles : c'est une donnée du fichier, pas
    // un état de travail. Un relevé manuel rapproche la sonde, il n'efface pas l'encadrement.
    this.bound = bound;
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

    // Carte de fiabilité, à trois canaux depuis l'apport communautaire : R = distance à la
    // sonde mesurée la plus proche, G = borne de profondeur Quickdraw (0 = aucune), B = le
    // relèvement qu'elle a appliqué. Trois états, donc, et non deux : mesuré, encadré,
    // interpolé. Une carte à un seul canal — les versions antérieures — se lit toujours :
    // G y vaut 0 partout, ce qui revient à « aucun encadrement », et l'application retombe
    // sur son comportement d'avant. Facultative : sans elle, plus aucune mise en garde.
    let coverage = null;
    let coverageBitmap = null;
    let bound = null;
    try {
      const response = await fetch(`${baseUrl}/data/coverage.png`);
      if (response.ok) {
        coverageBitmap = await createImageBitmap(await response.blob());
        context.clearRect(0, 0, meta.width, meta.height);
        context.drawImage(coverageBitmap, 0, 0);
        const channels = context.getImageData(0, 0, meta.width, meta.height).data;
        coverage = new Uint8Array(count);
        bound = new Uint8Array(count);
        for (let i = 0; i < count; i += 1) {
          coverage[i] = channels[i * 4];
          bound[i] = channels[i * 4 + 1];
        }
      }
    } catch {
      // Sans couverture, on n'affiche simplement aucune mise en garde.
    }

    return new BedGrid(meta, bitmap, altitudes, alpha, coverage, coverageBitmap, bound);
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
    return this.#sample(this.altitudes, lon, lat);
  }

  /** Altitude du levé 2009 seul, sans les corrections manuelles (point de départ d'un relevé). */
  baseAltitudeAt(lon, lat) {
    return this.#sample(this.baseAltitudes, lon, lat);
  }

  #sample(grid, lon, lat) {
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
        const z = grid[r * this.width + c];
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

  /**
   * Borne de profondeur donnée par la cartographie communautaire, en mètres — 0 si la
   * communauté n'est jamais passée là.
   *
   * Ce n'est pas une mesure : une bande dit « entre 4 et 6 m », et on n'en retient que la
   * borne basse de l'altitude. Mais entre deux traces du levé de 2009 distantes de 150 m,
   * savoir que le fond n'est pas plus bas que ça vaut mieux qu'une interpolation. C'est le
   * troisième état de la carte de fiabilité : ni mesuré, ni inconnu — encadré.
   */
  communityBoundAt(lon, lat) {
    if (!this.bound) return 0;
    const index = this.indexAt(lon, lat);
    return index < 0 ? 0 : this.bound[index];
  }

  /**
   * Applique des relevés manuels sur la grille du levé 2009 pour produire la « carte
   * courante ». Deux formes de relevé sont acceptées dans le même tableau :
   *
   *   • un **point** `{ lon, lat, bedZ, radius_m }` — une sonde ou un témoin ;
   *   • une **zone** `{ ring: [[lon, lat], …], bedZ, radius_m }` — un contour fermé, tracé
   *     à la main, dont tout l'intérieur est porté à `bedZ` (un îlot, une langue de terre).
   *
   * Chaque relevé pose un **plateau** — la surface où la carte vaut exactement la valeur
   * relevée — entouré d'un **fondu** en cosinus qui rejoint le levé 2009. Pour un point, le
   * plateau occupe la moitié centrale du rayon ; pour une zone, c'est l'intérieur du
   * contour, et `radius_m` mesure la largeur du fondu au-delà du bord.
   *
   * Le plateau est ce qui distingue cette version de la précédente, qui n'appliquait la
   * valeur relevée qu'au centre exact et retombait vers 2009 dès le premier mètre : une
   * mesure de haut-fond y devenait une pointe, alors que ce qu'elle dit honnêtement est
   * « au moins ça, sur une certaine surface ».
   *
   * Les recouvrements se **fusionnent** au lieu de s'empiler. Les relevés étaient
   * auparavant appliqués l'un après l'autre sur le résultat du précédent : deux points
   * voisins se corrigeaient l'un l'autre, et le résultat dépendait de leur ordre dans le
   * tableau — donc de l'ordre de saisie. Ici chaque cellule collecte les contributions de
   * tous les relevés qui l'atteignent, puis n'est écrite qu'une fois :
   *
   *   • couverte par un ou plusieurs plateaux → moyenne de ces relevés-là, eux seuls
   *     (deux mesures du même endroit se moyennent ; un voisin lointain ne déplace pas
   *     une valeur mesurée ici) ;
   *   • atteinte par des fondus seulement → moyenne pondérée des relevés concernés, mêlée
   *     au levé 2009 selon la somme des poids, plafonnée à 1. Plusieurs relevés qui se
   *     recouvrent tirent donc la carte **plus fermement** vers leur valeur commune, sans
   *     jamais la dépasser.
   *
   * Le relevé étant désormais connu, on ramène aussi la carte de couverture à la distance
   * réelle au relevé, ce qui efface le hachurage « non sondé » et la mise en garde
   * d'interpolation à cet endroit.
   *
   * On repart toujours de la grille brute : retirer un relevé suffit à revenir au 2009.
   * Renvoie le rectangle de cellules modifiées (pour un ré-upload ciblé), ou null.
   */
  applyCorrections(records, radiusM = 20) {
    const patches = (records ?? [])
      .filter((r) => Number.isFinite(r.bedZ))
      .map((r) => shapeOf(r, radiusM))
      .filter(Boolean);

    if (patches.length === 0) {
      this.altitudes = this.baseAltitudes;
      this.coverage = this.baseCoverage;
      return null;
    }

    const alt = this.baseAltitudes.slice();
    const cov = this.baseCoverage ? this.baseCoverage.slice() : null;

    // Accumulateurs épars. Un relevé ne touche qu'une poignée de cellules et la grille en
    // compte 1,2 million : deux tableaux pleins coûteraient 10 Mo à chaque saisie, pour
    // quelques centaines de cellules réellement écrites.
    const core = new Map(); // cellule → { sum, count } : relevés dont le plateau la couvre
    const halo = new Map(); // cellule → { w, wz }      : relevés dont seul le fondu l'atteint
    const reach = cov ? new Map() : null; // cellule → distance au relevé le plus proche (m)
    let minC = this.width; let minR = this.height; let maxC = -1; let maxR = -1;

    for (const patch of patches) {
      this.#eachCell(patch, (idx, col, row, distance) => {
        if (!Number.isFinite(this.baseAltitudes[idx])) return; // hors du lac : rien à corriger
        if (distance <= patch.core) {
          const cell = core.get(idx);
          if (cell) { cell.sum += patch.bedZ; cell.count += 1; }
          else core.set(idx, { sum: patch.bedZ, count: 1 });
        } else {
          const w = fade(distance, patch.core, patch.outer);
          if (w <= 0) return;
          const cell = halo.get(idx);
          if (cell) { cell.w += w; cell.wz += w * patch.bedZ; }
          else halo.set(idx, { w, wz: w * patch.bedZ });
        }
        if (reach) {
          const d = Math.max(0, Math.round(distance));
          const known = reach.get(idx);
          if (known === undefined || d < known) reach.set(idx, d);
        }
        if (col < minC) minC = col; if (col > maxC) maxC = col;
        if (row < minR) minR = row; if (row > maxR) maxR = row;
      });
    }

    for (const [idx, cell] of core) alt[idx] = cell.sum / cell.count;
    for (const [idx, cell] of halo) {
      if (core.has(idx)) continue; // un plateau commande, le fondu d'un voisin ne l'entame pas
      const w = Math.min(1, cell.w);
      alt[idx] = this.baseAltitudes[idx] * (1 - w) + (cell.wz / cell.w) * w;
    }
    if (cov) for (const [idx, d] of reach) cov[idx] = Math.min(cov[idx], d);

    this.altitudes = alt;
    if (cov) this.coverage = cov;
    return maxC < 0 ? null : { minC, minR, maxC, maxR };
  }

  /**
   * Parcourt les cellules atteintes par un relevé et livre leur distance au sol à sa
   * forme — négative à l'intérieur d'une zone, qui est son propre plateau.
   */
  #eachCell(shape, visit) {
    const cellW = (this.x1 - this.x0) / this.width;  // mètres mercator par colonne
    const cellH = (this.y1 - this.y0) / this.height; // mètres mercator par ligne
    // Un mètre au sol vaut 1/cos(lat) mètre mercator : on convertit la portée voulue.
    const scale = Math.max(Math.cos((shape.lat * Math.PI) / 180), 1e-6);
    const margin = shape.outer / scale;

    const col0 = Math.max(0, Math.floor((shape.x0 - margin - this.x0) / cellW - 0.5));
    const col1 = Math.min(this.width - 1, Math.ceil((shape.x1 + margin - this.x0) / cellW - 0.5));
    const row0 = Math.max(0, Math.floor((this.y1 - shape.y1 - margin) / cellH - 0.5));
    const row1 = Math.min(this.height - 1, Math.ceil((this.y1 - shape.y0 + margin) / cellH - 0.5));

    for (let row = row0; row <= row1; row += 1) {
      const my = this.y1 - (row + 0.5) * cellH;
      for (let col = col0; col <= col1; col += 1) {
        const mx = this.x0 + (col + 0.5) * cellW;
        const distance = shape.distance(mx, my) * scale;
        if (distance > shape.outer) continue;
        visit(row * this.width + col, col, row, distance);
      }
    }
  }
}

/**
 * Part du rayon d'un relevé ponctuel occupée par son plateau.
 *
 * La moitié : assez large pour qu'une sonde marque une surface plutôt qu'un pic — et pour
 * que la lecture bilinéaire sous le bateau retrouve exactement la valeur saisie, les quatre
 * cellules voisines tombant elles aussi dans le plateau — assez étroite pour que la
 * transition vers le levé garde de quoi se faire sans marche.
 */
export const CORE_RATIO = 0.5;

/** Poids du fondu : 1 au bord du plateau, 0 au bord extérieur, sans cassure aux deux bouts. */
function fade(distance, core, outer) {
  if (distance <= core) return 1;
  if (distance >= outer || outer <= core) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * (distance - core)) / (outer - core)));
}

/**
 * Traduit un relevé en forme géométrique prête à être estampée : emprise en mercator,
 * latitude de référence pour l'échelle, plateau, portée, et fonction de distance.
 */
function shapeOf(record, defaultRadius) {
  const radius = Number.isFinite(record.radius_m) && record.radius_m >= 0
    ? record.radius_m
    : defaultRadius;

  if (Array.isArray(record.ring) && record.ring.length >= 3) {
    const ring = record.ring
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat))
      .map(([lon, lat]) => toMercator(lon, lat));
    if (ring.length < 3) return null;
    const xs = ring.map(([x]) => x);
    const ys = ring.map(([, y]) => y);
    const lat = record.ring.reduce((s, [, y]) => s + y, 0) / record.ring.length;
    return {
      bedZ: record.bedZ,
      lat,
      x0: Math.min(...xs), x1: Math.max(...xs),
      y0: Math.min(...ys), y1: Math.max(...ys),
      core: 0,        // le plateau, c'est l'intérieur du contour
      outer: radius,  // et le rayon mesure la largeur du fondu au-delà du bord
      // À l'intérieur, la distance exacte au bord n'importe pas : elle est négative, donc
      // sous le plateau. La calculer quand même coûterait un parcours de segments par
      // cellule, sur la partie la plus dense de la zone.
      distance: (mx, my) => (inRing(mx, my, ring) ? -1 : distanceToRing(mx, my, ring)),
    };
  }

  if (!Number.isFinite(record.lon) || !Number.isFinite(record.lat)) return null;
  const [px, py] = toMercator(record.lon, record.lat);
  return {
    bedZ: record.bedZ,
    lat: record.lat,
    x0: px, x1: px, y0: py, y1: py,
    core: radius * CORE_RATIO,
    outer: radius,
    distance: (mx, my) => Math.hypot(mx - px, my - py),
  };
}

/** Point dans un contour fermé — lancer de rayon, sur les coordonnées projetées. */
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance d'un point au bord d'un contour (le plus court des segments). */
function distanceToRing(x, y, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const dx = xj - xi;
    const dy = yj - yi;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / len2)) : 0;
    const d = Math.hypot(x - (xi + t * dx), y - (yi + t * dy));
    if (d < best) best = d;
  }
  return best;
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
