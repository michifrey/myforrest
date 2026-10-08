'use strict';

/**
 * Metadata record of the MyForrest dataset in ISO 19115/19139, for
 * geocat.ch (and from there opendata.swiss) or any other catalogue.
 *
 *   profile 'che'  the Swiss profile GM03 (ISO19139.che), geocat.ch's native format:
 *                  che:CHE_MD_Metadata, che:CHE_MD_DataIdentification, …
 *   profile 'iso'  plain ISO 19139 (gmd:MD_Metadata) for other catalogues
 *
 * Title, abstract, purpose, keywords and lineage come in German, French,
 * Italian and English (PT_FreeText): the federal rules of geocat.ch ask for
 * at least German and French. Extent, dates and online resources are taken
 * from the data and the server's address.
 */

const crypto = require('node:crypto');

const NS = {
  gmd: 'http://www.isotc211.org/2005/gmd',
  gco: 'http://www.isotc211.org/2005/gco',
  gml: 'http://www.opengis.net/gml/3.2',
  gmx: 'http://www.isotc211.org/2005/gmx',
  xlink: 'http://www.w3.org/1999/xlink',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  che: 'http://www.geocat.ch/2008/che',
};
const CODELISTS = 'http://standards.iso.org/iso/19139/resources/gmxCodelists.xml';
const LANGUAGES = [['DE', 'ger'], ['FR', 'fre'], ['IT', 'ita'], ['EN', 'eng']];

/* ---------- Texts ---------- */

