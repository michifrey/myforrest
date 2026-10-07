'use strict';

/*
 * Vegetation density from a single photo.
 *
 * Every pixel is classified by its chromatic coordinates (r, g, b divided by
 * their sum), which do not change when the exposure does:
 *  - vegetation: excess green ExG = 2g − r − b above a small threshold
 *    (green leaves and needles; trunks, soil, sky and grey stone stay below);
 *  - sky: bright and either blue (blue chroma above green) or nearly white
 *    (overcast). Brightness is measured after scaling the photo so that its
 *    brightest 1 % reach 1, so an under- or overexposed photo reads the same.
 * From that:
 *  - greenFraction: share of vegetation pixels in the whole view;
 *  - gcc: mean green chromatic coordinate g (phenocam standard, sensitive to
 *    leaf-out and autumn colouring);
 *  - canopyCover: share of the upper half of the view that is not sky
 *    (foliage, branches, trunks), i.e. how closed the canopy is;
 *  - gapFraction: share of sky in the whole view (openings in the canopy).
 *
 * When the photo is aligned, the metrics are computed in the spot's common
 * frame (the view of its first aligned photo), so the numbers of all photos
 * of a spot describe the same scene section. Heuristics: a photo with a
 * bright, colourless wall or snow will read part of it as sky.
 */

const sharp = require('sharp');
const { apply, invert } = require('./homography');

const FRAME_WIDTH = 240;
const EXG_VEG = 0.05;

async function loadRGB(file, size) {
  const { data, info } = await sharp(file)
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Samples the photo into a grid of `width` × `height` pixels of the frame,
 * where `hFrameToPhoto` maps normalised frame coordinates into the photo.
 * Returns interleaved RGB (0–255) and a validity mask.
 */
function sampleFrame(img, hFrameToPhoto, width, height) {
  const n = width * height;
  const rgb = new Uint8Array(n * 3);
  const valid = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [u, v] = hFrameToPhoto ? apply(hFrameToPhoto, (x + 0.5) / width, (y + 0.5) / height)
        : [(x + 0.5) / width, (y + 0.5) / height];
      const px = Math.floor(u * img.width);
      const py = Math.floor(v * img.height);
      if (!(px >= 0 && py >= 0 && px < img.width && py < img.height)) continue;
      const i = y * width + x;
      const j = (py * img.width + px) * 3;
      rgb[i * 3] = img.data[j];
      rgb[i * 3 + 1] = img.data[j + 1];
      rgb[i * 3 + 2] = img.data[j + 2];
      valid[i] = 1;
    }
  }
  return { rgb, valid, width, height };
}

const round3 = (v) => (v === null ? null : Math.round(v * 1000) / 1000);

/**
 * Vegetation metrics of an RGB grid (interleaved, 0–255) with validity mask.
 * Pure function; see the header comment for the definitions.
 */
function measure({ rgb, valid, width, height }) {
  const n = width * height;
  // Exposure normalisation: the 99th percentile of brightness becomes 1.
  const hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    hist[Math.round((rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2]) / 3)]++;
    count++;
  }
  if (!count) return null;
  let acc = 0;
  let p99 = 255;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= count * 0.01) { p99 = v; break; }
  }
  const gain = 1 / Math.max(p99, 20);

  let veg = 0; let sky = 0; let gccSum = 0;
  let upper = 0; let upperSky = 0;
  const half = height / 2;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const R = rgb[i * 3]; const G = rgb[i * 3 + 1]; const B = rgb[i * 3 + 2];
    const s = R + G + B;
    const lum = Math.min(1, (s / 3) * gain);
    const r = s ? R / s : 1 / 3; const g = s ? G / s : 1 / 3; const b = s ? B / s : 1 / 3;
    gccSum += g;
    const exg = 2 * g - r - b;
    const spread = (Math.max(R, G, B) - Math.min(R, G, B)) * gain;
    const isVeg = exg > EXG_VEG && G > R && G > B && lum > 0.04;
    const isSky = !isVeg && ((lum > 0.45 && b > 0.36 && b > g) || (lum > 0.75 && spread < 0.14));
    if (isVeg) veg++;
    if (isSky) sky++;
    if ((i - (i % width)) / width < half) {
      upper++;
      if (isSky) upperSky++;
    }
  }
  return {
    greenFraction: round3(veg / count),
    gcc: round3(gccSum / count),
    canopyCover: upper ? round3(1 - upperSky / upper) : null,
    gapFraction: round3(sky / count),
    coverage: round3(count / n),
  };
}

/**
 * Vegetation metrics of a photo. With `h` (the photo's homography into the
 * spot's common frame) and `frameAspect` (width / height of that frame) the
 * photo is first warped into the common frame.
 */
async function analyzeVegetation(file, { h = null, frameAspect = null } = {}) {
  const img = await loadRGB(file, 480);
  let grid;
  if (h && frameAspect) {
    const inv = invert(h);
    if (!inv) throw new Error('Ausrichtung nicht invertierbar');
    grid = sampleFrame(img, inv, FRAME_WIDTH, Math.max(1, Math.round(FRAME_WIDTH / frameAspect)));
  } else {
    const height = Math.max(1, Math.round(FRAME_WIDTH * (img.height / img.width)));
    grid = sampleFrame(img, null, FRAME_WIDTH, height);
  }
  const m = measure(grid);
  if (!m) throw new Error('Foto liegt ausserhalb des gemeinsamen Ausschnitts');
  return { ...m, frame: h && frameAspect ? 'spot' : 'photo' };
}

/** Width / height of an image file, after EXIF rotation. */
async function imageAspect(file) {
  const meta = await sharp(file).metadata();
  const rotated = (meta.orientation || 1) >= 5;
  return rotated ? meta.height / meta.width : meta.width / meta.height;
}

module.exports = { analyzeVegetation, measure, sampleFrame, imageAspect };
