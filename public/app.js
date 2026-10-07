'use strict';

const $ = (id) => document.getElementById(id);
const DAMAGE_TAGS = ['sturmschaden', 'borkenkaefer', 'trockenschaden', 'holzschlag', 'fruehverfaerbung', 'frostschaden'];

const state = {
  config: { tags: {}, plantnet: false },
  spots: [],
  trees: [],
  spot: null,
  index: 0,
  picked: null,
  markers: L.layerGroup(),
};

const fmtDate = (iso) => new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' });
const SOURCE_LABEL = { exif: 'GPS aus Foto', gpx: 'über GPX-Track', manual: 'manuell gesetzt', spot: 'Wiederholungsfoto' };

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) node.append(c);
  return node;
}

async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 422) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function tagClass(tag) {
  if (tag === 'neophyt') return 'chip neo';
  if (DAMAGE_TAGS.includes(tag)) return 'chip damage';
  return 'chip';
}

function tagChip(tag) {
  return el('span', { class: tagClass(tag), text: state.config.tags[tag] || tag });
}

/* ---------- Alignment (homographies in normalised image coordinates) ---------- */

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function hMul(a, b) {
  const r = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r.push(a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]);
  }
  return r.map((v) => v / r[8]);
}
function hInv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const r = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
  return r.map((v) => v / r[8]);
}

/** Transform that maps `photo` onto `frame`, or null when either is not aligned. */
function relativeAlignment(photo, frame) {
  if (photo.id === frame.id) return IDENTITY;
  if (!photo.alignment || !frame.alignment) return null;
  return hMul(hInv(frame.alignment.h), photo.alignment.h);
}

/** CSS matrix3d for a normalised homography drawn into a box of w × h pixels. */
function cssMatrix(m, w, h) {
  const p = hMul(hMul([w, 0, 0, 0, h, 0, 0, 0, 1], m), [1 / w, 0, 0, 0, 1 / h, 0, 0, 0, 1]);
  return `matrix3d(${p[0]},${p[3]},0,${p[6]},${p[1]},${p[4]},0,${p[7]},0,0,1,0,${p[2]},${p[5]},0,${p[8]})`;
}

const imageSizes = new Map();
function imageSize(url) {
  if (!imageSizes.has(url)) {
    imageSizes.set(url, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 4, h: 3 });
      img.src = url;
    }));
  }
  return imageSizes.get(url);
}

const warps = new WeakMap();
function applyWarp(img) {
  const m = warps.get(img);
  if (!m) {
    img.style.transform = '';
    img.style.objectFit = 'cover';
    return;
  }
  const box = img.parentElement.closest('.stage, .swipe').getBoundingClientRect();
  img.style.objectFit = 'fill';
  img.style.transform = cssMatrix(m, box.width, box.height);
}

/**
 * Shows `photo` in `img`. With a `frame` photo it is warped into the frame's
 * view (if both are aligned); `setAspect` gives the stage the aspect ratio of
 * whatever defines the view. Returns whether the photo is shown aligned.
 */
async function showFramed(stage, img, photo, frame, setAspect = true) {
  const token = (img.dataset.token = String(Number(img.dataset.token || 0) + 1));
  const rel = frame ? relativeAlignment(photo, frame) : null;
  const size = await imageSize((rel ? frame : photo).url);
  if (img.dataset.token !== token) return Boolean(rel);
  if (setAspect) stage.style.setProperty('--ar', String(size.w / size.h));
  img.src = photo.url;
  warps.set(img, rel);
  applyWarp(img);
  return Boolean(rel);
}

const stageObserver = new ResizeObserver((entries) => {
  for (const e of entries) e.target.querySelectorAll('img:not(.heat)').forEach(applyWarp);
});
stageObserver.observe($('viewer-stage'));
stageObserver.observe($('swipe'));

/* ---------- Map ---------- */

