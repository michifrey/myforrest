'use strict';

/**
 * Feature catalogue (ISO 19110, XML encoding ISO 19139/gfc) of the open
 * MyForrest data: every collection of the OGC API / GeoPackage as a feature
 * type, every column with its definition, value type, unit and – for coded
 * columns – the listed values. geocat.ch links it from the metadata records
 * (contentInfo → MD_FeatureCatalogueDescription).
 *
 * Also the texts of the per-collection metadata records (four languages).
 */

const crypto = require('node:crypto');
const { COLLECTIONS } = require('./geodata');
const { TAGS } = require('./tags');
const { LICENSES } = require('./moderation');

const LANGS = ['DE', 'FR', 'IT', 'EN'];

/** Title and abstract of each collection's own metadata record. */
const COLLECTION_TEXT = {
  spots: {
    title: { DE: 'MyForrest – Spots', FR: 'MyForrest – Spots', IT: 'MyForrest – Spot', EN: 'MyForrest – Spots' },
    abstract: {
      DE: 'Orte, an denen Freiwillige über die Zeit wiederholt fotografiert haben, mit Blickrichtung, Höhe, Anzahl Fotos und Jahren, den beobachteten Befunden (Sturm, Borkenkäfer, Trockenheit …) und dem neusten Foto.',
      FR: 'Lieux photographiés à plusieurs reprises par des bénévoles au fil du temps, avec direction de prise de vue, altitude, nombre de photos et d’années, constats observés (tempête, scolytes, sécheresse …) et la photo la plus récente.',
      IT: 'Luoghi fotografati ripetutamente da volontari nel tempo, con direzione di ripresa, quota, numero di foto e di anni, constatazioni osservate (tempesta, bostrico, siccità …) e la foto più recente.',
      EN: 'Places that volunteers photographed repeatedly over time, with viewing direction, elevation, number of photos and years, the observed findings (storm, bark beetle, drought …) and the latest photo.',
    },
  },
  photos: {
    title: { DE: 'MyForrest – Fotos', FR: 'MyForrest – Photos', IT: 'MyForrest – Foto', EN: 'MyForrest – Photos' },
    abstract: {
      DE: 'Einzelne Wiederholungsfotos mit Aufnahmezeit, Position und deren Herkunft, Blickrichtung, Aktivität, Befunden, Notiz, Lizenz und Urheberschaft. Ausgeblendete Fotos und geschützte Funde sind nicht enthalten.',
      FR: 'Photos répétées individuelles avec date de prise de vue, position et son origine, direction, activité, constats, remarque, licence et auteur. Les photos masquées et les observations protégées ne sont pas incluses.',
      IT: 'Singole foto ripetute con data di ripresa, posizione e sua origine, direzione, attività, constatazioni, nota, licenza e autore. Foto nascoste e ritrovamenti protetti non sono inclusi.',
      EN: 'Individual repeat photos with time, position and its source, viewing direction, activity, findings, note, licence and author. Hidden photos and protected finds are not included.',
    },
  },
  findings: {
    title: { DE: 'MyForrest – Pflanzenfunde', FR: 'MyForrest – Observations de plantes', IT: 'MyForrest – Ritrovamenti di piante', EN: 'MyForrest – Plant findings' },
    abstract: {
      DE: 'Pflanzenfunde aus der automatischen Bestimmung mit Pl@ntNet (bestes Ergebnis pro Foto), invasive Neophyten markiert, mit Lageunsicherheit und Prüfstatus: von Fachleuten bestätigt, korrigiert oder nur automatisch.',
      FR: 'Observations de plantes issues de la détermination automatique par Pl@ntNet (meilleur résultat par photo), néophytes envahissantes signalées, avec incertitude de position et statut de vérification : confirmées, corrigées par des spécialistes ou seulement automatiques.',
      IT: 'Ritrovamenti di piante dalla determinazione automatica con Pl@ntNet (miglior risultato per foto), neofite invasive segnalate, con incertezza della posizione e stato di verifica: confermati, corretti da specialisti o solo automatici.',
      EN: 'Plant findings from the automatic identification with Pl@ntNet (best result per photo), invasive neophytes flagged, with position uncertainty and review status: confirmed or corrected by experts, or automatic only.',
    },
  },
  spread_fronts: {
    title: { DE: 'MyForrest – Ausbreitungsfronten', FR: 'MyForrest – Fronts de propagation', IT: 'MyForrest – Fronti di diffusione', EN: 'MyForrest – Spread fronts' },
    abstract: {
      DE: 'Pro Art und Jahr die bis dahin besiedelte Fläche (Alpha-Shape aller Funde mit 25 m Puffer), mit Anzahl Funde, Fläche, Teilbeständen und Frontradius – zeigt, wie sich invasive Neophyten ausbreiten.',
      FR: 'Par espèce et par année, la surface colonisée jusque-là (alpha-shape de toutes les observations avec une zone tampon de 25 m), avec nombre d’observations, surface, peuplements partiels et rayon du front – montre la propagation des néophytes envahissantes.',
      IT: 'Per specie e anno la superficie colonizzata fino ad allora (alpha shape di tutti i ritrovamenti con buffer di 25 m), con numero di ritrovamenti, superficie, popolamenti parziali e raggio del fronte – mostra la diffusione delle neofite invasive.',
      EN: 'Per species and year the area occupied so far (alpha shape of all findings with a 25 m buffer), with number of findings, area, patches and front radius – shows how invasive neophytes spread.',
    },
  },
};

