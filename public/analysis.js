'use strict';

/*
 * Automatic evaluation in the spot panel (uses the globals of app.js):
 *  - per photo: conifer/broadleaf share (heuristic) and object detections
 *    drawn as boxes on the photo, with "stimmt" / "falsch";
 *  - in the before/after comparison: which source classified each changed
 *    region (rules or the model learned from confirmations), its confidence,
 *    the presumed species of a discolouration, and buttons to confirm or
 *    correct the class – which feeds the learning.
 */

(() => {
  const AI = { status: null, photo: null, photoToken: 0, cmpToken: 0, showBoxes: true, lastCompare: null };
  const percent = (v) => `${Math.round(v * 100)} %`;
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const CLASS_OPTIONS = [
    ['windwurf', 'Windwurf / liegende Stämme'],
    ['auflichtung', 'Auflichtung / Holzschlag'],
    ['verfaerbung', 'Verfärbung'],
    ['bewuchs', 'Neuer Bewuchs'],
    ['sonstiges', 'Nichts davon / sonstiges'],
  ];

  async function refreshStatus() {
    try {
      AI.status = await api('/api/analysis/status');
    } catch {
      AI.status = null;
    }
    return AI.status;
  }

  /* ---------- Detection boxes on the photo ---------- */

  const overlay = el('div', { class: 'det-boxes', id: 'det-boxes' });
  $('viewer-stage').append(overlay);
  // The photo may be warped into the spot's common view: boxes follow the same transform.
  const syncOverlay = () => { overlay.style.transform = $('viewer-img').style.transform || ''; };
  new MutationObserver(syncOverlay).observe($('viewer-img'), { attributes: true, attributeFilter: ['style'] });

  function drawBoxes(detections) {
    syncOverlay();
    overlay.hidden = !AI.showBoxes;
    overlay.replaceChildren(...detections.filter((d) => d.status !== 'abgelehnt').map((d) => {
      const [x0, y0, x1, y1] = d.box;
      const box = el('div', { class: `det-box ${d.status}${y0 < 0.1 ? ' below' : ''}` },
        el('span', { text: `${d.text} · ${percent(d.score)}${d.status === 'bestaetigt' ? ' ✓' : ''}` }));
      Object.assign(box.style, { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` });
      return box;
    }));
  }

  /* ---------- Photo panel: foliage and detections ---------- */

  function foliageBlock(f) {
    if (!f || f.needleShare === null) {
      return el('p', { class: 'hint', text: 'Nadel-/Laubholzanteil: zu wenig Laub oder Nadeln im Bild für eine Schätzung.' });
    }
    const grid = el('div', { class: 'foliage-grid', style: `--cols:${f.cols}`, 'aria-hidden': 'true' },
      f.grid.map((c) => el('i', {
        style: c.needleShare === null ? '' : `--n:${Math.round(c.needleShare * 100)}%`,
        class: c.needleShare === null ? 'none' : '',
        title: c.needleShare === null ? 'kaum Vegetation' : `Nadelholz ≈ ${percent(c.needleShare)}`,
      })));
    return el('div', { class: 'foliage' }, [
      el('div', { class: 'foliage-head' }, [
        el('b', { text: `Nadelholz ≈ ${percent(f.needleShare)}` }),
        el('span', { text: `Laubholz ≈ ${percent(f.broadleafShare)}` }),
      ]),
      el('div', { class: 'foliage-bar', role: 'img', 'aria-label': `Nadelholz etwa ${percent(f.needleShare)}, Laubholz etwa ${percent(f.broadleafShare)}` },
        [el('i', { style: `width:${f.needleShare * 100}%` })]),
      grid,
      el('p', { class: 'hint', text: 'Heuristik aus Farbe und Textur der Vegetation (Nadeln: dunkler, bläulich, feinkörnig; Laub: heller, gelbgrün, gröber). Das Raster zeigt die Verteilung im Bild. Richtwert, keine Artbestimmung.' }),
    ]);
  }

  async function setDetectionStatus(d, status) {
    await api(`/api/detections/${d.id}`, json('PATCH', { status }));
    refreshStatus();
    renderPhoto(AI.photo);
  }

  async function adoptTag(photo, tag) {
    await api(`/api/photos/${photo.id}`, json('PATCH', { tags: [...new Set([...photo.tags, tag])] }));
    await Promise.all([openSpot(state.spot.id, photo.id), loadSpots()]);
  }

  function detectionRow(d, photo) {
    const source = d.source === 'extern' ? 'Externer Detektor' : 'Heuristik · experimentell';
    const actions = [
      el('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(d.status === 'bestaetigt'), text: 'Stimmt',
        onclick: () => setDetectionStatus(d, d.status === 'bestaetigt' ? 'offen' : 'bestaetigt'),
      }),
      el('button', {
        type: 'button', class: 'chip', 'aria-pressed': String(d.status === 'abgelehnt'), text: 'Falsch',
        onclick: () => setDetectionStatus(d, d.status === 'abgelehnt' ? 'offen' : 'abgelehnt'),
      }),
    ];
    if (d.status === 'bestaetigt' && d.suggestedTag && !photo.tags.includes(d.suggestedTag)) {
      actions.push(el('button', {
        type: 'button', class: 'link small', text: `Als „${state.config.tags[d.suggestedTag] || d.suggestedTag}“ festhalten`,
        onclick: () => adoptTag(photo, d.suggestedTag),
      }));
    }
    return el('li', { class: `det-row ${d.status}` }, [
      el('div', {}, [el('b', { text: d.text }), el('span', { class: 'muted small', text: ` · ${percent(d.score)} · ${source}` })]),
      el('div', { class: 'det-actions chips editable' }, actions),
    ]);
  }

  async function renderPhoto(photo) {
    if (!photo) return;
    AI.photo = photo;
    const token = ++AI.photoToken;
    const body = $('ai-photo-body');
    overlay.replaceChildren();
    if (!body.firstChild || body.dataset.photo !== String(photo.id)) {
      body.replaceChildren(el('p', { class: 'context-loading', text: 'Werte das Foto aus …' }));
    }
    body.dataset.photo = String(photo.id);
    const [foliage, det] = await Promise.all([
      api(`/api/photos/${photo.id}/foliage`).catch(() => null),
      api(`/api/photos/${photo.id}/detections`).catch(() => null),
    ]);
    if (token !== AI.photoToken) return;
    const parts = [foliageBlock(foliage)];
    if (det) {
      drawBoxes(det.detections);
      const visible = det.detections;
      parts.push(el('div', { class: 'det-head' }, [
        el('h4', { text: 'Erkannte Objekte' }),
        el('label', { class: 'toggle' }, [
          el('input', {
            type: 'checkbox', ...(AI.showBoxes ? { checked: '' } : {}),
            onchange: (e) => { AI.showBoxes = e.target.checked; overlay.hidden = !AI.showBoxes; },
          }),
          'Im Foto zeigen',
        ]),
      ]));
      if (det.warning) parts.push(el('p', { class: 'hint', text: det.warning }));
      parts.push(visible.length
        ? el('ul', { class: 'det-list' }, visible.map((d) => detectionRow(d, photo)))
        : el('p', { class: 'hint', text: 'Keine liegenden Stämme oder Holzpolter erkannt.' }));
      const stats = (AI.status?.detector?.stats || []).filter((s) => s.precision !== null);
      parts.push(el('p', {
        class: 'hint',
        text: (det.detector === 'extern'
          ? 'Erkennung durch den externen Detektor (DETECTOR_URL). '
          : 'Experimentelle Heuristik: liegende Stämme (lange, parallele, fast waagrechte Kanten mit rindenartiger Fläche dazwischen) und Holzpolter (viele runde, helle Schnittflächen). Wurzelteller, Totholz und Rückegassen erkennt erst ein trainiertes Modell. ') +
          'Bestätigte Stämme und Polter fliessen als Beispiele in die gelernte Einordnung ein.' +
          (stats.length ? ` Bisher bestätigt: ${stats.map((s) => `${s.text} ${s.bestaetigt} von ${s.bestaetigt + s.abgelehnt}`).join(', ')}.` : ''),
      }));
      parts.push(el('button', {
        type: 'button', class: 'link small', text: 'Erneut erkennen',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api(`/api/photos/${photo.id}/detections`, { method: 'POST' });
            renderPhoto(photo);
          } finally {
            e.target.disabled = false;
          }
        },
      }));
    }
    body.replaceChildren(...parts);
  }

  /* ---------- Compare: learned vs rule classification, confirmations ---------- */

  function sourceChip(g) {
    if (g.decidedBy === 'gelernt') return el('span', { class: 'src learned', text: `gelernt aus ${g.learned.examples} bestätigten Beispielen` });
    if (g.decidedBy === 'regel+gelernt') return el('span', { class: 'src learned', text: `Regel + gelernt (${g.learned.examples} Beispiele)` });
    return el('span', { class: 'src', text: 'Regel' });
  }

  async function label(a, b, g, cls) {
    await api(`/api/photos/${a.id}/region-labels`, json('POST', { to: b.id, index: g.index, class: cls }));
    await refreshStatus();
    renderCompare(AI.lastCompare);
  }

  function regionRow(a, b, g) {
    const details = [`≈ ${pct(g.area)} der Ansicht`, `Sicherheit ${percent(g.confidence)}`];
    if (g.foliage?.needleBefore !== null && g.foliage?.needleBefore !== undefined) details.push(`Nadelholz vorher ≈ ${percent(g.foliage.needleBefore)}`);
    if (g.decidedBy !== 'regel' && g.ruleClass !== g.class) details.push(`Regel sagte: ${CLASS_OPTIONS.find(([k]) => k === g.ruleClass)?.[1] || g.ruleClass}`);
    const select = el('select', {
      'aria-label': 'Richtige Einordnung wählen',
      onchange: (e) => e.target.value && label(a, b, g, e.target.value),
    }, [el('option', { value: '', text: 'Stattdessen …' }), ...CLASS_OPTIONS.filter(([k]) => k !== g.class).map(([k, t]) => el('option', { value: k, text: t }))]);
    const confirmed = g.userLabel?.class === g.class;
    return el('li', { class: `ai-region ${g.class}` }, [
      el('div', { class: 'ai-region-head' }, [el('i'), el('b', { text: g.label }), sourceChip(g)]),
      el('div', { class: 'muted small', text: details.join(' · ') }),
      g.attribution ? el('div', {
        class: 'small attribution',
        text: `Verfärbung vermutlich ${g.attribution.name}${g.attribution.sci ? ` (${percent(g.attribution.probability)})` : ''}` +
          (g.attribution.alternatives?.length ? ` – sonst ${g.attribution.alternatives.map((x) => `${x.name} ${percent(x.probability)}`).join(', ')}` : ''),
      }) : '',
      el('div', { class: 'ai-region-actions' }, [
        g.userLabel && !confirmed ? el('span', { class: 'small confirmed', text: `Von dir eingeordnet als: ${g.userLabel.label}` }) : '',
        el('button', {
          type: 'button', class: 'chip', 'aria-pressed': String(confirmed), text: confirmed ? 'Bestätigt ✓' : 'Stimmt',
          onclick: () => label(a, b, g, confirmed ? null : g.class),
        }),
        select,
      ]),
    ]);
  }

  async function renderCompare(detail) {
    AI.lastCompare = detail;
    const token = ++AI.cmpToken;
    const box = $('ai-regions');
    if (!detail?.change || !detail.change.regions?.length) return box.replaceChildren();
    const { a, b } = detail;
    let data;
    try {
      [data] = await Promise.all([api(`/api/photos/${a.id}/regions?to=${b.id}`), AI.status || refreshStatus()]);
    } catch {
      return box.replaceChildren();
    }
    if (token !== AI.cmpToken) return;
    const regions = data.regions.filter((g) => g.area >= 0.01);
    const learning = AI.status?.learning;
    const model = data.learning.model;
    const head = model
      ? `Lernmodell aktiv: gelernt aus ${model.examples} bestätigten Beispielen` +
        (model.cvAccuracy !== null && model.cvAccuracy !== undefined ? ` (Kreuzvalidierung ${percent(model.cvAccuracy)} richtig)` : '') +
        `, gewichtet mit ${percent(model.blendWeight)} gegenüber den Regeln.`
      : `Einordnung nach Regeln. Ein Lernmodell entsteht, sobald mindestens zwei Klassen je ${learning?.minPerClass ?? 5} bestätigte Beispiele haben` +
        ` (bisher ${data.learning.examples}${learning ? `: ${learning.classes.filter((c) => c.examples).map((c) => `${c.label} ${c.examples}`).join(', ') || 'keine'}` : ''}).`;
    box.replaceChildren(
      el('h4', { text: 'Einordnung prüfen' }),
      el('p', { class: 'hint', text: head }),
      el('ul', { class: 'ai-region-list' }, regions.map((g) => regionRow(a, b, g))),
      el('p', { class: 'hint', text: '„Stimmt“ oder eine andere Klasse wählen: Jede Bestätigung ist ein Trainingsbeispiel. Auch übernommene Beobachtungen (Tags) zählen als Bestätigung der passenden Region.' }),
    );
  }

  document.addEventListener('myforrest:photo', (e) => renderPhoto(e.detail));
  document.addEventListener('myforrest:compare', (e) => renderCompare(e.detail));
  refreshStatus();
})();
