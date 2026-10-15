/*
 * "Wetter" in the spot page: the live precipitation radar of the Deutscher
 * Wetterdienst around the spot (Germany and its border areas, which takes in
 * northern Switzerland), playable over the last two hours, and the forecast
 * for the next hours and seven days from Open-Meteo (/api/weather/forecast),
 * laid out like a weather app: hours to swipe through, then the days.
 *
 * The weather codes are WMO codes. Their wording, the icon kind and the radar
 * frames are pure functions and run in Node for tests; the rest needs the
 * browser (window.Forecast).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Forecast = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  /* ---------- Weather codes ---------- */

  const WMO = {
    0: 'klar', 1: 'überwiegend klar', 2: 'teils bewölkt', 3: 'bedeckt',
    45: 'Nebel', 48: 'Nebel mit Reif',
    51: 'leichter Niesel', 53: 'Niesel', 55: 'starker Niesel', 56: 'gefrierender Niesel', 57: 'gefrierender Niesel',
    61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen', 66: 'gefrierender Regen', 67: 'gefrierender Regen',
    71: 'leichter Schneefall', 73: 'Schneefall', 75: 'starker Schneefall', 77: 'Schneegriesel',
    80: 'Regenschauer', 81: 'Regenschauer', 82: 'heftige Regenschauer', 85: 'Schneeschauer', 86: 'starke Schneeschauer',
    95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'Gewitter mit Hagel',
  };
  const wmoLabel = (code) => WMO[code] ?? 'unbekannt';

  /** Which icon a weather code gets: sun/moon, partly, cloud, fog, drizzle, rain, freezing, snow, sleet, thunder. */
  function iconKind(code) {
    if (code === 0 || code === 1) return 'clear';
    if (code === 2) return 'partly';
    if (code === 3) return 'cloud';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 55) return 'drizzle';
    if (code === 56 || code === 57 || code === 66 || code === 67) return 'freezing';
    if ((code >= 61 && code <= 65) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'thunder';
    return 'cloud';
  }

  /**
   * Radar frames to play: `count` times `stepMin` minutes apart, ending with
   * the newest picture DWD has (ISO strings, oldest first). Without a known
   * time range only the newest picture (null = no time parameter).
   */
  function radarFrames(layer, { count = 9, stepMin = 15 } = {}) {
    if (!layer || !Number.isFinite(layer.to)) return [null];
    const step = stepMin * 60000;
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
      const t = layer.to - i * step;
      if (Number.isFinite(layer.from) && t < layer.from) continue;
      out.push(new Date(t).toISOString().replace('.000Z', 'Z'));
    }
    return out;
  }

  const pure = { wmoLabel, iconKind, radarFrames };
  if (typeof document === 'undefined' || typeof window === 'undefined' || !window.L) return pure;

  /* ---------- Icons ---------- */

  const SUN = '<circle cx="12" cy="12" r="4.2" class="i-sun"/><path class="i-ray" d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6"/>';
  const MOON = '<path class="i-moon" d="M15.5 4.5a7.5 7.5 0 1 0 4 12.8A6.2 6.2 0 0 1 15.5 4.5z"/>';
  const CLOUD = '<path class="i-cloud" d="M7.5 18.5h9.8a3.7 3.7 0 0 0 .4-7.4 5.2 5.2 0 0 0-10-.9 3.9 3.9 0 0 0-.2 8.3z"/>';
  const SMALL_SUN = '<g transform="translate(-3.5 -4) scale(.75)">' + SUN + '</g>';
  const SMALL_MOON = '<g transform="translate(-3 -3.5) scale(.75)">' + MOON + '</g>';
  const LOW_CLOUD = '<g transform="translate(0 -3)">' + CLOUD + '</g>';
  const drops = (n) => [[8.5, 18.5], [12, 19.5], [15.5, 18.5]].slice(0, n).map(([x, y]) => `<path class="i-drop" d="M${x} ${y}l-1 2.6"/>`).join('');
  const flakes = (n) => [[8.5, 19.5], [12, 21], [15.5, 19.5]].slice(0, n).map(([x, y]) => `<circle class="i-flake" cx="${x}" cy="${y}" r="1.1"/>`).join('');

  /** An inline SVG icon for a weather code, by day or night. */
  function icon(code, day = true) {
    const kind = iconKind(code);
    const body = {
      clear: day ? SUN : MOON,
      partly: (day ? SMALL_SUN : SMALL_MOON) + '<g transform="translate(2 1.5) scale(.85)">' + CLOUD + '</g>',
      cloud: CLOUD,
      fog: '<path class="i-fog" d="M4 9h16M6 13h12M4 17h16"/>',
      drizzle: LOW_CLOUD + drops(2),
      rain: LOW_CLOUD + drops(3),
      freezing: LOW_CLOUD + drops(1) + flakes(1).replace('8.5', '15.5'),
      snow: LOW_CLOUD + flakes(3),
      thunder: LOW_CLOUD + '<path class="i-bolt" d="M12.5 15.5 10 20h3l-1.5 3.5"/>',
    }[kind];
    return `<svg class="wx-icon" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  }

  /* ---------- In the spot page ---------- */

  const $ = (id) => document.getElementById(id);
  if (!$('side-pane-weather')) return pure;
  const forecasts = new Map(); // "lat,lon" → forecast (or a promise of it)
  let dwd = null; // /api/dwd/layers, once
  let radarMap = null;
  let radarLayers = [];
  let radarFramesNow = [];
  let spotDot = null;
  let shownSpot = null;
  let playTimer = null;

  const fmt = (v, d = 0) => (v === null || v === undefined ? '–' : v.toFixed(d).replace('-', '−'));
  const clock = (t) => new Date(t).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  const WEEKDAY = (date) => new Date(`${date}T12:00:00`).toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'numeric' });
  const visible = () => !$('side-pane-weather').hidden;

  /* Radar */

  async function drawRadar(spot) {
    if (!radarMap) {
      radarMap = L.map('spot-radar', { zoomControl: false, attributionControl: true, scrollWheelZoom: false, keyboard: false });
      radarMap.attributionControl.setPrefix(false);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '© OpenStreetMap' }).addTo(radarMap);
      radarMap.createPane('radar').style.zIndex = 350;
    }
    radarMap.invalidateSize();
    radarMap.setView([spot.lat, spot.lon], 9, { animate: false });
    spotDot?.remove();
    spotDot = L.circleMarker([spot.lat, spot.lon], { radius: 6, weight: 2.5, className: 'mini-dot current', interactive: false }).addTo(radarMap);
    if (!dwd) dwd = await api('/api/dwd/layers').catch((err) => ({ layers: [], error: err.message }));
    const layer = dwd.layers?.find((l) => l.id === 'radar');
    if (!layer) {
      $('radar-note').textContent = `Radar nicht verfügbar${dwd.error ? ` (${dwd.error})` : ''}.`;
      $('radar-bar').hidden = true;
      return;
    }
    const frames = radarFrames(layer);
    if (radarLayers.length && frames.join() === radarFramesNow.join()) return showFrame(Number($('radar-time').value));
    for (const l of radarLayers) l.remove();
    radarFramesNow = frames;
    radarLayers = frames.map((time) => L.tileLayer.wms(dwd.url, {
      layers: layer.name, format: 'image/png', transparent: true, version: '1.3.0', opacity: 0, pane: 'radar',
      attribution: `© <a href="https://www.dwd.de/">${dwd.attribution}</a>`, ...(time ? { time } : {}),
    }).addTo(radarMap));
    $('radar-time').max = String(frames.length - 1);
    $('radar-time').value = String(frames.length - 1);
    $('radar-bar').hidden = frames.length < 2;
    showFrame(frames.length - 1);
  }

  function showFrame(i) {
    radarLayers.forEach((l, j) => l.setOpacity(j === i ? 0.75 : 0));
    const time = radarFramesNow[i];
    $('radar-clock').textContent = time ? clock(Date.parse(time)) : 'aktuell';
    const age = time ? Math.round((Date.now() - Date.parse(time)) / 60000) : null;
    // A picture older than three hours (DWD stuck) says its date instead of how old it is.
    const when = age === null ? '' : age > 180
      ? ` vom ${new Date(Date.parse(time)).toLocaleString('de-CH', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}`
      : ` von ${clock(Date.parse(time))}${i === radarFramesNow.length - 1 ? ` (vor ${age} min)` : ''}`;
    $('radar-note').textContent = `Niederschlagsradar${when} · Deutschland und Grenzgebiet, © Deutscher Wetterdienst`;
  }

  function stopPlay() {
    clearInterval(playTimer);
    playTimer = null;
    $('radar-play').textContent = '▶';
    $('radar-play').setAttribute('aria-label', 'Radar der letzten zwei Stunden abspielen');
  }
  $('radar-play').addEventListener('click', () => {
    if (playTimer) return stopPlay();
    $('radar-play').textContent = '❚❚';
    $('radar-play').setAttribute('aria-label', 'Anhalten');
    let i = 0;
    const tick = () => {
      $('radar-time').value = String(i);
      showFrame(i);
      if (i === radarFramesNow.length - 1) { stopPlay(); return; }
      i += 1;
    };
    tick();
    playTimer = setInterval(tick, 700);
  });
  $('radar-time').addEventListener('input', (e) => { stopPlay(); showFrame(Number(e.target.value)); });

  /* Forecast */

  function windArrow(dir, speed) {
    if (dir === null) return '';
    // The arrow points where the wind blows to.
    return `<svg class="wind-arrow" viewBox="0 0 12 12" style="transform:rotate(${Math.round(dir + 180)}deg)" aria-hidden="true"><path d="M6 1.5v9M3 7.5 6 10.5 9 7.5"/></svg>${fmt(speed)}`;
  }

  function renderForecast(f) {
    const hours = $('forecast-hours');
    const days = $('forecast-days');
    if (!f.hourly?.length) {
      hours.replaceChildren();
      days.replaceChildren();
      $('forecast-note').textContent = `Vorhersage nicht verfügbar${f.error ? ` (${f.error})` : ''}.`;
      return;
    }
    const maxMm = Math.max(2, ...f.hourly.slice(0, 24).map((h) => h.precip ?? 0));
    hours.innerHTML = f.hourly.slice(0, 24).map((h, i) => {
      const mm = h.precip ?? 0;
      const label = `${i === 0 ? 'Jetzt' : clock(h.t)}: ${wmoLabel(h.code)}, ${fmt(h.temp)} °C${mm ? `, ${fmt(mm, 1)} mm` : ''}, Wind ${fmt(h.wind)} km/h`;
      return `<div class="fc-hour" role="listitem" aria-label="${label}" title="${label}">
        <span class="fc-time">${i === 0 ? 'Jetzt' : new Date(h.t).getHours()}</span>
        ${icon(h.code, h.day !== false)}
        <b class="fc-temp">${fmt(h.temp)}°</b>
        <span class="fc-rain"><i style="height:${Math.round((Math.min(mm, maxMm) / maxMm) * 100)}%"></i></span>
        <span class="fc-mm">${mm >= 0.1 ? fmt(mm, 1) : ''}</span>
        <span class="fc-prob">${(h.prob ?? 0) >= 10 ? `${h.prob} %` : ''}</span>
        <span class="fc-wind${(h.gust ?? 0) >= 60 ? ' gusty' : ''}">${windArrow(h.dir, h.wind)}</span>
      </div>`;
    }).join('');
    const lo = Math.min(...f.daily.map((d) => d.tmin ?? Infinity));
    const hi = Math.max(...f.daily.map((d) => d.tmax ?? -Infinity));
    const pos = (v) => `${Math.round(((v - lo) / Math.max(1, hi - lo)) * 100)}%`;
    days.innerHTML = f.daily.map((d, i) => `<li title="${wmoLabel(d.code)}">
      <span class="fc-day">${i === 0 ? 'Heute' : WEEKDAY(d.date)}</span>
      ${icon(d.code, true)}
      <span class="fc-dmm">${(d.precip ?? 0) >= 0.1 ? `${fmt(d.precip, 1)} mm` : ''}${(d.snowfall ?? 0) >= 0.5 ? ` · ${fmt(d.snowfall)} cm Schnee` : ''}</span>
      <span class="fc-range"><span class="fc-lo">${fmt(d.tmin)}°</span><span class="fc-bar"><i style="left:${pos(d.tmin)};right:calc(100% - ${pos(d.tmax)})"></i></span><span class="fc-hi">${fmt(d.tmax)}°</span></span>
    </li>`).join('');
    $('forecast-note').textContent = `Vorhersage von ${clock(f.issued)} · ${f.source}`;
  }

  async function loadForecast(spot) {
    const key = `${spot.lat.toFixed(2)},${spot.lon.toFixed(2)}`;
    if (!forecasts.has(key) || Date.now() - (forecasts.get(key).issued ?? Date.now()) > 30 * 60000) {
      const elev = Number.isFinite(spot.elevation) ? `&elevation=${Math.round(spot.elevation)}` : '';
      forecasts.set(key, api(`/api/weather/forecast?lat=${spot.lat.toFixed(4)}&lon=${spot.lon.toFixed(4)}${elev}`)
        .catch((err) => ({ hourly: [], daily: [], error: err.message })));
    }
    const f = await forecasts.get(key);
    if (f.error) forecasts.delete(key); else forecasts.set(key, f);
    if (shownSpot?.id === spot.id) renderForecast(f);
  }

  /** Fills the tab for the open spot; called when the tab is shown and when another spot opens. */
  function show() {
    const spot = state.spot; // app.js
    if (!spot || !visible()) return;
    const changed = shownSpot?.id !== spot.id;
    shownSpot = spot;
    if (changed) {
      $('forecast-hours').replaceChildren();
      $('forecast-days').replaceChildren();
      $('forecast-note').textContent = 'Vorhersage wird geladen …';
      $('forecast-hours').scrollLeft = 0;
    }
    drawRadar(spot);
    loadForecast(spot);
  }

  document.addEventListener('myforrest:photo', () => { if (visible() && state.spot?.id !== shownSpot?.id) show(); });

  return { ...pure, icon, show };
}));
