// Courbe de la cote du lac : géométrie et tracé.
//
// Le module est volontairement sans dépendance et sans DOM au cœur : `chartGeometry` ne
// fait que des mathématiques, ce qui permet de la vérifier au banc sans navigateur simulé.
// Seul `renderChart` fabrique du SVG, à partir de cette géométrie-là.
//
// Choix de lecture, tous dictés par l'usage sur l'eau, écran au soleil :
//
//   • l'échelle verticale se cale sur les extrêmes de la FENÊTRE affichée, pas sur la plage
//     de manœuvre du barrage. Vassivière descend de 10 m dans l'année mais de 2 cm dans une
//     journée : une échelle fixe écraserait la semaine en une ligne droite ;
//   • ces deux extrêmes sont matérialisés en pointillés et chiffrés, faute de quoi une
//     courbe autoéchelonnée ne dit rien de l'amplitude réelle ;
//   • le trait est épais et jaune, comme le curseur d'étiage auquel il répond.

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const JOUR_MS = 86400e3;

export const LEVEL_RANGES = [
  { key: 'D', label: 'Jour', days: 1, title: 'les dernières 24 h' },
  { key: 'W', label: 'Sem.', days: 7, title: 'les 7 derniers jours' },
  { key: 'M', label: 'Mois', days: 31, title: 'les 31 derniers jours' },
  { key: 'Y', label: 'Année', days: 365, title: 'les 12 derniers mois' },
];

export const DEFAULT_RANGE = 'W';

export function rangeOf(key) {
  return LEVEL_RANGES.find((r) => r.key === key) ?? LEVEL_RANGES.find((r) => r.key === DEFAULT_RANGE);
}

/**
 * Découpe la fenêtre à afficher, ancrée sur le DERNIER relevé connu et non sur l'instant.
 *
 * Un téléphone rallumé après trois jours sans réseau afficherait sinon une fenêtre « Jour »
 * vide, alors qu'il a la donnée en cache : mieux vaut montrer les dernières 24 h de mesures
 * et laisser l'axe des dates dire de quand elles datent.
 */
export function windowOf(entries, key) {
  if (!entries?.length) return [];
  const end = entries[entries.length - 1].t;
  const start = end - rangeOf(key).days * JOUR_MS;
  return entries.filter((e) => e.t >= start);
}

/**
 * Place la série dans la boîte de tracé.
 *
 * Renvoie `{ ok: false }` si rien n'est traçable — série vide ou boîte dégénérée — pour que
 * l'appelant affiche un état vide plutôt qu'un cadre avec des `NaN` dedans.
 */
export function chartGeometry(points, box) {
  const { width, height, padLeft = 46, padRight = 14, padTop = 16, padBottom = 24 } = box;
  const x0 = padLeft;
  const x1 = width - padRight;
  const y0 = padTop;
  const y1 = height - padBottom;
  if (!points?.length || x1 <= x0 || y1 <= y0) return { ok: false };

  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Marge verticale : une série plate ne doit pas être écrasée sur le bord de la boîte, et
  // les deux pointillés doivent rester à l'intérieur du cadre pour rester lisibles.
  const pad = Math.max(0.04, (max - min) * 0.22);
  const lo = min - pad;
  const hi = max + pad;

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = t1 - t0;

  // Une seule mesure, ou toutes à la même seconde : on la pose au milieu plutôt que de
  // diviser par zéro.
  const xOf = (t) => (span > 0 ? x0 + ((t - t0) / span) * (x1 - x0) : (x0 + x1) / 2);
  const yOf = (v) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);

  return {
    ok: true, x0, x1, y0, y1, t0, t1, min, max, lo, hi, xOf, yOf,
    first: points[0],
    last: points[points.length - 1],
  };
}

/**
 * Réduit la série à un point par colonne de pixels.
 *
 * Une année d'historique horaire fait 8 760 points pour 300 px de large : le chemin SVG
 * pèserait 100 ko pour un rendu identique. Les extrêmes chiffrés, eux, restent calculés sur
 * la série entière — c'est le tracé qu'on allège, pas la mesure.
 */
