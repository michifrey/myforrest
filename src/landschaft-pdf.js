'use strict';

/**
 * The report of «Landschaft im Wandel» as a PDF (A4, fixed layout), for communes and forest services: the same
 * sections as the page (public/landschaft.js), with a map excerpt of the place and one per theme. Made on the
 * server with PDFKit; the text is set in Manrope and Fraunces, like the app.
 *
 *   renderReportPdf({ place, report, dossier, dossierError, maps, url }) → Promise<Buffer>
 *     place    { lat, lon, name }
 *     report   the answer of /api/landschaft/bericht
 *     dossier  the climate dossier (/api/klima) or null
 *     maps     { overview, klima, wasser, wald, boden }: { png, caption } or null each
 */

const PDFDocument = require('pdfkit');

const font = (pkg, file) => require.resolve(`${pkg}/files/${file}`);
const FONTS = {
  body: font('@fontsource/manrope', 'manrope-latin-400-normal.woff'),
  bold: font('@fontsource/manrope', 'manrope-latin-700-normal.woff'),
  display: font('@fontsource/fraunces', 'fraunces-latin-600-normal.woff'),
};
const C = { text: '#1b2a1f', muted: '#5f6b5c', border: '#d9d2bd', accent: '#2f5d34', box: '#f6f3ea' };
const W = 495; // A4 595 pt less 50 pt margins
const LEFT = 50;
const BOTTOM = 842 - 60; // above the footer

