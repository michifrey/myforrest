'use strict';

/*
 * Computes the light and shadow pictures of the map (shade.js) off the page,
 * so the map stays smooth while the day plays. The page sends each elevation
 * or surface grid once ({ type: 'grid', key, grid }) and then only the sun
 * and the view per picture ({ type: 'frame', id, dem, surf, job }); the
 * answer is the light per cell ({ id, lit }) or { id, error }.
 */
importScripts('shade.js');

const grids = new Map();

self.onmessage = ({ data }) => {
  if (data.type === 'grid') {
    grids.set(data.key, data.grid);
    while (grids.size > 4) grids.delete(grids.keys().next().value); // the page keeps at most a few views
    return;
  }
  if (data.type === 'frame') {
    try {
      const dem = grids.get(data.dem);
      const surf = data.surf ? grids.get(data.surf) : null;
      if (!dem || (data.surf && !surf)) throw new Error('Raster fehlt');
      const lit = Shade.frame({ ...data.job, dem, surf });
      self.postMessage({ id: data.id, lit }, [lit.buffer]);
    } catch (err) {
      self.postMessage({ id: data.id, error: err.message });
    }
  }
};