const map = L.map('map', { zoomControl: false, scrollWheelZoom: false }).setView([47.2, 8.4], 8);
L.control.zoom({ position: 'bottomleft' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
state.markers.addTo(map);
// The map sits inside a scrolling page: only zoom with the wheel once it has been clicked.
map.on('click focus', () => map.scrollWheelZoom.enable());
map.on('mouseout', () => map.scrollWheelZoom.disable());

const pinKind = (spot) => {
  if (spot.tags.includes('neophyt')) return 'neo';
  if (spot.tags.some((t) => DAMAGE_TAGS.includes(t))) return 'damage';
  return 'ok';
};
const pins = new Map();

function renderMarkers() {
  state.markers.clearLayers();
  pins.clear();
  for (const s of state.spots) {
    const size = Math.round(28 + Math.min(Math.log2(s.photoCount) * 5, 16));
    const icon = L.divIcon({
      className: 'pin-icon',
      html: `<div class="pin ${pinKind(s)}${state.spot?.id === s.id ? ' active' : ''}"><b>${s.photoCount}</b>${s.irregularities.length ? '<i class="flag">!</i>' : ''}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size * 1.2],
      tooltipAnchor: [0, -size * 1.1],
    });
    const m = L.marker([s.lat, s.lon], { icon, title: `Spot ${s.id}`, riseOnHover: true });
    const extra = [
      s.change?.fraction >= 0.05 ? `≈ ${Math.round(s.change.fraction * 100)} % verändert${s.change.top ? ` (${s.change.top})` : ''}` : '',
      ...s.irregularities,
      s.species.length ? `Baumarten: ${s.species.join(', ')}` : '',
    ].filter(Boolean);
    const tip = el('div', {}, [
      el('div', { text: `Spot ${s.id} · ${s.photoCount} Foto${s.photoCount === 1 ? '' : 's'} · ${fmtDate(s.firstTaken)}–${fmtDate(s.lastTaken)}` }),
      ...extra.map((t) => el('div', { class: 'muted', text: t })),
    ]);
    m.bindTooltip(tip, { direction: 'top' });
    m.on('click', () => openSpot(s.id));
    state.markers.addLayer(m);
    pins.set(s.id, m);
  }
}

function highlightPin(id) {
  for (const [spotId, m] of pins) m.getElement()?.querySelector('.pin')?.classList.toggle('active', spotId === id);
}

async function loadSpots({ fit = false } = {}) {
  const filter = $('tag-filter').value;
  const special = filter.startsWith('@') ? filter : null;
  const tag = special ? '' : filter;
  const spots = await api(`/api/spots${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`);
  state.spots = special === '@change' ? spots.filter((s) => s.change?.fraction >= 0.05)
    : special === '@irregular' ? spots.filter((s) => s.irregularities.length)
      : spots;
  renderMarkers();
  renderStats(!filter);
  if (fit && state.spots.length) {
    // Keep spots clear of the floating toolbar and (on wide screens) the side panel.
    const wide = window.matchMedia('(min-width: 861px)').matches;
    map.fitBounds(L.latLngBounds(state.spots.map((s) => [s.lat, s.lon])), {
      maxZoom: 16,
      paddingTopLeft: [40, 150],
      paddingBottomRight: [wide ? $('panel').offsetWidth + 60 : 40, 50],
    });
  }
}

const RING_SVG = '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22"/><circle cx="24" cy="24" r="16.5"/><circle cx="24" cy="24" r="11"/><circle cx="24" cy="24" r="5.5"/></svg>';

function renderStats(updateHero = true) {
  const photos = state.spots.reduce((n, s) => n + s.photoCount, 0);
  const damaged = state.spots.filter((s) => s.tags.some((t) => DAMAGE_TAGS.includes(t) || t === 'neophyt')).length;
  const stat = (value, label) => el('div', { class: 'stat' }, [el('b', { text: String(value) }), el('span', { text: label })]);
  $('stats').replaceChildren(stat(state.spots.length, 'Spots'), stat(photos, 'Fotos'), stat(damaged, 'mit Befund'));

  if (updateHero) {
    const years = state.spots.length
      ? new Date(Math.max(...state.spots.map((s) => Date.parse(s.lastTaken)))).getFullYear() -
        new Date(Math.min(...state.spots.map((s) => Date.parse(s.firstTaken)))).getFullYear() + 1
      : 0;
    const heroStat = (value, label) => {
      const node = el('div', { class: 'hero-stat' });
      node.innerHTML = RING_SVG;
      node.append(el('div', {}, [el('b', { text: String(value) }), el('span', { text: label })]));
      return node;
    };
    $('hero-stats').replaceChildren(
      heroStat(state.spots.length, 'Orte'),
      heroStat(photos, 'Fotos'),
      heroStat(years, years === 1 ? 'Jahr Waldgeschichte' : 'Jahre Waldgeschichte'),
    );
  }

  const recent = [...state.spots].sort((a, b) => Date.parse(b.lastTaken) - Date.parse(a.lastTaken)).slice(0, 4);
  $('recent').replaceChildren(...(recent.length
    ? recent.map((s) => el('button', { type: 'button', onclick: () => openSpot(s.id) }, [
      el('img', { src: s.latestUrl, alt: '', loading: 'lazy' }),
      el('div', {}, [
        el('strong', { text: `Spot ${s.id}` }),
        el('span', { text: `${s.photoCount} Foto${s.photoCount === 1 ? '' : 's'} · zuletzt ${fmtDate(s.lastTaken)}` }),
      ]),
    ]))
    : [el('p', { class: 'empty', text: 'Noch keine Fotos – sei die erste Person, die hier etwas festhält.' })]));
}

/* ---------- Spot panel ---------- */

async function openSpot(id, photoId) {
  state.spot = await api(`/api/spots/${id}`);
  const photos = state.spot.photos;
  const wanted = photos.findIndex((p) => p.id === photoId);
  state.index = wanted >= 0 ? wanted : photos.length - 1;

  highlightPin(id);
  $('welcome').hidden = true;
  $('spot').hidden = false;
  if (window.matchMedia('(max-width: 860px)').matches) {
    $('panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    $('panel').scrollTop = 0;
  }
  $('compare').hidden = true;
  $('spot-title').textContent = `Spot ${state.spot.id}`;
  const years = new Set(photos.map((p) => new Date(p.takenAt).getFullYear()));
  $('spot-meta').textContent =
    `${state.spot.lat.toFixed(5)}, ${state.spot.lon.toFixed(5)} · ${photos.length} Foto${photos.length === 1 ? '' : 's'} · ` +
    `${fmtDate(photos[0].takenAt)} – ${fmtDate(photos[photos.length - 1].takenAt)} (${years.size} Jahr${years.size === 1 ? '' : 'e'})`;
  const allTags = [...new Set(photos.flatMap((p) => p.tags))].sort();
  $('spot-tags').replaceChildren(...allTags.map(tagChip));

  const slider = $('time-slider');
  slider.max = String(photos.length - 1);
  slider.disabled = photos.length < 2;
  $('t-first').textContent = fmtDate(photos[0].takenAt);
  $('t-last').textContent = fmtDate(photos[photos.length - 1].takenAt);
  $('thumbs').replaceChildren(...photos.map((p, i) =>
    el('button', { type: 'button', title: fmtDateTime(p.takenAt), onclick: () => showPhoto(i) },
      el('img', { src: p.url, alt: `Foto vom ${fmtDate(p.takenAt)}`, loading: 'lazy' }))));

  fillCompareSelects();
  showPhoto(state.index);
  updateSpotChange(state.spot);
  renderChronicle(state.spot);
  renderSpecies(state.spot);
  renderElevation(state.spot);
  map.setView([state.spot.lat, state.spot.lon], Math.max(map.getZoom(), 15));
}

function showPhoto(i) {
  const photos = state.spot.photos;
  state.index = i;
  const p = photos[i];
  const stabilize = $('stabilize').checked && photos.length > 1;
  const frame = stabilize ? photos.find((x) => x.alignment) : null;
  showFramed($('viewer-stage'), $('viewer-img'), p, frame);
  $('viewer-img').alt = `Spot ${state.spot.id} am ${fmtDate(p.takenAt)}`;
  const parts = [fmtDateTime(p.takenAt), SOURCE_LABEL[p.locationSource]];
  if (p.activity) parts.push(p.activity[0].toUpperCase() + p.activity.slice(1));
  if (p.heading !== null) parts.push(`Blickrichtung ${Math.round(p.heading)}°`);
  if (stabilize) parts.push(frame && relativeAlignment(p, frame) ? 'ausgerichtet' : 'nicht ausgerichtet');
  $('viewer-caption').textContent = parts.join(' · ');
  $('time-slider').value = String(i);
  [...$('thumbs').children].forEach((b, j) => b.setAttribute('aria-current', String(i === j)));
  $('thumbs').children[i]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  $('photo-tags').replaceChildren(...Object.entries(state.config.tags).map(([key, label]) =>
    el('button', {
      type: 'button',
      class: tagClass(key),
      'aria-pressed': String(p.tags.includes(key)),
      'data-tag': key,
      text: label,
      onclick: (e) => e.currentTarget.setAttribute('aria-pressed', String(e.currentTarget.getAttribute('aria-pressed') !== 'true')),
    })));
  $('photo-note').value = p.note || '';
  renderContext(p);
  $('identify-group').hidden = !state.config.plantnet;
  renderIdentifications(p);
  document.dispatchEvent(new CustomEvent('myforrest:photo', { detail: p })); // analysis.js
}

function renderIdentifications(p) {
  const box = $('identify-results');
  if (!p.identifications.length) return box.replaceChildren();
  box.replaceChildren(el('div', { class: 'ident' }, [
    el('strong', { text: 'Pflanzenerkennung (Pl@ntNet)' }),
    el('ul', {}, p.identifications.map((r) => el('li', {}, [
      el('i', { text: r.scientificName }),
      r.commonName ? ` – ${r.commonName}` : '',
      ` (${Math.round(r.score * 100)} %)`,
      r.neophyte ? el('span', { class: 'neo', text: ` · Neophyt: ${r.neophyte}` }) : '',
      r.tree && r.score >= 0.25 ? el('span', { class: 'tree-note', text: ` · Baum: ${r.tree.name}, beim Spot erfasst` }) : '',
    ]))),
  ]));
}

/* ---------- Tree species of a spot ---------- */

const TREE_ICONS = {
  nadel: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1 3.5 8H6l-3 4.5h4V15h2v-2.5h4L10 8h2.5z"/></svg>',
  laub: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a5 5 0 0 0-4.6 7A4 4 0 0 0 7 14h.2v1.5h1.6V14H9a4 4 0 0 0 3.6-5.5A5 5 0 0 0 8 1.5z"/></svg>',
};
const DROUGHT = { hoch: 'hoch', mittel: 'mittel', gering: 'gering' };
const fmtDoy = (d) => new Date(Date.UTC(2023, 0, 1 + d)).toLocaleDateString('de-CH', { day: '2-digit', month: 'long', timeZone: 'UTC' });

function colourText(t, spot) {
  const lowland = `~${fmtDoy(t.colourDoy)}`;
  if (t.colourDoyHere === null || t.colourDoyHere === t.colourDoy) return `Färbung typisch ab ${lowland} (Flachland)`;
  const here = [spot.elevation !== null ? `${Math.round(spot.elevation)} m` : null,
    spot.landform === 'senke' ? 'Senke' : null,
    spot.landform !== 'senke' && spot.exposition && spot.exposition !== 'eben' ? spot.exposition : null].filter(Boolean).join(', ');
  return `Färbung hier (${here}) typisch ab ~${fmtDoy(t.colourDoyHere)}; im Flachland ab ${lowland}`;
}

const ELEV_SOURCE = { dem: 'Höhenmodell', gps: 'GPS der Fotos', manual: 'manuell' };
const MOUNTAIN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 14 6 5l3 5 2-3 4 7z"/></svg>';

const COMPASS_CODES = { 0: 'N', 45: 'NO', 90: 'O', 135: 'SO', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
const days = (n) => `${Math.abs(n)} ${Math.abs(n) === 1 ? 'Tag' : 'Tage'}`;

function renderElevation(spot) {
  const text = $('spot-elev-text');
  text.innerHTML = MOUNTAIN_ICON;
  const parts = [];
  parts.push(spot.elevation === null ? 'Höhe unbekannt'
    : `${Math.round(spot.elevation)} m ü. M. (${ELEV_SOURCE[spot.elevationSource] || 'unbekannt'})`);
  // "eben" adds nothing once the landform (hollow, plain, …) is known.
  if (spot.exposition && !(spot.exposition === 'eben' && spot.landform)) {
    parts.push(spot.exposition === 'eben' ? 'eben'
      : `${spot.exposition}${spot.terrainSource === 'dem' ? `, ${Math.round(spot.slope)}° steil` : ''} (${ELEV_SOURCE[spot.terrainSource]})`);
  }
  if (spot.landform && spot.landform !== 'hang' && spot.landform !== 'ebene') {
    const depth = Number.isFinite(spot.tpi600) && spot.tpi600 !== 0
      ? `, ${Math.abs(Math.round(spot.tpi600))} m ${spot.tpi600 < 0 ? 'tiefer' : 'höher'} als die Umgebung`
      : '';
    parts.push(`${spot.landformLabel}${depth} (${ELEV_SOURCE[spot.landformSource]})`);
  }
  const shift = spot.colourShiftDays;
  if (shift) {
    const labels = { altitude: 'Höhe', exposition: 'Exposition', coldPool: 'Kaltluft' };
    const contributions = Object.entries(spot.colourShift).filter(([, v]) => v);
    const detail = contributions.length > 1
      ? ` (${contributions.map(([k, v]) => `${labels[k]} ${v > 0 ? '+' : '−'}${Math.abs(v)}`).join(', ')})`
      : '';
    parts.push(`Herbstfärbung ~${days(shift)} ${shift < 0 ? 'früher' : 'später'} als im Flachland${detail}`);
  } else if (spot.elevation === null && !spot.exposition && !spot.landform) {
    parts.push('Herbstfärbung wird für das Flachland bewertet');
  }
  text.append(parts.join(' · '));
  $('spot-elev-form').hidden = true;
  $('spot-elev-edit').hidden = false;
  $('spot-elev-input').value = spot.elevation ?? '';
  $('spot-expo-select').value = spot.terrainSource === 'manual'
    ? (spot.exposition === 'eben' ? 'eben' : COMPASS_CODES[spot.aspect] || '')
    : '';
  $('spot-landform-select').value = spot.landformSource === 'manual' ? spot.landform : '';
}

async function saveTerrain(body) {
  const current = state.spot.photos[state.index].id;
  await api(`/api/spots/${state.spot.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await Promise.all([openSpot(state.spot.id, current), loadSpots()]);
}

$('spot-elev-edit').addEventListener('click', () => {
  $('spot-elev-form').hidden = false;
  $('spot-elev-edit').hidden = true;
  $('spot-elev-input').focus();
});
$('spot-elev-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  const raw = $('spot-elev-input').value;
  if (raw !== '' && Number(raw) !== state.spot.elevation) body.elevation = Number(raw);
  const expo = $('spot-expo-select').value || null;
  const currentManual = state.spot.terrainSource === 'manual';
  if (expo || currentManual) body.exposition = expo;
  const form = $('spot-landform-select').value || null;
  if (form || state.spot.landformSource === 'manual') body.landform = form;
  if (!Object.keys(body).length) return renderElevation(state.spot);
  try {
    await saveTerrain(body);
  } catch (err) {
    alert(err.message);
  }
});
$('spot-elev-auto').addEventListener('click', () => saveTerrain({ elevation: null, exposition: null, landform: null }).catch((err) => alert(err.message)));

function treeChip(t) {
  const chip = el('span', { class: `tree-chip ${t.group}${t.invasive ? ' invasive' : ''}`, title: t.scientificName });
  chip.innerHTML = TREE_ICONS[t.group];
  chip.append(t.name);
  return chip;
}

function renderSpecies(spot) {
  const species = spot.species || [];
  const conifers = species.filter((t) => t.group === 'nadel').length;
  $('species-summary').replaceChildren(...(species.length
    ? [...species.map(treeChip), el('span', { class: 'muted small', text: `${species.length - conifers} Laub · ${conifers} Nadel` })]
    : [el('span', { class: 'empty muted', text: 'noch keine erfasst' })]));
  $('species-list').replaceChildren(...species.map((t) => el('li', {}, [
    el('header', {}, [
      treeChip(t),
      el('i', { text: t.scientificName }),
      el('span', { class: 'src', text: t.sources.includes('plantnet') ? `Pl@ntNet${t.score ? ` ${Math.round(t.score * 100)} %` : ''}` : 'manuell' }),
      el('button', { type: 'button', class: 'link remove', 'aria-label': `${t.name} entfernen`, text: 'entfernen', onclick: () => removeSpecies(t) }),
    ]),
    el('dl', {}, [
      el('dt', { text: 'Herbst' }),
      el('dd', { text: t.evergreen ? 'immergrün – Verfärbung ist ein Warnsignal' : colourText(t, spot) }),
      el('dt', { text: 'Trockenheit' }),
      el('dd', { text: `Empfindlichkeit ${DROUGHT[t.drought]}` }),
      ...(t.threats.length ? [el('dt', { text: 'Achten auf' }), el('dd', { text: t.threats.join(', ') })] : []),
      ...(t.invasive ? [el('dt', { text: 'Hinweis' }), el('dd', { text: 'invasiver Neophyt' })] : []),
    ]),
  ])));
  const known = new Set(species.map((t) => t.scientificName));
  const options = (group, label) => el('optgroup', { label }, state.trees
    .filter((t) => t.group === group && !known.has(t.scientificName))
    .map((t) => el('option', { value: t.scientificName, text: `${t.name} (${t.scientificName})` })));
  $('species-select').replaceChildren(
    el('option', { value: '', text: 'Baumart wählen …' }),
    options('laub', 'Laubbäume'),
    options('nadel', 'Nadelbäume'),
  );
}

async function refreshAfterSpecies() {
  const current = state.spot.photos[state.index].id;
  const open = $('species-box').open;
  await Promise.all([openSpot(state.spot.id, current), loadSpots()]);
  $('species-box').open = open;
}

async function removeSpecies(t) {
  await api(`/api/spots/${state.spot.id}/species?name=${encodeURIComponent(t.scientificName)}`, { method: 'DELETE' });
  await refreshAfterSpecies();
}

$('species-add').addEventListener('click', async () => {
  const scientificName = $('species-select').value;
  if (!scientificName) return;
  await api(`/api/spots/${state.spot.id}/species`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scientificName }),
  });
  await refreshAfterSpecies();
});

$('time-slider').addEventListener('input', (e) => showPhoto(Number(e.target.value)));
$('close-spot').addEventListener('click', () => {
  $('spot').hidden = true;
  $('welcome').hidden = false;
  state.spot = null;
  highlightPin(null);
});

$('save-photo').addEventListener('click', async () => {
  const p = state.spot.photos[state.index];
  const tags = [...$('photo-tags').querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.tag);
  await api(`/api/photos/${p.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags, note: $('photo-note').value }),
  });
  await Promise.all([openSpot(state.spot.id, p.id), loadSpots()]);
});

$('delete-photo').addEventListener('click', async () => {
  const p = state.spot.photos[state.index];
  if (!confirm(`Foto vom ${fmtDate(p.takenAt)} wirklich löschen?`)) return;
  await api(`/api/photos/${p.id}`, { method: 'DELETE' });
  await loadSpots();
  if (state.spot.photos.length > 1) await openSpot(state.spot.id);
  else $('close-spot').click();
});

$('identify').addEventListener('click', async (e) => {
  const p = state.spot.photos[state.index];
  e.target.disabled = true;
  e.target.textContent = 'Bestimme …';
  try {
    await api(`/api/photos/${p.id}/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organ: $('identify-organ').value }),
    });
    await Promise.all([openSpot(state.spot.id, p.id), loadSpots()]);
  } catch (err) {
    alert(err.message);
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Art bestimmen';
  }
});

