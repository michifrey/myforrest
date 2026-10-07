'use strict';

// Renders the app icons (PWA manifest, apple-touch-icon) from the MyForrest
// logo. Run after changing the logo: `node scripts/generate-icons.js`.
// The PNGs are committed, so the server needs no image work at runtime.

const path = require('node:path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const BG = '#16301f'; // --l5, the night-forest green also used as theme-color
const FG = '#f4f0e4'; // --bg, linen
const GOLD = '#c9a24a'; // --gold

// The logo (rings + fir) from public/index.html, drawn on a 40 × 40 grid.
// `scale` shrinks it around the centre so maskable icons keep the 80 % safe zone.
function svg({ rounded, scale }) {
  const t = 20 - 20 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
  <rect width="40" height="40" rx="${rounded ? 8 : 0}" fill="${BG}"/>
  <g transform="translate(${t} ${t}) scale(${scale})">
    <circle cx="20" cy="20" r="18.5" fill="none" stroke="${GOLD}" stroke-width="1" opacity=".55"/>
    <circle cx="20" cy="20" r="14" fill="none" stroke="${GOLD}" stroke-width="1" opacity=".8"/>
    <path d="M20 7 13 18h4l-5 7h6v6h4v-6h6l-5-7h4z" fill="${FG}"/>
  </g>
</svg>`;
}

const ICONS = [
  { file: 'icon-192.png', size: 192, rounded: true, scale: 0.9 },
  { file: 'icon-512.png', size: 512, rounded: true, scale: 0.9 },
  { file: 'maskable-192.png', size: 192, rounded: false, scale: 0.7 },
  { file: 'maskable-512.png', size: 512, rounded: false, scale: 0.7 },
  { file: 'apple-touch-icon.png', size: 180, rounded: false, scale: 0.78 },
];

(async () => {
  for (const icon of ICONS) {
    await sharp(Buffer.from(svg(icon)), { density: (72 * icon.size) / 40 })
      .resize(icon.size, icon.size)
      .png({ compressionLevel: 9 })
      .toFile(path.join(OUT, icon.file));
    console.log(`${icon.file} (${icon.size} px)`);
  }
})();
