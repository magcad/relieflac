// Synchronisation des relevés vers un fichier du dépôt GitHub.
//
// Modèle « propriétaire écrit, tout le monde lit » — le seul sûr pour une application
// statique publique : le jeton d'écriture ne peut pas être partagé (le code est lisible
// par tous), il reste donc sur l'appareil du propriétaire. Les autres visiteurs lisent le
// fichier publié, sans aucun jeton.
//
// Le format est volontairement générique (schema + waterbody + datum) pour resservir à
// d'autres plans d'eau : un fichier par lac, `data/corrections/<lac>.json`.

const TOKEN_KEY = 'relieflac.token.v1';
const DIRTY_KEY = 'relieflac.sync.dirty.v1';
const API = 'https://api.github.com';

/** Le jeton n'est jamais exporté avec les réglages : il vit seul, sur l'appareil. */
export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* stockage indisponible : le jeton ne sera pas mémorisé */ }
}

function isDirty() {
  try { return localStorage.getItem(DIRTY_KEY) === '1'; } catch { return false; }
}
function setDirty(v) {
  try { if (v) localStorage.setItem(DIRTY_KEY, '1'); else localStorage.removeItem(DIRTY_KEY); } catch { /* */ }
}

/** UTF-8 → base64 sans dépendance, en traitant les caractères hors ASCII. */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function fromBase64(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class CorrectionsSync {
  constructor({ repo, path, branch = 'main', waterbody, datum, baseUrl = '.' }) {
    this.repo = repo;         // « propriétaire/dépôt »
    this.path = path;         // « data/corrections/<lac>.json »
    this.branch = branch;
    this.waterbody = waterbody;
    this.datum = datum;
    this.baseUrl = baseUrl;
    this.sha = null;          // dernière révision connue du fichier (pour l'écriture)
  }

  hasToken() { return Boolean(getToken()); }
  get dirty() { return isDirty(); }
  markDirty() { setDirty(true); }

  // --- conversion enregistrement interne ↔ point du fichier -------------------
  // Interne : { id, at, lon, lat, bedZ, depth_m, cote_m, transducer_m, radius_m,
  //             position_source }
  // Fichier : { id, lon, lat, depth_m, cote_m_ngf, transducer_m, z_fond_m_ngf, radius_m,
  //             position_source, at, by }
  //
  // L'immersion accompagne le relevé au lieu d'être un réglage global : c'est un paramètre
  // de la mesure, figé à l'instant où elle a été prise. Écrire le réglage courant à sa
  // place réattribue aux anciens relevés une immersion qu'ils n'ont jamais eue — sans
  // conséquence tant que `z_fond` reste figé, mais faux dès qu'on le recalcule, ce que
  // fera toute correction d'échelle du sondeur. La valeur passée en paramètre ne sert
  // plus que de repli, pour les relevés antérieurs à cette règle.
  toFile(records, { transducer_m, radius_m }, zones = []) {
    return {
      schema: 'relieflac.corrections/1',
      waterbody: this.waterbody,
      datum: this.datum,
      updated_at: new Date().toISOString(),
      // Les zones voyagent à part des points, et c'est le fond de l'affaire : un point est
      // une mesure, une zone est une interprétation — « à partir d'ici, c'est de la terre ».
      // Les mêler donnerait un fichier où plus rien ne dit ce qui a été mesuré. Un lecteur
      // qui ne connaît pas les zones lit les points sans s'en apercevoir.
      zones: (zones ?? []).map((z) => ({
        id: z.id,
        ring: z.ring,
        ground_m_ngf: z.bedZ,
        height_m: z.height_m ?? null,
        cote_m_ngf: z.cote_m ?? null,
        feather_m: Number.isFinite(z.feather_m) ? z.feather_m : null,
        at: z.at,
        by: z.by ?? null,
      })),
      points: records.map((r) => ({
        id: r.id,
        lon: r.lon,
        lat: r.lat,
        depth_m: r.depth_m ?? null,
        cote_m_ngf: r.cote_m ?? null,
        transducer_m: r.transducer_m ?? transducer_m ?? null,
        z_fond_m_ngf: r.bedZ,
        // Comme l'immersion, le rayon appartient au relevé : c'est l'étendue sur laquelle
        // son auteur a jugé sa mesure représentative. Le réglage global ne sert que de
        // repli, pour les relevés antérieurs à cette règle.
        radius_m: Number.isFinite(r.radius_m) ? r.radius_m : radius_m,
        // « gps » (relevé sur place) ou « map » (position pointée à la main sur la carte).
        // Une position désignée ne vaut pas une position mesurée : le fichier doit le dire,
        // sans quoi rien ne permettra plus de trancher entre deux relevés qui se contredisent.
        position_source: r.position_source ?? 'gps',
        at: r.at,
        by: r.by ?? null,
      })),
    };
  }

  static fromFile(file) {
    const points = Array.isArray(file?.points) ? file.points : [];
    return points
      .filter((p) => Number.isFinite(p.z_fond_m_ngf) && Number.isFinite(p.lon) && Number.isFinite(p.lat))
      .map((p) => ({
        id: p.id ?? crypto.randomUUID(),
        at: p.at ?? new Date().toISOString(),
        lon: p.lon,
        lat: p.lat,
        bedZ: p.z_fond_m_ngf,
        depth_m: p.depth_m ?? null,
        cote_m: p.cote_m_ngf ?? null,
        // Relue et non redéduite du réglage courant : sans elle, le relevé n'est plus
        // recalculable, et `z_fond` devient une valeur qu'on ne sait plus refaire.
        transducer_m: Number.isFinite(p.transducer_m) ? p.transducer_m : null,
        radius_m: Number.isFinite(p.radius_m) ? p.radius_m : null,
        position_source: p.position_source ?? 'gps',
        by: p.by ?? null,
      }));
  }

  /**
   * Zones relues du fichier. Un contour de moins de trois sommets n'a pas de surface :
   * il est écarté ici plutôt que de faire tomber `applyCorrections` sur le bateau.
   */
  static zonesFromFile(file) {
    const zones = Array.isArray(file?.zones) ? file.zones : [];
    return zones
      .filter((z) => Number.isFinite(z.ground_m_ngf) && Array.isArray(z.ring) && z.ring.length >= 3)
      .map((z) => ({
        id: z.id ?? crypto.randomUUID(),
        at: z.at ?? new Date().toISOString(),
        ring: z.ring,
        bedZ: z.ground_m_ngf,
        height_m: Number.isFinite(z.height_m) ? z.height_m : null,
        cote_m: Number.isFinite(z.cote_m_ngf) ? z.cote_m_ngf : null,
        feather_m: Number.isFinite(z.feather_m) ? z.feather_m : null,
        by: z.by ?? null,
      }));
  }

  // --- lecture ----------------------------------------------------------------
  /**
   * Récupère les relevés partagés. Avec un jeton, on lit par l'API (frais + révision sha
   * pour pouvoir réécrire) ; sans jeton, on lit le fichier publié avec le site.
   * Renvoie { records, zones } — les deux tableaux, vides si le fichier n'existe pas encore.
   */
  async pull() {
    if (this.hasToken()) return this.#pullApi();
    return this.#pullPublished();
  }

  async #pullApi() {
    const url = `${API}/repos/${this.repo}/contents/${encodeURI(this.path)}?ref=${this.branch}`;
    const res = await fetch(url, { headers: this.#headers(), cache: 'no-store' });
    if (res.status === 404) { this.sha = null; return { records: [], zones: [] }; }
    if (!res.ok) throw new Error(`lecture API : HTTP ${res.status}`);
    const body = await res.json();
    this.sha = body.sha;
    const file = JSON.parse(fromBase64(body.content));
    return { records: CorrectionsSync.fromFile(file), zones: CorrectionsSync.zonesFromFile(file) };
  }

  async #pullPublished() {
    const res = await fetch(`${this.baseUrl}/${this.path}`, { cache: 'no-cache' });
    if (!res.ok) return { records: [], zones: [] };
    const file = await res.json();
    return { records: CorrectionsSync.fromFile(file), zones: CorrectionsSync.zonesFromFile(file) };
  }

  // --- écriture ---------------------------------------------------------------
  /** Écrit l'intégralité des relevés et des zones dans le dépôt. Nécessite un jeton. */
  async push(records, meta, zones = []) {
    if (!this.hasToken()) throw new Error('aucun jeton');
    // On s'assure d'avoir la révision courante, sinon GitHub refuse l'écriture.
    if (this.sha === null) { try { await this.#pullApi(); } catch { /* 1er commit */ } }
    const content = `${JSON.stringify(this.toFile(records, meta, zones), null, 2)}\n`;
    const put = async () => fetch(`${API}/repos/${this.repo}/contents/${encodeURI(this.path)}`, {
      method: 'PUT',
      headers: this.#headers(),
      body: JSON.stringify({
        message: `Relevés ${this.waterbody} : ${records.length} point(s)`
          + `${zones.length ? `, ${zones.length} zone(s)` : ''}`,
        content: toBase64(content),
        branch: this.branch,
        ...(this.sha ? { sha: this.sha } : {}),
      }),
    });

    let res = await put();
    if (res.status === 409) { // révision périmée : on relit et on réessaie une fois
      await this.#pullApi();
      res = await put();
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`écriture : HTTP ${res.status} ${detail.slice(0, 120)}`);
    }
    this.sha = (await res.json()).content.sha;
    setDirty(false);
    return true;
  }

  #headers() {
    return {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }
}
