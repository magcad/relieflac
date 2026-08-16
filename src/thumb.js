/**
 * Vignettes de trajets : silhouette du lac, tracé par-dessus, départ et arrivée marqués.
 *
 * Le texte seul ne distingue pas deux trajets — « Tour du lac » et « Tour du lac bis » se
 * ressemblent, et une miniature du seul tracé ne ferait pas mieux (deux allers-retours
 * donnent deux traits). Ce qui identifie un trajet, c'est **où** il est sur le lac : la
 * vignette est donc toujours cadrée sur l'emprise du LAC, jamais sur celle du trajet.
 * Cadrer sur le trajet ferait remplir sa vignette à chacun, et ils se ressembleraient de
 * nouveau. Conséquence assumée : un petit parcours devient un pâté de quelques pixels — sa
 * position dans la silhouette est l'information.
 *
 * Module pur : chaînes en entrée, chaîne SVG en sortie, aucun DOM, aucune dépendance à la
 * carte. Il se vérifie donc au banc. Les couleurs vivent dans `app.css` (classes `thumb__*`)
 * pour que le mode plein soleil les reprenne comme le reste.
 *
 * La silhouette vient de `src/lake-outline.js`, déjà projetée par
 * `tools/build_lake_outline.py` dans la boîte normalisée qu'il transporte : c'est la même
 * formule de projection des deux côtés, et le repère voyage avec le chemin plutôt que
 * d'être recopié ici.
 */

import { LAKE_OUTLINE } from './lake-outline.js';

/** Ordonnée Web Mercator, en degrés — jumelle de `mercator_y` de l'outil de génération. */
export function mercatorY(lat) {
  return (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;
}

/**
 * Projette un point (lon, lat) dans la boîte normalisée de la silhouette.
 * `bounds` et `box` viennent du module généré : rien n'est codé en dur ici.
 */
export function projectPoint(lon, lat, bounds = LAKE_OUTLINE.bounds, box = LAKE_OUTLINE.box) {
  const northY = mercatorY(bounds.north);
  const southY = mercatorY(bounds.south);
  return [
    ((lon - bounds.west) / (bounds.east - bounds.west)) * box.width,
    ((northY - mercatorY(lat)) / (northY - southY)) * box.height,
  ];
}

/** Chemin SVG d'une polyligne `[[lon, lat], …]`, vide si elle n'a pas deux points. */
export function polylinePath(points, bounds, box) {
  if (!Array.isArray(points) || points.length < 2) return '';
  return `M${points.map((p) => {
    const [x, y] = projectPoint(p[0], p[1], bounds, box);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ')}`;
}

function escapeAttr(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Vignette complète, en chaîne SVG à insérer telle quelle.
 *
 * Aucune donnée d'utilisateur n'entre dans la géométrie : seules des coordonnées formatées
 * en nombres et le libellé, échappé, y figurent.
 *
 * L'épaisseur des traits est en pixels d'écran (`vector-effect: non-scaling-stroke`) et non
 * en unités de la boîte : c'est ce qui garantit qu'un trajet court reste visible, quel que
 * soit le facteur d'échelle de l'affichage.
 */
export function thumbSvg(points, { label = '', outline = LAKE_OUTLINE } = {}) {
  const { box, bounds } = outline;
  const route = polylinePath(points, bounds, box);
  const first = Array.isArray(points) && points.length ? points[0] : null;
  const last = Array.isArray(points) && points.length ? points[points.length - 1] : null;
  const marker = (p, cls, r) => {
    if (!p) return '';
    const [x, y] = projectPoint(p[0], p[1], bounds, box);
    return `<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`;
  };
  return [
    `<svg class="thumb" viewBox="0 0 ${box.width} ${box.height}" preserveAspectRatio="xMidYMid meet"`,
    ` role="img" aria-label="${escapeAttr(label)}">`,
    `<path class="thumb__lake" fill-rule="evenodd" d="${outline.path}"/>`,
    route ? `<path class="thumb__route" fill="none" vector-effect="non-scaling-stroke" d="${route}"/>` : '',
    marker(first, 'thumb__start', 26),
    points && points.length > 1 ? marker(last, 'thumb__end', 26) : '',
    '</svg>',
  ].join('');
}

/**
 * Clé de cache d'une vignette. **`id` seul ne suffit pas** : un trajet partagé change sous
 * le même identifiant quand son propriétaire le modifie, et la synchronisation le remplace
 * après le premier rendu de la liste. L'horodatage de dernière écriture fait la différence.
 */
export function thumbKey(route) {
  return `${route?.id ?? ''}@${route?.at ?? ''}`;
}
