'use strict';

/*
 * "Wikipedia, Wikidata & Commons" on the spot page (src/wikimedia.js): what is
 * known about the place, which of it OpenStreetMap links to, and photos on
 * Wikimedia Commons taken nearby; a dated one with a suitable licence can
 * become an archive photo of the spot. Loaded only when the box is opened.
 * Relies on globals from app.js (state, api, el, $, openSpot).
 */
(function wikiBox() {
  const box = $('wiki-box');
  let spot = null;
  let loaded = null; // spot id the box shows
  let token = 0;
  const osmUrl = (ref) => `https://www.openstreetmap.org/${ref}`;
  const link = (href, text, title) => el('a', { href, text, target: '_blank', rel: 'noopener', ...(title ? { title } : {}) });
  const metres = (m) => (m >= 1000 ? `${(m / 1000).toLocaleString('de-CH', { maximumFractionDigits: 1 })} km` : `${m} m`);

  /** A new spot: closed and empty again; shown when the server has Wikimedia on. */
  function reset(s) {
    spot = s;
    loaded = null;
    token++;
    box.hidden = !state.config?.wikimedia;
    box.open = false;
    $('wiki-body').replaceChildren();
    $('wiki-summary').replaceChildren(el('span', { class: 'muted empty', text: 'Was über den Ort bekannt ist' }));
  }

  function item(it, editUrl) {
    const title = it.wikipedia ? link(it.wikipedia.url, it.label) : it.url ? link(it.url, it.label) : el('span', { text: it.label });
    const what = [it.relation === 'art' ? 'Art eines Baums in OSM' : it.kind, it.description, metres(it.distanceM)].filter(Boolean).join(' · ');
    const links = [
      it.wikipedia && link(it.wikipedia.url, `Wikipedia (${it.wikipedia.lang})`),
      it.url && link(it.url, it.qid),
      it.commonsCategory && link(it.commonsCategory.url, 'Commons-Kategorie'),
      ...it.osm.map((ref) => link(osmUrl(ref), `OSM ${ref.replace('/', ' ')}`)),
    ].filter(Boolean);
    const status = it.inOsm
      ? el('span', { class: 'wiki-linked', text: 'mit OSM verknüpft' })
      : el('span', { class: 'wiki-unlinked' }, ['noch nicht mit OSM verknüpft · ', link(editUrl, 'in OSM ergänzen', `wikidata=${it.qid} beim passenden Objekt eintragen`)]);
    return el('li', { class: 'wiki-item' }, [
      it.image ? el('a', { href: it.image.page, target: '_blank', rel: 'noopener', class: 'wiki-thumb' }, [el('img', { src: it.image.thumb, alt: it.label, loading: 'lazy' })]) : el('span', { class: 'wiki-thumb empty' }),
      el('div', {}, [
        el('strong', {}, [title]),
        el('p', { class: 'muted small', text: what }),
        el('p', { class: 'wiki-links small' }, [...links.flatMap((l, i) => (i ? [' · ', l] : [l])), links.length ? ' · ' : '', status]),
      ]),
    ]);
  }

  function photo(p) {
    const take = async (btn) => {
      btn.disabled = true;
      btn.textContent = 'wird übernommen …';
      try {
        await api(`/api/spots/${spot.id}/wikimedia/photos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: p.file }) });
        loaded = null;
        await openSpot(spot.id);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Als Archivfoto übernehmen';
        alert(err.message);
      }
    };
    const action = p.photoId ? el('span', { class: 'muted small', text: 'im Zeitverlauf' })
      : p.importable && window.Account?.user ? el('button', { type: 'button', class: 'link small', text: 'Als Archivfoto übernehmen', onclick: (e) => take(e.currentTarget) })
        : p.importable ? el('span', { class: 'muted small', text: 'Anmelden zum Übernehmen' })
          : el('span', { class: 'muted small', text: p.date ? 'Lizenz erlaubt nur den Link' : 'ohne Aufnahmedatum' });
    return el('figure', { class: 'wiki-photo' }, [
      el('a', { href: p.page, target: '_blank', rel: 'noopener' }, [el('img', { src: p.thumb, alt: p.title, loading: 'lazy' })]),
      el('figcaption', { class: 'small' }, [
        el('span', {}, [el('strong', { text: p.year ? String(p.year) : 'ohne Jahr' }), ` · ${metres(p.distanceM)}`]),
        el('span', { class: 'muted', text: [p.author, p.license].filter(Boolean).join(', ') }),
        action,
      ]),
    ]);
  }

  async function load() {
    if (!spot || loaded === spot.id) return;
    const my = ++token;
    loaded = spot.id;
    const body = $('wiki-body');
    body.replaceChildren(el('p', { class: 'muted small', text: 'Wikidata, OpenStreetMap und Commons werden gefragt …' }));
    let d;
    try {
      d = await api(`/api/spots/${spot.id}/wikimedia`);
    } catch (err) {
      if (my === token) { loaded = null; body.replaceChildren(el('p', { class: 'small', text: `Nicht erreichbar: ${err.message}` })); }
      return;
    }
    if (my !== token) return;
    const unlinked = d.items.filter((i) => !i.inOsm && i.qid).length;
    $('wiki-summary').replaceChildren(...[
      el('span', { class: 'chip', text: `${d.items.length} ${d.items.length === 1 ? 'Eintrag' : 'Einträge'}` }),
      el('span', { class: 'chip', text: `${d.photos.length} ${d.photos.length === 1 ? 'Foto' : 'Fotos'}` }),
    ]);
    const parts = [];
    parts.push(el('p', { class: 'label', text: 'Im Umkreis von 500 m' }));
    if (d.items.length) {
      parts.push(el('ul', { class: 'wiki-items' }, d.items.slice(0, 12).map((it) => item(it, d.editUrl))));
      if (unlinked && d.osm) parts.push(el('p', { class: 'muted small', text: `${unlinked} ${unlinked === 1 ? 'Eintrag hat' : 'Einträge haben'} Koordinaten in Wikidata, aber kein OSM-Objekt verweist darauf. Wer das passende Objekt in OSM kennt, ergänzt dort den Tag «wikidata».` }));
    } else parts.push(el('p', { class: 'muted small', text: 'Keine Einträge in Wikidata und OpenStreetMap.' }));
    parts.push(el('p', { class: 'label', text: 'Fotos auf Wikimedia Commons, bis 1 km' }));
    if (d.photos.length) {
      parts.push(el('div', { class: 'wiki-photos' }, d.photos.slice(0, 12).map(photo)));
      parts.push(el('p', { class: 'muted small', text: 'Ein Foto mit Aufnahmedatum und freier Lizenz (gemeinfrei, CC BY, CC BY-SA) lässt sich als Archivfoto übernehmen: Es kommt mit Datum, Urheber und Lizenz in den Zeitverlauf und wird auf die neuen Fotos ausgerichtet.' }));
    } else parts.push(el('p', { class: 'muted small', text: 'Keine Fotos mit Aufnahmeort in der Nähe.' }));
    const src = ['Wikidata (CC0)', 'Wikimedia Commons', 'Wikipedia'];
    if (d.osm) src.unshift('OpenStreetMap (ODbL)');
    parts.push(el('p', { class: 'wx-source', text: `${src.join(' · ')}${d.osm ? '' : ' · ohne Overpass-API nur Wikidata'}${d.errors?.length ? ` · nicht erreichbar: ${d.errors.join('; ')}` : ''}` }));
    body.replaceChildren(...parts);
  }

  box.addEventListener('toggle', () => { if (box.open) load(); });
  window.Wiki = { reset };
}());
