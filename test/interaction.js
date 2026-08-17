// Banc d'essai des enchaînements de l'interface.
//
// On charge le vrai `index.html` (une seule source de vérité pour le balisage), on démarre
// la vraie application, et l'on provoque sur la carte factice les mêmes événements que la
// vraie carte. Ce qui est vérifié ici n'est pas la logique des modules — `selftest.js` s'en
// charge — mais la chaîne complète : un geste, un état d'application, un affichage, et ce
// qui reste dans le stockage local une fois l'opération faite.

const results = [];
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
}
function group(name) {
  results.push({ group: name });
}

/** Un bouton destructeur demande deux appuis : le premier arme, le second exécute. */
function press(id) {
  $(id).click();
  $(id).click();
}

// ------------------------------------------------- emprunt du stockage de l'appareil
//
// Le banc tourne sur la MÊME origine que l'application : ses sondes, ses zones, ses
// réglages et son jeton d'écriture sont là, à portée. Deux dangers, tous deux réels sur le
// site publié : effacer des relevés que l'utilisateur a pris sur l'eau, et — pire —
// déclencher un envoi vers le dépôt, puisqu'une sonde ajoutée ici serait poussée comme une
// vraie dès lors qu'un jeton traîne. On met donc tout de côté avant de commencer, jeton
// compris (sans jeton, la synchronisation reste en lecture seule), et on remet l'appareil
// exactement dans l'état où on l'a trouvé — y compris si le banc échoue en route.

const KEPT = new Map();

function borrowStorage() {
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith('relieflac.')) KEPT.set(key, localStorage.getItem(key));
  }
  for (const key of KEPT.keys()) localStorage.removeItem(key);
}

function returnStorage() {
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i);
    if (key?.startsWith('relieflac.')) localStorage.removeItem(key);
  }
  for (const [key, value] of KEPT) localStorage.setItem(key, value);
}

const stored = (key) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? []; } catch { return []; }
};
const probes = () => stored('relieflac.probes.v1');
const zones = () => stored('relieflac.zones.v1');
const sims = () => stored('relieflac.sim.v1');

/** Attend qu'une condition devienne vraie, ou renonce — pour ne jamais figer la page. */
async function until(condition, timeout = 5000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (condition()) return true;
    await sleep(50);
  }
  return false;
}

async function boot() {
  // Le balisage vient de l'application elle-même : dupliquer les écrans ici, ce serait
  // vérifier une copie qui divergerait au premier bouton ajouté.
  const html = await fetch('./index.html', { cache: 'no-cache' }).then((r) => r.text());
  const page = new DOMParser().parseFromString(html, 'text/html');
  const report = $('rapport');
  for (const node of [...page.body.children]) {
    if (node.tagName === 'SCRIPT') continue;
    document.body.insertBefore(document.adoptNode(node), report);
  }

  // Le banc part d'un appareil vierge — et rendra le vrai stockage intact à la fin.
  borrowStorage();
  check('le stockage de l\'appareil est mis de côté, jeton compris',
    localStorage.getItem('relieflac.token.v1') === null,
    `${KEPT.size} clé(s) en dépôt`);
  // Aucun leurre sur `confirm` : l'application ne doit plus en dépendre du tout. On le
  // piège au contraire pour le prouver — ce navigateur, comme un Chrome où la case
  // « empêcher les boîtes de dialogue » a été cochée, le fait renvoyer `false`, ce qui
  // rendait toute suppression silencieusement inopérante.
  let dialogs = 0;
  Object.defineProperty(window, 'confirm', {
    value: () => { dialogs += 1; return false; }, configurable: true, writable: true,
  });
  window.__dialogs = () => dialogs;

  // GPS simulé. On capture l'instance de géolocalisation SANS armer le matériel : dans un
  // navigateur de banc, l'autorisation est refusée et aucun point n'arriverait jamais — or
  // tout le mode ski se joue sur la vitesse, donc sur des points. Le banc les pousse ensuite
  // par le même événement que la vraie puce.
  const { Geolocator } = await import('../src/geo.js');
  Geolocator.prototype.start = function start() { window.__geo = this; };

  // Adresses relatives à CE module (et non à la base du document) : c'est ainsi que se
  // résout un import dynamique. La carte d'import de la page les renvoie sur le leurre.
  const { LakeMap } = await import('../src/map.js');
  await import('../src/main.js');
  const started = await until(() => $('chargement').hidden, 15000);
  check('l\'application démarre entièrement', started,
    started ? '' : $('chargement').textContent.trim());
  if (!started) return null;

  // L'avertissement d'ouverture : il doit paraître à chaque lancement, et se refermer sur
  // le seul bouton qu'il porte. Le banc le lit puis l'écarte, comme le ferait un barreur.
  check('l\'avertissement communautaire s\'affiche au lancement', $('gate').hidden === false,
    $('gate').textContent.replace(/\s+/g, ' ').trim().slice(0, 70));
  $('btn-gate-ok').click();
  check('il se referme sur « J\'ai compris »', $('gate').hidden === true);

  // `initSync` récupère les relevés publiés en tâche de fond et remplace le jeu local :
  // provoquer un geste avant qu'il ait fini le ferait écraser sans rapport avec le geste.
  await sleep(2000);
  return LakeMap.last;
}

