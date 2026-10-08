'use strict';

/* =========================================================
   Videos: upload (GoPro, 360°-MP4) and the 360° panorama viewer.
   Uses the globals of app.js: $, el, api, state, loadSpots, openSpot.
   ========================================================= */

(function video() {
  const VIDEO_EXT = /\.(mp4|mov|m4v|insv|360|lrv)$/i;
  const isVideo = (f) => f.type.startsWith('video/') || VIDEO_EXT.test(f.name);
  const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  let videoConfig = { ffmpeg: true, frameDistanceM: 25, frameIntervalS: 10, maxMb: 4096 };
  api('/api/videos/config').then((c) => { videoConfig = c; renderOptions(); }).catch(() => {});

  /* ---------- Upload form ---------- */

  const form = $('upload-form');
  const dialog = $('upload-dialog');
  const options = el('fieldset', { class: 'field video-options', hidden: '' }, [
    el('legend', { text: 'Video' }),
    el('p', { class: 'muted small video-note' }),
    el('div', { class: 'grid3' }, [
      el('label', { class: 'field' }, [
        el('span', { text: 'Bild alle … Meter' }),
        el('input', { type: 'number', name: 'frameDistanceM', min: '5', max: '500', step: '1', inputmode: 'numeric' }),
      ]),
      el('label', { class: 'field' }, [
        el('span', {}, ['Ohne GPS alle … s']),
        el('input', { type: 'number', name: 'frameIntervalS', min: '1', max: '600', step: '1', inputmode: 'numeric' }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { text: '360°-Video' }),
        el('select', { name: 'panorama' }, [
          el('option', { value: 'auto', text: 'Automatisch' }),
          el('option', { value: '1', text: 'Ja (equirektangulär)' }),
          el('option', { value: '0', text: 'Nein' }),
        ]),
      ]),
    ]),
  ]);
  form.photos.closest('.dropzone').after(options);

  function renderOptions() {
    const files = [...form.photos.files];
    const videos = files.filter(isVideo);
    options.hidden = !videos.length;
    if (!form.frameDistanceM.value) form.frameDistanceM.value = String(videoConfig.frameDistanceM);
    if (!form.frameIntervalS.value) form.frameIntervalS.value = String(videoConfig.frameIntervalS);
    const note = options.querySelector('.video-note');
    const insv = videos.some((f) => /\.(insv|360)$/i.test(f.name));
    note.classList.toggle('err', !videoConfig.ffmpeg || insv);
    note.textContent = !videoConfig.ffmpeg
      ? 'Auf dem Server fehlt ffmpeg – Videos können gerade nicht verarbeitet werden.'
      : insv
        ? 'Insta360- (.insv) und GoPro-MAX-Rohdateien (.360) bitte zuerst als 360°-MP4 exportieren.'
        : 'Aus dem Video wird entlang der Strecke ein Bild pro Spot gezogen. Position und Zeit kommen aus der '
          + 'GoPro-Telemetrie, sonst aus dem GPX-Track oder dem gewählten Standort.';
  }
  form.photos.addEventListener('change', renderOptions);
  $('open-upload').addEventListener('click', () => {
    form.frameDistanceM.value = '';
    form.frameIntervalS.value = '';
    renderOptions();
  });

  /** The fields shared with photo uploads (place, time, tags …). */
  function commonFields(fd) {
    if (form.gpx.files[0]) fd.append('gpx', form.gpx.files[0]);
    if (state.picked) {
      fd.append('lat', String(state.picked.lat));
      fd.append('lon', String(state.picked.lng));
    }
    if (form.takenAtLocal.value) fd.append('takenAt', new Date(form.takenAtLocal.value).toISOString());
    for (const name of ['activity', 'note', 'utcOffsetMinutes', 'clockShiftSeconds']) fd.append(name, form[name].value);
    fd.append('tags', [...$('upload-tags').querySelectorAll('input:checked')].map((c) => c.value).join(','));
    return fd;
  }

  /** POST with upload progress (fetch has none). Resolves to { status, body }. */
  function postWithProgress(url, fd, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.responseType = 'json';
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.response || {} });
      xhr.onerror = () => reject(new Error('Verbindung unterbrochen'));
      xhr.send(fd);
    });
  }

  const progress = el('div', { class: 'video-progress', hidden: '' }, [
    el('div', { class: 'video-progress-label' }),
    el('div', { class: 'video-progress-bar' }, el('i')),
  ]);
  $('upload-result').before(progress);
  function showProgress(label, fraction) {
    progress.hidden = false;
    progress.querySelector('.video-progress-label').textContent = label;
    progress.querySelector('i').style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  }

  async function uploadVideo(file, i, n) {
    const prefix = n > 1 ? `Video ${i + 1}/${n}: ` : '';
    const fd = commonFields(new FormData());
    fd.append('video', file);
    fd.append('async', '1');
    for (const name of ['frameDistanceM', 'frameIntervalS', 'panorama']) fd.append(name, form[name].value);
    const { status, body } = await postWithProgress('/api/videos', fd, (f) =>
      showProgress(`${prefix}wird hochgeladen … ${Math.round(f * 100)} %`, f * 0.4));
    if (status !== 202) throw new Error(body.error || `HTTP ${status}`);
    let job = body;
    while (job.status === 'wartet' || job.status === 'läuft') {
      showProgress(
        job.total ? `${prefix}${job.phase} … ${job.done}/${job.total}` : `${prefix}${job.phase} …`,
        0.4 + (job.total ? (0.6 * job.done) / job.total : 0),
      );
      await new Promise((r) => setTimeout(r, 1000));
      job = await api(`/api/videos/jobs/${job.id}`);
    }
    if (job.status === 'fehler') throw new Error(job.error);
    return job.result;
  }

  function describe(v, createdCount, spotCount) {
    const how = { gpmf: 'GPS aus der Kamera-Telemetrie', gpx: 'über GPX-Track', manual: 'am gewählten Standort' }[v.track];
    const parts = [
      `${plural(createdCount, 'Bild', 'Bilder')} aus ${fmtClock(v.durationS)} min`,
      v.distanceM ? `${v.distanceM < 1000 ? `${v.distanceM} m` : `${(v.distanceM / 1000).toLocaleString('de-CH', { maximumFractionDigits: 1 })} km`} Strecke` : null,
      plural(spotCount, 'Spot', 'Spots'),
      how,
      v.panorama ? '360°' : null,
    ];
    return parts.filter(Boolean).join(' · ');
  }

  // Runs before app.js's own submit handler and takes over when videos are selected.
  dialog.addEventListener('submit', async (e) => {
    if (e.target !== form) return;
    const files = [...form.photos.files];
    const videos = files.filter(isVideo);
    if (!videos.length) return;
    e.preventDefault();
    e.stopPropagation();
    const images = files.filter((f) => !isVideo(f));
    const submit = $('upload-submit');
    submit.disabled = true;
    submit.textContent = 'Wird verarbeitet …';
    $('upload-result').replaceChildren();
    const lines = [];
    const errors = [];
    const created = [];
    const touched = new Set();
    let sameSpot = 0;
    try {
      for (const [i, file] of videos.entries()) {
        try {
          const r = await uploadVideo(file, i, videos.length);
          created.push(...r.created);
          r.spots.forEach((s) => touched.add(s));
          lines.push(el('li', {}, [el('strong', { text: file.name }), `: ${describe(r.video, r.created.length, r.spots.length)}`]));
          for (const s of r.skipped) {
            if (/Gleicher Spot/.test(s.reason)) sameSpot++;
            else errors.push(`${s.name}: ${s.reason}`);
          }
        } catch (err) {
          errors.push(`${file.name}: ${err.message}`);
        }
      }
      for (let i = 0; i < images.length; i += 10) {
        showProgress(`Fotos werden hochgeladen … ${Math.min(i + 10, images.length)}/${images.length}`, (i + 10) / images.length);
        const fd = commonFields(new FormData());
        images.slice(i, i + 10).forEach((f) => fd.append('photos', f));
        try {
          const r = await api('/api/photos', { method: 'POST', body: fd });
          created.push(...r.created);
          r.spots.forEach((s) => touched.add(s));
          r.skipped.forEach((s) => errors.push(`${s.name}: ${s.reason}`));
        } catch (err) {
          errors.push(`Fotos: ${err.message}`);
        }
      }
    } finally {
      submit.disabled = false;
      submit.textContent = 'Hochladen';
      progress.hidden = true;
    }

    const result = [el('p', { text: `${plural(created.length, 'Bild', 'Bilder')} gespeichert, ${plural(touched.size, 'Spot', 'Spots')} aktualisiert.` })];
    if (lines.length) result.push(el('ul', { class: 'video-lines' }, lines));
    if (sameSpot) result.push(el('p', { class: 'muted small', text: `${plural(sameSpot, 'Bild', 'Bilder')} übersprungen, weil der Ort schon ein Bild aus diesem Video hat.` }));
    if (errors.length) result.push(el('ul', { class: 'err' }, errors.map((t) => el('li', { text: t }))));
    $('upload-result').replaceChildren(...result);
    await loadSpots({ fit: created.length > 0 && !state.spot });
    if (created.length) {
      const last = created[created.length - 1];
      await openSpot(last.spotId, last.id);
      $('explore').scrollIntoView({ behavior: 'smooth' });
    }
  }, true);

  /* ---------- 360° viewer ---------- */

  const VERT = 'attribute vec2 p; varying vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }';
  const FRAG = `
    precision highp float;
    varying vec2 v;
    uniform sampler2D tex;
    uniform float yaw, pitch, tanHalf, aspect;
    const float PI = 3.141592653589793;
    void main() {
      vec3 d = normalize(vec3(v.x * tanHalf * aspect, v.y * tanHalf, 1.0));
      float cp = cos(pitch), sp = sin(pitch);
      d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
      float cy = cos(yaw), sy = sin(yaw);
      d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
      vec2 uv = vec2(atan(d.x, d.z) / (2.0 * PI) + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI);
      gl_FragColor = texture2D(tex, uv);
    }`;

  /** Drag-to-look viewer for an equirectangular image, drawn with one WebGL fragment shader. */
  class PanoViewer {
    constructor(canvas, onView) {
      this.canvas = canvas;
      this.onView = onView;
      this.yaw = 0;
      this.pitch = 0;
      this.fov = 75;
      const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: false });
      this.gl = gl;
      if (!gl) return;
      const shader = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      gl.useProgram(prog);
      this.u = Object.fromEntries(['yaw', 'pitch', 'tanHalf', 'aspect'].map((n) => [n, gl.getUniformLocation(prog, n)]));
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      for (const [k, val] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
      this.bindInput();
      new ResizeObserver(() => this.draw()).observe(canvas);
    }

    get ok() { return Boolean(this.gl); }

    async load(url) {
      const token = (this.token = url);
      const img = new Image();
      img.src = url;
      await img.decode();
      if (this.token !== token || !this.gl) return;
      const gl = this.gl;
      // Phones often cap textures at 4096 px: scale larger panoramas down first.
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      let source = img;
      if (img.naturalWidth > max) {
        source = document.createElement('canvas');
        source.width = max;
        source.height = Math.round((img.naturalHeight * max) / img.naturalWidth);
        source.getContext('2d').drawImage(img, 0, 0, source.width, source.height);
      }
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
      this.loaded = true;
      this.draw();
    }

    set(view) {
      Object.assign(this, view);
      this.pitch = Math.max(-85, Math.min(85, this.pitch));
      this.fov = Math.max(30, Math.min(110, this.fov));
      this.yaw = ((this.yaw % 360) + 540) % 360 - 180;
      this.draw();
    }

    draw() {
      if (!this.gl || this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        const { gl, canvas } = this;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) [canvas.width, canvas.height] = [w, h];
        gl.viewport(0, 0, w, h);
        const rad = Math.PI / 180;
        gl.uniform1f(this.u.yaw, this.yaw * rad);
        gl.uniform1f(this.u.pitch, this.pitch * rad);
        gl.uniform1f(this.u.tanHalf, Math.tan((this.fov * rad) / 2));
        gl.uniform1f(this.u.aspect, w / h);
        if (this.loaded) gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.onView?.(this);
      });
    }

    bindInput() {
      const c = this.canvas;
      const pointers = new Map();
      let pinch = null;
      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        c.classList.add('grabbing');
      });
      c.addEventListener('pointermove', (e) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch) this.set({ fov: this.fov * (pinch / dist) });
          pinch = dist;
          return;
        }
        // Degrees per pixel follow the field of view, so the image sticks to the finger.
        const k = this.fov / c.clientHeight;
        this.set({ yaw: this.yaw - (e.clientX - prev.x) * k, pitch: this.pitch + (e.clientY - prev.y) * k });
      });
      const end = (e) => {
        pointers.delete(e.pointerId);
        pinch = null;
        if (!pointers.size) c.classList.remove('grabbing');
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.set({ fov: this.fov * Math.exp(e.deltaY * 0.001) });
      }, { passive: false });
      c.addEventListener('dblclick', () => this.set({ yaw: 0, pitch: 0, fov: 75 }));
      c.addEventListener('keydown', (e) => {
        const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 8], ArrowDown: [0, -8] }[e.key];
        if (step) {
          e.preventDefault();
          this.set({ yaw: this.yaw + step[0], pitch: this.pitch + step[1] });
        } else if (e.key === '+' || e.key === '-') {
          this.set({ fov: this.fov * (e.key === '+' ? 0.85 : 1.18) });
        }
      });
    }
  }

  const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

  const stage = $('viewer-stage');
  const img = $('viewer-img');
  const canvas = el('canvas', { class: 'pano-canvas', tabindex: '0', 'aria-label': '360°-Ansicht: ziehen zum Umsehen, Pfeiltasten drehen, + und − zoomen', hidden: '' });
  const badge = el('div', { class: 'pano-ui', hidden: '' }, [
    el('span', { class: 'pano-dir', 'aria-live': 'off' }),
    el('button', { type: 'button', class: 'pano-btn', 'data-pano': 'toggle', text: 'Flach' }),
    el('button', { type: 'button', class: 'pano-btn', 'data-pano': 'full', 'aria-label': 'Vollbild', text: '⤢' }),
  ]);
  const hint = el('div', { class: 'pano-hint', text: 'Ziehen zum Umsehen', hidden: '' });
  stage.append(canvas, hint, badge);
  let current = null;
  let flat = false;
  const viewer = new PanoViewer(canvas, (v) => {
    // A turned panorama looks the way the spot's first panorama does.
    const heading = img.dataset.heading !== undefined ? Number(img.dataset.heading) : current?.heading;
    badge.querySelector('.pano-dir').textContent = heading === null || heading === undefined
      ? `360° · ${Math.round(v.yaw)}°`
      : `360° · Blick nach ${compass(heading + v.yaw)}`;
  });
  canvas.addEventListener('pointerdown', () => { hint.hidden = true; }, { once: false });

  /** The photo shown in the stage: as original, preview, or turned into the spot's orientation (aligned.jpg). */
  const alignedSrc = (p, src) => src.startsWith(`/api/photos/${p.id}/aligned.jpg`);
  function currentPhoto() {
    const p = state.spot?.photos?.[state.index];
    const src = img.getAttribute('src') || '';
    return p && (src === p.url || src === p.largeUrl || alignedSrc(p, src)) ? p : null;
  }

  let currentSrc = null;
  function update() {
    const p = currentPhoto();
    const pano = Boolean(p?.panorama) && viewer.ok;
    stage.classList.toggle('pano', pano && !flat);
    canvas.hidden = !pano || flat;
    badge.hidden = !pano;
    badge.querySelector('[data-pano="toggle"]').textContent = flat ? '360°' : 'Flach';
    badge.querySelector('[data-pano="full"]').hidden = flat;
    badge.querySelector('.pano-dir').hidden = flat;
    // The full original, or the panorama turned into the spot's orientation.
    const src = p && alignedSrc(p, img.getAttribute('src')) ? img.getAttribute('src') : p?.url;
    if (pano && !flat && src !== currentSrc) {
      // Aligned panoramas of one spot look the same way: keep the view when stepping through them.
      const keep = current && current.spotId === p.spotId && alignedSrc(p, src) && currentSrc && currentSrc.includes('/aligned.jpg');
      if (!keep) {
        hint.hidden = false;
        viewer.set({ yaw: 0, pitch: 0 });
      }
      viewer.load(src).catch(() => {});
    }
    currentSrc = pano && !flat ? src : null;
    if (!pano) hint.hidden = true;
    current = p;

    // Caption: where in the video the frame comes from.
    const caption = $('viewer-caption');
    caption.querySelector('.video-src')?.remove();
    const fromVideo = p && p.videoTime !== null && p.videoTime !== undefined;
    // Frames placed by the camera's own telemetry are stored as 'exif'.
    if (fromVideo && p.locationSource === 'exif' && caption.firstChild?.nodeType === Node.TEXT_NODE) {
      caption.firstChild.textContent = caption.firstChild.textContent.replace(SOURCE_LABEL.exif, 'GPS aus Video');
    }
    if (p && (p.videoTime !== null && p.videoTime !== undefined || p.panorama)) {
      const bits = [];
      if (p.videoTime !== null && p.videoTime !== undefined) bits.push(`aus Video bei ${fmtClock(p.videoTime)}`);
      if (p.panorama) bits.push('360°');
      caption.append(el('span', { class: 'video-src', text: ` · ${bits.join(' · ')}` }));
    }
  }

  badge.addEventListener('click', (e) => {
    const action = e.target.closest('[data-pano]')?.dataset.pano;
    if (action === 'toggle') {
      flat = !flat;
      current = null;
      update();
    } else if (action === 'full') {
      const target = stage.closest('.viewer') || stage;
      if (document.fullscreenElement) document.exitFullscreen();
      else target.requestFullscreen?.().catch(() => {});
    }
  });
  document.addEventListener('fullscreenchange', () => viewer.draw());

  new MutationObserver(update).observe(img, { attributes: true, attributeFilter: ['src'] });

  // Mark 360° photos in the thumbnail strip.
  new MutationObserver(() => {
    const photos = state.spot?.photos || [];
    [...$('thumbs').children].forEach((b, i) => b.classList.toggle('is-pano', Boolean(photos[i]?.panorama)));
  }).observe($('thumbs'), { childList: true });
}());