/* ---------- Before / after ---------- */

function fillCompareSelects() {
  const opts = () => state.spot.photos.map((p, i) => el('option', { value: String(i), text: fmtDateTime(p.takenAt) }));
  $('cmp-a').replaceChildren(...opts());
  $('cmp-b').replaceChildren(...opts());
  $('cmp-a').value = '0';
  $('cmp-b').value = String(state.spot.photos.length - 1);
  updateCompare();
}

const pct = (f) => (f < 0.01 && f > 0 ? '< 1 %' : `${Math.round(f * 100)} %`);
let compareToken = 0;

async function updateCompare() {
  const token = ++compareToken;
  const photos = state.spot.photos;
  const a = photos[Number($('cmp-a').value)];
  const b = photos[Number($('cmp-b').value)];
  const alignOn = $('cmp-align').checked;
  const heat = $('cmp-heat-img');
  heat.hidden = true;
  $('cmp-boxes').replaceChildren();
  $('cmp-regions').replaceChildren();
  document.dispatchEvent(new CustomEvent('myforrest:compare', { detail: { a, b, change: null } })); // analysis.js
  await showFramed($('swipe'), $('cmp-img-a'), a, null);
  const aligned = await showFramed($('swipe'), $('cmp-img-b'), b, alignOn ? a : null, false);
  const canCompare = alignOn && aligned && a.id !== b.id;
  $('cmp-heat').disabled = !canCompare;
  $('cmp-status').textContent = !alignOn ? ''
    : aligned ? (a.id === b.id ? '' : 'Deckungsgleich ausgerichtet')
      : 'Nicht ausrichtbar – Blickwinkel zu verschieden';
  if (!canCompare) return;

  try {
    const change = await api(`/api/photos/${a.id}/change?to=${b.id}`);
    if (token !== compareToken) return;
    $('cmp-status').textContent = `Ausgerichtet · ≈ ${pct(change.changedFraction)} verändert`;
    if ($('cmp-heat').checked) {
      heat.src = change.heatmap;
      heat.hidden = false;
      $('cmp-boxes').replaceChildren(...change.regions.filter((r) => r.area >= 0.01).map((r) => {
        const [x0, y0, x1, y1] = r.bbox;
        const box = el('div', { class: `box ${r.class}${y0 < 0.1 ? ' below' : ''}` }, el('span', { text: r.label }));
        Object.assign(box.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
        return box;
      }));
    }
    renderRegions(change, b);
    document.dispatchEvent(new CustomEvent('myforrest:compare', { detail: { a, b, change } })); // analysis.js
  } catch {
    // Change detection is an extra; the aligned comparison still works without it.
  }
}

/** Classified changes of the compared pair, with one click to record them as tags on the later photo. */
function renderRegions(change, later) {
  const box = $('cmp-regions');
  if (!change.summary.length) return box.replaceChildren();
  const rows = change.summary.map((s) => el('div', { class: `region-row ${s.class}` }, [
    el('i'), el('b', { text: s.label }), el('span', { text: `≈ ${pct(s.area)} der Ansicht` }),
  ]));
  const missing = [...new Set(change.summary.map((s) => s.tag).filter(Boolean))].filter((t) => !later.tags.includes(t));
  const children = [...rows];
  if (missing.length) {
    children.push(el('button', {
      type: 'button',
      class: 'secondary suggest',
      text: `Als Beobachtung übernehmen: ${missing.map((t) => state.config.tags[t] || t).join(', ')}`,
      onclick: () => addTags(later, missing),
    }));
  }
  children.push(el('p', { class: 'hint', text: 'Automatische Einordnung anhand von Farbe, Helligkeit, Struktur und Form – bitte prüfen.' }));
  box.replaceChildren(...children);
}

async function addTags(photo, tags) {
  const keep = [$('cmp-a').value, $('cmp-b').value, $('compare').hidden];
  await api(`/api/photos/${photo.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: [...new Set([...photo.tags, ...tags])] }),
  });
  await Promise.all([openSpot(state.spot.id, state.spot.photos[state.index].id), loadSpots()]);
  [$('cmp-a').value, $('cmp-b').value] = keep;
  $('compare').hidden = keep[2];
  if (!keep[2]) updateCompare();
}

/** Badge in the spot header: change of the latest analysed photo against the spot's first photo. */
function updateSpotChange(spot) {
  const badge = $('spot-change');
  const latest = [...spot.photos].reverse().find((p) => p.change);
  badge.hidden = !latest;
  if (!latest) return;
  const { fraction, summary, baseTakenAt } = latest.change;
  const top = fraction >= 0.05 && summary[0] ? ` · ${summary[0].label}` : '';
  badge.textContent = `≈ ${pct(fraction)} der Ansicht verändert seit ${fmtDate(baseTakenAt)}${top}`;
  badge.classList.toggle('calm', fraction < 0.05);
}

/* ---------- Weather context and irregularities ---------- */

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  node.append(...children);
  return node;
}
const signed = (v, unit) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)} ${unit}`;

/** Monthly precipitation (bars, coloured dry/wet) against the 1991–2020 normal (ticks). */
function precipChart(monthly) {
  const W = 360; const H = 150; const left = 30; const bottom = 20; const top = 8;
  const max = Math.max(10, ...monthly.flatMap((m) => [m.precip, m.normal]));
  const nice = Math.ceil(max / 50) * 50;
  const y = (v) => top + (H - top - bottom) * (1 - v / nice);
  const step = (W - left) / monthly.length;
  const bw = Math.min(18, step - 6);
  const wrap = el('div', { class: 'wx-chart' });
  const tip = el('div', { class: 'wx-tip', hidden: '' });
  const nodes = [
    svg('line', { class: 'grid', x1: left, x2: W, y1: y(0), y2: y(0) }),
    svg('line', { class: 'grid', x1: left, x2: W, y1: y(nice / 2), y2: y(nice / 2), 'stroke-dasharray': '2 3' }),
    svg('text', { class: 'axis', x: left - 4, y: y(nice) + 3, 'text-anchor': 'end' }, [`${nice}`]),
    svg('text', { class: 'axis', x: left - 4, y: y(nice / 2) + 3, 'text-anchor': 'end' }, [`${nice / 2}`]),
    svg('text', { class: 'axis', x: left - 4, y: y(0) + 3, 'text-anchor': 'end' }, ['0']),
  ];
  monthly.forEach((m, i) => {
    const cx = left + step * i + step / 2;
    const [yr, mo] = m.month.split('-').map(Number);
    const dry = m.precip < m.normal;
    const h = Math.max(0, y(0) - y(m.precip));
    const r = Math.min(4, bw / 2, h);
    // Bar with rounded data end, anchored square on the baseline.
    const x0 = cx - bw / 2; const yTop = y(m.precip); const yb = y(0);
    const d = h > 0
      ? `M${x0} ${yb}V${yTop + r}Q${x0} ${yTop} ${x0 + r} ${yTop}H${x0 + bw - r}Q${x0 + bw} ${yTop} ${x0 + bw} ${yTop + r}V${yb}Z`
      : '';
    if (d) nodes.push(svg('path', { class: `bar ${dry ? 'dry' : 'wet'}`, d }));
    nodes.push(svg('line', { class: 'norm', x1: cx - bw / 2 - 3, x2: cx + bw / 2 + 3, y1: y(m.normal), y2: y(m.normal) }));
    nodes.push(svg('text', { class: 'axis', x: cx, y: H - 6, 'text-anchor': 'middle' }, [MONTHS[mo - 1][0]]));
    const label = `${MONTHS[mo - 1]} ${yr}${m.days < 28 ? ` (${m.days} Tage)` : ''}`;
    const ratio = m.normal ? Math.round((m.precip / m.normal) * 100) : null;
    const hit = svg('rect', { class: 'hit', x: cx - step / 2, y: top, width: step, height: H - top - bottom + 4, tabindex: 0, 'aria-label': `${label}: ${m.precip} mm, Mittel ${m.normal} mm` });
    const show = () => {
      tip.replaceChildren(el('strong', { text: label }), `${m.precip} mm · Mittel ${m.normal} mm${ratio !== null ? ` · ${ratio} %` : ''}`);
      tip.hidden = false;
      const box = wrap.getBoundingClientRect();
      const sv = wrap.querySelector('svg').getBoundingClientRect();
      const half = tip.offsetWidth / 2 + 4;
      tip.style.left = `${Math.min(Math.max(sv.left - box.left + (cx / W) * sv.width, half), box.width - half)}px`;
      tip.style.top = `${sv.top - box.top + (y(Math.max(m.precip, m.normal)) / H) * sv.height}px`;
    };
    hit.addEventListener('mouseenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('mouseleave', () => { tip.hidden = true; });
    hit.addEventListener('blur', () => { tip.hidden = true; });
    nodes.push(hit);
  });
  // Screen-reader table; wrapped because tables ignore the 1 px box of .sr-only.
  const table = el('div', { class: 'sr-only' }, el('table', {}, [
    el('caption', { text: 'Monatlicher Niederschlag in mm im Vergleich zum Mittel 1991–2020' }),
    el('tr', {}, [el('th', { text: 'Monat' }), el('th', { text: 'Niederschlag' }), el('th', { text: 'Mittel' })]),
    ...monthly.map((m) => el('tr', {}, [el('td', { text: m.month }), el('td', { text: String(m.precip) }), el('td', { text: String(m.normal) })])),
  ]));
  wrap.append(
    el('h4', { text: 'Niederschlag der letzten 12 Monate (mm)' }),
    el('div', { class: 'wx-legend' }, [
      el('span', {}, [el('i', { style: 'background: var(--dry)' }), 'trockener als üblich']),
      el('span', {}, [el('i', { style: 'background: var(--wet)' }), 'nasser als üblich']),
      el('span', {}, [el('i', { class: 'tick' }), 'Mittel 1991–2020']),
    ]),
    svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Monatlicher Niederschlag gegenüber dem langjährigen Mittel' }, nodes),
    tip,
    table,
  );
  return wrap;
}

let contextToken = 0;
async function renderContext(photo) {
  const token = ++contextToken;
  const body = $('context-body');
  body.replaceChildren(el('p', { class: 'context-loading', text: 'Wetterdaten und Auffälligkeiten werden ermittelt …' }));
  let ctx;
  try {
    ctx = await api(`/api/photos/${photo.id}/context`);
  } catch (err) {
    if (token === contextToken) body.replaceChildren(el('p', { class: 'context-loading', text: `Kontext nicht verfügbar: ${err.message}` }));
    return;
  }
  if (token !== contextToken || !state.spot) return;
  photo.context = ctx;
  renderChronicle(state.spot);
  if (state.spot.elevation === null) {
    // The first context lookup also determines the spot's elevation.
    const fresh = await api(`/api/spots/${state.spot.id}`).catch(() => null);
    if (fresh && fresh.elevation !== null && state.spot?.id === fresh.id) {
      for (const k of ['elevation', 'elevationSource', 'slope', 'aspect', 'exposition', 'terrainSource', 'landform',
        'landformLabel', 'landformSource', 'tpi300', 'tpi600', 'colourShift', 'colourShiftDays', 'species']) {
        state.spot[k] = fresh[k];
      }
      renderElevation(state.spot);
      renderSpecies(state.spot);
    }
  }

  const parts = [];
  const w = ctx.weather?.last90;
  if (w) {
    const tile = (value, label, sub) => el('div', { class: 'wx-tile' }, [el('span', { text: label }), el('b', { text: value }), el('em', { text: sub })]);
    parts.push(el('p', { class: 'muted small', text: `90 Tage vor der Aufnahme (${fmtDate(w.from)} – ${fmtDate(w.to)}), verglichen mit dem Mittel 1991–2020:` }));
    parts.push(el('div', { class: 'wx-tiles' }, [
      tile(`${Math.round(w.precip)} mm`, 'Niederschlag', w.precipRatio !== null ? `${Math.round(w.precipRatio * 100)} % des Mittels (${Math.round(w.precipNormal)} mm)` : ''),
      tile(signed(w.tempAnomaly, '°C'), 'Temperatur', `Mittel ${w.tempMean.toFixed(1)} °C statt ${w.tempNormal.toFixed(1)} °C`),
      tile(String(w.hotDays), 'Hitzetage ≥ 30 °C', `üblich ${Math.round(w.hotDaysNormal)}`),
      tile(`${w.longestDrySpell} Tage`, 'Längste Trockenphase', 'ohne nennenswerten Regen'),
    ]));
    if (ctx.weather.monthly?.length) parts.push(precipChart(ctx.weather.monthly));
  } else {
    parts.push(el('p', { class: 'context-loading', text: `Wetterdaten nicht verfügbar${ctx.weatherError ? ` (${ctx.weatherError})` : ''}.` }));
  }

  if (ctx.irregularities.length) {
    for (const irr of ctx.irregularities) {
      const card = el('article', { class: 'irregular', 'data-severity': irr.severity }, [
        el('header', {}, [el('h4', { text: irr.title }), el('span', { class: 'sev', text: irr.severity === 'hinweis' ? 'Hinweis' : irr.severity })]),
        el('p', { text: irr.text }),
      ]);
      if (irr.suggestedTag && !photo.tags.includes(irr.suggestedTag)) {
        card.append(el('button', {
          type: 'button',
          class: 'btn primary btn-tag',
          text: `Als „${state.config.tags[irr.suggestedTag]}“ festhalten`,
          onclick: () => addTags(photo, [irr.suggestedTag]),
        }));
      }
      parts.push(card);
    }
  } else if (w) {
    parts.push(el('p', { class: 'calm-note', text: 'Keine Auffälligkeiten gegenüber dem langjährigen Mittel.' }));
  }
  if (ctx.weather) parts.push(el('p', { class: 'wx-source', text: `Wetterdaten: ${ctx.weather.source}` }));
  body.replaceChildren(...parts);
}

/** All recorded irregularities of a spot, oldest first: the spot's record over the years. */
function renderChronicle(spot) {
  const items = spot.photos.flatMap((p, index) => (p.context?.irregularities || [])
    .map((irr) => ({ p, index, irr })));
  $('chronicle-wrap').hidden = !items.length;
  $('chronicle').replaceChildren(...items.map(({ p, index, irr }) => el('li', { 'data-severity': irr.severity }, [
    el('time', { datetime: p.takenAt, text: fmtDate(p.takenAt) }),
    el('button', { type: 'button', text: irr.title, onclick: () => showPhoto(index) }),
  ])));
}

function updateSwipe() {
  const v = Number($('swipe-range').value);
  $('swipe-top').style.clipPath = `inset(0 ${100 - v}% 0 0)`;
  $('swipe-handle').style.left = `${v}%`;
}

$('open-compare').addEventListener('click', () => {
  $('compare').hidden = !$('compare').hidden;
  if (!$('compare').hidden) $('compare').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('cmp-a').addEventListener('change', updateCompare);
$('cmp-b').addEventListener('change', updateCompare);
$('cmp-align').addEventListener('change', updateCompare);
$('cmp-heat').addEventListener('change', updateCompare);
$('stabilize').addEventListener('change', () => showPhoto(state.index));
$('realign').addEventListener('click', async (e) => {
  const { id } = state.spot;
  const current = state.spot.photos[state.index].id;
  const [a, b] = [$('cmp-a').value, $('cmp-b').value];
  e.target.disabled = true;
  e.target.textContent = 'Berechne …';
  try {
    await api(`/api/spots/${id}/align`, { method: 'POST' });
    await openSpot(id, current);
    $('cmp-a').value = a;
    $('cmp-b').value = b;
    $('compare').hidden = false;
    await updateCompare();
  } catch (err) {
    alert(err.message);
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Neu berechnen';
  }
});
$('swipe-range').addEventListener('input', updateSwipe);

/* ---------- Upload ---------- */

const dialog = $('upload-dialog');
const form = $('upload-form');

function setPicked(latlng) {
  state.picked = latlng;
  $('picked').textContent = latlng ? `${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}` : 'nicht gesetzt';
}

let pickMarker = null;
function startPicking() {
  dialog.close();
  $('explore').scrollIntoView({ behavior: 'smooth' });
  $('pick-hint').hidden = false;
  map.getContainer().style.cursor = 'crosshair';
}
function stopPicking() {
  $('pick-hint').hidden = true;
  map.getContainer().style.cursor = '';
  dialog.showModal();
}
map.on('click', (e) => {
  if ($('pick-hint').hidden) return;
  setPicked(e.latlng);
  if (pickMarker) pickMarker.setLatLng(e.latlng);
  else pickMarker = L.marker(e.latlng).addTo(map);
  stopPicking();
});
$('pick-cancel').addEventListener('click', stopPicking);
$('pick-on-map').addEventListener('click', startPicking);
$('use-geo').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Standortbestimmung wird nicht unterstützt');
  navigator.geolocation.getCurrentPosition(
    (pos) => setPicked(L.latLng(pos.coords.latitude, pos.coords.longitude)),
    (err) => alert(`Standort nicht verfügbar: ${err.message}`),
    { enableHighAccuracy: true, timeout: 15000 },
  );
});

$('open-upload').addEventListener('click', () => {
  form.reset();
  form.utcOffsetMinutes.value = String(-new Date().getTimezoneOffset());
  $('upload-result').replaceChildren();
  refreshDropzones();
  setPicked(null);
  if (pickMarker) { pickMarker.remove(); pickMarker = null; }
  dialog.showModal();
});
$('upload-cancel').addEventListener('click', () => dialog.close());
document.querySelectorAll('[data-action="upload"]').forEach((b) => b.addEventListener('click', () => $('open-upload').click()));

// Drop zones: show what was picked and highlight while dragging files over them.
function refreshDropzones() {
  for (const zone of form.querySelectorAll('.dropzone')) {
    const input = zone.querySelector('input');
    const label = zone.querySelector('strong');
    const files = [...input.files];
    zone.classList.toggle('has-files', files.length > 0);
    label.textContent = !files.length ? label.dataset.empty
      : files.length === 1 ? files[0].name
        : `${files.length} Dateien ausgewählt`;
  }
}
for (const zone of form.querySelectorAll('.dropzone')) {
  const input = zone.querySelector('input');
  input.addEventListener('change', refreshDropzones);
  input.addEventListener('dragenter', () => zone.classList.add('dragging'));
  for (const ev of ['dragleave', 'drop']) input.addEventListener(ev, () => zone.classList.remove('dragging'));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = [...form.photos.files];
  if (!files.length) return;
  const submit = $('upload-submit');
  submit.disabled = true;
  const created = [];
  const skipped = [];
  const touched = new Set();
  const BATCH = 10;
  try {
    for (let i = 0; i < files.length; i += BATCH) {
      submit.textContent = `Lade hoch … ${Math.min(i + BATCH, files.length)}/${files.length}`;
      const fd = new FormData();
      files.slice(i, i + BATCH).forEach((f) => fd.append('photos', f));
      if (form.gpx.files[0]) fd.append('gpx', form.gpx.files[0]);
      if (state.picked) {
        fd.append('lat', String(state.picked.lat));
        fd.append('lon', String(state.picked.lng));
      }
      if (form.takenAtLocal.value) fd.append('takenAt', new Date(form.takenAtLocal.value).toISOString());
      for (const name of ['activity', 'note', 'utcOffsetMinutes', 'clockShiftSeconds']) fd.append(name, form[name].value);
      const tags = [...$('upload-tags').querySelectorAll('input:checked')].map((c) => c.value);
      fd.append('tags', tags.join(','));

      const res = await api('/api/photos', { method: 'POST', body: fd });
      created.push(...res.created);
      skipped.push(...res.skipped);
      res.spots.forEach((s) => touched.add(s));
    }
  } catch (err) {
    skipped.push({ name: 'Upload', reason: err.message });
  } finally {
    submit.disabled = false;
    submit.textContent = 'Hochladen';
  }

  const result = [el('p', { text: `${created.length} Foto${created.length === 1 ? '' : 's'} gespeichert, ${touched.size} Spot${touched.size === 1 ? '' : 's'} aktualisiert.` })];
  if (skipped.length) {
    result.push(el('ul', { class: 'err' }, skipped.map((s) => el('li', { text: `${s.name}: ${s.reason}` }))));
  }
  $('upload-result').replaceChildren(...result);
  await loadSpots({ fit: created.length > 0 && !state.spot });
  if (created.length) {
    await openSpot(created[created.length - 1].spotId, created[created.length - 1].id);
    $('explore').scrollIntoView({ behavior: 'smooth' });
  }
});

/* ---------- Rephotography (repeat photo with overlay) ---------- */

const cam = { stream: null, watchId: null, position: null, ref: null, blob: null, mode: 'blend' };

const toRad = (d) => (d * Math.PI) / 180;
function distanceM(a, b) {
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

/** Largest box with the reference photo's aspect ratio that fits the camera area. */
function layoutStage() {
  if (!cam.ref) return;
  const area = document.querySelector('.cam-area').getBoundingClientRect();
  const ratio = cam.ref.naturalWidth / cam.ref.naturalHeight;
  let w = area.width;
  let h = w / ratio;
  if (h > area.height) { h = area.height; w = h * ratio; }
  const portraitScreen = area.height > area.width;
  $('cam-hint').hidden = portraitScreen === ratio < 1;
  Object.assign($('cam-stage').style, { width: `${Math.floor(w)}px`, height: `${Math.floor(h)}px` });
}

/** Draws the reference photo's edges (Sobel) as bright lines on a transparent canvas. */
function renderEdges(img) {
  const canvas = $('cam-edges');
  const scale = Math.min(1, 720 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const src = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2];
  const mag = new Float32Array(w * h);
  let max = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
      const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
      mag[i] = Math.hypot(gx, gy);
      if (mag[i] > max) max = mag[i];
    }
  }
  const out = ctx.createImageData(w, h);
  const threshold = max * 0.18;
  for (let i = 0; i < w * h; i++) {
    if (mag[i] < threshold) continue;
    out.data[i * 4] = 255;
    out.data[i * 4 + 1] = 225;
    out.data[i * 4 + 2] = 77;
    out.data[i * 4 + 3] = Math.min(255, 80 + (mag[i] / max) * 400);
  }
  ctx.putImageData(out, 0, 0);
}

function applyOverlay() {
  const opacity = Number($('cam-opacity').value) / 100;
  $('cam-ref').hidden = cam.mode !== 'blend';
  $('cam-edges').hidden = cam.mode !== 'edges';
  $('cam-ref').style.opacity = String(opacity);
  $('cam-edges').style.opacity = String(Math.min(1, opacity * 1.6));
  $('cam-opacity').disabled = cam.mode === 'off';
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === cam.mode)));
}