const TEXT = {
  title: {
    DE: 'MyForrest – Waldveränderung aus Wiederholungsfotos',
    FR: 'MyForrest – Évolution de la forêt à partir de photos répétées',
    IT: 'MyForrest – Cambiamenti del bosco da fotografie ripetute',
    EN: 'MyForrest – Forest change from repeat photographs',
  },
  alternateTitle: { DE: 'MyForrest', FR: 'MyForrest', IT: 'MyForrest', EN: 'MyForrest' },
  abstract: {
    DE: 'Fotos, die Freiwillige beim Joggen, Wandern und Biken immer wieder vom selben Standort aus aufnehmen – '
      + 'eine Art «Street View für die Natur über die Zeit». Der Datensatz enthält die Standorte (Spots) mit '
      + 'Blickrichtung und Schadensbefund, die einzelnen Fotos mit Aufnahmezeit und Lizenz, automatisch bestimmte '
      + 'Pflanzenfunde mit markierten invasiven Neophyten sowie daraus abgeleitete Ausbreitungsfronten pro Art und Jahr.',
    FR: 'Photos prises à maintes reprises depuis le même endroit par des bénévoles lors de leur jogging, de leurs '
      + 'randonnées ou de leurs sorties à vélo – une sorte de «Street View de la nature au fil du temps». Le jeu de '
      + 'données contient les emplacements (spots) avec direction de prise de vue et constat de dégâts, les photos '
      + 'avec date et licence, les plantes déterminées automatiquement avec les néophytes envahissantes signalées, '
      + 'ainsi que les fronts de propagation par espèce et par année qui en sont dérivés.',
    IT: 'Fotografie scattate ripetutamente dallo stesso punto da volontari durante corsa, escursioni e giri in '
      + 'bicicletta – una sorta di «Street View della natura nel tempo». Il set di dati contiene i punti di ripresa '
      + '(spot) con direzione di ripresa e constatazione dei danni, le singole foto con data e licenza, le piante '
      + 'determinate automaticamente con le neofite invasive segnalate e i fronti di diffusione per specie e anno '
      + 'che ne derivano.',
    EN: 'Photos that volunteers take again and again from the same spot while jogging, hiking and biking – a kind '
      + 'of “Street View for nature over time”. The dataset contains the locations (spots) with viewing direction '
      + 'and damage status, the individual photos with time and licence, automatically identified plants with '
      + 'invasive neophytes flagged, and the spread fronts per species and year derived from them.',
  },
  purpose: {
    DE: 'Veränderungen im Wald – Sturm-, Trockenheits- und Borkenkäferschäden, Holzschläge, die Ausbreitung invasiver '
      + 'Neophyten – über Jahre sichtbar und für Forschung, Forstdienste und Naturschutz nutzbar machen.',
    FR: 'Rendre visibles sur plusieurs années les changements en forêt – dégâts de tempête, de sécheresse et de '
      + 'scolytes, coupes, propagation des néophytes envahissantes – et les mettre à disposition de la recherche, '
      + 'des services forestiers et de la protection de la nature.',
    IT: 'Rendere visibili nel corso degli anni i cambiamenti nel bosco – danni da tempesta, siccità e bostrico, tagli, '
      + 'diffusione delle neofite invasive – e metterli a disposizione della ricerca, dei servizi forestali e della '
      + 'protezione della natura.',
    EN: 'Make changes in the forest – storm, drought and bark beetle damage, logging, the spread of invasive '
      + 'neophytes – visible over the years and usable for research, forest services and nature conservation.',
  },
  lineage: {
    DE: 'Fotos mit GPS-Position aus Smartphones und Kameras, hochgeladen von Freiwilligen (Citizen Science). Fotos '
      + 'innerhalb von 25 m und mit ähnlicher Blickrichtung werden zu Spots zusammengefasst. Pflanzen bestimmt '
      + 'Pl@ntNet automatisch (bestes Ergebnis pro Foto ab Score 0,2), invasive Neophyten nach der Liste von '
      + 'Info Flora. Ausbreitungsfronten sind Alpha-Shapes aller Funde einer Art bis zum jeweiligen Jahr mit 25 m '
      + 'Puffer. Von der Moderation ausgeblendete Fotos sind nicht enthalten.',
    FR: 'Photos géolocalisées par GPS prises avec des smartphones et des appareils photo et téléchargées par des '
      + 'bénévoles (science citoyenne). Les photos à moins de 25 m et de direction similaire sont regroupées en '
      + 'spots. Les plantes sont déterminées automatiquement par Pl@ntNet (meilleur résultat par photo à partir d’un '
      + 'score de 0,2), les néophytes envahissantes selon la liste d’Info Flora. Les fronts de propagation sont des '
      + 'alpha-shapes de toutes les observations d’une espèce jusqu’à l’année concernée, avec une zone tampon de 25 m. '
      + 'Les photos masquées par la modération ne sont pas incluses.',
    IT: 'Foto con posizione GPS da smartphone e fotocamere, caricate da volontari (citizen science). Le foto entro '
      + '25 m e con direzione di ripresa simile sono raggruppate in spot. Le piante sono determinate automaticamente '
      + 'da Pl@ntNet (miglior risultato per foto da un punteggio di 0,2), le neofite invasive secondo la lista di '
      + 'Info Flora. I fronti di diffusione sono alpha shape di tutti i ritrovamenti di una specie fino all’anno '
      + 'considerato, con un buffer di 25 m. Le foto nascoste dalla moderazione non sono incluse.',
    EN: 'Photos with GPS position from smartphones and cameras, uploaded by volunteers (citizen science). Photos '
      + 'within 25 m and with a similar viewing direction are grouped into spots. Plants are identified '
      + 'automatically by Pl@ntNet (best result per photo from a score of 0.2), invasive neophytes according to the '
      + 'Info Flora list. Spread fronts are alpha shapes of all findings of a species up to the year, with a 25 m '
      + 'buffer. Photos hidden by moderators are not included.',
  },
  keywords: [
    { DE: 'Wald', FR: 'forêt', IT: 'bosco', EN: 'forest' },
    { DE: 'Waldschäden', FR: 'dégâts aux forêts', IT: 'danni forestali', EN: 'forest damage' },
    { DE: 'Borkenkäfer', FR: 'scolytes', IT: 'bostrico', EN: 'bark beetle' },
    { DE: 'invasive Neophyten', FR: 'néophytes envahissantes', IT: 'neofite invasive', EN: 'invasive neophytes' },
    { DE: 'Wiederholungsfotografie', FR: 'photographie répétée', IT: 'fotografia ripetuta', EN: 'repeat photography' },
    { DE: 'Citizen Science', FR: 'science citoyenne', IT: 'citizen science', EN: 'citizen science' },
  ],
};

