'use strict';

/*
 * Turns weather context, detected changes and tags of a photo into a list of
 * irregularities worth recording, e.g. "early leaf colouring during a dry
 * summer". Thresholds are deliberately simple and stated in the text so the
 * reasoning stays visible to whoever reads the record.
 */

const { doy } = require('./weather');

// Natural autumn colouring of beech, oak and maple in the Central European
// lowlands usually starts in the second half of September.
const AUTUMN_START_DOY = 258; // ~15 September
const VERY_EARLY_DOY = 232; // ~20 August
const SEASON_START_DOY = 120; // ~1 May; earlier "yellow" is usually not foliage

const pct = (r) => `${Math.round(r * 100)} %`;
const fmtDay = (t) => new Date(t).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const signed = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} °C`;

function assess({ takenAt, tags = [], change = null, weather = null }) {
  const out = [];
  const w = weather?.last90;

  const dry = w?.precipRatio !== null && w?.precipRatio !== undefined && w.precipRatio < 0.75;
  const hot = w && w.tempAnomaly >= 1.5;
  if (dry) {
    out.push({
      type: 'trockenheit',
      severity: w.precipRatio < 0.5 ? 'stark' : 'auffällig',
      title: w.precipRatio < 0.5 ? 'Ausgeprägte Trockenheit' : 'Trockener als üblich',
      text: `In den 90 Tagen vor der Aufnahme fielen ${Math.round(w.precip)} mm Niederschlag, ` +
        `${pct(w.precipRatio)} des Mittels 1991–2020 (${Math.round(w.precipNormal)} mm). ` +
        `Längste Phase ohne nennenswerten Regen: ${w.longestDrySpell} Tage.`,
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

  const day = doy(takenAt);
  const coloured = (change?.summary || []).find((s) => s.class === 'verfaerbung' && s.area >= 0.02);
  const taggedColouring = tags.includes('fruehverfaerbung') || tags.includes('trockenschaden');
  if ((coloured || taggedColouring) && day >= SEASON_START_DOY && day < AUTUMN_START_DOY) {
    const source = coloured
      ? `Auf ${pct(coloured.area)} der Ansicht hat sich das Laub gegenüber dem ersten Foto gelb oder braun verfärbt`
      : 'Laubverfärbung beobachtet';
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
      severity: day < VERY_EARLY_DOY ? 'stark' : 'auffällig',
      title: 'Frühe Laubverfärbung',
      text: `${source}, am ${fmtDay(takenAt)}. Die natürliche Herbstfärbung beginnt im Flachland meist erst in der zweiten Septemberhälfte.${cause}`,
      suggestedTag: 'fruehverfaerbung',
    });
  }
  return out;
}

module.exports = { assess, AUTUMN_START_DOY };