async function run() {
  const map = await boot();
  if (!map) return render();

  const lngLat = { lng: 1.87132, lat: 45.79328 };
  const fire = (type, detail) => map.dispatchEvent(new CustomEvent(type, { detail }));

  // ---------------------------------------------------- point posé sans GPS
  group('Point posé au clic droit, sans position GPS');
  const before = probes().length;
  fire('pinpoint', lngLat);
  check('le repère de visée est posé sur la carte', map.pin !== null,
    JSON.stringify(map.pin));
  check('la barre de saisie s\'ouvre', $('capture').hidden === false);
  check('l\'abandon est proposé', $('btn-cap-cancel').hidden === false);

  $('cap-input').value = '3.2';
  $('cap-input').dispatchEvent(new Event('input'));
  $('btn-capture').click();
  check('la sonde est enregistrée', probes().length === before + 1,
    `${probes().length} sonde(s), ${before} avant`);
  check('la position vient du point désigné',
    probes().at(-1)?.fixSource === 'map' && probes().at(-1)?.lon === lngLat.lng,
    `${probes().at(-1)?.fixSource}`);
  check('le repère de visée est retiré une fois la sonde posée', map.pin === null);

  // Le trait de côte se relève à zéro. Le champ refusait cette valeur — héritée de la règle
  // des logs de sondeur, où un zéro signe un décrochage de l'instrument : la campagne à pied
  // était donc impossible, sans autre message qu'un « saisissez la profondeur ». Le fond
  // relevé doit tomber exactement sur la cote du moment, immersion du transducteur comprise
  // (rien n'est immergé sur la ligne d'eau).
  fire('pinpoint', lngLat);
  $('cap-input').value = '0';
  $('cap-input').dispatchEvent(new Event('input'));
  $('btn-capture').click();
  const shore = probes().at(-1);
  check('une sonde à zéro — le trait de côte — est acceptée',
    shore?.sounderDepth === 0, `${probes().length} sonde(s), dernière à ${shore?.sounderDepth}`);
  check('et son fond tombe sur la cote du lac, sans retrancher l\'immersion',
    shore != null && Math.abs(shore.bedZ - shore.level) < 1e-9,
    `fond ${shore?.bedZ} pour une cote de ${shore?.level}`);

  // -------------------------------------------- suppression par la barre de saisie
  group('Suppression depuis la barre de saisie');
  const target = probes().at(-1);
  fire('probeselect', target.id);
  check('toucher la pastille ouvre la correction',
    $('capture').hidden === false && $('capture').classList.contains('is-editing'));
  check('le bouton de suppression apparaît', $('btn-cap-delete').hidden === false);
  check('le rayon d\'influence est proposé', $('cap-radius-box').hidden === false,
    `rayon ${$('cap-radius').value}`);

  // Le premier appui ne doit rien détruire : il arme, et cela doit se voir.
  $('btn-cap-delete').click();
  check('un seul appui n\'efface rien',
    probes().some((p) => p.id === target.id)
    && $('btn-cap-delete').classList.contains('is-arming'),
    `libellé « ${$('btn-cap-delete').textContent} »`);

  $('btn-cap-delete').click();
  check('la sonde est supprimée du stockage',
    probes().every((p) => p.id !== target.id),
    `${probes().length} restante(s)`);
  check('la pastille disparaît de la carte',
    map.probes.every((p) => p.id !== target.id));
  check('la barre revient en saisie', $('btn-capture').textContent === 'Relever'
    && $('btn-cap-delete').hidden === true);

  // ------------------------------------- suppression depuis la liste des Paramètres
  group('Suppression depuis la liste des Paramètres');
  fire('pinpoint', { lng: 1.8720, lat: 45.7935 });
  $('cap-input').value = '4.5';
  $('cap-input').dispatchEvent(new Event('input'));
  $('btn-capture').click();
  const listed = probes().at(-1);
  location.hash = '#/parametres';
  await sleep(60);
  // La liste est présentée du plus récent au plus ancien : la sonde qu'on vient de poser
  // est en tête.
  const row = $('probe-records').children[0];
  check('la sonde figure en tête de liste', row?.textContent.includes('4.5 m'),
    `${$('probe-records').children.length} ligne(s) · « ${row?.textContent.trim().slice(0, 24)} »`);
  row?.querySelector('button:last-child')?.click();
  check('la croix de la liste supprime la sonde',
    probes().every((p) => p.id !== listed.id), `${probes().length} restante(s)`);
  location.hash = '#/';
  await sleep(60);

  // ------------------------------------- la suppression survit-elle à la synchronisation ?
  group('Suppression et relevés partagés');
  const shared = probes().find((p) => p.levelSource === 'sync');
  if (!shared) {
    check('un relevé partagé est disponible pour l\'essai', false, 'aucun relevé venu du dépôt');
  } else {
    const others = probes().length - 1;
    fire('probeselect', shared.id);
    press('btn-cap-delete');
    check('un relevé venu du dépôt se supprime localement',
      probes().every((p) => p.id !== shared.id), `${probes().length} restante(s)`);
    // « Récupérer les relevés » refait exactement ce que fait l'ouverture de l'application.
    $('btn-sync-now').click();
    await until(() => probes().length !== others, 4000);
    check('et il ne revient pas à la synchronisation suivante',
      probes().every((p) => p.id !== shared.id),
      probes().some((p) => p.id === shared.id) ? 'ressuscité par la fusion' : 'bien absent');
  }

  // ------------------------------------------------------------- zones émergées
  group('Zone émergée : tracé, sélection, suppression');
  // Le dépôt publie ses propres zones, et l'application les reprend au démarrage : le banc
  // ne part donc pas d'une carte vierge, même après avoir mis le stockage de côté. On
  // compte ce que ce banc ajoute, jamais ce que l'appareil contient — sans quoi publier une
  // seule zone communautaire ferait échouer huit enchaînements qui n'ont rien à voir avec
  // elle. Même raison pour viser la zone par son identifiant plutôt que par son rang.
  const zonesFond = zones().length;
  $('btn-zone').click();
  check('le panneau s\'ouvre sur la liste, sans commencer à tracer',
    map.zoneMode === true && map.tracing === false
    && $('zone-list').hidden === false && $('btn-zone-new').hidden === false);

  $('btn-zone-new').click();
  check('« Nouvelle zone » démarre le tracé',
    map.tracing === true && $('btn-zone-undo').hidden === false);
  const ring = [[1.8710, 45.7930], [1.8716, 45.7930], [1.8716, 45.7935], [1.8710, 45.7935]];
  for (const [lng, lat] of ring) fire('zonevertex', { lngLat: { lng, lat }, zoneId: null });
  check('les sommets s\'accumulent', map.zoneDraft.length === 4, `${map.zoneDraft.length}`);
  check('la fermeture devient possible', $('btn-zone-close').disabled === false);

  fire('zoneclose');
  check('la zone est enregistrée', zones().length === zonesFond + 1,
    `${zones().length} pour ${zonesFond} au départ`);
  check('elle est reprise en réglage aussitôt', $('btn-zone-del').hidden === false);
  // Les zones sont rangées de la plus ancienne à la plus récente : celle qu'on vient de
  // refermer est la dernière.
  const zoneId = zones().at(-1)?.id;
  check('son contour est affiché', map.zones.length === zonesFond + 1
    && map.zones.find((z) => z.id === zoneId)?.selected === true);

  // Sortir du mode puis y revenir pour reprendre une zone posée plus tôt : c'est le geste
  // courant, et le chemin vers sa suppression depuis la carte.
  $('btn-zone-exit').click();
  $('btn-zone').click();
  fire('zonevertex', { lngLat: { lng: 1.8713, lat: 45.7932 }, zoneId });
  check('un contour posé plus tôt se reprend au toucher',
    $('btn-zone-del').hidden === false, `zone ${zoneId ? 'présente' : 'absente'}`);

  // Le défaut signalé par l'utilisateur : un sommet posé par mégarde avant de viser le
  // contour rendait la zone injoignable, donc impossible à supprimer. Le tracé ne
  // commençant plus tout seul, un clic hors tracé ne peut plus poser de sommet.
  $('btn-zone-exit').click();
  $('btn-zone').click();
  fire('zonevertex', { lngLat: { lng: 1.8700, lat: 45.7920 }, zoneId: null });
  check('hors tracé, un clic sur la carte ne pose aucun sommet',
    map.zoneDraft.length === 0, `${map.zoneDraft.length} sommet(s)`);
  fire('zonevertex', { lngLat: { lng: 1.8713, lat: 45.7932 }, zoneId });
  check('le contour reste joignable ensuite',
    $('btn-zone-del').hidden === false, `${map.zoneDraft.length} sommet(s) en cours`);

  // Un tracé abandonné en route ne doit rien laisser derrière lui.
  $('btn-zone-new').click();
  fire('zonevertex', { lngLat: { lng: 1.8700, lat: 45.7920 }, zoneId: null });
  $('btn-zone-cancel').click();
  check('annuler un tracé le retire de la carte',
    map.zoneDraft.length === 0 && map.tracing === false && $('zone-list').hidden === false);

  // La liste du panneau : la reprise qui ne dépend d'aucun visé.
  check('la zone figure dans la liste du panneau',
    $('zone-list').children.length === zonesFond + 1,
    `${$('zone-list').children.length} ligne(s) · « ${$('zone-list').textContent.trim().slice(0, 30)} »`);
  $('btn-zone-exit').click();
  location.hash = '#/parametres';
  await sleep(60);
  check('et dans celle des Paramètres',
    $('zone-records').children.length === zonesFond + 1,
    `${$('zone-records').children.length} ligne(s)`);
  location.hash = '#/';
  await sleep(60);

  // Suppression par la liste du panneau, sans passer par la carte du tout. La liste va de
  // la plus récente à la plus ancienne : la première ligne est bien celle du banc.
  $('btn-zone').click();
  $('zone-list').children[0].querySelector('.zone__del').click();
  check('la croix de la liste supprime la zone',
    zones().length === zonesFond && zones().every((z) => z.id !== zoneId), `${zones().length}`);

  // Puis la même chose par le gros bouton, sur une zone tracée à neuf.
  $('btn-zone-new').click();
  for (const [lng, lat] of ring) fire('zonevertex', { lngLat: { lng, lat }, zoneId: null });
  fire('zoneclose');
  check('une seconde zone se trace après une suppression', zones().length === zonesFond + 1);
  press('btn-zone-del');
  check('la zone est supprimée du stockage', zones().length === zonesFond, `${zones().length}`);
  check('son contour disparaît de la carte', map.zones.length === zonesFond);
  check('le panneau repasse à la liste', $('btn-zone-del').hidden === true
    && $('zone-list').hidden === false && map.tracing === false);
  $('btn-zone-exit').click();
  check('quitter le mode zone rend le clic à la sonde ponctuelle', map.zoneMode === false);

  // -------------------------------------------------- témoins de simulation
  group('Témoin de simulation : pose et suppression');
  // La cote du bandeau ouvre l'étiage, et non les Paramètres : c'est le geste de quelqu'un
  // qui veut voir ce que découvre une baisse, pas saisir une cote à la main.
  $('btn-cote').click();
  check('toucher la cote ouvre le panneau d\'étiage',
    $('sim').hidden === false && location.hash !== '#/parametres', location.hash);
  $('btn-sim-exit').click();

  $('btn-sim').click();
  fire('probe', { lng: 1.8714, lat: 45.7933 });
  check('le témoin est posé', sims().length === 1, `${sims().length}`);
  check('il est sélectionné pour réglage', $('sim-sel').hidden === false);
  $('btn-sim-del').click();
  check('le témoin est supprimé', sims().length === 0, `${sims().length}`);
  check('sa pastille disparaît', map.simPoints.length === 0);

  // La simulation pilote la cote par `manualLevel`, qui est PERSISTANT. Tant qu'on en
  // sort par le bouton, tout va bien ; fermée en route, elle laissait une cote inventée
  // derrière elle, prise ensuite pour la cote du lac — et une cote fausse fausse toutes
  // les profondeurs. On vérifie donc les deux chemins de sortie, dont celui qui n'en est
  // pas un.
  const settings = () => { try { return JSON.parse(localStorage.getItem('relieflac.settings.v1')) ?? {}; } catch { return {}; } };
  // Le texte plutôt que le nombre : la cote peut être indisponible sur le poste d'essai,
  // auquel cas le bandeau affiche « — » et l'on veut quand même savoir qu'il a changé.
  // Relevé AVANT la simulation : c'est la cote du lac, celle que tout doit retrouver.
  const coteShown = () => $('cote-value').textContent;
  const coteEdf = coteShown();
  $('sim-slider').value = '644.95';
  $('sim-slider').dispatchEvent(new Event('input'));
  check('la simulation pilote bien la cote affichée',
    Math.abs(Number(settings().manualLevel) - 644.95) < 0.005
    && settings().manualFromSim === true,
    `cote ${settings().manualLevel}, marqueur ${settings().manualFromSim}`);
  check('la cote saisie se voit sur le bandeau',
    $('btn-cote').classList.contains('level--manual'),
    $('btn-cote').className);

  const coteSim = coteShown();
  $('btn-sim-exit').click();
  check('sortir de la simulation rend la cote du lac',
    settings().manualLevel === null && settings().manualFromSim === false,
    `cote ${settings().manualLevel}`);
  // Le réglage remis ne prouve rien : c'est le bandeau que le barreur lit. Il est resté
  // figé sur la cote de simulation tant que la relecture n'a pas été branchée sur le
  // changement de réglage — le premier essai de cette suite ne regardait que le stockage,
  // et il passait pendant que l'écran mentait.
  check('et le bandeau cesse d\'afficher celle de la simulation',
    !$('btn-cote').classList.contains('level--manual') && coteShown() !== coteSim,
    `bandeau ${coteShown()} (simulation ${coteSim})`);

  // ------------------------------------------------- courbe de l'évolution de la cote
  //
  // Ce qu'on vient chercher dans « Étiage » neuf fois sur dix, c'est de savoir si le lac
  // monte ou descend. La courbe est donc au premier plan, et le curseur de saisie — le
  // geste rare, et celui qui fausse toutes les profondeurs quand on l'oublie en place —
  // passe derrière un crayon.
  group('Courbe de la cote du lac');
  $('btn-sim').click();
  const drawn = await until(() => $('chart-svg').querySelector('.chart__line'), 8000);
  check('ouvrir l\'étiage dessine la courbe',
    drawn && $('chart-empty').hidden,
    `${$('chart-svg').innerHTML.length} caractères de tracé`);
  check('les extrêmes de la période sont chiffrés en marge',
    $('chart-svg').querySelectorAll('.chart__limlab').length === 2);
  check('la semaine est la durée proposée d\'emblée',
    $('chart-ranges').querySelector('[data-range="W"]').getAttribute('aria-pressed') === 'true',
    $('chart-read').textContent);

  check('la saisie manuelle et le retour à la cote EDF sont repliés',
    $('sim-manual').hidden && $('btn-sim-reset').hidden);
  $('btn-sim-manual').click();
  check('le crayon déplie le curseur, et le bouton « Cote EDF » avec lui',
    !$('sim-manual').hidden && !$('btn-sim-reset').hidden
    && $('btn-sim-manual').getAttribute('aria-pressed') === 'true');
  $('btn-sim-manual').click();
  check('un second appui les replie', $('sim-manual').hidden && $('btn-sim-reset').hidden);

  // Le panneau a grandi : il ne doit jamais recouvrir le bas du rail, où se trouve
  // « Outils » — le seul moyen de ressortir des modes de correction.
  const railBottom = document.querySelector('.rail').getBoundingClientRect().bottom;
  const panelTop = $('sim').getBoundingClientRect().top;
  check('la courbe ne mange jamais le bas du rail',
    panelTop >= railBottom - 1,
    `rail jusqu'à ${railBottom.toFixed(0)} px, panneau à partir de ${panelTop.toFixed(0)} px`);
  check('et il lui reste une hauteur utile',
    $('chart-plot').offsetHeight >= 150, `${$('chart-plot').offsetHeight} px`);

  const weekRead = $('chart-read').textContent;
  $('chart-ranges').querySelector('[data-range="D"]').click();
  check('changer de durée redessine et le dit',
    $('chart-read').textContent !== weekRead && $('chart-read').textContent.includes('24 h'),
    $('chart-read').textContent);
  $('chart-ranges').querySelector('[data-range="W"]').click();

  check('l\'ouverture a inscrit la cote dans l\'historique de l\'appareil',
    localStorage.getItem('relieflac.levelhist.v1') !== null);

  $('btn-sim-exit').click();
  check('quitter l\'étiage replie la saisie manuelle',
    $('sim-manual').hidden && $('btn-sim-reset').hidden
    && $('btn-sim-manual').getAttribute('aria-pressed') === 'false');

  // -------------------------------------------- retour à la cote EDF depuis les réglages
  //
  // Le chemin que suit quelqu'un qui trouve une cote manuelle en place et veut s'en
  // débarrasser : le champ des Paramètres, puis le bouton d'à côté.
  group('Retour à la cote EDF');
  location.hash = '#/parametres';
  await sleep(60);
  $('set-manual-level').value = '644.95';
  $('set-manual-level').dispatchEvent(new Event('change'));
  check('une cote saisie à la main s\'affiche aussitôt',
    coteShown() === '644,95' && $('btn-cote').classList.contains('level--manual'),
    `bandeau ${coteShown()}, classes ${$('btn-cote').className}`);

  $('btn-clear-manual').click();
  check('« Revenir à la cote EDF » vide le réglage',
    settings().manualLevel === null, `cote ${settings().manualLevel}`);
  check('et le bandeau retrouve la cote du lac',
    coteShown() === coteEdf && !$('btn-cote').classList.contains('level--manual'),
    `bandeau ${coteShown()}, attendu ${coteEdf}`);
  check('le champ de saisie est vidé lui aussi',
    $('set-manual-level').value === '', `« ${$('set-manual-level').value} »`);
  location.hash = '#/';
  await sleep(60);

  // ------------------------------------------------- bascule de fond bathymétrique
  //
  // Le seul moyen de prouver que la bascule change vraiment la carte lue, et pas seulement
  // le libellé affiché : poser deux fois la même sonde au même point, une fois sur chaque
  // fond, et comparer l'altitude que le modèle annonce dessous.
  group('Bascule de fond bathymétrique');
  // Point choisi pour que les deux cartes y diffèrent franchement : celui des sondes
  // précédentes tombe, depuis le recalage de terrain, à 3 cm près sur les deux — un
  // enchaînement juste y échouerait sans que rien ne soit cassé.
  const forkPoint = { lng: 1.90, lat: 45.79 };
  const readModel = async () => {
    fire('pinpoint', forkPoint);
    $('cap-input').value = '3.0';
    $('cap-input').dispatchEvent(new Event('input'));
    $('btn-capture').click();
    return probes().at(-1)?.modelBedZ;
  };

  // La carte communautaire est celle qui s'ouvre par défaut depuis le 16/08/2026 : le banc
  // part donc d'elle, et c'est vers le levé qu'il bascule.
  check('la carte communautaire est affichée au démarrage',
    $('set-bed-source').value === 'quickdraw', $('set-bed-source').value);
  const onCommunity = await readModel();
  location.hash = '#/parametres';
  await sleep(60);
  $('set-bed-source').value = 'ofb2009';
  $('set-bed-source').dispatchEvent(new Event('change'));
  // Le menu ne montre pas le souhait mais le fond RÉELLEMENT chargé : `refreshSettingsUi`
  // le remet sur la source affichée, et il ne bascule qu'une fois la grille échangée. C'est
  // donc le signal d'attente le plus honnête dont dispose le banc.
  const swapped = await until(() => $('set-bed-source').value === 'ofb2009', 8000);
  check('le réglage bascule sur le levé de 2009', swapped,
    $('hint-bed-source').textContent.slice(0, 90));

  location.hash = '#/';
  await sleep(60);
  const onSurvey = await readModel();
  check('le modèle lu sous le bateau change avec le fond',
    Number.isFinite(onSurvey) && Number.isFinite(onCommunity)
    && Math.abs(onSurvey - onCommunity) > 0.5,
    `${onSurvey?.toFixed(2)} m NGF (levé) · ${onCommunity?.toFixed(2)} m NGF (communauté)`);

  // Le champ « Recalage de la carte » est unique et suit la carte affichée : sur le levé il
  // porte la cote du jour du levé, sur la communautaire le plan d'eau des bandes. Les deux
  // valeurs ne doivent pas se contaminer — c'est tout l'enjeu du regroupement.
  location.hash = '#/parametres';
  await sleep(60);
  check('sur le levé, le champ de recalage porte la cote du levé',
    Math.abs(Number($('set-datum').value)) < 0.005
    && $('hint-datum').textContent.includes('levé'),
    `${$('set-datum').value} · ${$('hint-datum').textContent.slice(0, 60)}`);

  group('Retour au fond communautaire');
  $('set-bed-source').value = 'quickdraw';
  $('set-bed-source').dispatchEvent(new Event('change'));
  const back = await until(() => $('set-bed-source').value === 'quickdraw', 8000);
  location.hash = '#/';
  await sleep(60);
  const again = await readModel();
  check('retour à la communautaire : la même valeur qu\'au départ',
    back && Number.isFinite(again) && Math.abs(again - onCommunity) < 0.01,
    `${again?.toFixed(2)} m NGF`);

  // ------------------------------------- recalage réglable de la carte communautaire
  //
  // C'est le réglage qui sert à mesurer le bon décalage sur l'eau : il doit déplacer la
  // grille pour de vrai, et « valeur d'origine » doit rendre exactement la valeur de départ.
  group('Recalage de la carte communautaire');
  location.hash = '#/parametres';
  await sleep(60);
  const baseline = Number($('set-datum').value);
  check('le champ porte le recalage mesuré sur l\'eau',
    Math.abs(baseline - 1.72) < 0.005, `${baseline} m`);
  $('set-datum').value = (baseline + 1.5).toFixed(2);
  $('set-datum').dispatchEvent(new Event('change'));
  const moved = await until(
    () => Math.abs(Number($('set-datum').value) - (baseline + 1.5)) < 0.005, 8000);
  location.hash = '#/';
  await sleep(60);
  const raised = await readModel();
  check('le fond remonte de la valeur réglée',
    moved && Number.isFinite(raised) && Math.abs(raised - onCommunity - 1.5) < 0.05,
    `${onCommunity?.toFixed(2)} → ${raised?.toFixed(2)} m NGF, attendu `
    + `${(onCommunity + 1.5).toFixed(2)}`);

  location.hash = '#/parametres';
  await sleep(60);
  $('btn-datum-reset').click();
  const back0 = await until(
    () => Math.abs(Number($('set-datum').value) - baseline) < 0.005, 8000);
  location.hash = '#/';
  await sleep(60);
  const restored = await readModel();
  check('« Valeur d\'origine » rend exactement la valeur de départ',
    back0 && Number.isFinite(restored) && Math.abs(restored - onCommunity) < 0.005,
    `${restored?.toFixed(2)} m NGF`);

  // ------------------------------- raccourci du rail, et non-cumul des deux recalages
  //
  // Le bouton du rail est le seul endroit qui dise en permanence quelle carte est sous les
  // pieds : il doit annoncer celle qui est RÉELLEMENT chargée, et en changer d'un appui.
  group('Raccourci de carte du rail');
  check('le rail annonce la carte communautaire',
    $('tag-bed-source').textContent === 'COM', $('tag-bed-source').textContent);
  $('btn-bed-source').click();
  const toSurvey = await until(() => $('tag-bed-source').textContent === '2009', 8000);
  check('un appui bascule sur le levé de 2009', toSurvey,
    `${$('tag-bed-source').textContent} · réglage ${settings().bedSource}`);
  check('et le sélecteur des réglages suit la carte affichée',
    $('set-bed-source').value === 'ofb2009', $('set-bed-source').value);

  // Chaque carte a son recalage, et un seul agit : celui de la carte affichée. Le recalage
  // du levé s'appliquait aussi à la communautaire, qui n'en montre pourtant pas la valeur —
  // le champ disait « +1,72 » et la carte se déplaçait de 1,72 plus autre chose.
  location.hash = '#/parametres';
  await sleep(60);
  $('set-datum').value = '0.60';
  $('set-datum').dispatchEvent(new Event('change'));
  const offsetSet = await until(
    () => Math.abs((settings().calibrationOffset_m ?? 0) - 0.6) < 0.005, 8000);
  location.hash = '#/';
  await sleep(60);
  const surveyRaised = await readModel();
  check('sur le levé, le recalage remonte bien le fond lu',
    offsetSet && Number.isFinite(surveyRaised) && Math.abs(surveyRaised - onSurvey - 0.6) < 0.02,
    `${onSurvey?.toFixed(2)} → ${surveyRaised?.toFixed(2)} m NGF`);

  $('btn-bed-source').click();
  const toCommunity = await until(() => $('tag-bed-source').textContent === 'COM', 8000);
  const communityAgain = await readModel();
  check('le recalage du levé ne déplace pas la carte communautaire',
    toCommunity && Number.isFinite(communityAgain)
    && Math.abs(communityAgain - onCommunity) < 0.005,
    `${communityAgain?.toFixed(2)} m NGF, attendu ${onCommunity?.toFixed(2)}`);
  check('et le recalage resté sur l\'autre carte est signalé, non appliqué',
    !$('hint-dormant').hidden && $('hint-dormant').textContent.includes('+0.60'),
    `${$('hint-dormant').hidden ? 'masqué' : $('hint-dormant').textContent.slice(0, 70)}`);

  // On rend le levé à son recalage d'origine : la suite du banc ne doit pas hériter d'un
  // réglage posé ici.
  $('btn-bed-source').click();
  await until(() => $('tag-bed-source').textContent === '2009', 8000);
  location.hash = '#/parametres';
  await sleep(60);
  $('btn-datum-reset').click();
  const cleared = await until(() => !settings().calibrationOffset_m, 4000);
  $('btn-bed-source').click();
  const home = await until(() => $('tag-bed-source').textContent === 'COM', 8000);
  check('les deux cartes sont rendues telles qu\'on les a trouvées',
    cleared && home && $('hint-dormant').hidden,
    `recalage levé ${settings().calibrationOffset_m}`);
  location.hash = '#/';
  await sleep(60);

  // ------------------------------------------ effacement en bloc et persistance
  group('Effacement en bloc');
  fire('pinpoint', lngLat);
  $('cap-input').value = '2.0';
  $('cap-input').dispatchEvent(new Event('input'));
  $('btn-capture').click();
  const withOne = probes().length;
  location.hash = '#/parametres';
  await sleep(60);
  press('btn-probe-clear');
  check('« Tout effacer » vide bien les sondes', probes().length === 0,
    `${withOne} avant, ${probes().length} après`);
  check('aucune suppression n\'a eu besoin d\'une boîte de dialogue', window.__dialogs() === 0,
    `${window.__dialogs()} appel(s) à confirm()`);
  location.hash = '#/';
  await sleep(60);

  // ------------------------------------------------- ski nautique : session complète
  //
  // Le mode ski est celui dont la mise au point sur l'eau coûte le plus cher : on ne
  // débogue pas avec quelqu'un au bout d'une corde. Ce qui est vérifié ici, c'est la chaîne
  // complète — tracer un couloir, préparer la session, la lancer, tenir la vitesse, arrêter
  // — et surtout ce qu'il en reste dans l'Historique une fois rentré.
  group('Ski nautique : couloir, préparation, session, synthèse');

  const gps = (lon, lat, speedKmh) => window.__geo?.dispatchEvent(new CustomEvent('position', {
    detail: {
      lon, lat, accuracy: 5, speed: speedKmh / 3.6, heading: 90, timestamp: Date.now(),
    },
  }));

  // Un couloir se trace comme un trajet : mêmes gestes, même constructeur.
  $('mode-ski').click();
  check('le mode Ski montre son panneau et son catalogue',
    !$('pane-ski').hidden && $('pane-nav').hidden && $('ski-picker') !== null);
  $('btn-ski-new').click();
  for (const [lng, lat] of [[1.8700, 45.7930], [1.8730, 45.7930], [1.8760, 45.7930]]) {
    fire('routevertex', { lng, lat });
  }
  $('route-name').value = 'Couloir de slalom';
  $('btn-route-save').click();
  // Le catalogue n'est pas vide pour autant : `initSync` a déjà descendu les trajets
  // partagés du dépôt. C'est le nôtre qu'on cherche, pas un compte.
  const couloir = stored('relieflac.routes.v1').find((r) => r.name === 'Couloir de slalom');
  check('le couloir est enregistré comme un trajet, mais typé ski',
    Boolean(couloir) && couloir.points.length === 3 && couloir.kind === 'ski',
    `${stored('relieflac.routes.v1').length} trajet(s) au catalogue, métier ${couloir?.kind}`);

  // Le cloisonnement des deux catalogues : c'est la raison d'être de l'attribut. Les trajets
  // descendus du dépôt n'ont pas de métier — ce sont donc des routes de navigation.
  const names = (id) => [...document.querySelectorAll(`#${id} .route__name`)].map((n) => n.firstChild.textContent.trim());
  $('btn-route-exit').click();
  $('btn-menu').click();
  $('mode-nav').click();
  await sleep(60);
  check('un couloir de ski n’apparaît pas dans le menu Navigation',
    !names('route-picker').includes('Couloir de slalom') && names('route-picker').length >= 1,
    names('route-picker').join(' · '));
  $('mode-ski').click();
  await sleep(60);
  // Même règle que plus haut, et elle vient de se rappeler à nous : depuis que le ski existe,
  // de VRAIS couloirs ont été tracés sur le lac et descendent du dépôt. Le banc ne compte donc
  // pas les entrées. Il ne les compare pas non plus au contenu de `localStorage` — première
  // rustine, et fausse : ce que le menu affiche vient de la mémoire, et la copie stockée peut
  // avoir été écrite par une version d'avant le métier. Ce qui se vérifie, c'est l'ÉCRAN : les
  // deux listes sont disjointes, la nôtre est du bon côté, et chaque entrée y est marquée ski.
  const skiNames = names('ski-picker');
  const skiItems = [...document.querySelectorAll('#ski-picker li')];
  check('et le menu Ski ne montre que les couloirs',
    skiNames.includes('Couloir de slalom')
    && skiItems.length === skiNames.length
    && skiItems.every((li) => li.classList.contains('is-ski'))
    && !skiNames.some((n) => names('route-picker').includes(n)),
    skiNames.join(' · '));
  check('la vignette d’un couloir est corail, pas bleue',
    Boolean(document.querySelector('#ski-picker .thumb__route--ski'))
    && !document.querySelector('#route-picker .thumb__route--ski'));

  // Reclasser : sans cela, un trajet tracé avant que le ski n'existe le resterait à jamais.
  const navRoute = names('route-picker')[0];
  document.querySelector('#route-picker .route__edit').click();
  await sleep(60);
  check('l’éditeur affiche le métier du trajet repris',
    !$('route-kind').hidden
    && $('route-kind').querySelector('[data-kind="nav"]').classList.contains('is-on'));
  $('route-kind').querySelector('[data-kind="ski"]').click();
  check('choisir « Ski nautique » repeint le panneau', $('route').classList.contains('is-ski'));
  $('btn-route-save').click();
  $('btn-route-exit').click();
  $('btn-menu').click();
  $('mode-ski').click();
  await sleep(60);
  check('le trajet reclassé a changé de liste',
    names('ski-picker').includes(navRoute) && !names('route-picker').includes(navRoute),
    `« ${navRoute} » · ski : ${names('ski-picker').join(' · ')}`);
  // Et on le rend à la navigation, pour ne pas laisser l'appareil dans un état inventé. Le
  // couloir est épinglé en tête (dernier suivi) : on vise la ligne par son nom, jamais par
  // son rang — c'est la même règle que pour les zones (§ « ne jamais compter le rang »).
  const rowOf = (id, name) => [...document.querySelectorAll(`#${id} li`)]
    .find((li) => li.querySelector('.route__name')?.firstChild.textContent.trim() === name);
  rowOf('ski-picker', navRoute).querySelector('.route__edit').click();
  await sleep(60);
  $('route-kind').querySelector('[data-kind="nav"]').click();
  $('btn-route-save').click();
  $('btn-route-exit').click();
  check('et il revient à la navigation aussi facilement',
    stored('relieflac.routes.v1').find((r) => r.name === navRoute)?.kind === 'nav', navRoute);

  // Préparation : c'est ici que le tableau des vitesses entre en jeu.
  $('btn-menu').click();
  $('mode-ski').click();
  await sleep(60);
  document.querySelector('#ski-picker .route__open').click();
  check('toucher un couloir ouvre la préparation, et ne lance rien',
    !$('skilaunch').hidden && !document.body.classList.contains('mode-go'),
    $('skilaunch-route').textContent);

  // Le tableau des vitesses est une donnée : la grille en est engendrée. Le foil tracté,
  // ajouté après le reste, doit donc s'y trouver sans qu'aucune tuile n'ait été recopiée.
  const acts = [...document.querySelectorAll('#ski-activities .act')];
  check('la grille reprend toutes les activités du tableau, foil tracté compris',
    acts.length === 7 && acts.some((b) => b.dataset.act === 'foil'),
    acts.map((b) => b.dataset.act).join(' · '));
  document.querySelector('#ski-activities [data-act="foil"]').click();
  document.querySelector('#ski-who [data-who="enfant"]').click();
  check('le foil tracté annonce la plage la plus basse du tableau',
    $('ski-env').textContent === '8 – 12 km/h', $('ski-env').textContent);

  document.querySelector('#ski-activities [data-act="monoski"]').click();
  document.querySelector('#ski-who [data-who="adulte"]').click();
  check('activité et personne fixent la plage du tableau',
    $('ski-env').textContent === '32 – 38 km/h', $('ski-env').textContent);
  document.querySelector('#ski-who [data-who="enfant"]').click();
  check('changer de personne change la plage, sans changer d’activité',
    $('ski-env').textContent === '25 – 30 km/h', $('ski-env').textContent);
  document.querySelector('#ski-who [data-who="adulte"]').click();
  document.querySelector('#ski-chrono-choice [data-chrono="600"]').click();
  check('le chrono se choisit d’un appui', $('btn-ski-start').textContent.includes('10 min'),
    $('btn-ski-start').textContent);

  $('btn-ski-start').click();
  check('la session part en plein écran, avec son HUD et son couloir élargi',
    document.body.classList.contains('mode-ski') && !$('ski-hud').hidden
    && map.routeStyle === 'ski' && map.goMode === true,
    `allure ${map.routeStyle}`);
  check('le chrono affiche la durée demandée, en décompte',
    $('ski-time').textContent === '10:00', $('ski-time').textContent);

  // Vitesse tenue : le compteur se colore de l'écart à la plage, la jauge suit.
  gps(1.8700, 45.7930, 35);
  await sleep(30);
  check('dans la plage, le compteur passe au vert et la jauge au centre',
    $('go-speed').classList.contains('is-in')
    && Math.abs(parseFloat($('ski-cursor').style.left) - 50) < 1,
    `${$('go-speed').textContent} km/h, curseur à ${$('ski-cursor').style.left}`);
  gps(1.8705, 45.7930, 12);
  await sleep(30);
  check('trop lent, le compteur le dit', $('go-speed').classList.contains('is-slow'));
  gps(1.8710, 45.7930, 48);
  await sleep(30);
  check('trop vite aussi', $('go-speed').classList.contains('is-fast'));

  // Chrono à la main : le départ automatique, lui, demande dix secondes de vitesse tenue —
  // il est vérifié seconde par seconde dans selftest.js, sans attendre.
  $('btn-ski-chrono').click();
  // Plus d'une demi-seconde : le décompte s'affiche à la seconde, et « 9:59 » n'apparaît
  // qu'une fois passé l'arrondi.
  await sleep(1200);
  const running = $('ski-time').textContent;
  check('le chrono lancé à la main décompte',
    running !== '10:00' && $('ski-card').classList.contains('is-run')
    && $('btn-ski-chrono').textContent.includes('Pause'), running);
  $('btn-ski-chrono').click();
  const paused = $('ski-time').textContent;
  await sleep(700);
  check('la pause l’arrête vraiment', $('ski-time').textContent === paused
    && $('btn-ski-chrono').textContent.includes('Reprendre'), paused);
  $('btn-ski-chrono').click();

  $('ski-falls').click();
  $('ski-falls').click();
  check('les chutes se corrigent d’un appui', $('ski-falls-num').textContent === '2');

  // Fin de session : la trace part à l'Historique AVEC sa synthèse, et le partage la portera.
  gps(1.8740, 45.7930, 34);
  gps(1.8770, 45.7930, 33);
  await sleep(30);
  $('btn-go-exit').click();
  const trips = stored('relieflac.trips.v1');
  const session = trips[trips.length - 1];
  check('la session est versée à l’Historique avec sa synthèse',
    Boolean(session?.ski) && session.ski.activityName === 'Monoski' && session.ski.who === 'adulte'
    && session.ski.falls === 2 && session.ski.min_kmh === 32 && session.ski.target_s === 600,
    JSON.stringify(session?.ski ?? null).slice(0, 120));
  check('quitter la session rend la carte à la navigation',
    !document.body.classList.contains('mode-ski') && $('ski-hud').hidden
    && map.routeStyle === 'nav' && map.goMode === false);

  // Et l'Historique la montre, chiffres de ski compris.
  $('btn-menu').click();
  $('mode-nav').click();
  $('btn-nav-hist').click();
  await sleep(60);
  check('l’Historique affiche les cumuls de ski à part',
    $('hist-ski').textContent.startsWith('dont ski : 1 session'),
    `${$('hist-total').textContent} | ${$('hist-ski').textContent}`);
  check('la ligne de la sortie porte sa synthèse',
    document.querySelector('#hist-list .route__stat--ski')?.textContent.includes('Monoski'),
    document.querySelector('#hist-list .route__stat--ski')?.textContent ?? 'aucune ligne');
  $('btn-hist-exit').click();

  render();
}

