// Synchronisation vers des fichiers du dépôt GitHub : relevés, trajets, sorties.
//
// Modèle « propriétaire écrit, tout le monde lit » — le seul sûr pour une application
// statique publique : le jeton d'écriture ne peut pas être partagé (le code est lisible
// par tous), il reste donc sur l'appareil du propriétaire. Les autres visiteurs lisent les
// fichiers publiés, sans aucun jeton.
//
// Les formats sont volontairement génériques (schema + waterbody + datum) pour resservir à
// d'autres plans d'eau : un fichier par lac.
//
//   data/corrections/<lac>.json     relevés (points) et zones émergées
//   data/routes/<lac>.json          trajets, l'intention de route
//   data/trips/<lac>/index.json     sorties : le catalogue
//   data/trips/<lac>/<id>.json      sorties : la trace de chacune
//
// Pourquoi les sorties ont droit à un fichier chacune, alors que tout le reste tient dans
// un seul : une trace fait des centaines de points et ne sera jamais modifiée. Les réunir
// obligerait à retélécharger toute la saison pour en consulter une, et à réécrire le tout
// pour en ajouter une. Le catalogue suffit à dresser la liste ; la trace ne se charge que
// lorsqu'on demande à la revoir.

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

function headers() {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/**
 * Un fichier JSON du dépôt, lu et écrit par l'API Contents.
 *
 * Toute la plomberie GitHub tient ici : lecture fraîche avec révision quand on a le jeton,
 * lecture du fichier publié sinon, écriture avec reprise sur révision périmée (409). Les
 * trois synchronisations ci-dessous n'ont plus qu'à décrire leur format.
 */
export class RepoFile {
  constructor({ repo, path, branch = 'main', baseUrl = '.' }) {
    this.repo = repo;
    this.path = path;
    this.branch = branch;
    this.baseUrl = baseUrl;
    this.sha = null; // dernière révision connue du fichier (exigée pour réécrire)
  }

  hasToken() { return Boolean(getToken()); }

  /** Contenu du fichier, ou `null` s'il n'existe pas encore. */
  async read() {
    if (this.hasToken()) return this.readApi();
    return this.readPublished();
  }

  async readApi() {
    const url = `${API}/repos/${this.repo}/contents/${encodeURI(this.path)}?ref=${this.branch}`;
    const res = await fetch(url, { headers: headers(), cache: 'no-store' });
    if (res.status === 404) { this.sha = null; return null; }
    if (!res.ok) throw new Error(`lecture API : HTTP ${res.status}`);
    const body = await res.json();
    this.sha = body.sha;
    return JSON.parse(fromBase64(body.content));
  }

  async readPublished() {
    const res = await fetch(`${this.baseUrl}/${this.path}`, { cache: 'no-cache' });
    if (!res.ok) return null;
    return res.json();
  }

  /** Écrit le fichier. Nécessite un jeton. */
  async write(value, message) {
    if (!this.hasToken()) throw new Error('aucun jeton');
    // On s'assure d'avoir la révision courante, sinon GitHub refuse l'écriture.
    if (this.sha === null) { try { await this.readApi(); } catch { /* 1er commit */ } }
    const content = `${JSON.stringify(value, null, 2)}\n`;
    const put = async () => fetch(`${API}/repos/${this.repo}/contents/${encodeURI(this.path)}`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        message,
        content: toBase64(content),
        branch: this.branch,
        ...(this.sha ? { sha: this.sha } : {}),
      }),
    });

    let res = await put();
    if (res.status === 409) { // révision périmée : on relit et on réessaie une fois
      await this.readApi();
      res = await put();
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`écriture : HTTP ${res.status} ${detail.slice(0, 120)}`);
    }
    this.sha = (await res.json()).content.sha;
    return true;
  }

  /** Supprime le fichier du dépôt. Silencieux s'il n'y était pas. */
  async erase(message) {
    if (!this.hasToken()) throw new Error('aucun jeton');
    if (this.sha === null) { try { await this.readApi(); } catch { /* déjà absent */ } }
    if (!this.sha) return false;
    const res = await fetch(`${API}/repos/${this.repo}/contents/${encodeURI(this.path)}`, {
      method: 'DELETE',
      headers: headers(),
      body: JSON.stringify({ message, sha: this.sha, branch: this.branch }),
    });
    if (!res.ok && res.status !== 404) throw new Error(`suppression : HTTP ${res.status}`);
    this.sha = null;
    return true;
  }
}