function updateCamInfo() {
  const parts = [`Referenz vom ${fmtDate(state.spot.photos[state.index].takenAt)}`];
  const info = $('cam-info');
  info.replaceChildren(parts[0]);
  if (cam.position) {
    const d = distanceM(cam.position, state.spot);
    const far = d > 25;
    info.append(' · ', el('span', {
      class: far ? 'far' : '',
      text: `${far ? 'noch ' : ''}≈ ${Math.round(d)} m zum Spot (±${Math.round(cam.position.accuracy)} m)`,
    }));
  } else {
    info.append(' · Standort wird ermittelt …');
  }
}

function startWatchingPosition() {
  if (!navigator.geolocation) return;
  cam.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      cam.position = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
      updateCamInfo();
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
}

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    // Insecure context (plain http on a phone) or old browser: fall back to the native camera app.
    alert('Live-Overlay braucht HTTPS. Es öffnet sich die normale Kamera – das Foto wird trotzdem diesem Spot zugeordnet.');
    $('rephoto-file').click();
    return;
  }
  const photo = state.spot.photos[state.index];
  cam.ref = $('cam-ref');
  cam.ref.src = photo.url;
  await cam.ref.decode().catch(() => {});
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
  } catch (err) {
    alert(`Kamera nicht verfügbar (${err.message}). Es öffnet sich die normale Kamera.`);
    $('rephoto-file').click();
    return;
  }
  $('cam-video').srcObject = cam.stream;
  renderEdges(cam.ref);
  showCaptureMode();
  $('camera').hidden = false;
  document.body.style.overflow = 'hidden';
  layoutStage();
  applyOverlay();
  updateCamInfo();
  startWatchingPosition();
}

