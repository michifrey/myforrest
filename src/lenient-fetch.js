'use strict';

/**
 * A minimal fetch for services that do not speak strict HTTP/1.1: BRouter's
 * own server ends header lines with a bare "\n", which Node's fetch (undici)
 * rejects. node:http accepts it with `insecureHTTPParser` (for this response
 * only). HTTPS goes through the normal fetch.
 *
 * lenientFetch(url, { signal, headers }) → Promise<{ ok, status, json(), text() }>
 */

const http = require('node:http');
const zlib = require('node:zlib');

function lenientFetch(url, { signal, headers = {} } = {}) {
  if (!String(url).startsWith('http:')) return fetch(url, { signal, headers });
  return new Promise((resolve, reject) => {
    const req = http.get(url, { insecureHTTPParser: true, signal, headers: { 'accept-encoding': 'gzip', ...headers } }, (res) => {
      const enc = String(res.headers['content-encoding'] || '');
      const body = enc.includes('gzip') ? res.pipe(zlib.createGunzip()) : res;
      const chunks = [];
      body.on('data', (c) => chunks.push(c));
      body.on('error', reject);
      body.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
  });
}

module.exports = { lenientFetch };
