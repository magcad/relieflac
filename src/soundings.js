// Les 8 118 sondes du levé de 2009 : affichage et recherche de proximité.
//
// À quoi ça sert d'afficher des points de mesure vieux de dix-sept ans : les traces sont
// espacées d'environ 100 m, et tout ce qui est entre deux traces est interpolé. Un relevé
// d'étalonnage pris entre les traces mesure surtout l'erreur d'interpolation, pas le
// décalage de référence qu'on cherche. Voir la trace, c'est pouvoir naviguer dessus.

const CELL_DEGREES = 0.002; // ~150 m, du même ordre que l'espacement entre traces

export class Soundings {
  constructor(points) {
    this.points = points; // Float64Array [lon, lat, prof] × n
    this.count = points.length / 3;
    this.buckets = new Map();
    for (let i = 0; i < this.count; i += 1) {
      const key = this.#key(points[i * 3], points[i * 3 + 1]);
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(i); else this.buckets.set(key, [i]);
    }
  }

  static async load(baseUrl = '.') {
    const text = await fetch(`${baseUrl}/data/soundings/ofb2009.csv`).then((r) => {
      if (!r.ok) throw new Error(`sondes : HTTP ${r.status}`);
      return r.text();
    });

    const lines = text.trim().split('\n');
    const points = new Float64Array((lines.length - 1) * 3);
    let n = 0;
    for (let i = 1; i < lines.length; i += 1) {
      const [lon, lat, depth] = lines[i].split(',');
      const values = [Number(lon), Number(lat), Number(depth)];
      if (!values.every(Number.isFinite)) continue;
      points.set(values, n * 3);
      n += 1;
    }
    return new Soundings(points.subarray(0, n * 3));
  }

  #key(lon, lat) {
    return `${Math.floor(lon / CELL_DEGREES)}:${Math.floor(lat / CELL_DEGREES)}`;
  }

  /** Distance en mètres à la sonde la plus proche, ou Infinity au-delà d'une cellule. */
  distanceToNearest(lon, lat) {
    const mPerDegLat = 111320;
    const mPerDegLon = mPerDegLat * Math.cos(lat * (Math.PI / 180));
    const cx = Math.floor(lon / CELL_DEGREES);
    const cy = Math.floor(lat / CELL_DEGREES);

    let best = Infinity;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = this.buckets.get(`${cx + dx}:${cy + dy}`);
        if (!bucket) continue;
        for (const i of bucket) {
          const ex = (this.points[i * 3] - lon) * mPerDegLon;
          const ey = (this.points[i * 3 + 1] - lat) * mPerDegLat;
          const d = ex * ex + ey * ey;
          if (d < best) best = d;
        }
      }
    }
    return best === Infinity ? Infinity : Math.sqrt(best);
  }

  toGeoJSON() {
    const features = new Array(this.count);
    for (let i = 0; i < this.count; i += 1) {
      features[i] = {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [this.points[i * 3], this.points[i * 3 + 1]] },
        properties: { prof: this.points[i * 3 + 2] },
      };
    }
    return { type: 'FeatureCollection', features };
  }
}