/** Online resources: path, protocol, function, format, descriptions. */
const RESOURCES = [
  {
    path: '/ogc', protocol: 'WWW:LINK', fn: 'information', name: 'OGC API – Features',
    text: {
      DE: 'OGC API – Features: alle Collections als GeoJSON, in WGS84 und LV95 (EPSG:2056)',
      FR: 'OGC API – Features : toutes les collections en GeoJSON, en WGS84 et MN95 (EPSG:2056)',
      IT: 'OGC API – Features: tutte le collezioni in GeoJSON, in WGS84 e MN95 (EPSG:2056)',
      EN: 'OGC API – Features: all collections as GeoJSON, in WGS84 and LV95 (EPSG:2056)',
    },
  },
  {
    path: '/ogc/tiles', protocol: 'WWW:LINK', fn: 'information', name: 'OGC API – Tiles',
    text: {
      DE: 'Vektorkacheln (OGC API – Tiles, Mapbox Vector Tiles) im Kachelgitter WebMercatorQuad und LV95 von swisstopo',
      FR: 'Tuiles vectorielles (OGC API – Tiles, Mapbox Vector Tiles) dans les grilles WebMercatorQuad et MN95 de swisstopo',
      IT: 'Tasselli vettoriali (OGC API – Tiles, Mapbox Vector Tiles) nelle griglie WebMercatorQuad e MN95 di swisstopo',
      EN: 'Vector tiles (OGC API – Tiles, Mapbox Vector Tiles) in the WebMercatorQuad grid and swisstopo’s LV95 grid',
    },
  },
  {
    path: '/api/export/myforrest.gpkg', protocol: 'WWW:DOWNLOAD-URL', fn: 'download', name: 'myforrest.gpkg',
    text: {
      DE: 'Download: alle Collections als GeoPackage (LV95)',
      FR: 'Téléchargement : toutes les collections en GeoPackage (MN95)',
      IT: 'Download: tutte le collezioni come GeoPackage (MN95)',
      EN: 'Download: all collections as GeoPackage (LV95)',
    },
  },
  {
    path: '/api/export/myforrest.pmtiles', protocol: 'WWW:DOWNLOAD-URL', fn: 'download', name: 'myforrest.pmtiles',
    text: {
      DE: 'Download: Vektorkacheln als PMTiles (WebMercatorQuad, für statisches Hosting)',
      FR: 'Téléchargement : tuiles vectorielles en PMTiles (WebMercatorQuad, pour un hébergement statique)',
      IT: 'Download: tasselli vettoriali come PMTiles (WebMercatorQuad, per hosting statico)',
      EN: 'Download: vector tiles as PMTiles (WebMercatorQuad, for static hosting)',
    },
  },
  {
    path: '/api/export/myforrest.mbtiles', protocol: 'WWW:DOWNLOAD-URL', fn: 'download', name: 'myforrest.mbtiles',
    text: {
      DE: 'Download: Vektorkacheln als MBTiles (WebMercatorQuad)',
      FR: 'Téléchargement : tuiles vectorielles en MBTiles (WebMercatorQuad)',
      IT: 'Download: tasselli vettoriali come MBTiles (WebMercatorQuad)',
      EN: 'Download: vector tiles as MBTiles (WebMercatorQuad)',
    },
  },
  {
    path: '/vektorkarte-lv95.html', protocol: 'MAP:Preview', fn: 'browsing', name: 'Vektorkarte LV95',
    text: {
      DE: 'Kartenansicht auf der Landeskarte von swisstopo',
      FR: 'Visualisation sur la carte nationale de swisstopo',
      IT: 'Visualizzazione sulla carta nazionale di swisstopo',
      EN: 'Map view on swisstopo’s national map',
    },
  },
  {
    path: '/', protocol: 'WWW:LINK', fn: 'information', name: 'MyForrest',
    text: {
      DE: 'Webanwendung: Fotos ansehen, vergleichen und hochladen',
      FR: 'Application web : consulter, comparer et téléverser des photos',
      IT: 'Applicazione web: guardare, confrontare e caricare foto',
      EN: 'Web application: view, compare and upload photos',
    },
  },
];