function render() {
  const box = $('rapport');
  const failed = results.filter((r) => r.name && !r.ok).length;
  const total = results.filter((r) => r.name).length;
  $('etat').remove();

  const count = document.createElement('p');
  count.className = 'n';
  count.textContent = failed
    ? `${failed} enchaînement(s) en échec sur ${total}`
    : `${total} enchaînements vérifiés`;
  count.style.color = failed ? '#ff8080' : '#22c55e';
  box.append(count);

  const list = document.createElement('ol');
  for (const r of results) {
    const item = document.createElement('li');
    if (r.group) {
      item.style.listStyle = 'none';
      item.style.marginLeft = '-1.2rem';
      item.innerHTML = `<b>${r.group}</b>`;
    } else {
      item.className = r.ok ? 'ok' : 'ko';
      item.textContent = r.name;
      if (r.detail) {
        const detail = document.createElement('span');
        detail.className = 'detail';
        detail.textContent = ` — ${r.detail}`;
        item.append(detail);
      }
    }
    list.append(item);
  }
  box.append(list);
}

// Le stockage revient à l'appareil quoi qu'il arrive : échec du banc, ou page quittée en
// plein essai. Sans ce filet, une exécution interrompue laisserait l'application amputée
// de ses relevés et de son jeton.
window.addEventListener('beforeunload', returnStorage);

run()
  .catch((err) => {
    results.push({
      name: `interrompu : ${err.message}`,
      ok: false,
      detail: String(err.stack).split('\n')[1]?.trim() ?? '',
    });
    render();
  })
  .finally(() => {
    returnStorage();
    const note = document.createElement('p');
    note.textContent = `Stockage de l'application rendu intact — ${KEPT.size} clé(s) restaurée(s).`;
    $('rapport').append(note);
  });