const tagValues = Object.entries(TAGS).map(([code, label]) => [code, label]);
const ISO_TIME = 'Zeitpunkt nach ISO 8601 (UTC)';

/** Definitions per collection and column: { def, unit?, values?: [[code, meaning], …] }. */
const FIELDS = {
  spots: {
    spot_id: { def: 'Kennung des Spots' },
    photos: { def: 'Anzahl öffentlich sichtbarer Fotos am Spot' },
    first_photo: { def: `Aufnahmezeit des ersten Fotos, ${ISO_TIME}` },
    last_photo: { def: `Aufnahmezeit des neusten Fotos, ${ISO_TIME}` },
    years: { def: 'Anzahl Kalenderjahre mit mindestens einem Foto' },
    heading: { def: 'Mittlere Blickrichtung der Fotos, von Norden im Uhrzeigersinn', unit: 'Grad (°)' },
    elevation: { def: 'Höhe des Spots aus dem Höhenmodell', unit: 'Meter über Meer (m ü. M.)' },
    tags: { def: 'Beobachtete Befunde aller Fotos des Spots, durch Komma getrennt', values: tagValues },
    status: { def: 'Zusammenfassung der Befunde', values: [['schaden', 'Mindestens ein Schadens-Befund oder Neophyt'], ['ohne', 'Keine Schäden beobachtet']] },
    latest_photo_url: { def: 'Adresse (URL) des neusten Fotos' },
  },
  photos: {
    photo_id: { def: 'Kennung des Fotos' },
    spot_id: { def: 'Kennung des Spots, zu dem das Foto gehört' },
    taken_at: { def: `Aufnahmezeit, ${ISO_TIME}` },
    heading: { def: 'Blickrichtung, von Norden im Uhrzeigersinn', unit: 'Grad (°)' },
    location_source: {
      def: 'Herkunft der Position',
      values: [['exif', 'GPS der Kamera (EXIF), ±15 m'], ['gpx', 'Aus einem GPS-Track über die Aufnahmezeit, ±25 m'], ['manual', 'Von Hand auf der Karte gesetzt, ±50 m'], ['spot', 'Mitte des Spots (z. B. Archivfotos)']],
    },
    activity: {
      def: 'Unterwegs als',
      values: [['joggen', 'Joggen'], ['wandern', 'Wandern'], ['biken', 'Velo / Bike'], ['fahren', 'Fahrt (Dashcam)'], ['sonstiges', 'Sonstiges']],
    },
    tags: { def: 'Beobachtete Befunde, durch Komma getrennt', values: tagValues },
    note: { def: 'Notiz der fotografierenden Person' },
    url: { def: 'Adresse (URL) des Fotos' },
    license: { def: 'Lizenz des Fotos', values: Object.values(LICENSES).map((l) => [l.url ? l.url.replace(/deed\.\w+$/, '') : l.label, l.label]) },
    author: { def: 'Anzeigename der fotografierenden Person (Urheberschaft)' },
  },
  findings: {
    photo_id: { def: 'Kennung des Fotos mit dem Fund' },
    scientific_name: { def: 'Wissenschaftlicher Artname (bei korrigierten Funden die korrigierte Art)' },
    common_name: { def: 'Deutscher Name, bei invasiven Neophyten nach Info Flora' },
    neophyte: { def: 'Invasiver Neophyt nach der Liste von Info Flora', values: [['1', 'ja'], ['0', 'nein']] },
    score: { def: 'Sicherheit der automatischen Bestimmung durch Pl@ntNet, 0 bis 1', unit: 'Anteil (0–1)' },
    taken_at: { def: `Aufnahmezeit des Fotos, ${ISO_TIME}` },
    uncertainty_m: { def: 'Lageunsicherheit je nach Herkunft der Position', unit: 'Meter (m)' },
    url: { def: 'Adresse (URL) des Fotos' },
    license: { def: 'Lizenz des Fotos' },
    verification: {
      def: 'Prüfstatus der Bestimmung',
      values: [['automatisch', 'Nur automatisch bestimmt (Pl@ntNet)'], ['bestaetigt', 'Von einer Fachperson oder der Moderation bestätigt'], ['korrigiert', 'Von einer Fachperson oder der Moderation auf eine andere Art korrigiert']],
    },
  },
  spread_fronts: {
    scientific_name: { def: 'Wissenschaftlicher Artname' },
    common_name: { def: 'Deutscher Name' },
    neophyte: { def: 'Invasiver Neophyt nach der Liste von Info Flora', values: [['1', 'ja'], ['0', 'nein']] },
    year: { def: 'Jahr, bis zu dem die Funde zählen' },
    findings: { def: 'Anzahl Funde der Art bis und mit diesem Jahr' },
    area_m2: { def: 'Besiedelte Fläche (Alpha-Shape mit 25 m Puffer)', unit: 'Quadratmeter (m²)' },
    patches: { def: 'Anzahl getrennter Teilbestände' },
    front_radius_m: { def: 'Mittlerer Abstand der Front vom Ursprung der Ausbreitung', unit: 'Meter (m)' },
    alpha_m: { def: 'Parameter α des Alpha-Shapes (grösster Abstand, über den Funde verbunden werden)', unit: 'Meter (m)' },
    recency: { def: 'Lage des Jahres zwischen erstem (0) und neustem (1) Jahr der Art, für Kartenstile', unit: 'Anteil (0–1)' },
    recency_class: { def: 'Dasselbe in fünf Stufen', values: [['0', 'erstes Jahr'], ['1', ''], ['2', ''], ['3', ''], ['4', 'neustes Jahr']] },
  },
};

