'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { neophyteName } = require('./neophytes');

const ENDPOINT = 'https://my-api.plantnet.org/v2/identify/all';
const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

/**
 * Identifies plant species on a photo using the Pl@ntNet API
 * (free API key: https://my.plantnet.org). Returns the top candidates,
 * each flagged when it is a known neophyte.
 */
async function identifyPlant(filePath, { apiKey, organ = 'auto', fetchImpl = fetch, limit = 5 }) {
  const form = new FormData();
  const data = await fs.readFile(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] || 'image/jpeg';
  form.append('images', new Blob([data], { type }), path.basename(filePath));
  form.append('organs', organ);

  const url = `${ENDPOINT}?lang=de&nb-results=${limit}&api-key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url, { method: 'POST', body: form });
  if (res.status === 404) return []; // Pl@ntNet answers 404 when no plant was recognised.
  if (!res.ok) throw new Error(`Pl@ntNet antwortete mit HTTP ${res.status}`);

  const body = await res.json();
  return (body.results || []).slice(0, limit).map((r) => {
    const scientific = r.species?.scientificNameWithoutAuthor || '';
    return {
      scientificName: scientific,
      commonName: r.species?.commonNames?.[0] || null,
      score: Math.round((r.score || 0) * 1000) / 1000,
      neophyte: neophyteName(scientific),
    };
  });
}

module.exports = { identifyPlant };
