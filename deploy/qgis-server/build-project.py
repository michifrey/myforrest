#!/usr/bin/env python3
"""
Builds the QGIS project QGIS Server publishes: deploy/qgis-server/project/myforrest.qgz.

The project reads the MyForrest GeoPackage at ../data/myforrest.gpkg (relative
paths; in the container /io/project and /io/data), is in LV95 (EPSG:2056) and
carries the styles, layer metadata and the WMS/WMTS/WFS settings.

    python3 build-project.py path/to/myforrest.gpkg

Needs PyQGIS 3.28+ (e.g. `apt install python3-qgis` or the QGIS Python console).
The GeoPackage only provides the layer structure and the extent; QGIS Server
later reads whatever the export currently holds.
"""
import os
import shutil
import sys
import tempfile

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')

from qgis.core import (  # noqa: E402
    QgsApplication, QgsCoordinateReferenceSystem, QgsFillSymbol, QgsMarkerSymbol, QgsSimpleMarkerSymbolLayer,
    QgsProject, QgsProperty, QgsRectangle, QgsRuleBasedRenderer, QgsSingleSymbolRenderer, QgsSymbolLayer,
    QgsVectorLayer, QgsFeatureRequest, QgsLayerMetadata, QgsCoordinateTransform, QgsReferencedRectangle,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'project', 'myforrest.qgz')

# Colours of the web app (public/style.css), so map and app look alike.
FOREST = '#2f5d34'
GOLD = '#c99512'
NEO = '#8650c8'
DAMAGE = '#c2611d'

LAYERS = [
    # (table, title, abstract, visible), from bottom to top
    ('photos', 'Fotos',
     'Alle Fotos mit Aufnahmezeit, Blickrichtung, Tags, Lizenz und Urheber. Nur über WFS (keine Kartenebene).', False),
    ('spread_fronts', 'Ausbreitungsfronten',
     'Besiedelte Fläche pro Art und Jahr: Alpha-Shape aller Pflanzenfunde bis zu diesem Jahr, jeder Fund um 25 m '
     'gepuffert. Hellere, grössere Flächen sind jüngere Jahre. Filterbar nach scientific_name und year.', True),
    ('spots', 'Spots',
     'Orte, an denen über die Zeit Fotos entstanden sind. Grösse nach Anzahl Fotos, Pfeil in Blickrichtung, '
     'orange bei Schäden (Sturm, Borkenkäfer, Trockenheit, Holzschlag, Erosion).', True),
    ('findings', 'Pflanzenfunde',
     'Automatische Pflanzenbestimmungen (Pl@ntNet, bestes Ergebnis pro Foto ab Score 0,2). Violett: invasive '
     'Neophyten.', True),
]

DAMAGE_TAGS = ['sturmschaden', 'borkenkaefer', 'trockenheit', 'holzschlag', 'erosion', 'frostschaden']


def style_fronts(layer):
    """One polygon per species and year, coloured from light (old) to dark violet (new); older on top."""
    symbol = QgsFillSymbol.createSimple({
        'color': '134,80,200,40', 'outline_color': NEO, 'outline_width': '0.5', 'outline_width_unit': 'MM',
    })
    sl = symbol.symbolLayer(0)
    ramp = ("ramp_color('Purples', scale_linear(\"year\", minimum(\"year\", group_by:=\"scientific_name\"), "
            "maximum(\"year\", group_by:=\"scientific_name\") + 0.001, 0.35, 0.95))")
    sl.setDataDefinedProperty(QgsSymbolLayer.PropertyStrokeColor, QgsProperty.fromExpression(ramp))
    sl.setDataDefinedProperty(QgsSymbolLayer.PropertyFillColor, QgsProperty.fromExpression(f'set_color_part({ramp}, \'alpha\', 45)'))
    renderer = QgsRuleBasedRenderer(QgsRuleBasedRenderer.Rule(None))
    renderer.rootRule().appendChild(QgsRuleBasedRenderer.Rule(symbol, 0, 0, '', 'nach Jahr: hell = früher, dunkel = neuer'))
    # Newest (largest) first, so the older, smaller outlines stay visible on top.
    renderer.setOrderBy(QgsFeatureRequest.OrderBy([QgsFeatureRequest.OrderByClause('year', False)]))
    renderer.setOrderByEnabled(True)
    layer.setRenderer(renderer)