export class CorrectionsSync {
  constructor({ repo, path, branch = 'main', waterbody, datum, baseUrl = '.' }) {
    this.repo = repo;         // « propriétaire/dépôt »
    this.path = path;         // « data/corrections/<lac>.json »
    this.branch = branch;
    this.waterbody = waterbody;
    this.datum = datum;
    this.baseUrl = baseUrl;
    this.file = new RepoFile({ repo, path, branch, baseUrl });
  }

  hasToken() { return Boolean(getToken()); }
  get dirty() { return isDirty(); }
  markDirty() { setDirty(true); }
  get sha() { return this.file.sha; }

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
    const file = await this.file.read();
    if (!file) return { records: [], zones: [] };
    return { records: CorrectionsSync.fromFile(file), zones: CorrectionsSync.zonesFromFile(file) };
  }

  // --- écriture ---------------------------------------------------------------
  /** Écrit l'intégralité des relevés et des zones dans le dépôt. Nécessite un jeton. */
  async push(records, meta, zones = []) {
    await this.file.write(
      this.toFile(records, meta, zones),
      `Relevés ${this.waterbody} : ${records.length} point(s)`
        + `${zones.length ? `, ${zones.length} zone(s)` : ''}`,
    );
    setDirty(false);
    return true;
  }
}

/**
 * Trajets partagés : un seul fichier, comme les relevés.
 *
 * Un trajet est court (quelques points de passage) et se retouche — c'est une intention de
 * route, pas un fait. Le fichier unique s'y prête : on le relit, on le fusionne, on le
 * réécrit en entier, exactement comme les relevés.
 */
export class RoutesSync {
  constructor({ repo, path, branch = 'main', waterbody, baseUrl = '.' }) {
    this.waterbody = waterbody;
    this.file = new RepoFile({ repo, path, branch, baseUrl });
  }

  hasToken() { return Boolean(getToken()); }

  static fromFile(file) {
    const routes = Array.isArray(file?.routes) ? file.routes : [];
    return routes
      .filter((r) => Array.isArray(r.points) && r.points.length >= 2)
      .map((r) => ({
        id: r.id ?? crypto.randomUUID(),
        at: r.at ?? new Date().toISOString(),
        name: r.name || 'Trajet',
        points: r.points.map((p) => [p[0], p[1]]),
        by: r.by ?? null,
      }));
  }

  toFile(records) {
    return {
      schema: 'relieflac.routes/1',
      waterbody: this.waterbody,
      updated_at: new Date().toISOString(),
      routes: records.map((r) => ({
        id: r.id,
        name: r.name,
        at: r.at,
        points: r.points.map((p) => [p[0], p[1]]),
        by: r.by ?? null,
      })),
    };
  }

  async pull() {
    const file = await this.file.read();
    return file ? RoutesSync.fromFile(file) : [];
  }

  async push(records) {
    return this.file.write(
      this.toFile(records),
      `Trajets ${this.waterbody} : ${records.length} trajet(s)`,
    );
  }
}

/**
 * Sorties partagées : un catalogue, et un fichier par trace.
 *
 * Le catalogue porte de quoi dresser la liste — nom, dates, longueur, nombre de points —
 * sans une seule coordonnée. C'est lui qu'on lit au démarrage ; les traces, qui pèsent
 * mille fois plus, ne descendent qu'à la demande, et jamais deux fois grâce à la copie
 * locale.
 */
