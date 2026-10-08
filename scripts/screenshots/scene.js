'use strict';
// Procedural demo forest photos (SVG rendered with sharp). One layout per spot, one state per visit.
const sharp = require('sharp');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 1600;
const H = 1200;
const HORIZON = 640;

/** Fixed layout of a spot: trees, path, ground features. */
function layout(seed, { kind = 'beech', path = true, trees = 9 } = {}) {
  const r = rng(seed);
  const list = [];
  for (let i = 0; i < trees; i++) {
    const depth = r(); // 0 near, 1 far
    const x = 60 + (i + r() * 0.8) * ((W - 120) / trees);
    const conifer = kind === 'spruce' ? r() < 0.85 : kind === 'mixed' ? r() < 0.45 : r() < 0.12;
    list.push({ i, x, depth, conifer, w: (1 - depth) * 46 + 22, base: HORIZON + 60 + (1 - depth) * 380, seed: Math.floor(r() * 1e9) });
  }
  list.sort((a, b) => b.depth - a.depth);
  const background = [];
  for (let i = 0; i < 70; i++) background.push({ x: r() * W, y: HORIZON - 40 - r() * 160, rx: 50 + r() * 70, ry: 120 + r() * 120, c: r() });
  const grass = [];
  for (let i = 0; i < 900; i++) {
    const y = HORIZON + 40 + Math.pow(r(), 0.8) * (H - HORIZON - 40);
    grass.push({ x: r() * W, y, s: 1 + ((y - HORIZON) / (H - HORIZON)) * 5, c: r() });
  }
  const stones = [];
  for (let i = 0; i < 40; i++) stones.push({ x: r() * W, y: HORIZON + 80 + r() * 480, s: 4 + r() * 14, c: r() });
  return { seed, kind, path, trees: list, background, grass, stones, pathX: 650 + r() * 300 };
}

const SEASONS = {
  summer: { sky: ['#cfe3ec', '#eef3e6'], crown: ['#3f7a35', '#5c9a45', '#2e6230', '#78b056'], ground: ['#5f7d3a', '#7c8d48'], far: ['#7fa07a', '#9cb795'] },
  spring: { sky: ['#d5e6ef', '#f2f4e8'], crown: ['#78b84f', '#9ccd63', '#5c9e43', '#b5dc7c'], ground: ['#6e8b3e', '#8fa152'], far: ['#9cbf8a', '#b7cfa3'] },
  autumn: { sky: ['#d9dfe2', '#f1ecdf'], crown: ['#c98a2a', '#e0a83a', '#a6621f', '#8a9a3b'], ground: ['#7a6a3a', '#8f7a45'], far: ['#a8a07a', '#c2b48c'] },
  earlyautumn: { sky: ['#d3e2ea', '#f0efe2'], crown: ['#a7a43a', '#d1a23c', '#6f8f35', '#c47f2a'], ground: ['#6d7a3b', '#86884a'], far: ['#94a37c', '#b4b892'] },
  winter: { sky: ['#dfe4e8', '#f3f3f0'], crown: null, ground: ['#7d7a63', '#958d70'], far: ['#a9ada4', '#c3c5bd'] },
};

function crownBlob(r, cx, cy, size, colors, n = 26, opacity = 1) {
  let s = '';
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * size;
    const rr = size * (0.22 + r() * 0.22);
    s += `<circle cx="${(cx + Math.cos(a) * d * 1.25).toFixed(1)}" cy="${(cy + Math.sin(a) * d * 0.8).toFixed(1)}" r="${rr.toFixed(1)}" fill="${colors[Math.floor(r() * colors.length)]}" opacity="${opacity}"/>`;
  }
  return s;
}

function conifer(r, x, base, height, w, color, dark) {
  let s = `<rect x="${x - w * 0.18}" y="${base - height}" width="${w * 0.36}" height="${height}" fill="#4a3a2c"/>`;
  const tiers = 9;
  for (let k = 0; k < tiers; k++) {
    const t = k / tiers;
    const y = base - height * 0.25 - t * height * 0.78;
    const half = w * (2.6 - t * 2.2) * (0.9 + r() * 0.2);
    s += `<polygon points="${x - half},${y} ${x + half},${y} ${x},${y - height * 0.2}" fill="${k % 2 ? color : dark}"/>`;
  }
  return s;
}