/** QGIS Server services (deploy/qgis-server), when their address is configured. */
const OWS = [
  ['OGC:WMS', 'WMS', { DE: 'Darstellungsdienst (WMS) mit den Stilen von MyForrest', FR: 'Service de visualisation (WMS) avec les styles de MyForrest', IT: 'Servizio di visualizzazione (WMS) con gli stili di MyForrest', EN: 'View service (WMS) with MyForrest’s styles' }],
  ['OGC:WMTS', 'WMTS', { DE: 'Kachelkartendienst (WMTS) in LV95 und Web Mercator', FR: 'Service de tuiles (WMTS) en MN95 et Web Mercator', IT: 'Servizio a tasselli (WMTS) in MN95 e Web Mercator', EN: 'Tile service (WMTS) in LV95 and Web Mercator' }],
  ['OGC:WFS', 'WFS', { DE: 'Downloaddienst (WFS)', FR: 'Service de téléchargement (WFS)', IT: 'Servizio di download (WFS)', EN: 'Download service (WFS)' }],
];

const FORMATS = [['GeoJSON', 'RFC 7946'], ['GeoPackage', '1.3'], ['Mapbox Vector Tiles', '2.1'], ['PMTiles', '3'], ['MBTiles', '1.3']];

/* ---------- XML helpers ---------- */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const str = (v) => `<gco:CharacterString>${esc(v)}</gco:CharacterString>`;
const code = (list, value) => `<gmd:${list} codeList="${CODELISTS}#${list}" codeListValue="${value}"/>`;
/** German as the main text, all four languages as PT_FreeText. */
const free = (el, t) => `<gmd:${el} xsi:type="gmd:PT_FreeText_PropertyType">${str(t.DE)}<gmd:PT_FreeText>${
  LANGUAGES.map(([id]) => `<gmd:textGroup><gmd:LocalisedCharacterString locale="#${id}">${esc(t[id])}</gmd:LocalisedCharacterString></gmd:textGroup>`).join('')
}</gmd:PT_FreeText></gmd:${el}>`;
const date = (d, type) => `<gmd:date><gmd:CI_Date><gmd:date><gco:Date>${d}</gco:Date></gmd:date><gmd:dateType>${code('CI_DateTypeCode', type)}</gmd:dateType></gmd:CI_Date></gmd:date>`;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const deg = (v) => `<gco:Decimal>${Math.round(v * 1e6) / 1e6}</gco:Decimal>`;