const VALUE_TYPE = { INTEGER: 'Integer', REAL: 'Real', TEXT: 'CharacterString' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (v) => `<gco:CharacterString>${esc(v)}</gco:CharacterString>`;

/** UUID (v5 style) of the catalogue: stable per server address. */
function catalogueUuid(base) {
  const h = crypto.createHash('sha1').update(`myforrest-featurecatalogue:${base}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** UUID of a collection's own metadata record, derived from the main record's. */
function collectionUuid(mainUuid, id) {
  const h = crypto.createHash('sha1').update(`myforrest-collection:${mainUuid}:${id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The catalogue as XML. contact: { organisation, email }; date: 'YYYY-MM-DD'. */
function featureCatalogue({ base, contact, date }) {
  const uuid = catalogueUuid(base);
  const attr = (name, type, doc) => '<gfc:carrierOfCharacteristics><gfc:FC_FeatureAttribute>'
    + `<gfc:memberName><gco:LocalName>${esc(name)}</gco:LocalName></gfc:memberName>`
    + `<gfc:definition>${str(doc.unit ? `${doc.def}. Einheit: ${doc.unit}` : doc.def)}</gfc:definition>`
    + '<gfc:cardinality><gco:Multiplicity><gco:range><gco:MultiplicityRange><gco:lower><gco:Integer>0</gco:Integer></gco:lower>'
    + '<gco:upper><gco:UnlimitedInteger>1</gco:UnlimitedInteger></gco:upper></gco:MultiplicityRange></gco:range></gco:Multiplicity></gfc:cardinality>'
    + (doc.values || []).map(([code, meaning]) => '<gfc:listedValue><gfc:FC_ListedValue>'
      + `<gfc:label>${str(code)}</gfc:label><gfc:code>${str(code)}</gfc:code>${meaning ? `<gfc:definition>${str(meaning)}</gfc:definition>` : ''}`
      + '</gfc:FC_ListedValue></gfc:listedValue>').join('')
    + `<gfc:valueType><gco:TypeName><gco:aName>${str(VALUE_TYPE[type] || 'CharacterString')}</gco:aName></gco:TypeName></gfc:valueType>`
    + '</gfc:FC_FeatureAttribute></gfc:carrierOfCharacteristics>';
  const geometry = (c) => '<gfc:carrierOfCharacteristics><gfc:FC_FeatureAttribute>'
    + '<gfc:memberName><gco:LocalName>geometry</gco:LocalName></gfc:memberName>'
    + `<gfc:definition>${str(c.geometry === 'POINT' ? 'Lage als Punkt (WGS84 oder LV95, EPSG:2056)' : 'Fläche als Multipolygon (WGS84 oder LV95, EPSG:2056)')}</gfc:definition>`
    + '<gfc:cardinality><gco:Multiplicity><gco:range><gco:MultiplicityRange><gco:lower><gco:Integer>1</gco:Integer></gco:lower>'
    + '<gco:upper><gco:UnlimitedInteger>1</gco:UnlimitedInteger></gco:upper></gco:MultiplicityRange></gco:range></gco:Multiplicity></gfc:cardinality>'
    + `<gfc:valueType><gco:TypeName><gco:aName>${str(c.geometry === 'POINT' ? 'GM_Point' : 'GM_MultiSurface')}</gco:aName></gco:TypeName></gfc:valueType>`
    + '</gfc:FC_FeatureAttribute></gfc:carrierOfCharacteristics>';
  const types = Object.entries(COLLECTIONS).map(([id, c]) => '<gfc:featureType><gfc:FC_FeatureType>'
    + `<gfc:typeName><gco:LocalName>${esc(id)}</gco:LocalName></gfc:typeName>`
    + `<gfc:definition>${str(`${c.title}: ${c.description}`)}</gfc:definition>`
    + '<gfc:isAbstract><gco:Boolean>false</gco:Boolean></gfc:isAbstract>'
    + `<gfc:featureCatalogue uuidref="${uuid}"/>`
    + geometry(c)
    + Object.entries(c.fields).map(([name, type]) => attr(name, type, FIELDS[id]?.[name] || { def: name })).join('')
    + '</gfc:FC_FeatureType></gfc:featureType>').join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gfc:FC_FeatureCatalogue xmlns:gfc="http://www.isotc211.org/2005/gfc" xmlns:gmx="http://www.isotc211.org/2005/gmx" xmlns:gco="http://www.isotc211.org/2005/gco" xmlns:gmd="http://www.isotc211.org/2005/gmd" uuid="${uuid}">`
    + `<gmx:name>${str('Objektkatalog MyForrest')}</gmx:name>`
    + `<gmx:scope>${str('Offene Daten von MyForrest: OGC API – Features, GeoPackage und Vektorkacheln')}</gmx:scope>`
    + `<gmx:fieldOfApplication>${str('Waldveränderung, invasive Neophyten, Citizen Science')}</gmx:fieldOfApplication>`
    + `<gmx:versionNumber>${str(date)}</gmx:versionNumber>`
    + `<gmx:versionDate><gco:Date>${date}</gco:Date></gmx:versionDate>`
    + '<gmx:language><gmd:LanguageCode codeList="http://www.loc.gov/standards/iso639-2/" codeListValue="ger"/></gmx:language>'
    + '<gfc:producer><gmd:CI_ResponsibleParty>'
    + `<gmd:organisationName>${str(contact.organisation)}</gmd:organisationName>`
    + (contact.email ? `<gmd:contactInfo><gmd:CI_Contact><gmd:address><gmd:CI_Address><gmd:electronicMailAddress>${str(contact.email)}</gmd:electronicMailAddress></gmd:CI_Address></gmd:address></gmd:CI_Contact></gmd:contactInfo>` : '')
    + '<gmd:role><gmd:CI_RoleCode codeList="http://standards.iso.org/iso/19139/resources/gmxCodelists.xml#CI_RoleCode" codeListValue="originator"/></gmd:role>'
    + '</gmd:CI_ResponsibleParty></gfc:producer>'
    + types
    + '</gfc:FC_FeatureCatalogue>\n';
}

module.exports = { featureCatalogue, catalogueUuid, collectionUuid, COLLECTION_TEXT, FIELDS, LANGS };