/** Bark: trunk with stripes and spots so the aligner finds features. */
function trunk(r, x, base, top, w, light) {
  let s = `<rect x="${(x - w / 2).toFixed(1)}" y="${top}" width="${w.toFixed(1)}" height="${base - top}" fill="${light ? '#9b9a92' : '#6f6a62'}"/>`;
  s += `<rect x="${(x + w * 0.15).toFixed(1)}" y="${top}" width="${(w * 0.35).toFixed(1)}" height="${base - top}" fill="#000" opacity=".18"/>`;
  for (let k = 0; k < (base - top) / 14; k++) {
    const y = top + r() * (base - top);
    s += `<rect x="${(x - w / 2 + r() * w * 0.8).toFixed(1)}" y="${y.toFixed(1)}" width="${(2 + r() * w * 0.25).toFixed(1)}" height="${(2 + r() * 6).toFixed(1)}" fill="${r() < 0.5 ? '#3d3a35' : '#c9c6bb'}" opacity=".8"/>`;
  }
  return s;
}

/** Lying stem from a fallen tree, with root plate. */
function log(r, x, y, len, w, angle, rootPlate) {
  let s = `<g transform="rotate(${angle} ${x} ${y})">`;
  s += `<rect x="${x}" y="${y - w / 2}" width="${len}" height="${w}" rx="${w / 2}" fill="#7b766c"/>`;
  s += `<rect x="${x}" y="${y - w / 2}" width="${len}" height="${w * 0.35}" rx="${w / 3}" fill="#a8a397"/>`;
  for (let k = 0; k < len / 10; k++) s += `<rect x="${x + r() * len}" y="${y - w / 2 + r() * w}" width="${3 + r() * 8}" height="${2 + r() * 3}" fill="${r() < 0.5 ? '#45403a' : '#cfcabd'}"/>`;
  s += '</g>';
  if (rootPlate) s += `<ellipse cx="${x}" cy="${y - w * 0.6}" rx="${w * 1.3}" ry="${w * 1.9}" fill="#5a4630"/><ellipse cx="${x - 4}" cy="${y - w * 0.6}" rx="${w}" ry="${w * 1.5}" fill="#6e5638"/>`;
  return s;
}

/**
 * state: { season, fallen: [tree indices], brown: [indices], grey: [indices] (dead spruce),
 *          regrowth: 0..1, balsam: 0..1 (Impatiens patch), goldenrod: 0..1, light: -1..1, jitter seed }
 */