export function samplePerColumn(points, columns) {
  if (!points?.length || points.length <= columns || columns < 2) return points ?? [];
  const t0 = points[0].t;
  const span = points[points.length - 1].t - t0;
  if (span <= 0) return [points[0]];

  const kept = [];
  let lastColumn = -1;
  for (const point of points) {
    const column = Math.round(((point.t - t0) / span) * (columns - 1));
    if (column !== lastColumn) { kept.push(point); lastColumn = column; }
  }
  const last = points[points.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

/** Graduations de l'axe des dates, en pas ronds propres à chaque durée. */
export function ticksFor(key, t0, t1) {
  if (!(t1 > t0)) return [];
  const ticks = [];

  if (key === 'D') {
    const cursor = new Date(t0);
    cursor.setMinutes(0, 0, 0);
    cursor.setHours(Math.ceil(cursor.getHours() / 6) * 6);
    for (let t = cursor.getTime(); t <= t1; t += 6 * 3600e3) {
      ticks.push({ t, label: `${String(new Date(t).getHours()).padStart(2, '0')} h` });
    }
    return ticks;
  }

  if (key === 'Y') {
    const cursor = new Date(t0);
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);
    if (cursor.getTime() < t0) cursor.setMonth(cursor.getMonth() + 1);
    while (cursor.getTime() <= t1) {
      ticks.push({ t: cursor.getTime(), label: MOIS[cursor.getMonth()] });
      cursor.setMonth(cursor.getMonth() + 2);
    }
    return ticks;
  }

  const step = key === 'M' ? 7 : 1; // en jours
  const cursor = new Date(t0);
  cursor.setHours(0, 0, 0, 0);
  if (cursor.getTime() < t0) cursor.setDate(cursor.getDate() + 1);
  while (cursor.getTime() <= t1) {
    const d = new Date(cursor);
    ticks.push({
      t: d.getTime(),
      label: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`,
    });
    cursor.setDate(cursor.getDate() + step);
  }
  return ticks;
}

/** Relevé le plus proche d'un instant donné — c'est ce que désigne le doigt sur la courbe. */
export function nearestPoint(points, t) {
  if (!points?.length) return null;
  let best = points[0];
  let bestGap = Math.abs(points[0].t - t);
  for (const point of points) {
    const gap = Math.abs(point.t - t);
    if (gap < bestGap) { best = point; bestGap = gap; }
  }
  return best;
}

export function formatMoment(t, key) {
  const d = new Date(t);
  const jour = `${String(d.getDate()).padStart(2, '0')} ${MOIS[d.getMonth()]}`;
  if (key === 'Y' || key === 'M') return `${jour} ${d.getFullYear()}`;
  return `${jour}, ${String(d.getHours()).padStart(2, '0')} h`;
}

export function shortDate(t) {
  const d = new Date(t);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function formatCote(v) {
  return v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Le tracé complet, en une chaîne de balises SVG prête à poser dans le panneau. */
export function renderChart(points, key, box) {
  const g = chartGeometry(points, box);
  if (!g.ok) return '';

  const drawn = samplePerColumn(points, Math.round(g.x1 - g.x0));
  const line = drawn.map((p, i) => `${i ? 'L' : 'M'}${g.xOf(p.t).toFixed(1)} ${g.yOf(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${g.xOf(g.last.t).toFixed(1)} ${g.y1.toFixed(1)} `
    + `L${g.xOf(g.first.t).toFixed(1)} ${g.y1.toFixed(1)} Z`;

  const limite = (v, nom) => `
    <g class="chart__limg">
      <title>${nom} ${formatCote(v)} m NGF</title>
      <line class="chart__lim" x1="${g.x0}" x2="${g.x1}" y1="${g.yOf(v).toFixed(1)}" y2="${g.yOf(v).toFixed(1)}"/>
      <text class="chart__limlab" x="${g.x0 - 6}" y="${(g.yOf(v) + 3.5).toFixed(1)}"
            text-anchor="end">${formatCote(v)}</text>
    </g>`;

  const inside = ticksFor(key, g.t0, g.t1)
    .filter((tick) => g.xOf(tick.t) > g.x0 + 8 && g.xOf(tick.t) < g.x1 - 8);

  // Aucune graduation ronde ne tombe dans la fenêtre — une semaine d'historique regardée en
  // « Année », par exemple. Un axe muet ne dit pas de quand datent les mesures : on borne
  // alors par les deux dates extrêmes, sans trait de grille.
  const ticks = inside.length
    ? inside.map((tick) => `
        <line class="chart__grid" x1="${g.xOf(tick.t).toFixed(1)}" x2="${g.xOf(tick.t).toFixed(1)}"
              y1="${g.y0}" y2="${g.y1}"/>
        <text class="chart__xlab" x="${g.xOf(tick.t).toFixed(1)}" y="${g.y1 + 15}"
              text-anchor="middle">${tick.label}</text>`).join('')
    : `<text class="chart__xlab" x="${g.x0}" y="${g.y1 + 15}" text-anchor="start">${shortDate(g.t0)}</text>
       <text class="chart__xlab" x="${g.x1}" y="${g.y1 + 15}" text-anchor="end">${shortDate(g.t1)}</text>`;

  // Un seul relevé dans la fenêtre : le chemin serait invisible, on montre la pastille.
  const trait = drawn.length > 1
    ? `<path class="chart__area" d="${area}"/><path class="chart__line" d="${line}"/>`
    : '';

  return `
    <defs>
      <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fbbf24" stop-opacity=".26"/>
        <stop offset="1" stop-color="#fbbf24" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${ticks}
    ${limite(g.max, 'Maximum sur la période :')}
    ${limite(g.min, 'Minimum sur la période :')}
    ${trait}
    <g class="chart__cursor" id="chart-cursor" hidden>
      <line x1="0" x2="0" y1="${g.y0}" y2="${g.y1}"/>
      <circle r="5.5" cx="0" cy="0"/>
    </g>
    <circle class="chart__last" cx="${g.xOf(g.last.t).toFixed(1)}" cy="${g.yOf(g.last.v).toFixed(1)}" r="4.5"/>`;
}