/** A stable identifier for the record of this server: METADATA_UUID, else derived from the base URL (UUID v5 style). */
function recordUuid(base, configured) {
  if (configured) return configured;
  const h = crypto.createHash('sha1').update(`myforrest-metadata:${base}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Terms of use of opendata.swiss (https://opendata.swiss/de/terms-of-use). */
const OPENDATA_TERMS = ['terms_open', 'terms_by', 'terms_ask', 'terms_by_ask'];

/**
 * The record as XML.
 *
 * info: { base, bbox: [w, s, e, n] (WGS84), firstPhoto, lastPhoto, created, updated (ms) }
 * contact: { organisation, email, city, country, url }
 * options: { profile: 'che' | 'iso', uuid, owsUrl, opendataTerms, licenseUrl, licenseLabel }
 */
function metadataRecord(info, contact, options = {}) {
  const che = options.profile !== 'iso';
  const el = (cheName, isoName) => (che ? [`che:${cheName}`, ` gco:isoType="gmd:${isoName}"`] : [`gmd:${isoName}`, '']);
  const [root, rootIso] = el('CHE_MD_Metadata', 'MD_Metadata');
  const [party, partyIso] = el('CHE_CI_ResponsibleParty', 'CI_ResponsibleParty');
  const [ident, identIso] = el('CHE_MD_DataIdentification', 'MD_DataIdentification');
  const [legal, legalIso] = el('CHE_MD_LegalConstraints', 'MD_LegalConstraints');
  const { base } = info;
  const terms = OPENDATA_TERMS.includes(options.opendataTerms) ? options.opendataTerms : null;

  const responsible = (role) => `<${party}${partyIso}>`
    + `<gmd:organisationName>${str(contact.organisation)}</gmd:organisationName>`
    + '<gmd:contactInfo><gmd:CI_Contact><gmd:address><gmd:CI_Address>'
    + (contact.city ? `<gmd:city>${str(contact.city)}</gmd:city>` : '')
    + `<gmd:country>${str(contact.country || 'CH')}</gmd:country>`
    + (contact.email ? `<gmd:electronicMailAddress>${str(contact.email)}</gmd:electronicMailAddress>` : '')
    + '</gmd:CI_Address></gmd:address>'
    + `<gmd:onlineResource><gmd:CI_OnlineResource><gmd:linkage><gmd:URL>${esc(contact.url || `${base}/`)}</gmd:URL></gmd:linkage></gmd:CI_OnlineResource></gmd:onlineResource>`
    + '</gmd:CI_Contact></gmd:contactInfo>'
    + `<gmd:role>${code('CI_RoleCode', role)}</gmd:role></${party}>`;

  const online = ({ url, protocol, fn, name, text }) => '<gmd:onLine><gmd:CI_OnlineResource>'
    + `<gmd:linkage><gmd:URL>${esc(url)}</gmd:URL></gmd:linkage>`
    + `<gmd:protocol>${str(protocol)}</gmd:protocol>`
    + `<gmd:name>${str(name)}</gmd:name>`
    + free('description', text)
    + `<gmd:function>${code('CI_OnLineFunctionCode', fn)}</gmd:function>`
    + '</gmd:CI_OnlineResource></gmd:onLine>';
  const resources = [
    ...RESOURCES.map((r) => ({ ...r, url: `${base}${r.path}` })),
    ...(options.owsUrl ? OWS.map(([protocol, service, text]) => ({
      url: `${options.owsUrl}?SERVICE=${service}&REQUEST=GetCapabilities`, protocol, fn: 'information', name: 'myforrest', text,
    })) : []),
  ];

  const [w, s, e, n] = info.bbox;
  const topics = che ? ['biota', 'environment', 'environment_NatureProtection'] : ['biota', 'environment'];
  const licenseText = {
    DE: `Lizenz: ${options.licenseLabel}. Jedes Foto trägt seine eigene Lizenz (Standard ${options.licenseLabel}); Quellenangabe: «MyForrest-Mitwirkende».`,
    FR: `Licence : ${options.licenseLabel}. Chaque photo a sa propre licence (par défaut ${options.licenseLabel}) ; mention de la source : «contributeurs MyForrest».`,
    IT: `Licenza: ${options.licenseLabel}. Ogni foto ha la propria licenza (predefinita ${options.licenseLabel}); indicazione della fonte: «contributori MyForrest».`,
    EN: `Licence: ${options.licenseLabel}. Each photo has its own licence (default ${options.licenseLabel}); attribution: “MyForrest contributors”.`,
  };

  return `<?xml version="1.0" encoding="UTF-8"?>
<${root}${rootIso} xmlns:gmd="${NS.gmd}" xmlns:gco="${NS.gco}" xmlns:gml="${NS.gml}" xmlns:gmx="${NS.gmx}" xmlns:xlink="${NS.xlink}" xmlns:xsi="${NS.xsi}"${che ? ` xmlns:che="${NS.che}"` : ''}>`
    + `<gmd:fileIdentifier>${str(recordUuid(base, options.uuid))}</gmd:fileIdentifier>`
    + `<gmd:language><gmd:LanguageCode codeList="http://www.loc.gov/standards/iso639-2/" codeListValue="ger"/></gmd:language>`
    + `<gmd:characterSet>${code('MD_CharacterSetCode', 'utf8')}</gmd:characterSet>`
    + `<gmd:hierarchyLevel>${code('MD_ScopeCode', 'dataset')}</gmd:hierarchyLevel>`
    + `<gmd:contact>${responsible('pointOfContact')}</gmd:contact>`
    + `<gmd:dateStamp><gco:DateTime>${new Date(info.updated).toISOString().slice(0, 19)}</gco:DateTime></gmd:dateStamp>`
    + `<gmd:metadataStandardName>${str(che ? 'GM03 2+ (ISO 19115:2003 / ISO 19139, SN 612050)' : 'ISO 19115:2003/19139')}</gmd:metadataStandardName>`
    + `<gmd:metadataStandardVersion>${str(che ? '2+' : '1.0')}</gmd:metadataStandardVersion>`
    + `<gmd:dataSetURI>${str(`${base}/ogc`)}</gmd:dataSetURI>`
    + LANGUAGES.map(([id, iso3]) => `<gmd:locale><gmd:PT_Locale id="${id}"><gmd:languageCode><gmd:LanguageCode codeList="http://www.loc.gov/standards/iso639-2/" codeListValue="${iso3}"/></gmd:languageCode>`
      + `<gmd:characterEncoding>${code('MD_CharacterSetCode', 'utf8')}</gmd:characterEncoding></gmd:PT_Locale></gmd:locale>`).join('')
    + ['EPSG:2056', 'EPSG:4326'].map((c) => `<gmd:referenceSystemInfo><gmd:MD_ReferenceSystem><gmd:referenceSystemIdentifier><gmd:RS_Identifier><gmd:code>${str(c)}</gmd:code></gmd:RS_Identifier></gmd:referenceSystemIdentifier></gmd:MD_ReferenceSystem></gmd:referenceSystemInfo>`).join('')
    + `<gmd:identificationInfo><${ident}${identIso}>`
    + '<gmd:citation><gmd:CI_Citation>'
    + free('title', TEXT.title) + free('alternateTitle', TEXT.alternateTitle)
    + date(day(info.created), 'creation') + date(day(info.updated), 'revision')
    + `<gmd:identifier><gmd:MD_Identifier><gmd:code>${str(`${base}/ogc`)}</gmd:code></gmd:MD_Identifier></gmd:identifier>`
    + `<gmd:citedResponsibleParty>${responsible('owner')}</gmd:citedResponsibleParty>`
    + '</gmd:CI_Citation></gmd:citation>'
    + free('abstract', TEXT.abstract) + free('purpose', TEXT.purpose)
    + `<gmd:status>${code('MD_ProgressCode', 'onGoing')}</gmd:status>`
    + `<gmd:pointOfContact>${responsible('pointOfContact')}</gmd:pointOfContact>`
    + `<gmd:resourceMaintenance><gmd:MD_MaintenanceInformation><gmd:maintenanceAndUpdateFrequency>${code('MD_MaintenanceFrequencyCode', 'continual')}</gmd:maintenanceAndUpdateFrequency></gmd:MD_MaintenanceInformation></gmd:resourceMaintenance>`
    + '<gmd:descriptiveKeywords><gmd:MD_Keywords>'
    + TEXT.keywords.map((k) => free('keyword', k)).join('')
    + (terms ? `<gmd:keyword>${str('opendata.swiss')}</gmd:keyword>` : '')
    + `<gmd:type>${code('MD_KeywordTypeCode', 'theme')}</gmd:type>`
    + '</gmd:MD_Keywords></gmd:descriptiveKeywords>'
    + `<gmd:resourceConstraints><${legal}${legalIso}>`
    + free('useLimitation', licenseText)
    + `<gmd:accessConstraints>${code('MD_RestrictionCode', 'otherRestrictions')}</gmd:accessConstraints>`
    + `<gmd:useConstraints>${code('MD_RestrictionCode', 'otherRestrictions')}</gmd:useConstraints>`
    + `<gmd:otherConstraints><gmx:Anchor xlink:href="${esc(options.licenseUrl)}">${esc(options.licenseLabel)}</gmx:Anchor></gmd:otherConstraints>`
    + (terms ? `<gmd:otherConstraints><gmx:Anchor xlink:href="https://opendata.swiss/en/terms-of-use/#${terms}">opendata.swiss ${terms}</gmx:Anchor></gmd:otherConstraints>` : '')
    + `</${legal}></gmd:resourceConstraints>`
    + `<gmd:spatialRepresentationType><gmd:MD_SpatialRepresentationTypeCode codeList="${CODELISTS}#MD_SpatialRepresentationTypeCode" codeListValue="vector"/></gmd:spatialRepresentationType>`
    + `<gmd:language><gmd:LanguageCode codeList="http://www.loc.gov/standards/iso639-2/" codeListValue="ger"/></gmd:language>`
    + `<gmd:characterSet>${code('MD_CharacterSetCode', 'utf8')}</gmd:characterSet>`
    + topics.map((t) => `<gmd:topicCategory><gmd:MD_TopicCategoryCode>${t}</gmd:MD_TopicCategoryCode></gmd:topicCategory>`).join('')
    + '<gmd:extent><gmd:EX_Extent>'
    + `<gmd:geographicElement><gmd:EX_GeographicBoundingBox><gmd:westBoundLongitude>${deg(w)}</gmd:westBoundLongitude><gmd:eastBoundLongitude>${deg(e)}</gmd:eastBoundLongitude>`
    + `<gmd:southBoundLatitude>${deg(s)}</gmd:southBoundLatitude><gmd:northBoundLatitude>${deg(n)}</gmd:northBoundLatitude></gmd:EX_GeographicBoundingBox></gmd:geographicElement>`
    + (info.firstPhoto ? `<gmd:temporalElement><gmd:EX_TemporalExtent><gmd:extent><gml:TimePeriod gml:id="photos"><gml:beginPosition>${day(info.firstPhoto)}</gml:beginPosition>`
      + `<gml:endPosition>${day(info.lastPhoto)}</gml:endPosition></gml:TimePeriod></gmd:extent></gmd:EX_TemporalExtent></gmd:temporalElement>` : '')
    + '</gmd:EX_Extent></gmd:extent>'
    + `</${ident}></gmd:identificationInfo>`
    + '<gmd:distributionInfo><gmd:MD_Distribution>'
    + FORMATS.map(([name, version]) => `<gmd:distributionFormat><gmd:MD_Format><gmd:name>${str(name)}</gmd:name><gmd:version>${str(version)}</gmd:version></gmd:MD_Format></gmd:distributionFormat>`).join('')
    + `<gmd:transferOptions><gmd:MD_DigitalTransferOptions>${resources.map(online).join('')}</gmd:MD_DigitalTransferOptions></gmd:transferOptions>`
    + '</gmd:MD_Distribution></gmd:distributionInfo>'
    + '<gmd:dataQualityInfo><gmd:DQ_DataQuality>'
    + `<gmd:scope><gmd:DQ_Scope><gmd:level>${code('MD_ScopeCode', 'dataset')}</gmd:level></gmd:DQ_Scope></gmd:scope>`
    + `<gmd:lineage><gmd:LI_Lineage>${free('statement', TEXT.lineage)}</gmd:LI_Lineage></gmd:lineage>`
    + '</gmd:DQ_DataQuality></gmd:dataQualityInfo>'
    + `</${root}>\n`;
}

module.exports = { metadataRecord, recordUuid, OPENDATA_TERMS };