function closeCamera() {
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  if (cam.watchId !== null) navigator.geolocation.clearWatch(cam.watchId);
  cam.watchId = null;
  cam.blob = null;
  $('camera').hidden = true;
  document.body.style.overflow = '';
}

function showCaptureMode() {
  if ($('cam-shot').src.startsWith('blob:')) URL.revokeObjectURL($('cam-shot').src);
  $('cam-shot').hidden = true;
  $('cam-shot').removeAttribute('src');
  $('cam-controls').hidden = false;
  $('cam-confirm').hidden = true;
  applyOverlay();
}

/** Captures exactly the framing visible in the stage (same aspect as the reference). */
function capture() {
  const video = $('cam-video');
  const stage = $('cam-stage').getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.max(stage.width / vw, stage.height / vh);
  const sw = stage.width / scale;
  const sh = stage.height / scale;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw);
  canvas.height = Math.round(sh);
  canvas.getContext('2d').drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    cam.blob = blob;
    $('cam-shot').src = URL.createObjectURL(blob);
    $('cam-shot').hidden = false;
    $('cam-ref').hidden = true;
    $('cam-edges').hidden = true;
    $('cam-controls').hidden = true;
    $('cam-confirm').hidden = false;
  }, 'image/jpeg', 0.9);
}

