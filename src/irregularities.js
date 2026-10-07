'use strict';

/*
 * Turns weather context, detected changes and tags of a photo into a list of
 * irregularities worth recording, e.g. "early leaf colouring during a dry
 * summer". Thresholds are deliberately simple and stated in the text so the
 * reasoning stays visible to whoever reads the record.
 */

const { doy } = require('./weather');
const { terrainShift, expectedColourDoy, aspectLabel, sunnySlope } = require('./phenology');

// Natural autumn colouring of beech, oak and maple in the Central European
// lowlands usually starts in the second half of September.
const AUTUMN_START_DOY = 258; // ~15 September
const VERY_EARLY_DOY = 232; // ~20 August
const SEASON_START_DOY = 120; // ~1 May; earlier "yellow" is usually not foliage

const pct = (r) => `${Math.round(r * 100)} %`;
const fmtDay = (t) => new Date(t).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const signed = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} °C`;

/** "29.09." for a day of year (non-leap calendar). */
const fmtDoy = (d) => new Date(Date.UTC(2023, 0, 1 + d)).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const names = (list) => list.map((t) => t.de).join(', ');

/**
 * `species` are the tree species known at the spot (entries of trees.js):
 * they set the expected start of autumn colouring and add species-specific
 * risks (bark beetle on drought-stressed spruce, ash dieback, ...).
 */
function assess({ takenAt, tags = [], change = null, weather = null, species = [], elevation = null, aspect = null, slope = null }) {
  const terrain = { elevation, aspect, slope };
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

  // Needles of spruce, fir, pine and Douglas fir do not colour in autumn.
  if (colouredRegion && evergreen.length) {
    const onlyConifers = evergreen.length === species.length;
    out.push({
      type: 'nadelverfaerbung',
      severity: onlyConifers ? 'stark' : 'hinweis',
      title: onlyConifers ? 'Verfärbung im Nadelwald' : 'Verfärbung – Nadelbäume prüfen',
      text: `${onlyConifers ? 'An diesem Spot stehen nur immergrüne Nadelbäume' : `An diesem Spot stehen auch ${names(evergreen)}`}` +
        ` – sie verfärben sich nicht im Herbst. ${onlyConifers ? 'Gelbe, rote oder braune Kronen' : 'Betrifft die Verfärbung Nadelbäume, ist das'}` +
        ` ${onlyConifers ? 'deuten' : 'ein Warnsignal und deutet'} auf Borkenkäferbefall, Trockenschäden oder Pilzbefall hin.`,
      suggestedTag: onlyConifers ? 'borkenkaefer' : undefined,
    });
  }

  // Expected start of colouring at this spot: earliest colouring species, shifted for altitude.
  const shift = terrainShift(terrain);
  const autumnStart = deciduous.length
    ? Math.min(...deciduous.map((t) => expectedColourDoy(t.colourDoy, terrain)))
    : AUTUMN_START_DOY + shift;
  const veryEarly = autumnStart - (AUTUMN_START_DOY - VERY_EARLY_DOY);
  const deciduousCanColour = !species.length || deciduous.length;
  if ((coloured || taggedColouring) && deciduousCanColour && day >= SEASON_START_DOY && day < autumnStart) {
    const source = coloured
      ? `Auf ${pct(coloured.area)} der Ansicht hat sich das Laub gegenüber dem ersten Foto gelb oder braun verfärbt`
      : 'Laubverfärbung beobachtet';
    const first = deciduous.find((t) => expectedColourDoy(t.colourDoy, terrain) === autumnStart);
    const place = [
      Number.isFinite(elevation) ? `auf ${Math.round(elevation)} m ü. M.` : null,
      aspectLabel(aspect, slope) !== 'eben' ? `am ${aspectLabel(aspect, slope)}` : null,
    ].filter(Boolean).join(' ');
    const where = place && shift !== 0
      ? `${place} (${Math.abs(shift)} ${Math.abs(shift) === 1 ? 'Tag' : 'Tage'} ${shift < 0 ? 'früher' : 'später'} als im Flachland)`
      : place || 'im Flachland';
    const reference = first
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
      text: `${source}, am ${fmtDay(takenAt)}. ${reference}${cause}`,
      suggestedTag: 'fruehverfaerbung',
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
