"""Build every scenario's station comparison map from the published analysis.

Run from any directory: python scripts/build_station_change_layers.py
No optimization or baseline values are recomputed.
"""
import json
import math
from pathlib import Path, PureWindowsPath

LAYERS = Path(__file__).resolve().parents[1] / 'frontend' / 'public' / 'layers'

def read(name):
    return json.loads((LAYERS / name).read_text(encoding='utf-8'))

def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)

def build():
    manifest = read('manifest.json')
    # Source metadata is descriptive; never publish machine-specific directories.
    sources = manifest.get('sources', {})
    for key, value in sources.items():
        if isinstance(value, list):
            sources[key] = [PureWindowsPath(item).name for item in value]
        elif isinstance(value, str):
            sources[key] = PureWindowsPath(value).name
    analysis = read('analysis.json')
    stations = {str(int(f['properties']['STATION10'])): f['geometry']
                for f in read('fire_stations.geojson')['features']
                if int(f['properties']['STATION10']) != 0}
    allocation_layers = [layer for layer in manifest['layers']
                         if layer.get('workspace') in ('historical', 'ml')
                         and layer['id'].endswith('_mvc') and not layer['id'].endswith('_non_mvc')]
    assert len(allocation_layers) == 12, 'Expected four Historical, four RF, and four XGB scenarios'
    manifest['layers'] = [layer for layer in manifest['layers'] if not layer['id'].endswith('_station_changes')]
    for allocation in allocation_layers:
        workspace = allocation['workspace']
        scenario = allocation['scenario']
        number = int(scenario.split()[1].split('.')[0])
        variant = 'Historical' if workspace == 'historical' else 'RF' if ' RF' in scenario else 'XGB'
        rows = [row for row in analysis[workspace]['stationChange']
                if row['scenario'].split(':', 1)[0] == scenario]
        assert rows, f'Missing station comparisons: {scenario}'
        by_station = {str(row['station']): row for row in rows}
        assert len(by_station) == len(rows), f'Duplicate stations: {scenario}'
        assert set(by_station) <= set(stations), f'Unknown station: {scenario}'
        # Preserve existing Scenario 3 URLs while extending the same layer to all others.
        layer_id = (f'allocation_historical_s{number}_station_changes' if workspace == 'historical'
                    else 'allocation_ml_s3_station_changes' if variant == 'RF' and number == 3
                    else f'allocation_ml_{variant.lower()}_s{number}_station_changes')
        features = []
        for station, geometry in sorted(stations.items(), key=lambda item: int(item[0])):
            row = by_station.get(station, {})
            baseline = row.get('averageBaselineSec')
            optimized = row.get('averageOptimizedSec')
            comparable = finite(baseline) and finite(optimized)
            improvement = baseline - optimized if comparable else None
            if comparable:
                assert math.isclose(row['averageChangeSec'], -improvement, abs_tol=1e-7)
            status = ('Improved' if improvement > 1e-8 else 'Worsened' if improvement < -1e-8 else 'Unchanged') if comparable else 'No MVC demand for comparison'
            properties = dict(Station_ID=int(station), Variant=variant, Scenario=scenario,
                              Baseline_MVC_Avg_sec=baseline, Scenario_MVC_Avg_sec=optimized,
                              Improvement_sec=improvement,
                              Improvement_pct=100 * improvement / baseline if comparable and baseline > 0 else None,
                              Status=status, Abs_Change=abs(improvement) if comparable else 0)
            features.append(dict(type='Feature', geometry=geometry, properties=properties))
        (LAYERS / f'{layer_id}.geojson').write_text(json.dumps(dict(type='FeatureCollection', features=features), allow_nan=False, separators=(',', ':'))+'\n', encoding='utf-8')
        manifest['layers'].append(dict(id=layer_id,
            label=f'{variant}: MVC travel time improvement and worsening by station',
            kind='circle', url=f'/layers/{layer_id}.geojson', color='#64748b', colorBy='Status',
            colorMap={'Improved':'#2ca02c', 'Worsened':'#eab308', 'Unchanged':'#64748b', 'No MVC demand for comparison':'#94a3b8'},
            sizeBy='Abs_Change', opacity=0.9, featureCount=len(features), workspace=workspace,
            scenario=scenario, scenarioTitle=allocation['scenarioTitle']))
        print(f'{variant} S{number}: {len(features)} stations, {sum(f["properties"]["Improvement_sec"] is not None for f in features)} comparable')
    (LAYERS / 'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')

if __name__ == '__main__':
    build()