export class TripsSync {
  constructor({ repo, dir, branch = 'main', waterbody, baseUrl = '.' }) {
    this.repo = repo;
    this.dir = dir.replace(/\/$/, '');   // « data/trips/<lac> »
    this.branch = branch;
    this.waterbody = waterbody;
    this.baseUrl = baseUrl;
    this.index = new RepoFile({ repo, path: `${this.dir}/index.json`, branch, baseUrl });
    this.tracks = new Map();             // id → RepoFile, pour garder les révisions connues
  }

  hasToken() { return Boolean(getToken()); }

  /** Nom de fichier d'une sortie. L'identifiant est un UUID : sûr comme nom de fichier. */
  pathOf(id) { return `${this.dir}/${id}.json`; }

  #track(id) {
    if (!this.tracks.has(id)) {
      this.tracks.set(id, new RepoFile({
        repo: this.repo, path: this.pathOf(id), branch: this.branch, baseUrl: this.baseUrl,
      }));
    }
    return this.tracks.get(id);
  }

  static entriesFromIndex(file) {
    const trips = Array.isArray(file?.trips) ? file.trips : [];
    return trips
      .filter((t) => t && t.id)
      .map((t) => ({
        id: t.id,
        name: t.name || 'Sortie',
        at: t.at ?? null,
        endedAt: t.ended_at ?? null,
        length_m: Number.isFinite(t.length_m) ? t.length_m : null,
        count: Number.isFinite(t.points) ? t.points : null,
        routeId: t.route_id ?? null,
        by: t.by ?? null,
        // Synthèse de session de ski, absente des sorties de navigation et des fichiers
        // publiés avant le L15 : `null` alors, et la sortie s'affiche sans elle.
        ski: t.ski ?? null,
      }));
  }

  toIndex(entries) {
    return {
      schema: 'relieflac.trips-index/1',
      waterbody: this.waterbody,
      updated_at: new Date().toISOString(),
      trips: entries.map((t) => ({
        id: t.id,
        name: t.name,
        at: t.at,
        ended_at: t.endedAt ?? null,
        length_m: Number.isFinite(t.length_m) ? Math.round(t.length_m) : null,
        points: Number.isFinite(t.count) ? t.count : null,
        route_id: t.routeId ?? null,
        by: t.by ?? null,
        ski: t.ski ?? null,
        file: `${t.id}.json`,
      })),
    };
  }

  toTrackFile(trip) {
    return {
      schema: 'relieflac.trip/1',
      waterbody: this.waterbody,
      id: trip.id,
      name: trip.name,
      at: trip.at,
      ended_at: trip.endedAt ?? null,
      route_id: trip.routeId ?? null,
      by: trip.by ?? null,
      ski: trip.ski ?? null,
      points: trip.points.map((p) => [p[0], p[1]]),
    };
  }

  /** Catalogue des sorties partagées. Tableau vide si rien n'a encore été publié. */
  async pullIndex() {
    const file = await this.index.read();
    return file ? TripsSync.entriesFromIndex(file) : [];
  }

  /** Trace d'une sortie partagée, ou `null` si son fichier a disparu. */
  async pullTrack(id) {
    const file = await this.#track(id).read();
    const points = Array.isArray(file?.points) ? file.points : null;
    return points && points.length >= 2 ? points.map((p) => [p[0], p[1]]) : null;
  }

  /** Publie une trace, puis le catalogue mis à jour. */
  async pushTrip(trip, entries) {
    await this.#track(trip.id).write(
      this.toTrackFile(trip),
      `Sortie ${this.waterbody} : ${trip.name}`,
    );
    return this.pushIndex(entries);
  }

  async pushIndex(entries) {
    return this.index.write(
      this.toIndex(entries),
      `Sorties ${this.waterbody} : ${entries.length} sortie(s)`,
    );
  }

  /** Retire une sortie du partage : sa trace, puis le catalogue. */
  async removeTrip(id, entries) {
    await this.#track(id).erase(`Sortie ${this.waterbody} retirée`);
    this.tracks.delete(id);
    return this.pushIndex(entries);
  }
}
