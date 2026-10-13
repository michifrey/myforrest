'use strict';

/**
 * Map services of QGIS Server under MyForrest's own address: /ows/ is passed on to OWS_UPSTREAM (the
 * QGIS Server container's HTTP port), as nginx does in the Docker Compose setup. Used where MyForrest is the
 * only public service, e.g. on Render with QGIS Server as a private service (render.yaml).
 *
 *   GET|POST /ows/?SERVICE=WMS&REQUEST=GetCapabilities …   WMS, WMTS, WFS of the QGIS project
 *
 * QGIS Server is told the public address (X-Qgis-Service-Url, X-Forwarded-*), so the links in its
 * capabilities point here and not to the internal host. Answers carry CORS for geoportals.
 */

const express = require('express');
const { Readable } = require('node:stream');

const PASS_HEADERS = ['content-type', 'cache-control', 'content-disposition', 'last-modified', 'etag', 'expires'];

module.exports = function registerOwsProxy(app, { upstream, publicUrl = process.env.PUBLIC_URL, fetchImpl = fetch, timeoutMs = 60000 }) {
  if (!upstream) return;
  const base = String(upstream).replace(/\/+$/, '');
  const raw = express.raw({ type: () => true, limit: '10mb' });

  app.all(/^\/ows(\/.*)?$/, raw, async (req, res) => {
    if (!['GET', 'HEAD', 'POST', 'OPTIONS'].includes(req.method)) return res.status(405).json({ error: 'Nur GET und POST' });
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS').set('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).end();
    }
    const host = req.get('host');
    const own = (publicUrl ? String(publicUrl).replace(/\/+$/, '') : `${req.protocol}://${host}`);
    const path = req.originalUrl.startsWith('/ows/') ? req.originalUrl : req.originalUrl.replace(/^\/ows/, '/ows/');
    const headers = {
      'x-forwarded-host': new URL(own).host,
      'x-forwarded-proto': new URL(own).protocol.replace(':', ''),
      'x-forwarded-port': new URL(own).port || (own.startsWith('https') ? '443' : '80'),
      'x-qgis-service-url': `${own}/ows/`,
    };
    for (const h of ['accept', 'accept-language', 'content-type']) if (req.get(h)) headers[h] = req.get(h);
    try {
      const r = await fetchImpl(`${base}${path}`, {
        method: req.method,
        headers,
        body: req.method === 'POST' && Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      res.status(r.status);
      for (const h of PASS_HEADERS) if (r.headers.get(h)) res.set(h, r.headers.get(h));
      if (req.method === 'HEAD' || !r.body) return res.end();
      Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
    } catch (err) {
      res.status(502).json({ error: `Kartenserver nicht erreichbar (${err.message})` });
    }
  });
};