def spot_symbol(colour):
    """Circle sized by photo count with a gold arrow in viewing direction."""
    symbol = QgsMarkerSymbol.createSimple({
        'name': 'circle', 'color': colour, 'outline_color': '#ffffff', 'outline_width': '0.4', 'size': '3',
    })
    symbol.symbolLayer(0).setDataDefinedProperty(QgsSymbolLayer.PropertySize, QgsProperty.fromExpression(
        'scale_linear(coalesce("photos", 1), 1, 20, 2.6, 5.5)'))
    # The arrowhead points east (+x); turned to the heading and pushed forward so its tip sticks out
    # (QGIS turns the offset together with the marker, so a fixed forward offset follows the heading).
    arrow = QgsSimpleMarkerSymbolLayer.create({
        'name': 'filled_arrowhead', 'color': GOLD, 'outline_color': '#ffffff', 'outline_width': '0.2', 'size': '3',
        'offset': '3.4,0', 'offset_unit': 'MM',
    })
    arrow.setDataDefinedProperty(QgsSymbolLayer.PropertyAngle, QgsProperty.fromExpression('"heading" - 90'))
    arrow.setDataDefinedProperty(QgsSymbolLayer.PropertyLayerEnabled, QgsProperty.fromExpression('"heading" IS NOT NULL'))
    symbol.insertSymbolLayer(0, arrow)
    return symbol


def style_spots(layer):
    """Orange with damage tags (storm, bark beetle, drought, logging, erosion, frost), green otherwise."""
    damage = ' OR '.join(f"\"tags\" LIKE '%{t}%'" for t in DAMAGE_TAGS)
    root = QgsRuleBasedRenderer.Rule(None)
    root.appendChild(QgsRuleBasedRenderer.Rule(spot_symbol(FOREST), 0, 0, f'NOT ({damage}) OR "tags" IS NULL', 'Ohne Befund'))
    root.appendChild(QgsRuleBasedRenderer.Rule(spot_symbol(DAMAGE), 0, 0, damage, 'Mit Schäden'))
    layer.setRenderer(QgsRuleBasedRenderer(root))


def style_findings(layer):
    """Neophytes as violet diamonds, other plants as small green dots."""
    root = QgsRuleBasedRenderer.Rule(None)
    neo = QgsMarkerSymbol.createSimple({'name': 'diamond', 'color': NEO, 'outline_color': '#ffffff', 'outline_width': '0.3', 'size': '3.2'})
    other = QgsMarkerSymbol.createSimple({'name': 'circle', 'color': '#5c8f4a', 'outline_color': '#ffffff', 'outline_width': '0.2', 'size': '2'})
    root.appendChild(QgsRuleBasedRenderer.Rule(other, 0, 0, '"neophyte" = 0', 'Andere Pflanzen'))
    root.appendChild(QgsRuleBasedRenderer.Rule(neo, 0, 0, '"neophyte" = 1', 'Neophyten'))
    layer.setRenderer(QgsRuleBasedRenderer(root))


def style_photos(layer):
    layer.setRenderer(QgsSingleSymbolRenderer(QgsMarkerSymbol.createSimple({
        'name': 'circle', 'color': '#ffffff', 'outline_color': FOREST, 'outline_width': '0.4', 'size': '1.6',
    })))


STYLES = {'spread_fronts': style_fronts, 'spots': style_spots, 'findings': style_findings, 'photos': style_photos}