const nf = (d) => new Intl.NumberFormat('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (v, d = 0) => (Number.isFinite(v) ? nf(d).format(v) : '–');
const signed = (v, d = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmt(Math.abs(v), d)}` : '–');
// Characters Manrope lacks.
const clean = (s) => String(s ?? '').replace(/≈/g, 'ca. ').replace(/→/g, '>').replace(/≥/g, '>=').replace(/≤/g, '<=');

function renderReportPdf({ place, report: r, dossier: d, dossierError = null, maps = {}, url = '', date = new Date() }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: LEFT, right: 50 }, bufferPages: true, info: {
    Title: `Landschaft im Wandel – ${place.name || `${fmt(place.lat, 4)}° N, ${fmt(place.lon, 4)}° O`}`,
    Author: 'MyForrest', Subject: 'Bericht für einen Ort: Klima, Gletscher und Wasser, Wald, Landwirtschaft und Boden',
  } });
  doc.registerFont('body', FONTS.body);
  doc.registerFont('bold', FONTS.bold);
  doc.registerFont('display', FONTS.display);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const room = (h) => { if (doc.y + h > BOTTOM) doc.addPage(); };
  const para = (text, { color = C.text, size = 10, bold = false, gap = 6 } = {}) => {
    if (!text) return;
    doc.font(bold ? 'bold' : 'body').fontSize(size).fillColor(color);
    room(doc.heightOfString(clean(text), { width: W }) + gap);
    doc.text(clean(text), LEFT, doc.y, { width: W, lineGap: 1.5 });
    doc.moveDown(gap / 12);
  };
  const muted = (text) => para(text, { color: C.muted, size: 9 });
  const heading = (text) => {
    room(70);
    doc.moveDown(0.6);
    doc.moveTo(LEFT, doc.y).lineTo(LEFT + W, doc.y).lineWidth(0.6).strokeColor(C.border).stroke();
    doc.moveDown(0.5);
    doc.font('display').fontSize(15).fillColor(C.text).text(clean(text), LEFT, doc.y, { width: W });
    doc.moveDown(0.3);
  };
  // A subheading keeps a few lines of what follows on its page.
  const subheading = (text) => { room(90); para(text, { bold: true, size: 10, gap: 3 }); };

  /** A table with a header row; `widths` in parts of the page width. */
  function table(head, rows, widths) {
    if (!rows.length) return;
    const cols = widths.map((w) => w * W);
    const rowHeight = (cells, f) => Math.max(...cells.map((c, i) => doc.font(f).fontSize(8.5).heightOfString(clean(c), { width: cols[i] - 8 }))) + 7;
    const draw = (cells, f, color) => {
      const h = rowHeight(cells, f);
      if (doc.y + h > BOTTOM) { doc.addPage(); if (f !== 'bold') draw(head, 'bold', C.muted); }
      const y = doc.y;
      let x = LEFT;
      cells.forEach((c, i) => {
        doc.font(f).fontSize(8.5).fillColor(color).text(clean(c), x + 4, y + 3.5, { width: cols[i] - 8 });
        x += cols[i];
      });
      doc.moveTo(LEFT, y + h).lineTo(LEFT + W, y + h).lineWidth(0.5).strokeColor(C.border).stroke();
      doc.y = y + h;
    };
    room(40);
    draw(head, 'bold', C.muted);
    for (const row of rows) draw(row, 'body', C.text);
    doc.x = LEFT;
    doc.moveDown(0.6);
  }

  /** What a map layer says at the place: title, then key and value per line. */
  function item(it) {
    const lines = it.attributes.map(([k, v]) => `${k}: ${v}`);
    const text = clean(lines.join('\n'));
    doc.font('body').fontSize(8.5);
    const h = 18 + doc.heightOfString(text, { width: W - 20 });
    room(h + 6);
    const y = doc.y;
    doc.roundedRect(LEFT, y, W, h, 4).fillAndStroke(C.box, C.border);
    doc.font('bold').fontSize(9).fillColor(C.text).text(clean(it.title), LEFT + 10, y + 6, { width: W - 20 });
    doc.font('body').fontSize(8.5).fillColor(C.muted).text(text, LEFT + 10, doc.y + 1, { width: W - 20 });
    doc.y = y + h + 6;
    doc.x = LEFT;
  }

  function map(m, height) {
    if (!m?.png) return;
    room(height + 22);
    const y = doc.y;
    doc.image(m.png, LEFT, y, { fit: [W, height], align: 'center' });
    doc.rect(LEFT, y, W, height).lineWidth(0.5).strokeColor(C.border).stroke();
    doc.y = y + height + 3;
    doc.font('body').fontSize(7.5).fillColor(C.muted).text(clean(m.caption), LEFT, doc.y, { width: W });
    doc.moveDown(0.6);
  }

  const change = (key) => d?.climate?.changes?.find((c) => c.key === key);
  function changeTable(keys) {
    const rows = keys.map(change).filter((c) => c && Number.isFinite(c.delta));
    if (!rows.length) return;
    const digits = (c) => d.indicators?.[c.key]?.digits ?? 0;
    const p = d.climate.periods;
    table(['Kennzahl', p.ref.join('–'), p.recent.join('–'), 'Änderung'], rows.map((c) => [
      c.label, `${fmt(c.ref, digits(c))} ${c.unit}`, `${fmt(c.recent, digits(c))} ${c.unit}`,
      `${signed(c.delta, digits(c))}${Number.isFinite(c.percent) ? ` (${signed(c.percent, 0)} %)` : ''}`,
    ]), [0.4, 0.2, 0.2, 0.2]);
  }
  const theme = (id) => r.themes.find((t) => t.id === id) || { items: [], layers: [] };

  /* ---------- Head ---------- */
  doc.font('bold').fontSize(8).fillColor(C.muted).text('BERICHT · LANDSCHAFT IM WANDEL', LEFT, 50, { characterSpacing: 1 });
  doc.moveDown(0.4);
  const elevation = Number.isFinite(d?.centre?.elevation) ? ` · ${fmt(d.centre.elevation)} m ü. M.` : '';
  doc.font('display').fontSize(22).fillColor(C.text).text(clean(`${place.name || `${fmt(place.lat, 4)}° N, ${fmt(place.lon, 4)}° O`}${elevation}`), { width: W });
  doc.moveDown(0.2);
  muted(`${place.name ? `${fmt(place.lat, 4)}° N, ${fmt(place.lon, 4)}° O · ` : ''}Stand ${date.toLocaleDateString('de-CH', { day: 'numeric', month: 'long', year: 'numeric' })} · MyForrest`);
  para('Was amtliche Karten, Messreihen, Klimaszenarien, Gletscherinventare und die Beobachtungen von MyForrest an diesem Ort sagen.', { size: 9.5, color: C.muted });
  doc.moveDown(0.3);
  map(maps.overview, 210);

  /* ---------- Klima ---------- */
  heading('Klima');
  const c = d?.climate;
  if (c) {
    para(`Die Jahre ${c.periods.recent.join('–')} waren am Ort im Mittel ${signed(c.warming)} °C wärmer als ${c.periods.ref.join('–')}; der Trend seit ${c.first} beträgt ${signed(c.trendPerDecade, 2)} °C pro Jahrzehnt.${d.station?.name ? ` Nächste homogene Messreihe: ${d.station.name}.` : ''}`);
    changeTable(['tmean', 'summerT', 'hotDays', 'tropicalNights', 'frostDays', 'snowDays', 'summerP', 'dryRun']);
    if (d.levels?.length) {
      subheading('Szenarien: was +1,5, +2 und +3 °C weltweit hier bedeuten');
      const get = (l, k) => l.indicators.find((i) => i.key === k);
      const cell = (l, k, dd = 0) => { const i = get(l, k); return i && Number.isFinite(i.value) ? `von ${fmt(i.normal, dd)} auf ${fmt(i.value, dd)} ${i.unit}` : '–'; };
      table(['Globale Erwärmung', 'Jahresmittel', 'Hitzetage', 'Sommerregen', 'Höhenstufen'], d.levels.map((l) => [
        `${l.title}\n${l.when || ''}`, cell(l, 'tmean', 1), cell(l, 'hotDays'), cell(l, 'summerP'), Number.isFinite(l.shiftM) ? `${fmt(l.shiftM)} m höher` : '–',
      ]), [0.32, 0.18, 0.16, 0.18, 0.16]);
    }
  } else {
    muted(dossierError ? `Klimadaten nicht verfügbar: ${dossierError}` : 'Keine Klimadaten für diesen Ort.');
  }
  theme('klima').items.forEach(item);
  map(maps.klima, 170);

  /* ---------- Gletscher und Wasser ---------- */
  heading('Gletscher und Wasser');
  const g = r.glacier;
  const water = theme('wasser');
  if (g) {
    subheading(g.name || 'Gletscher in der Nähe');
    para(g.distanceM === 0 ? `Der Ort liegt auf dem Eis des Inventars ${g.latestYear}.` : Number.isFinite(g.distanceM) ? `Abstand zum Eis des Inventars ${g.latestYear}: ${fmt(g.distanceM)} m.` : '');
    if (g.history?.length) para(`Eis am Ort: ${g.history.map((h) => `${h.year ?? '?'} ${h.ice ? 'ja' : 'nein'}`).join(' · ')}`);
    if (g.areas?.length) {
      const first = g.areas[0].km2;
      table(['Inventar', 'Fläche', `seit ${g.areas[0].year}`], g.areas.map((a, i) => [
        String(a.year), `${fmt(a.km2, a.km2 < 10 ? 2 : 1)} km²`, i && first > 0 ? `${signed(((a.km2 - first) / first) * 100, 0)} %` : '–',
      ]), [0.3, 0.35, 0.35]);
    }
    if (g.length) para(`Längenänderung der Zunge (GLAMOS) ${g.length.firstYear}–${g.length.lastYear}: ${signed(g.length.total, 0)} m${Number.isFinite(g.length.recentRate) ? `, zuletzt ${signed(g.length.recentRate, 1)} m pro Jahr` : ''}.`);
  }
  changeTable(['snowDays', 'summerP', 'winterP', 'dryRun']);
  water.items.forEach(item);
  if (!g && !water.items.length && !change('snowDays')) muted('Für diesen Ort sagen die Gletscherinventare und Wasserkarten nichts.');
  map(maps.wasser, 170);

  /* ---------- Wald ---------- */
  heading('Wald');
  const forest = theme('wald');
  forest.items.forEach(item);
  for (const f of d?.forest || []) {
    subheading(f.title);
    para(f.text, { size: 9.5 });
    if (f.levels) muted(Object.entries(f.levels).map(([k, v]) => `${k.replace('GWL', '+')} °C: ${v}`).join(' · '));
  }
  if (d?.species?.length) para(`Baumarten der Spots in der Region: ${d.species.map((s) => s.name || s.scientificName).join(', ')}.`);
  if (!forest.items.length && !d?.forest?.length) muted('Für diesen Ort sagen die Waldkarten nichts.');
  map(maps.wald, 170);

  /* ---------- Landwirtschaft und Boden ---------- */
  heading('Landwirtschaft und Boden');
  const soil = theme('boden');
  soil.items.forEach(item);
  changeTable(['growingDays', 'summerP', 'dryRun', 'hotDays']);
  if (!soil.items.length) muted('Für diesen Ort sagen die Karten zu Bodennutzung und Landwirtschaft nichts.');
  map(maps.boden, 170);

  /* ---------- Beobachtungen ---------- */
  const o = r.observed;
  heading(`Was MyForrest im Umkreis von ${o.radiusKm} km sah`);
  if (o.photos) {
    para(`${fmt(o.photos)} Fotos an ${fmt(o.spots)} Spots${o.firstYear ? `, ${o.firstYear === o.lastYear ? o.firstYear : `${o.firstYear}–${o.lastYear}`}` : ''}.`);
    if (o.tags.length) para(`Befunde: ${o.tags.map((t) => `${t.label || t.tag} (${t.spots} Spot${t.spots === 1 ? '' : 's'})`).join(', ')}.`);
    if (o.neophytes.length) para(`Neophyten: ${o.neophytes.map((n) => `${n.common || n.name} (${n.n})`).join(', ')}.`);
  } else {
    muted('Noch keine Fotos in der Nähe. Ein Foto beitragen macht den Ort zur eigenen Messreihe.');
  }

  /* ---------- Quellen ---------- */
  heading('Quellen');
  const used = r.themes.flatMap((t) => t.layers).filter((l, i, a) => a.findIndex((x) => x.name === l.name) === i);
  const sources = [
    ...(d?.sources ? Object.values(d.sources).filter(Boolean) : []),
    ...(d?.levels?.length ? ['Klimaszenarien CH2025 (MeteoSchweiz, ETH Zürich, NCCS) und IPCC AR6, wo am Ort geladen; sonst Klimamodelle, skaliert mit der globalen Erwärmung'] : []),
    ...used.map((l) => `${l.title} (${l.name}), ${l.attribution || 'geo.admin.ch'}`),
    ...(r.glacier ? ['Gletscherinventare und GLAMOS (Glacier Monitoring Switzerland)'] : []),
    'Karten: swisstopo und geo.admin.ch (WMS)',
    'Fotos und Funde von MyForrest (CC BY-SA 4.0 oder die Lizenz des Fotos)',
  ];
  for (const s of sources) para(`– ${s}`, { size: 8.5, color: C.muted, gap: 2 });
  if (url) {
    doc.moveDown(0.4);
    para(`Online mit Karten durch die Zeit: ${url}`, { size: 8.5, color: C.accent });
  }

  /* ---------- Footer on every page ---------- */
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i += 1) {
    doc.switchToPage(i);
    const label = clean(`MyForrest · Landschaft im Wandel · ${place.name || `${fmt(place.lat, 4)}° N, ${fmt(place.lon, 4)}° O`}`);
    // Below the bottom margin: without lifting it PDFKit would start a new page.
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('body').fontSize(7.5).fillColor(C.muted);
    doc.text(label, LEFT, 842 - 36, { width: W - 80, lineBreak: false });
    doc.text(`Seite ${i - start + 1} von ${count}`, LEFT + W - 80, 842 - 36, { width: 80, align: 'right', lineBreak: false });
    doc.page.margins.bottom = margin;
  }
  doc.end();
  return done;
}

module.exports = { renderReportPdf, clean };
