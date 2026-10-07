'use strict';

/*
 * "Sonne & Wetter" map mode: sun path, sun position and tree shadow around
 * the selected spot (or the map centre) for any date and time, clear-sky
 * irradiance on flat ground and on the spot's slope, and – for past days
 * and the coming ~16 days – measured or forecast radiation and rain.
 * Relies on globals from app.js (map, state, api, el, $) and sun.js (Sun).
 */
(function sunMode() {
  const TREE_HEIGHT = 25; // m, for the shadow
  const RING_PX = 110; // radius of the sun-path diagram on screen
  const sunLayer = L.layerGroup();
  const rainLayer = L.layerGroup();
  const sm = {
    open: false,
    date: null,
    minute: 720,
    day: null, // Sun.day(...) for place and date
    weather: null, // /api/weather/day
    playing: null,
    loadToken: 0,
  };

  const pad = (n) => String(n).padStart(2, '0');
  const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayStart = (date) => new Date(`${date}T00:00:00`).getTime();
  const clock = (t) => new Date(t).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  const fmtNum = (v, d = 0) => v.toLocaleString('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d });

  /** The place the sun is computed for: open spot (with its terrain) or map centre. */
  function place() {
    if (state.spot) {
      return {
        lat: state.spot.lat,
        lon: state.spot.lon,
        label: `Spot ${state.spot.id}`,
        elevation: state.spot.elevation,
        slope: state.spot.slope,
        aspect: state.spot.aspect,
        exposition: state.spot.exposition,
      };
    }
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng, label: 'Kartenmitte', elevation: null, slope: null, aspect: null, exposition: null };
  }

  function metresPerPixel(lat) {
    return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 8);
  }

  /* ---------- Map overlay ---------- */

  function drawMap() {
    sunLayer.clearLayers();
    if (!sm.open || !sm.day) return;
    const p = place();
    const R = RING_PX * metresPerPixel(p.lat);
    const at = (az, dist) => Sun.destination(p.lat, p.lon, az, dist);
    const css = getComputedStyle(document.documentElement);
    const gold = css.getPropertyValue('--sun').trim() || '#a8780c';

    // Horizon ring and the sun's path projected onto it (zenith in the centre).
    L.circle([p.lat, p.lon], { radius: R, color: gold, weight: 1, dashArray: '3 5', fill: true, fillOpacity: 0.05, interactive: false }).addTo(sunLayer);
    const path = sm.day.samples.filter((s) => s.altitude > 0).map((s) => at(s.azimuth, R * (1 - s.altitude / 90)));
    if (path.length) L.polyline(path, { color: gold, weight: 2.5, opacity: 0.85, interactive: false }).addTo(sunLayer);

    for (const [t, name] of [[sm.day.sunrise, 'Aufgang'], [sm.day.sunset, 'Untergang']]) {
      if (t === null) continue;
      const az = Sun.position(t, p.lat, p.lon).azimuth;
      L.polyline([[p.lat, p.lon], at(az, R)], { color: '#e07b28', weight: 2, dashArray: '6 5', interactive: false }).addTo(sunLayer);
      L.marker(at(az, R * 1.12), {
        icon: L.divIcon({ className: '', html: `<span class="map-label">${name} ${clock(t)}</span>`, iconSize: null, iconAnchor: [40, 10] }),
        interactive: false,
      }).addTo(sunLayer);
    }

    const t = dayStart(sm.date) + sm.minute * 60000;
    const sun = Sun.position(t, p.lat, p.lon);
    if (sun.altitude > 0) {
      const pos = at(sun.azimuth, R * (1 - sun.altitude / 90));
      L.polyline([[p.lat, p.lon], pos], { color: gold, weight: 2, opacity: 0.6, interactive: false }).addTo(sunLayer);
      L.marker(pos, {
        icon: L.divIcon({ className: '', html: '<div class="sun-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false,
        zIndexOffset: 1000, // above pins and rain badges
      }).addTo(sunLayer);
      // Shadow of a tree at the place, in real metres on the map.
      const shadow = Math.min(TREE_HEIGHT / Math.tan((sun.altitude * Math.PI) / 180), 2000);
      L.polyline([[p.lat, p.lon], at((sun.azimuth + 180) % 360, shadow)], { color: '#1b2a1f', weight: 5, opacity: 0.55, lineCap: 'round', interactive: false }).addTo(sunLayer);
    }
    L.circleMarker([p.lat, p.lon], { radius: 4, color: '#fff', weight: 2, fillColor: gold, fillOpacity: 1, interactive: false }).addTo(sunLayer);
  }

  /** Rain of the chosen day at every spot. */
  async function drawRain() {
    rainLayer.clearLayers();
    if (!sm.open || !sm.date) return;
    const token = sm.loadToken;
    let data;
    try {
      data = await api(`/api/weather/day/spots?date=${sm.date}`);
    } catch {
      return;
    }
    if (token !== sm.loadToken || !sm.open) return;
    const bySpot = new Map(data.spots.map((s) => [s.spotId, s.precip]));
    for (const s of state.spots) {
      const v = bySpot.get(s.id);
      if (v === null || v === undefined) continue;
      const drop = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 0C5 0 1 4.6 1 6.6a4 4 0 0 0 8 0C9 4.6 5 0 5 0z"/></svg>';
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({
          className: '',
          html: `<span class="rain-badge${v < 0.1 ? ' dry' : ''}" title="Niederschlag am ${sm.date}">${drop}${fmtNum(v, v < 10 ? 1 : 0)} mm</span>`,
          iconSize: null,
          iconAnchor: [-14, 4],
        }),
        interactive: false,
        zIndexOffset: 500,
      }).addTo(rainLayer);
    }
  }

  /* ---------- Panel ---------- */

  function tile(label, value, sub) {
    return el('div', { class: 'wx-tile' }, [el('span', { text: label }), el('b', { text: value }), el('em', { text: sub || '' })]);
  }

  function weatherAt(t) {
    const h = sm.weather?.hourly || [];
    return h.find((x) => t >= x.t && t < x.t + 3600000) || null;
  }

  function renderPanel() {
    const p = place();
    const t = dayStart(sm.date) + sm.minute * 60000;
    $('sun-clock').textContent = clock(t);
    $('sun-place').textContent = `${p.label} · ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}` +
      (p.exposition && p.exposition !== 'eben' ? ` · ${p.exposition}, ${Math.round(p.slope)}°` : '');
    const sun = Sun.position(t, p.lat, p.lon);
    const irr = Sun.clearSky(sun.altitude, Sun.dayOfYear(t), p.elevation || 0);
    const onSlope = Number.isFinite(p.slope) && p.slope >= 3 ? Sun.onSlope(sun, irr, p.slope, p.aspect ?? 180) : null;
    const wx = weatherAt(t);
    const shadow = sun.altitude > 0 ? TREE_HEIGHT / Math.tan((sun.altitude * Math.PI) / 180) : null;

    $('sun-tiles').replaceChildren(
      tile('Sonnenstand', sun.altitude > 0 ? `${fmtNum(sun.altitude, 1)}° hoch` : 'unter dem Horizont',
        `Richtung ${Math.round(sun.azimuth)}° (${Sun.compass(sun.azimuth)})`),
      tile('Einstrahlung klar', `${Math.round(irr.ghi)} W/m²`,
        onSlope !== null ? `am Hang ${Math.round(onSlope)} W/m²` : 'auf ebenem Boden'),
      tile(sm.weather?.source === 'forecast' ? 'Prognose' : 'Gemessen',
        wx && Number.isFinite(wx.radiation) ? `${Math.round(wx.radiation)} W/m²` : '–',
        wx ? `${Number.isFinite(wx.precip) ? `${fmtNum(wx.precip, 1)} mm Regen` : ''}${Number.isFinite(wx.cloud) ? ` · ${wx.cloud} % bewölkt` : ''}` : 'keine Wetterdaten für diesen Tag'),
      tile(`Schatten ${TREE_HEIGHT}-m-Baum`, shadow !== null ? (shadow > 999 ? '> 1 km' : `${Math.round(shadow)} m`) : '–',
        shadow !== null ? `nach ${Sun.compass((sun.azimuth + 180) % 360)}` : ''),
    );

    const d = sm.day;
    const len = d.sunrise !== null && d.sunset !== null ? (d.sunset - d.sunrise) / 60000 : null;
    const parts = [];
    if (d.sunrise !== null) parts.push(['Aufgang', clock(d.sunrise)]);
    if (d.sunset !== null) parts.push(['Untergang', clock(d.sunset)]);
    if (len !== null) parts.push(['Tageslänge', `${Math.floor(len / 60)} h ${pad(Math.round(len % 60))} min`]);
    parts.push(['Höchststand', `${fmtNum(d.maxAltitude, 1)}°`]);
    parts.push(['Tagessumme klar', `${fmtNum(d.totalFlat, 1)} kWh/m²${Number.isFinite(p.slope) && p.slope >= 3 ? ` (Hang ${fmtNum(d.totalSlope, 1)})` : ''}`]);
    const tot = sm.weather?.totals;
    if (tot?.radiationKwh != null) parts.push([sm.weather.source === 'forecast' ? 'Prognose' : 'Gemessen', `${fmtNum(tot.radiationKwh, 1)} kWh/m²`]);
    if (tot?.precip != null) parts.push(['Regen', `${fmtNum(tot.precip, 1)} mm`]);
    if (tot?.tmin != null) parts.push(['Temperatur', `${fmtNum(tot.tmin, 0)}–${fmtNum(tot.tmax, 0)} °C`]);
    $('sun-dayline').replaceChildren(...parts.flatMap(([k, v], i) => [i ? ' · ' : '', `${k} `, el('b', { text: v })]));

    $('sun-source').textContent = sm.weather?.source
      ? `Sonnenstand berechnet; ${sm.weather.source === 'archive' ? 'Messdaten (ERA5-Reanalyse)' : 'Prognose'}: Open-Meteo.com`
      : `Sonnenstand und Einstrahlung bei klarem Himmel berechnet${sm.weather?.error ? ` · Wetterdaten nicht verfügbar (${sm.weather.error})` : ' · für diesen Tag gibt es keine Wetterdaten'}`;
  }

  /* ---------- Charts: irradiance (W/m²) and rain (mm/h), same time axis ---------- */

  const SVG = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}, children = []) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    n.append(...children);
    return n;
  };
  const W = 360; const LEFT = 30; const RIGHT = 6;
  const xOf = (minute) => LEFT + ((W - LEFT - RIGHT) * minute) / 1440;

  function chartFrame(title, legend, height, maxY, unit) {
    const wrap = el('div', { class: 'sun-chart' });
    const tip = el('div', { class: 'wx-tip', hidden: '' });
    const top = 8; const bottom = 18;
    const y = (v) => top + (height - top - bottom) * (1 - v / maxY);
    const nodes = [
      sv('line', { class: 'grid', x1: LEFT, x2: W - RIGHT, y1: y(0), y2: y(0) }),
      sv('line', { class: 'grid', x1: LEFT, x2: W - RIGHT, y1: y(maxY / 2), y2: y(maxY / 2), 'stroke-dasharray': '2 3' }),
      sv('text', { class: 'axis', x: LEFT - 4, y: y(maxY) + 3, 'text-anchor': 'end' }, [String(maxY)]),
      sv('text', { class: 'axis', x: LEFT - 4, y: y(0) + 3, 'text-anchor': 'end' }, ['0']),
      ...[0, 6, 12, 18, 24].map((hr) => sv('text', { class: 'axis', x: xOf(hr * 60), y: height - 4, 'text-anchor': 'middle' }, [`${hr}`])),
    ];
    wrap.append(el('h4', { text: `${title} (${unit})` }), el('div', { class: 'wx-legend' }, legend));
    return { wrap, tip, nodes, y, height };
  }

  function renderCharts() {
    const p = place();
    const d = sm.day;
    const slopeOk = Number.isFinite(p.slope) && p.slope >= 3;
    const hourly = (sm.weather?.hourly || []).map((h) => ({ ...h, minute: (h.t - dayStart(sm.date)) / 60000 }))
      .filter((h) => h.minute >= 0 && h.minute < 1440);
    const maxRad = Math.max(200, ...d.samples.map((s) => Math.max(s.ghi, slopeOk ? s.slope : 0)), ...hourly.map((h) => h.radiation || 0));
    const niceRad = Math.ceil(maxRad / 200) * 200;

    const legend = [el('span', {}, [el('i', { style: 'background: var(--sun)' }), 'klarer Himmel'])];
    if (slopeOk) legend.push(el('span', {}, [el('i', { class: 'dash' }), `klar am Hang (${p.exposition})`]));
    if (hourly.some((h) => Number.isFinite(h.radiation))) {
      legend.push(el('span', {}, [el('i', { style: 'background: var(--measured)' }), sm.weather.source === 'forecast' ? 'Prognose' : 'gemessen']));
    }
    const rad = chartFrame('Sonneneinstrahlung', legend, 150, niceRad, 'W/m²');
    const pts = (key) => d.samples.map((s) => `${xOf(s.minute).toFixed(1)},${rad.y(s[key]).toFixed(1)}`).join(' ');
    rad.nodes.push(sv('polygon', { class: 'clear', points: `${xOf(0)},${rad.y(0)} ${pts('ghi')} ${xOf(1440)},${rad.y(0)}` }));
    if (slopeOk) rad.nodes.push(sv('polyline', { class: 'clear-slope', points: pts('slope') }));
    const measured = hourly.filter((h) => Number.isFinite(h.radiation));
    if (measured.length) {
      // Hourly means are drawn at the middle of their hour.
      rad.nodes.push(sv('polyline', { class: 'measured', points: measured.map((h) => `${xOf(h.minute + 30).toFixed(1)},${rad.y(h.radiation).toFixed(1)}`).join(' ') }));
    }
    const charts = [rad];

    const rainy = hourly.filter((h) => Number.isFinite(h.precip));
    if (rainy.length) {
      const maxRain = Math.max(1, ...rainy.map((h) => h.precip));
      const niceRain = maxRain <= 2 ? 2 : Math.ceil(maxRain / 2) * 2;
      const rain = chartFrame('Regen pro Stunde', [el('span', {}, [el('i', { style: 'background: var(--wet)' }), `${fmtNum(sm.weather.totals.precip ?? 0, 1)} mm am Tag`])], 90, niceRain, 'mm');
      const bw = (W - LEFT - RIGHT) / 24 - 2;
      for (const h of rainy) {
        if (h.precip <= 0) continue;
        const x0 = xOf(h.minute) + 1; const yTop = rain.y(h.precip); const yb = rain.y(0); const r = Math.min(3, (yb - yTop), bw / 2);
        rain.nodes.push(sv('path', { class: 'rain', d: `M${x0} ${yb}V${yTop + r}Q${x0} ${yTop} ${x0 + r} ${yTop}H${x0 + bw - r}Q${x0 + bw} ${yTop} ${x0 + bw} ${yTop + r}V${yb}Z` }));
      }
      charts.push(rain);
    }

    // Shared: marker for the chosen time, crosshair + tooltip on hover, click/drag sets the time.
    for (const c of charts) {
      const now = sv('line', { class: 'now', x1: xOf(sm.minute), x2: xOf(sm.minute), y1: 4, y2: c.y(0) });
      const cross = sv('line', { class: 'cross', x1: 0, x2: 0, y1: 4, y2: c.y(0), visibility: 'hidden' });
      const hit = sv('rect', { class: 'hit', x: LEFT, y: 0, width: W - LEFT - RIGHT, height: c.height, tabindex: 0, 'aria-label': 'Zeitpunkt im Diagramm wählen' });
      const svg = sv('svg', { viewBox: `0 0 ${W} ${c.height}`, role: 'img', 'aria-label': c.wrap.querySelector('h4').textContent }, [...c.nodes, now, cross, hit]);
      const minuteAt = (evt) => {
        const r = svg.getBoundingClientRect();
        const x = ((evt.clientX - r.left) / r.width) * W;
        return Math.max(0, Math.min(1439, Math.round((((x - LEFT) / (W - LEFT - RIGHT)) * 1440) / 5) * 5));
      };
      const show = (minute, evt) => {
        cross.setAttribute('x1', xOf(minute)); cross.setAttribute('x2', xOf(minute)); cross.setAttribute('visibility', 'visible');
        const t = dayStart(sm.date) + minute * 60000;
        const s = Sun.position(t, p.lat, p.lon);
        const irr = Sun.clearSky(s.altitude, Sun.dayOfYear(t), p.elevation || 0);
        const w = weatherAt(t);
        const lines = [`Sonne ${s.altitude > 0 ? `${fmtNum(s.altitude, 0)}°` : 'unter Horizont'} · klar ${Math.round(irr.ghi)} W/m²`];
        if (w && Number.isFinite(w.radiation)) lines.push(`${sm.weather.source === 'forecast' ? 'Prognose' : 'gemessen'} ${Math.round(w.radiation)} W/m²`);
        if (w && Number.isFinite(w.precip)) lines.push(`Regen ${fmtNum(w.precip, 1)} mm/h`);
        c.tip.replaceChildren(el('strong', { text: clock(t) }), ...lines.flatMap((l, i) => (i ? [el('br'), l] : [l])));
        c.tip.hidden = false;
        const box = c.wrap.getBoundingClientRect();
        const half = c.tip.offsetWidth / 2 + 4;
        c.tip.style.left = `${Math.min(Math.max(evt.clientX - box.left, half), box.width - half)}px`;
        c.tip.style.top = `${svg.getBoundingClientRect().top - box.top + 14}px`;
      };
      hit.addEventListener('pointermove', (evt) => {
        show(minuteAt(evt), evt);
        if (evt.buttons === 1) setMinute(minuteAt(evt));
      });
      hit.addEventListener('pointerdown', (evt) => setMinute(minuteAt(evt)));
      hit.addEventListener('pointerleave', () => { c.tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
      hit.addEventListener('keydown', (evt) => {
        if (evt.key === 'ArrowRight') { setMinute(Math.min(1439, sm.minute + 10)); evt.preventDefault(); }
        if (evt.key === 'ArrowLeft') { setMinute(Math.max(0, sm.minute - 10)); evt.preventDefault(); }
      });
      c.wrap.append(svg, c.tip);
    }
    // Screen-reader table with the hourly values.
    const table = el('div', { class: 'sr-only' }, el('table', {}, [
      el('caption', { text: `Stundenwerte am ${sm.date}` }),
      el('tr', {}, ['Stunde', 'klar (W/m²)', 'gemessen (W/m²)', 'Regen (mm)'].map((h) => el('th', { text: h }))),
      ...Array.from({ length: 24 }, (_, hr) => {
        const s = d.samples.find((x) => x.minute === hr * 60 + 30) || d.samples[hr * 6];
        const w = hourly.find((h) => Math.round(h.minute / 60) === hr);
        return el('tr', {}, [String(hr), String(Math.round(s.ghi)), w?.radiation ?? '–', w?.precip ?? '–'].map((v) => el('td', { text: String(v) })));
      }),
    ]));
    $('sun-charts').replaceChildren(...charts.map((c) => c.wrap), table);
  }

  /* ---------- State changes ---------- */

  function setMinute(minute) {
    sm.minute = minute;
    $('sun-slider').value = String(minute);
    renderPanel();
    drawMap();
    for (const line of document.querySelectorAll('#sun-charts .now')) {
      line.setAttribute('x1', xOf(minute));
      line.setAttribute('x2', xOf(minute));
    }
  }

  async function load() {
    if (!sm.open) return;
    const p = place();
    const token = ++sm.loadToken;
    sm.day = Sun.day(dayStart(sm.date), p.lat, p.lon, { elevation: p.elevation || 0, slope: p.slope || 0, aspect: p.aspect ?? 180, stepMin: 10 });
    sm.weather = null;
    renderPanel();
    renderCharts();
    drawMap();
    drawRain();
    try {
      const q = `lat=${p.lat.toFixed(4)}&lon=${p.lon.toFixed(4)}&date=${sm.date}${Number.isFinite(p.elevation) ? `&elevation=${Math.round(p.elevation)}` : ''}`;
      const wx = await api(`/api/weather/day?${q}`);
      if (token !== sm.loadToken) return;
      sm.weather = wx;
      renderPanel();
      renderCharts();
    } catch {
      // Panel already shows the astronomical part.
    }
  }

  function setDate(date) {
    sm.date = date;
    $('sun-date').value = date;
    load();
  }

  function toggle(open) {
    sm.open = open;
    $('sunpanel').hidden = !open;
    $('sun-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      sunLayer.addTo(map);
      rainLayer.addTo(map);
      if (!sm.date) {
        const now = new Date();
        sm.minute = Math.floor((now.getHours() * 60 + now.getMinutes()) / 5) * 5;
        $('sun-slider').value = String(sm.minute);
        setDate(isoLocal(now));
      } else {
        load();
      }
    } else {
      stop();
      sunLayer.remove();
      rainLayer.remove();
    }
  }

  function stop() {
    clearInterval(sm.playing);
    sm.playing = null;
    $('sun-play').textContent = '▶';
    $('sun-play').setAttribute('aria-label', 'Tagesverlauf abspielen');
  }

  $('sun-toggle').addEventListener('click', () => toggle(!sm.open));
  $('sun-close').addEventListener('click', () => toggle(false));
  $('sun-slider').addEventListener('input', (e) => setMinute(Number(e.target.value)));
  $('sun-date').addEventListener('change', (e) => e.target.value && setDate(e.target.value));
  const shiftDay = (n) => {
    const d = new Date(`${sm.date}T12:00:00`);
    d.setDate(d.getDate() + n);
    setDate(isoLocal(d));
  };
  $('sun-prev').addEventListener('click', () => shiftDay(-1));
  $('sun-next').addEventListener('click', () => shiftDay(1));
  $('sun-today').addEventListener('click', () => setDate(isoLocal(new Date())));
  $('sun-play').addEventListener('click', () => {
    if (sm.playing) return stop();
    $('sun-play').textContent = '❚❚';
    $('sun-play').setAttribute('aria-label', 'Anhalten');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    sm.playing = setInterval(() => setMinute((sm.minute + (reduce ? 60 : 10)) % 1440), reduce ? 600 : 90);
  });

  // Follow the place: spot opened or closed, map moved without a spot, zoom changes the ring size.
  let lastPlace = '';
  const placeKey = () => { const p = place(); return `${p.label}:${p.lat.toFixed(3)},${p.lon.toFixed(3)}:${p.slope}:${p.aspect}`; };
  const refreshPlace = () => {
    if (!sm.open) return;
    const k = placeKey();
    if (k !== lastPlace) { lastPlace = k; load(); } else drawMap();
  };
  map.on('moveend zoomend', refreshPlace);
  new MutationObserver(refreshPlace).observe($('spot'), { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(refreshPlace).observe($('spot-elev-text'), { childList: true, characterData: true, subtree: true });
}());