def main(gpkg):
    qgs = QgsApplication([], False)
    qgs.initQgis()
    work = tempfile.mkdtemp()
    try:
        # Build in a copy of the container layout so the saved paths are ../data/myforrest.gpkg.
        os.makedirs(os.path.join(work, 'project'))
        os.makedirs(os.path.join(work, 'data'))
        shutil.copy(gpkg, os.path.join(work, 'data', 'myforrest.gpkg'))
        data = os.path.join(work, 'data', 'myforrest.gpkg')

        project = QgsProject.instance()
        project.setTitle('MyForrest – Wald im Wandel')
        project.setCrs(QgsCoordinateReferenceSystem('EPSG:2056'))
        project.writeEntry('Paths', 'Absolute', False)

        lv95 = QgsCoordinateReferenceSystem('EPSG:2056')
        extent = QgsRectangle()
        wfs_ids = []
        for table, title, abstract, visible in LAYERS:
            layer = QgsVectorLayer(f'{data}|layername={table}', title, 'ogr')
            if not layer.isValid():
                raise SystemExit(f'Layer {table} fehlt im GeoPackage')
            layer.setShortName(table)  # WMS/WFS name
            layer.setTitle(title)
            layer.setAbstract(abstract)
            meta = QgsLayerMetadata()
            meta.setTitle(title)
            meta.setAbstract(abstract)
            meta.setLicenses(['Fotos und Funde: Lizenz pro Objekt im Attribut "license" (Standard CC BY-SA 4.0)'])
            layer.setMetadata(meta)
            STYLES[table](layer)
            project.addMapLayer(layer, False)
            node = project.layerTreeRoot().insertLayer(0, layer)
            node.setItemVisibilityChecked(visible)
            wfs_ids.append(layer.id())
            if layer.featureCount():
                e = QgsCoordinateTransform(layer.crs(), lv95, project).transformBoundingBox(layer.extent())
                extent.combineExtentWith(e)
            # WFS: 2 decimals = cm in LV95.
            project.writeEntry('WFSLayersPrecision', '/' + layer.id(), 2)
        if extent.isEmpty():
            extent = QgsRectangle(2485000, 1075000, 2834000, 1296000)  # Switzerland
        extent.grow(max(extent.width(), extent.height()) * 0.1 + 200)
        project.viewSettings().setDefaultViewExtent(QgsReferencedRectangle(extent, lv95))

        # --- QGIS Server: service metadata ---
        project.writeEntry('WMSServiceCapabilities', '/', True)
        project.writeEntry('WMSServiceTitle', '/', 'MyForrest – Wald im Wandel')
        project.writeEntry('WMSServiceAbstract', '/',
                           'Fotos vom Joggen, Wandern und Biken dokumentieren Veränderungen des Waldes über die Zeit: '
                           'Spots, Pflanzenfunde mit Neophyten und Ausbreitungsfronten.')
        project.writeEntry('WMSKeywordList', '/', ['Wald', 'Neophyten', 'Waldschäden', 'Citizen Science', 'Monitoring'])
        project.writeEntry('WMSFees', '/', 'keine')
        project.writeEntry('WMSAccessConstraints', '/',
                           'Fotos und Funde unter der Lizenz im Attribut "license" (Standard CC BY-SA 4.0), Quelle: MyForrest')
        project.writeEntry('WMSContactOrganization', '/', 'MyForrest')
        project.writeEntry('WMSUseLayerIDs', '/', False)
        project.writeEntry('WMSAddWktGeometry', '/', True)
        project.writeEntry('WMSFeatureInfoUseAttributeFormSettings', '/', True)
        project.writeEntry('WMSPrecision', '/', '2')
        project.writeEntry('WMSCrsList', '/', ['EPSG:2056', 'EPSG:4326', 'EPSG:3857', 'EPSG:21781'])
        project.writeEntry('WMSRestrictedComposers', '/', [])
        project.writeEntry('WMSExtent', '/', [str(round(v)) for v in (extent.xMinimum(), extent.yMinimum(), extent.xMaximum(), extent.yMaximum())])
        project.writeEntry('WMSRootName', '/', 'myforrest')
        # Photos are data, not a map layer: WFS only (otherwise a root-group GetMap would draw them over everything).
        project.writeEntry('WMSRestrictedLayers', '/', ['Fotos'])

        # WFS: all layers readable, not editable.
        project.writeEntry('WFSLayers', '/', wfs_ids)
        # WMTS: the project as a whole and every layer, in LV95 and Web Mercator.
        project.writeEntry('WMTSLayers', 'Project', True)
        project.writeEntry('WMTSPngLayers', 'Project', True)
        project.writeEntry('WMTSJpegLayers', 'Project', False)
        for layer_id in wfs_ids[1:]:  # all but the photos
            project.writeEntry('WMTSLayers', 'Layer', [*project.readListEntry('WMTSLayers', 'Layer')[0], layer_id])
            project.writeEntry('WMTSPngLayers', 'Layer', [*project.readListEntry('WMTSPngLayers', 'Layer')[0], layer_id])
        project.writeEntry('WMTSGrids', 'CRS', ['EPSG:2056', 'EPSG:3857'])
        project.writeEntry('WMTSGrids', 'Config', [
            # crs, top, left, scale denominator of the top level, levels
            'EPSG:2056,1350000,2420000,2000000,10',
            'EPSG:3857,20037508.342789248,-20037508.342789248,559082264.0287179,20',
        ])
        project.writeEntry('WMTSMinScale', '/', 5000)

        out = os.path.join(work, 'project', 'myforrest.qgz')
        if not project.write(out):
            raise SystemExit('Projekt konnte nicht gespeichert werden')
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        shutil.copy(out, OUT)
        print(f'Gespeichert: {OUT}')
    finally:
        QgsProject.instance().clear()
        qgs.exitQgis()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(os.path.abspath(sys.argv[1]))
