'use strict';

/*
 * Turns weather context, detected changes and tags of a photo into a list of
 * irregularities worth recording, e.g. "early leaf colouring during a dry
 * summer". Thresholds are deliberately simple and stated in the text so the
 * reasoning stays visible to whoever reads the record.
 */

const { doy } = require('./weather');
const { terrainShift, expectedColourDoy, microShift, aspectLabel, sunnySlope } = require('./phenology');
const { attributeChange } = require('./foliage');
const { treeInfo: treeInfoOf } = require('./trees');

// Species whose fresh leaves and shoots are particularly frost-tender.
const FROST_TENDER = ['Fagus sylvatica', 'Fraxinus excelsior', 'Quercus robur', 'Quercus petraea', 'Juglans regia', 'Castanea sativa', 'Abies alba'];

// Natural autumn colouring of beech, oak and maple in the Central European
// lowlands usually starts in the second half of September.
const AUTUMN_START_DOY = 258; // ~15 September
const VERY_EARLY_DOY = 232; // ~20 August
const SEASON_START_DOY = 120; // ~1 May; earlier "yellow" is usually not foliage
const LEAF_OUT_DOY = 104; // ~15 April

const pct = (r) => `${Math.round(r * 100)} %`;
const fmtDay = (t) => new Date(t).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const signed = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} °C`;

/** Late-frost nights with the estimated minimum in the hollow (see nightcool.js). */
function frostNightsText(nf) {
  const n = nf.frostNights.length;
  const k = nf.frostNights.reduce((m, x) => (!m || x.est < m.est ? x : m), null);
  const deg = (v) => `${v.toFixed(1).replace('-', '−')} °C`;
  return `Nach dem Laubaustrieb ${n === 1 ? 'war eine Nacht' : `waren ${n} Nächte`} so windstill und klar, dass die Kaltluft ` +
    `in der Senke geschätzt unter 0 °C abkühlte (kälteste: ${deg(k.est)} in der Nacht auf den ${fmtDay(Date.parse(`${k.date}T00:00:00Z`))}; ` +
    `Wettermodell ${deg(k.tmin)}, Wind ${k.wind.toFixed(1)} m/s, ${k.cloud} % Bewölkung). `;
}

/** "29.09." for a day of year (non-leap calendar). */
const fmtDoy = (d) => new Date(Date.UTC(2023, 0, 1 + d)).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const names = (list) => list.map((t) => t.de).join(', ');

/**
 * `species` are the tree species known at the spot (entries of trees.js):
 * they set the expected start of autumn colouring and add species-specific
 * risks (bark beetle on drought-stressed spruce, ash dieback, ...).
 */
function assess({
  takenAt, tags = [], change = null, weather = null, species = [],
  elevation = null, aspect = null, slope = null, landform = null, tpi600 = null,
  nightFrost = null, phenoRef = null, leafOut = null,
}) {
  const terrain = { elevation, aspect, slope, landform, tpi600 };
  const out = [];
  const w = weather?.last90;
  const colouredRegion = (change?.summary || []).find((s) => s.class === 'verfaerbung' && s.area >= 0.02);
  const opened = (change?.summary || []).find((s) => s.class === 'auflichtung' && s.area >= 0.02);
  const evergreen = species.filter((t) => t.evergreen);
  const deciduous = species.filter((t) => !t.evergreen && t.colourDoy);
  const spruce = species.find((t) => t.sci === 'Picea abies');

  const dry = w?.precipRatio !== null && w?.precipRatio !== undefined && w.precipRatio < 0.75;
  const hot = w && w.tempAnomaly >= 1.5;
  if (dry) {
    const sensitive = species.filter((t) => t.drought === 'hoch');
    out.push({
      type: 'trockenheit',
      severity: w.precipRatio < 0.5 ? 'stark' : 'auffällig',
      title: w.precipRatio < 0.5 ? 'Ausgeprägte Trockenheit' : 'Trockener als üblich',
      text: `In den 90 Tagen vor der Aufnahme fielen ${Math.round(w.precip)} mm Niederschlag, ` +
        `${pct(w.precipRatio)} des Mittels 1991–2020 (${Math.round(w.precipNormal)} mm). ` +
        `Längste Phase ohne nennenswerten Regen: ${w.longestDrySpell} Tage.` +
        (sensitive.length ? ` Besonders trockenheitsempfindlich an diesem Spot: ${names(sensitive)}.` : '') +
        (sunnySlope(aspect, slope) ? ` Am ${aspectLabel(aspect, slope)} (${Math.round(slope)}° steil) trocknet der Boden durch die stärkere Sonneneinstrahlung zusätzlich schneller aus.` : ''),
    });
  } else if (w?.precipRatio >= 1.5) {
    out.push({
      type: 'naesse',
      severity: 'hinweis',
      title: 'Nasser als üblich',
      text: `${Math.round(w.precip)} mm Niederschlag in 90 Tagen, ${pct(w.precipRatio)} des Mittels.`,
    });
  }
  if (hot) {
    out.push({
      type: 'waerme',
      severity: w.tempAnomaly >= 2.5 ? 'stark' : 'auffällig',
      title: 'Wärmer als üblich',
      text: `Mitteltemperatur ${signed(w.tempAnomaly)} über dem Mittel` +
        (w.hotDays > 0 ? `; ${w.hotDays} Hitzetage ab 30 °C (üblich ${Math.round(w.hotDaysNormal)}).` : '.'),
    });
  }

  if (spruce && (dry || hot)) {
    out.push({
      type: 'borkenkaefer_risiko',
      severity: (dry && hot) || colouredRegion ? 'stark' : 'auffällig',
      title: 'Erhöhtes Borkenkäfer-Risiko',
      text: 'Fichten unter Trocken- und Hitzestress können kaum Harz bilden und sind anfällig für den Buchdrucker. ' +
        'Prüfen: braunes Bohrmehl am Stammfuss und in Rindenritzen, Harztröpfchen, sich rötlich verfärbende Kronen. ' +
        'Befallene Bäume früh melden, bevor die nächste Käfergeneration ausfliegt.',
    });
  }

  const day = doy(takenAt);
  const taggedColouring = tags.includes('fruehverfaerbung') || tags.includes('trockenschaden');
  const coloured = colouredRegion;

  // Which species the discolouration most plausibly concerns (foliage.js: needle share + inventory; heuristic).
  const attribution = colouredRegion ? attributeChange(change, { species, takenAt, terrain }) : null;
  const sure = attribution && attribution.sci && attribution.probability >= 0.5 ? treeInfoOf(attribution.sci) : null;
  const attributionText = attribution
    ? ` Nach Farbe und Textur der Region vor der Verfärbung (Nadelholzanteil ≈ ${pct(attribution.needleShare)}, Heuristik) ` +
      `betrifft sie vermutlich ${attribution.sci ? `${attribution.name} (${pct(attribution.probability)})` : attribution.name}.`
    : '';

  // Needles of spruce, fir, pine and Douglas fir do not colour in autumn.
  if (colouredRegion && evergreen.length) {
    const onlyConifers = evergreen.length === species.length || Boolean(sure?.evergreen);
    out.push({
      type: 'nadelverfaerbung',
      severity: onlyConifers ? 'stark' : 'hinweis',
      title: sure?.evergreen && evergreen.length !== species.length ? `Verfärbung vermutlich an ${sure.de}`
        : onlyConifers ? 'Verfärbung im Nadelwald' : 'Verfärbung – Nadelbäume prüfen',
      text: `${evergreen.length === species.length ? 'An diesem Spot stehen nur immergrüne Nadelbäume' : `An diesem Spot stehen auch ${names(evergreen)}`}` +
        ` – sie verfärben sich nicht im Herbst. ${onlyConifers ? 'Gelbe, rote oder braune Kronen' : 'Betrifft die Verfärbung Nadelbäume, ist das'}` +
        ` ${onlyConifers ? 'deuten' : 'ein Warnsignal und deutet'} auf Borkenkäferbefall, Trockenschäden oder Pilzbefall hin.${attributionText}`,
      attribution: attribution || undefined,
      suggestedTag: onlyConifers ? 'borkenkaefer' : undefined,
    });
  }

  // Expected start of colouring at this spot: earliest colouring species, shifted for altitude.
  const shift = terrainShift(terrain);
  // Cold-air pools: frost after leaf-out even when the weather model stays just above zero.
  // This year's leaf-out lies in the year-to-date window, not necessarily in the last 90 days.
  const season = weather?.yearToDate;
  // Leaf-out of the region (phenoref.js: this year's observations or the ten-year mean, at the spot's altitude);
  // without data the fixed mid-April date. Frost before leaf-out does not hurt the leaves.
  const leafOutDoy = leafOut?.doy ?? LEAF_OUT_DOY;
  const doyOf = (iso) => Math.floor((Date.parse(`${iso}T12:00:00Z`) - Date.UTC(+iso.slice(0, 4), 0, 1)) / 86400000) + 1;
  const frostAfter = nightFrost && leafOut
    ? { ...nightFrost, frostNights: nightFrost.frostNights.filter((n) => doyOf(n.date) >= leafOutDoy) }
    : nightFrost;
  // With estimated hollow minima (nightcool.js) only nights estimated below 0 °C count; else the 3 °C model rule.
  const cold = frostAfter ? frostAfter.frostNights.length : season?.coldNightsAfterLeafOut;
  const frostRisk = landform === 'senke' && cold > 0 && day >= leafOutDoy;
  // Brown young leaves in early summer after cold nights in a hollow: frost damage, not autumn colouring.
  const frostDamage = frostRisk && (colouredRegion || taggedColouring) && day >= SEASON_START_DOY && day <= 200;

  // Regional observation series (phenoref.js) replace the lowland value plus altitude gradient when available.
  const colourDoyOf = (t) => (phenoRef?.[t.sci] ? phenoRef[t.sci].doy + microShift(terrain) : expectedColourDoy(t.colourDoy, terrain));
  // Species-specific: when the colouring is attributed to one deciduous species, its own date counts.
  const own = sure && !sure.evergreen && sure.colourDoy ? sure : null;
  const autumnStart = own ? colourDoyOf(own)
    : deciduous.length
      ? Math.min(...deciduous.map(colourDoyOf))
      : AUTUMN_START_DOY + shift;
  const veryEarly = autumnStart - (AUTUMN_START_DOY - VERY_EARLY_DOY);
  const deciduousCanColour = (!species.length || deciduous.length) && !sure?.evergreen;
  if ((coloured || taggedColouring) && deciduousCanColour && !frostDamage && day >= SEASON_START_DOY && day < autumnStart) {
    const source = coloured
      ? `Auf ${pct(coloured.area)} der Ansicht hat sich das Laub gegenüber dem ersten Foto gelb oder braun verfärbt`
      : 'Laubverfärbung beobachtet';
    const first = own || deciduous.find((t) => colourDoyOf(t) === autumnStart);
    const ref = first && phenoRef?.[first.sci];
    const place = [
      Number.isFinite(elevation) ? `auf ${Math.round(elevation)} m ü. M.` : null,
      landform === 'senke' ? 'in einer Senke mit Kaltluftsee' : null,
      landform !== 'senke' && aspectLabel(aspect, slope) !== 'eben' ? `am ${aspectLabel(aspect, slope)}` : null,
    ].filter(Boolean).join(' ');
    const where = place && shift !== 0
      ? `${place} (${Math.abs(shift)} ${Math.abs(shift) === 1 ? 'Tag' : 'Tage'} ${shift < 0 ? 'früher' : 'später'} als im Flachland)`
      : place || 'im Flachland';
    const reference = ref
      ? `Bei ${first.de} beginnt die Herbstfärbung ${place || 'hier'} typischerweise um den ${fmtDoy(autumnStart)} (${ref.label}, auf die Höhe des Spots umgerechnet).`
      : first
      ? `Bei ${first.de} beginnt die Herbstfärbung ${where} typischerweise um den ${fmtDoy(autumnStart)}`
      : `Die natürliche Herbstfärbung beginnt ${where} meist erst um den ${fmtDoy(autumnStart)}`; // date ends with ".
    let cause;
    if (dry || hot) {
      const reasons = [dry && `Trockenheit (${pct(w.precipRatio)} Niederschlag in 90 Tagen)`, hot && `Wärme (${signed(w.tempAnomaly)})`].filter(Boolean);
      cause = ` Das passt zur ${reasons.join(' und ')}: wahrscheinlich Trockenstress, bei dem Bäume ihr Laub vorzeitig verfärben und abwerfen, um Wasser zu sparen.`;
    } else if (w) {
      cause = ' Das Wetter war unauffällig: andere Ursachen wie Schädlinge (z. B. Borkenkäfer), Pilzbefall oder Wurzelschäden prüfen.';
    } else {
      cause = ' Wetterdaten fehlen, die Ursache bleibt offen.';
    }
    out.push({
      type: 'fruehe_verfaerbung',
      severity: day < veryEarly ? 'stark' : 'auffällig',
      title: 'Frühe Laubverfärbung',
      text: `${source}, am ${fmtDay(takenAt)}. ${reference}${coloured ? attributionText : ''}${cause}`,
      suggestedTag: 'fruehverfaerbung',
      attribution: attribution || undefined,
    });
  }

  if (frostRisk) {
    const damaged = frostDamage;
    const tender = species.filter((t) => FROST_TENDER.includes(t.sci));
    const c = season?.coldestAfterLeafOut;
    out.push({
      type: 'spaetfrost',
      severity: damaged ? 'auffällig' : 'hinweis',
      title: damaged ? 'Spätfrost wahrscheinlich' : 'Spätfrost-Gefahr in der Senke',
      text: 'Der Spot liegt in einer Senke, in der sich in klaren Nächten Kaltluft sammelt. ' +
        (leafOut
          ? `Das Laub treibt hier um den ${fmtDoy(leafOut.doy)} aus (${leafOut.label}, auf die Höhe des Spots umgerechnet). `
          : '') +
        (frostAfter
          ? frostNightsText(frostAfter)
          : `Nach dem Laubaustrieb zeigt das Wettermodell ${cold} ${cold === 1 ? 'Nacht' : 'Nächte'} unter 3 °C` +
            (c ? ` (kälteste: ${c.tmin.toFixed(1)} °C am ${fmtDay(Date.parse(`${c.date}T00:00:00Z`))})` : '') +
            '; in der Senke war es vermutlich mehrere Grad kälter, also Frost. ') +
        (damaged
          ? 'Braune, schlaffe junge Blätter und Triebe im Frühsommer sind typische Frostschäden. Die Bäume treiben meist neu aus.'
          : 'Auf braune, welke junge Blätter und abgestorbene Triebspitzen achten.') +
        (tender.length ? ` Besonders frostempfindlich hier: ${names(tender)}.` : ''),
      suggestedTag: damaged ? 'frostschaden' : undefined,
    });
  }

  const windthrow = (change?.summary || []).find((s) => s.class === 'windwurf' && s.area >= 0.02) || tags.includes('sturmschaden');
  if (landform === 'kuppe' && windthrow) {
    out.push({
      type: 'windexponiert',
      severity: 'hinweis',
      title: 'Windexponierte Kuppenlage',
      text: 'Der Spot liegt auf einer Kuppe oder einem Rücken und ist dem Wind stärker ausgesetzt als die Umgebung. ' +
        'Nach Stürmen hier besonders auf Windwurf und angeschobene Bäume achten' +
        (spruce ? '; flach wurzelnde Fichten sind besonders gefährdet.' : '.'),
    });
  }

  const ash = species.find((t) => t.sci === 'Fraxinus excelsior');
  if (ash && (coloured || opened)) {
    out.push({
      type: 'eschentriebsterben',
      severity: 'hinweis',
      title: 'Eschentriebsterben möglich',
      text: 'An diesem Spot stehen Eschen. Welke Blätter, absterbende Triebe und lichter werdende Kronen sind typisch ' +
        'für das Eschentriebsterben (Pilz Hymenoscyphus fraxineus); geschwächte Eschen können umstürzen.',
    });
  }
  return out;
}

module.exports = { assess, AUTUMN_START_DOY };
