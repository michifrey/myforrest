'use strict';

const $ = (id) => document.getElementById(id);
const DAMAGE_TAGS = ['sturmschaden', 'borkenkaefer', 'trockenschaden', 'holzschlag'];

const state = {
  config: { tags: {}, plantnet: false },
  spots: [],
  spot: null,
  index: 0,
  picked: null,
  markers: L.layerGroup(),
};

const fmtDate = (iso) => new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' });
const SOURCE_LABEL = { exif: 'GPS aus Foto', gpx: 'über GPX-Track', manual: 'manuell gesetzt' };

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

/* ---------- Map ---------- */

const map = L.map('map', { zoomControl: true }).setView([47.2, 8.4], 8);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
state.markers.addTo(map);

function spotColor(spot) {
  const css = getComputedStyle(document.documentElement);
  if (spot.tags.includes('neophyt')) return css.getPropertyValue('--neo').trim();
  if (spot.tags.some((t) => DAMAGE_TAGS.includes(t))) return css.getPropertyValue('--damage').trim();
  return css.getPropertyValue('--ok').trim();
}

function renderMarkers() {
  state.markers.clearLayers();
  for (const s of state.spots) {
    const color = spotColor(s);
    const m = L.circleMarker([s.lat, s.lon], {
      radius: 6 + Math.min(Math.log2(s.photoCount) * 2, 8),
      color: '#fff',
      weight: 2,
      fillColor: color,
      fillOpacity: 0.9,
    });
    m.bindTooltip(`Spot ${s.id} · ${s.photoCount} Foto${s.photoCount === 1 ? '' : 's'} · ${fmtDate(s.firstTaken)}–${fmtDate(s.lastTaken)}`);
    m.on('click', () => openSpot(s.id));
    state.markers.addLayer(m);
  }
}

async function loadSpots({ fit = false } = {}) {
  const tag = $('tag-filter').value;
  state.spots = await api(`/api/spots${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`);
  renderMarkers();
  renderStats();
  if (fit && state.spots.length) {
    map.fitBounds(L.latLngBounds(state.spots.map((s) => [s.lat, s.lon])).pad(0.2), { maxZoom: 16 });
  }
}

function renderStats() {
  const photos = state.spots.reduce((n, s) => n + s.photoCount, 0);
  const damaged = state.spots.filter((s) => s.tags.some((t) => DAMAGE_TAGS.includes(t) || t === 'neophyt')).length;
  const stat = (value, label) => el('div', { class: 'stat' }, [el('b', { text: String(value) }), el('span', { text: label })]);
  $('stats').replaceChildren(stat(state.spots.length, 'Spots'), stat(photos, 'Fotos'), stat(damaged, 'mit Befund'));
}

/* ---------- Spot panel ---------- */

async function openSpot(id, photoId) {
  state.spot = await api(`/api/spots/${id}`);
  const photos = state.spot.photos;
  const wanted = photos.findIndex((p) => p.id === photoId);
  state.index = wanted >= 0 ? wanted : photos.length - 1;

  $('welcome').hidden = true;
  $('spot').hidden = false;
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
  map.setView([state.spot.lat, state.spot.lon], Math.max(map.getZoom(), 15));
}

function showPhoto(i) {
  const photos = state.spot.photos;
  state.index = i;
  const p = photos[i];
  $('viewer-img').src = p.url;
  $('viewer-img').alt = `Spot ${state.spot.id} am ${fmtDate(p.takenAt)}`;
  const parts = [fmtDateTime(p.takenAt), SOURCE_LABEL[p.locationSource]];
  if (p.activity) parts.push(p.activity[0].toUpperCase() + p.activity.slice(1));
  if (p.heading !== null) parts.push(`Blickrichtung ${Math.round(p.heading)}°`);
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
  $('identify').hidden = !state.config.plantnet;
  renderIdentifications(p);
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
    ]))),
  ]));
}

$('time-slider').addEventListener('input', (e) => showPhoto(Number(e.target.value)));
$('close-spot').addEventListener('click', () => {
  $('spot').hidden = true;
  $('welcome').hidden = false;
  state.spot = null;
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
    await api(`/api/photos/${p.id}/identify`, { method: 'POST' });
    await Promise.all([openSpot(state.spot.id, p.id), loadSpots()]);
  } catch (err) {
    alert(err.message);
  } finally {
    e.target.disabled = false;
    e.target.textContent = 'Pflanze bestimmen';
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

function updateCompare() {
  const photos = state.spot.photos;
  $('cmp-img-a').src = photos[Number($('cmp-a').value)].url;
  $('cmp-img-b').src = photos[Number($('cmp-b').value)].url;
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
  setPicked(null);
  if (pickMarker) { pickMarker.remove(); pickMarker = null; }
  dialog.showModal();
});
$('upload-cancel').addEventListener('click', () => dialog.close());

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
  if (created.length) await openSpot(created[created.length - 1].spotId, created[created.length - 1].id);
});

/* ---------- Init ---------- */

(async function init() {
  state.config = await api('/api/config');
  for (const [key, label] of Object.entries(state.config.tags)) {
    $('tag-filter').append(el('option', { value: key, text: label }));
    $('upload-tags').append(el('label', {}, [el('input', { type: 'checkbox', value: key }), label]));
  }
  $('tag-filter').addEventListener('change', () => loadSpots());
  await loadSpots({ fit: true });
})();