/** Uploads a repeat photo to the current spot and opens the before/after view. */
async function uploadRephoto(file, name, position) {
  const spotId = state.spot.id;
  const refIndex = state.index;
  const fd = new FormData();
  fd.append('photos', file, name);
  fd.append('spotId', String(spotId));
  fd.append('refPhotoId', String(state.spot.photos[refIndex].id));
  fd.append('takenAt', new Date().toISOString());
  fd.append('utcOffsetMinutes', String(-new Date().getTimezoneOffset()));
  if (position) {
    fd.append('lat', String(position.lat));
    fd.append('lon', String(position.lon));
  }
  const res = await api('/api/photos', { method: 'POST', body: fd });
  if (!res.created.length) throw new Error(res.skipped.map((s) => s.reason).join(', ') || 'Upload fehlgeschlagen');
  const created = res.created[0];
  await Promise.all([loadSpots(), openSpot(spotId, created.id)]);
  // Compare the reference with the new photo straight away.
  $('cmp-a').value = String(Math.min(refIndex, state.spot.photos.length - 1));
  $('cmp-b').value = String(state.spot.photos.findIndex((p) => p.id === created.id));
  updateCompare();
  $('compare').hidden = false;
}

$('open-camera').addEventListener('click', openCamera);
$('cam-close').addEventListener('click', closeCamera);
$('cam-capture').addEventListener('click', capture);
$('cam-retake').addEventListener('click', showCaptureMode);
$('cam-opacity').addEventListener('input', applyOverlay);
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  cam.mode = b.dataset.mode;
  applyOverlay();
}));
window.addEventListener('resize', layoutStage);
document.addEventListener('keydown', (e) => {
  if ($('camera').hidden) return;
  if (e.key === 'Escape') closeCamera();
  if (e.key === ' ' && !$('cam-controls').hidden) { e.preventDefault(); capture(); }
});

$('cam-save').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    await uploadRephoto(cam.blob, `wiederholung-${Date.now()}.jpg`, cam.position);
    closeCamera();
  } catch (err) {
    alert(err.message);
  } finally {
    e.target.disabled = false;
  }
});

$('rephoto-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    await uploadRephoto(file, file.name, null);
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- Init ---------- */

(async function init() {
  [state.config, state.trees] = await Promise.all([api('/api/config'), api('/api/trees')]);
  $('tag-filter').append(
    el('option', { value: '@change', text: 'Starke Veränderung (≥ 5 %)' }),
    el('option', { value: '@irregular', text: 'Auffälligkeiten' }),
  );
  for (const [key, label] of Object.entries(state.config.tags)) {
    $('tag-filter').append(el('option', { value: key, text: label }));
    $('upload-tags').append(el('label', {}, [el('input', { type: 'checkbox', value: key }), label]));
  }
  $('tag-filter').addEventListener('change', () => loadSpots());
  await loadSpots({ fit: true });
})();