function svg(lay, state) {
  const season = SEASONS[state.season || 'summer'];
  const r = rng(lay.seed);
  const j = rng(state.jitter || 1);
  const dx = (j() - 0.5) * 70;
  const dy = (j() - 0.5) * 40;
  const sc = 1 + (j() - 0.3) * 0.08;
  const rot = (j() - 0.5) * 2.2;
  const fallen = new Set(state.fallen || []);
  const brown = new Set(state.brown || []);
  const grey = new Set(state.grey || []);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${season.sky[0]}"/><stop offset="1" stop-color="${season.sky[1]}"/></linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${season.ground[1]}"/><stop offset="1" stop-color="${season.ground[0]}"/></linearGradient>
    <filter id="blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="soft"><feGaussianBlur stdDeviation="1.2"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="#5b6b3e"/>
  <g transform="translate(${W / 2 + dx} ${H / 2 + dy}) rotate(${rot}) scale(${sc}) translate(${-W / 2} ${-H / 2})">
  <rect x="-200" y="-200" width="${W + 400}" height="${HORIZON + 260}" fill="url(#sky)"/>
  <g filter="url(#blur)">`;
  for (const b of lay.background) s += `<ellipse cx="${b.x}" cy="${b.y + 120}" rx="${b.rx}" ry="${b.ry}" fill="${season.far[b.c < 0.5 ? 0 : 1]}"/>`;
  s += `</g><rect x="-200" y="${HORIZON}" width="${W + 400}" height="${H - HORIZON + 200}" fill="url(#ground)"/>`;
  if (lay.path) {
    const px = lay.pathX;
    s += `<polygon points="${px - 40},${HORIZON + 10} ${px + 40},${HORIZON + 10} ${px + 380},${H + 50} ${px - 300},${H + 50}" fill="#b9a681"/>`;
    s += `<polygon points="${px - 20},${HORIZON + 10} ${px + 20},${HORIZON + 10} ${px + 150},${H + 50} ${px - 90},${H + 50}" fill="#c9b893" opacity=".6"/>`;
  }
  for (const g of lay.grass) s += `<circle cx="${g.x.toFixed(1)}" cy="${g.y.toFixed(1)}" r="${g.s.toFixed(1)}" fill="${g.c < 0.4 ? '#45612c' : g.c < 0.8 ? '#86964c' : '#a4a364'}"/>`;
  for (const st of lay.stones) s += `<ellipse cx="${st.x}" cy="${st.y}" rx="${st.s}" ry="${st.s * 0.6}" fill="${st.c < 0.5 ? '#8c8778' : '#6a665b'}"/>`;

  // Goldenrod (Solidago) in the light gap
  if (state.goldenrod) {
    const g = rng(lay.seed + 7);
    const n = Math.floor(state.goldenrod * 260);
    for (let k = 0; k < n; k++) {
      const x = 380 + g() * 900 * (0.4 + state.goldenrod * 0.6);
      const y = HORIZON + 140 + g() * 300;
      const h = 30 + g() * 50;
      s += `<rect x="${x}" y="${y - h}" width="3" height="${h}" fill="#5f7d30"/><ellipse cx="${x + 1}" cy="${y - h}" rx="7" ry="14" fill="${g() < 0.5 ? '#e3c02c' : '#d2a91f'}"/>`;
    }
  }
  // Himalayan balsam patch (pink flowers) spreading from the left
  if (state.balsam) {
    const g = rng(lay.seed + 11);
    const n = Math.floor(state.balsam * 420);
    for (let k = 0; k < n; k++) {
      const x = -40 + g() * (200 + state.balsam * 1300);
      const y = HORIZON + 120 + g() * 420;
      const h = 50 + g() * 90 * (0.5 + (y - HORIZON) / 600);
      s += `<rect x="${x}" y="${y - h}" width="4" height="${h}" fill="#6c8f3a"/>`;
      s += `<ellipse cx="${x - 8}" cy="${y - h * 0.6}" rx="14" ry="5" fill="#5c8a33"/><ellipse cx="${x + 10}" cy="${y - h * 0.75}" rx="14" ry="5" fill="#4f7b2c"/>`;
      s += `<circle cx="${x + 2}" cy="${y - h}" r="${6 + g() * 4}" fill="${g() < 0.5 ? '#d65aa0' : '#e889bf'}"/>`;
    }
  }

  // Trees (far to near)
  for (const t of lay.trees) {
    const tr = rng(t.seed);
    const height = (t.base - 40) * (0.95 + tr() * 0.1);
    if (fallen.has(t.i)) {
      // stump + lying stem
      s += `<rect x="${t.x - t.w / 2}" y="${t.base - t.w * 0.9}" width="${t.w}" height="${t.w * 0.9}" fill="#7a6a55"/>`;
      s += log(tr, t.x - t.w * 0.2, t.base + 10 + t.w * 0.5, 520 + t.w * 4, t.w * 0.9, t.i % 2 ? -8 : 186, true);
      continue;
    }
    if (t.conifer) {
      let color = '#2f5a35';
      let dark = '#23452a';
      if (brown.has(t.i)) [color, dark] = ['#a5642c', '#7e4a22'];
      if (grey.has(t.i)) {
        s += trunk(tr, t.x, t.base, 20, t.w * 0.55, true);
        for (let k = 0; k < 14; k++) {
          const y = t.base - height * 0.3 - (k / 14) * height * 0.7;
          s += `<line x1="${t.x}" y1="${y}" x2="${t.x + (k % 2 ? 1 : -1) * (40 + tr() * 50)}" y2="${y + 18}" stroke="#8d877c" stroke-width="3"/>`;
        }
        continue;
      }
      if (state.season === 'winter' && false) color = '#2a4f30';
      s += conifer(tr, t.x, t.base, height, t.w, color, dark);
    } else {
      s += trunk(tr, t.x, t.base, -40, t.w, true);
    }
  }
  // Deciduous canopy over everything except gaps
  if (season.crown) {
    for (const t of lay.trees) {
      if (t.conifer || fallen.has(t.i)) continue;
      const tr = rng(t.seed + 3);
      s += crownBlob(tr, t.x, 70 + tr() * 90, 150 + t.w * 1.4, season.crown, 46);
    }
  } else {
    for (const t of lay.trees) {
      if (t.conifer || fallen.has(t.i)) continue;
      const tr = rng(t.seed + 3);
      for (let k = 0; k < 12; k++) s += `<line x1="${t.x}" y1="${180 + k * 25}" x2="${t.x + (tr() - 0.5) * 260}" y2="${80 + k * 18}" stroke="#77736a" stroke-width="${3 - k * 0.15}"/>`;
    }
  }
  // Young trees in gaps
  if (state.regrowth) {
    const g = rng(lay.seed + 5);
    const n = Math.floor(state.regrowth * 26);
    for (let k = 0; k < n; k++) {
      const x = 300 + g() * 1000;
      const base = HORIZON + 200 + g() * 330;
      const h = (40 + g() * 90) * (0.4 + state.regrowth);
      if (g() < 0.5) s += conifer(g, x, base, h, 8, '#3f7a3a', '#2f6230');
      else s += `<rect x="${x - 2}" y="${base - h}" width="4" height="${h}" fill="#6a5a40"/>` + crownBlob(g, x, base - h, h * 0.35, ['#7cb455', '#5f9a44', '#9ccd63'], 10);
    }
  }
  s += '</g>';
  const light = state.light || 0;
  if (light) s += `<rect width="${W}" height="${H}" fill="${light > 0 ? '#fff6dc' : '#1e2a2a'}" opacity="${Math.abs(light) * 0.22}"/>`;
  s += '</svg>';
  return s;
}

async function render(lay, state, file) {
  await sharp(Buffer.from(svg(lay, state))).jpeg({ quality: 86 }).toFile(file);
}

/** Close-up of a neophyte for findings along the stream. */
function closeupSvg(seed, species) {
  const r = rng(seed);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect width="1200" height="1600" fill="#4e6b34"/>`;
  for (let k = 0; k < 400; k++) s += `<circle cx="${r() * 1200}" cy="${r() * 1600}" r="${10 + r() * 40}" fill="${['#3d5a2a', '#5f7f3c', '#6f8f45', '#2f4a22'][Math.floor(r() * 4)]}" opacity=".8"/>`;
  for (let k = 0; k < 18; k++) {
    const x = r() * 1200;
    const y = 300 + r() * 1200;
    if (species === 'balsam') {
      s += `<rect x="${x}" y="${y}" width="10" height="600" fill="#7a9a3f"/><ellipse cx="${x + 5}" cy="${y}" rx="${30 + r() * 20}" ry="${22 + r() * 10}" fill="${r() < 0.5 ? '#d65aa0' : '#e889bf'}"/><ellipse cx="${x + 5}" cy="${y + 8}" rx="14" ry="10" fill="#f4c6df"/>`;
    } else {
      s += `<rect x="${x}" y="${y}" width="8" height="600" fill="#6a8a3a"/>`;
      for (let m = 0; m < 30; m++) s += `<circle cx="${x + (r() - 0.5) * 120}" cy="${y - r() * 200}" r="${6 + r() * 6}" fill="${r() < 0.5 ? '#e8c42c' : '#d6a91f'}"/>`;
    }
  }
  return s + '</svg>';
}

async function renderCloseup(seed, species, file) {
  await sharp(Buffer.from(closeupSvg(seed, species))).jpeg({ quality: 84 }).toFile(file);
}

module.exports = { layout, svg, render, renderCloseup };
