import type { Workspace, BasemapMode, Study, LayerDefinition, TravelTimeRow, ContextInfoData, AnalysisData } from "./types";
import { isStationZeroLabel, isFireStationZero, stationSortValue, averageNumbers, numericValue, manualWeightedAverage, attributeLabel, displayAttribute, displayLabel } from "./formatting";
import { AttributeTable } from "./components/AttributeTable";
import { valueLabel, CoverageLineChart, TravelTimeChart, StationAnalysisChart, ManualScenarioSummary, ManualStationAnalysisChart, ScenarioBarChart, ExistingMetricLineChart } from "./components/Charts";
import { useEffect, useMemo, useRef, useState } from "react";

import maplibregl, { Map } from "maplibre-gl";

import type { ManualAllocationGeoJSON, ManualAllocationResult } from "./manualOptimizer";

const DEFAULT_WEIGHTS = { mvcTime: 0.60, mvcPaths: 0.20, nonMvcTime: 0.20 };
const DEFAULT_MANUAL_SETTINGS = { mvcLower: 0, mvcUpper: 1.3, nonMvcLower: 0, nonMvcUpper: 1.3, maxPaths: 250 as 250 | 500 };

const API_URL = import.meta.env.VITE_API_URL as string | undefined;

const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;

const FALLBACK_STUDY: Study = {

  id: "toronto",

  label: "A Decision-Intelligence Framework for Resilient Emergency Response to Motor Vehicle Collisions within Vision Zero Post-Crash Care",

  map_center: [-79.38, 43.70],

  default_zoom: 10,

};

const MAP_STYLE: maplibregl.StyleSpecification = {

  version: 8,

  sources: {

    openstreetmap: {

      type: "raster",

      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],

      tileSize: 256,

      maxzoom: 19,

      attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',

    },

    openmaptiles: {

      type: "vector",

      url: "https://tiles.openfreemap.org/planet",

      attribution: '<a href="https://openfreemap.org">OpenFreeMap</a>',

    },

  },

  layers: [{ id: "openstreetmap", type: "raster", source: "openstreetmap" }],

};

const BUILDING_3D_LAYER_ID = "openfreemap-3d-buildings";

const workspaceCopy: Record<Workspace, { title: string; description: string }> = {

  context: {

    title: "City context",

    description: "",

  },

  historical: {

    title: "Model 01: Historical Allocation",

    description: "Historical incident allocation with separate MVC and Non-MVC workload capacity bands",

  },

  ml: {

    title: "Model 02: Proactive Allocation",

    description: "Predicted incident intensity with shared territory area capacity bands",

  },

  manual: {

    title: "Historical User-Defined Weights Allocation",

    description: "Weighted user-based optimization",

  },

};

const allocationLayerPrefix = "allocation_";

const manualAllocationSourceIds = {

  mvc: "manual-allocation-mvc-area",

  nonMvc: "manual-allocation-non-mvc-area",

} as const;

type ManualVisibleKey = keyof typeof manualAllocationSourceIds;

const stationPalette = [

  "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f",

  "#bcbd22", "#17becf", "#2563eb", "#ea580c", "#16a34a", "#dc2626", "#7c3aed", "#0891b2",

  "#be123c", "#4d7c0f", "#0f766e", "#9333ea", "#b45309", "#0369a1", "#9f1239", "#475569",

];

const defaultVisibleLayerIds: Record<Workspace, string[]> = {

  context: ["city_boundary", "fire_stations"],

  historical: [],

  ml: [],

  manual: [],

};

const openingVisibleLayerIds = new Set(["city_boundary", "fire_stations"]);

function layerWorkspace(layer: LayerDefinition): Workspace {

  if (layer.workspace) return layer.workspace;

  return layer.id.startsWith(allocationLayerPrefix) ? "historical" : "context";

}

function layerSortKey(layer: LayerDefinition) {

  const id = layer.id;

  if (id === "existing_mvc_incidents") return 1;

  if (id === "existing_non_mvc_incidents") return 2;

  if (id === "existing_mvc_response_time") return 3;

  if (id === "existing_non_mvc_response_time") return 4;

  if (id === "mvc_incidents") return 10;

  if (id === "mvc_density_raster") return 11;

  if (id === "non_mvc_incidents") return 20;

  if (id === "non_mvc_density_raster") return 21;

  if (id === "centrelines") return 30;

  if (id === "street_intensity_raster") return 31;

  if (id === "ml_mvc_rf_prediction") return 10;

  if (id === "ml_mvc_xgb_prediction") return 11;

  if (id === "ml_non_mvc_rf_prediction") return 20;

  if (id === "ml_non_mvc_xgb_prediction") return 21;

  if (id.startsWith("allocation_")) return 30;

  return 0;

}

function allocationGroupTitle(workspace: Workspace) {

  if (workspace === "historical" || workspace === "ml") return "Scenarios";

  return "";

}

function scenarioModelDescription(workspace: Workspace) {

  if (workspace === "historical") {

    return "Compare workload bands of 90–110% or 80–120%, with up to 250 or 500 MVC paths within 240 seconds. Travel times are severity weighted.";

  }

  if (workspace === "ml") {

    return "Compare territory area bands of 90–110% or 80–120%, with up to 250 or 500 MVC paths within 240 seconds. Travel times and path averages are weighted by predicted demand.";

  }

  return "";

}

function allocationScenarioGroups(layers: LayerDefinition[]) {

  const groups: Record<string, LayerDefinition[]> = {};

  layers.forEach((layer) => {

    const title = layer.scenarioTitle ?? layer.scenario ?? "Scenario 1";

    groups[title] = [...(groups[title] ?? []), layer];

  });

  return Object.entries(groups);

}

function groupedLayerRows(layers: LayerDefinition[]) {

  const rows: Array<{ type: "single"; layer: LayerDefinition } | { type: "group"; title: string; layers: LayerDefinition[] }> = [];

  const grouped = new Set<string>();

  layers.forEach((layer) => {

    if (!layer.layerGroup) {

      rows.push({ type: "single", layer });

      return;

    }

    if (grouped.has(layer.layerGroup)) return;

    grouped.add(layer.layerGroup);

    rows.push({ type: "group", title: displayLabel(layer.layerGroup), layers: layers.filter((item) => item.layerGroup === layer.layerGroup) });

  });

  return rows;

}

const fireStationVisibleFilter = [

  "all",

  ["!=", ["to-string", ["get", "STATION10"]], "0"],

  ["!=", ["to-string", ["get", "STATION10"]], "0.0"],

  ["!=", ["downcase", ["to-string", ["get", "STATION10"]]], "station 0"],

] as any;

function addLayer(map: Map, layer: LayerDefinition) {

  if (layer.kind === "raster") {

    if (!map.getSource(layer.id) && layer.coordinates) {

      map.addSource(layer.id, { type: "image", url: layer.url, coordinates: layer.coordinates });

    }

    if (!map.getLayer(`${layer.id}-raster`)) {

      map.addLayer({

        id: `${layer.id}-raster`,

        type: "raster",

        source: layer.id,

        paint: { "raster-opacity": layer.opacity },

      });

    }

    return;

  }

  if (!map.getSource(layer.id)) {

    map.addSource(layer.id, { type: "geojson", data: layer.url });

  }

  if (layer.kind === "fill") {

    const quantileValue = layer.colorRampBy ? ["to-number", ["get", layer.colorRampBy], 0] : null;

    const fillColor = layer.colorRampBy && layer.legend?.type === "quantile"

      ? [

          "case",

          ...layer.legend.breaks.flatMap((breakValue, index) => [["<=", quantileValue, breakValue], layer.legend?.colors[index] ?? layer.color ?? "#94a3b8"]),

          layer.legend.colors[layer.legend.colors.length - 1],

        ]

      : layer.colorRampBy && layer.legend?.type === "ramp"

      ? [

          "interpolate",

          ["linear"],

          ["to-number", ["get", layer.colorRampBy], layer.legend.min],

          layer.legend.min,

          layer.legend.colors[0],

          (layer.legend.min + layer.legend.max) / 2,

          layer.legend.colors[Math.floor(layer.legend.colors.length / 2)],

          layer.legend.max,

          layer.legend.colors[layer.legend.colors.length - 1],

        ]

      : layer.colorBy && layer.colorMap

      ? ["match", ["to-string", ["get", layer.colorBy]], ...Object.entries(layer.colorMap).flatMap(([value, color]) => [value, color]), layer.color ?? "#94a3b8"]

      : layer.color ?? "#94a3b8";

    map.addLayer({

      id: `${layer.id}-fill`,

      type: "fill",

      source: layer.id,

      paint: { "fill-color": fillColor as any, "fill-opacity": layer.opacity },

    });

    map.addLayer({

      id: `${layer.id}-line`,

      type: "line",

      source: layer.id,

      paint: { "line-color": layer.lineColor ?? layer.color ?? "#64748b", "line-width": layer.lineWidth ?? 1.2, "line-opacity": layer.lineOpacity ?? 0.85 },

    });

  }

  if (layer.kind === "line") {

    map.addLayer({

      id: `${layer.id}-line`,

      type: "line",

      source: layer.id,

      paint: { "line-color": layer.color ?? "#64748b", "line-width": 1, "line-opacity": layer.opacity },

    });

  }

  if (layer.kind === "circle") {

    const isIncidentLayer = layer.id === "mvc_incidents" || layer.id === "non_mvc_incidents";

    const circleColor = layer.colorBy && layer.colorMap

      ? ["match", ["to-string", ["get", layer.colorBy]], ...Object.entries(layer.colorMap).flatMap(([value, color]) => [value, color]), layer.color ?? "#7c3aed"]

      : layer.color ?? "#7c3aed";

    const circleLayer: maplibregl.CircleLayerSpecification = {

      id: `${layer.id}-circle`,

      type: "circle",

      source: layer.id,

      paint: {

        "circle-color": circleColor as any,

        "circle-radius": layer.sizeBy ? ["step", ["to-number", ["get", layer.sizeBy], 0], 4, 10.01, 6, 30.01, 9, 60.01, 13] : layer.id === "fire_stations"

          ? ["interpolate", ["linear"], ["zoom"], 9, 5, 13, 8]

          : isIncidentLayer

            ? ["interpolate", ["linear"], ["zoom"], 9, 3.2, 13, 6.2]

            : ["interpolate", ["linear"], ["zoom"], 9, 2, 13, 5],

        "circle-opacity": isIncidentLayer ? Math.max(layer.opacity, 0.78) : layer.opacity,

        "circle-stroke-color": "#ffffff",

        "circle-stroke-width": layer.id === "fire_stations" ? 1.4 : isIncidentLayer ? 0.9 : 0.7,

      },

    };

    if (layer.id === "fire_stations") circleLayer.filter = fireStationVisibleFilter;

    map.addLayer(circleLayer);

    if (layer.id === "fire_stations") {

      map.addLayer({

        id: `${layer.id}-label`,

        type: "symbol",

        source: layer.id,

        filter: fireStationVisibleFilter,

        layout: {

          "text-field": ["to-string", ["get", "STATION10"]],

          "text-font": ["Noto Sans Regular"],

          "text-size": 12,

          "text-offset": [0, 1.25],

          "text-anchor": "top",

          "text-allow-overlap": false,

        },

        paint: {

          "text-color": "#7f1d1d",

          "text-halo-color": "#ffffff",

          "text-halo-width": 1.4,

        },

      });

    }

  }

}

function setLayerVisibility(map: Map, layer: LayerDefinition, visible: boolean) {

  [`${layer.id}-fill`, `${layer.id}-line`, `${layer.id}-circle`, `${layer.id}-label`, `${layer.id}-raster`].forEach((id) => {

    if (map.getLayer(id)) {

      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");

    }

  });

}

function bringFireStationsToFront(map: Map) {

  ["fire_stations-circle", "fire_stations-label"].forEach((id) => {

    if (map.getLayer(id)) map.moveLayer(id);

  });

}

function bringIncidentPointsToFront(map: Map) {

  ["mvc_incidents-circle", "non_mvc_incidents-circle"].forEach((id) => {

    if (map.getLayer(id)) map.moveLayer(id);

  });

}

function bringReferenceLayersToFront(map: Map) {

  ["service_area-fill", "service_area-line"].forEach((id) => {

    if (map.getLayer(id)) map.moveLayer(id);

  });

  bringIncidentPointsToFront(map);

  bringFireStationsToFront(map);

}

function renderedLayerIds(layer: LayerDefinition) {

  if (layer.kind === "raster") return [];

  if (layer.kind === "fill") return [`${layer.id}-fill`, `${layer.id}-line`];

  if (layer.kind === "line") return [`${layer.id}-line`];

  return [`${layer.id}-circle`];

}

function clickableLayerIds(map: Map, layers: LayerDefinition[], visibleLayers: Record<string, boolean>) {

  const priority = ["fire_stations", "mvc_incidents", "non_mvc_incidents", "service_area", "centrelines"];

  const orderedLayers = [

    ...priority.flatMap((layerId) => layers.filter((layer) => layer.id === layerId)),

    ...layers.filter((layer) => layer.id.startsWith("existing_")),

    ...layers.filter((layer) => layer.id.startsWith(allocationLayerPrefix)),

  ];

  return orderedLayers

    .filter((layer) => visibleLayers[layer.id] ?? false)

    .flatMap(renderedLayerIds)

    .filter((id) => map.getLayer(id));

}

function manualStationColors(result: ManualAllocationResult | null) {

  if (!result) return {};

  const stations = Array.from(new Set(

    [...result.mvcGeojson.features, ...result.nonMvcGeojson.features]

      .map((feature) => String(feature.properties.Allocated_Station ?? ""))

      .filter((station) => station && !isStationZeroLabel(station)),

  )).sort((a, b) => {

    const aValue = stationSortValue(a);

    const bValue = stationSortValue(b);

    return typeof aValue === "number" && typeof bValue === "number" ? aValue - bValue : String(aValue).localeCompare(String(bValue));

  });

  return Object.fromEntries(stations.map((station, index) => [station, stationPalette[index % stationPalette.length]]));

}

function manualFillColorExpression(colorMap: Record<string, string>) {

  const entries = Object.entries(colorMap).flatMap(([station, color]) => [station, color]);

  return ["match", ["to-string", ["get", "Allocated_Station"]], ...entries, "#cbd5e1"] as any;

}

function geometryPolygons(geometry: unknown) {

  const item = geometry as { type?: string; coordinates?: unknown[] } | null;

  if (!item) return [];

  if (item.type === "Polygon") return [item.coordinates ?? []];

  if (item.type === "MultiPolygon") return item.coordinates ?? [];

  return [];

}

function dissolveManualAllocation(collection: ManualAllocationResult["mvcGeojson"]): ManualAllocationGeoJSON {

  const groups = new globalThis.Map<string, {

    polygons: unknown[];

    demandType: unknown;

    gridCount: number;

    incidents: number;

    workload: number;

    freeFlow: number[];

    service: number[];

    paths: number[];

  }>();

  collection.features.forEach((feature) => {

    const station = String(feature.properties.Allocated_Station ?? "").trim();

    if (!station || isStationZeroLabel(station)) return;

    const group = groups.get(station) ?? {

      polygons: [],

      demandType: feature.properties.Demand_Type,

      gridCount: 0,

      incidents: 0,

      workload: 0,

      freeFlow: [],

      service: [],

      paths: [],

    };

    group.polygons.push(...geometryPolygons(feature.geometry));

    group.gridCount += 1;

    group.incidents += numericValue(feature.properties.Unique_Incidents) ?? 0;

    group.workload += numericValue(feature.properties.Allocated_Service_Workload_sec) ?? 0;

    const freeFlow = numericValue(feature.properties.FreeFlow_Time_sec);

    const service = numericValue(feature.properties.Average_Service_Time_sec);

    const paths = numericValue(feature.properties.Effective_Path_Count_Under240);

    if (freeFlow !== null) group.freeFlow.push(freeFlow);

    if (service !== null) group.service.push(service);

    if (paths !== null) group.paths.push(paths);

    groups.set(station, group);

  });

  return {

    type: "FeatureCollection" as const,

    features: Array.from(groups.entries())

      .sort(([a], [b]) => {

        const aValue = stationSortValue(a);

        const bValue = stationSortValue(b);

        return typeof aValue === "number" && typeof bValue === "number" ? aValue - bValue : String(aValue).localeCompare(String(bValue));

      })

      .map(([station, group]) => ({

        type: "Feature" as const,

        geometry: { type: "MultiPolygon", coordinates: group.polygons },

        properties: {

          Demand_Type: group.demandType == null ? null : String(group.demandType),

          Allocated_Station: station,

          Grid_Count: group.gridCount,

          Unique_Incidents: Number(group.incidents.toFixed(2)),

          Allocated_Demand: Number((group.incidents > 0 ? group.incidents : group.gridCount).toFixed(2)),

          Density_Basis: group.incidents > 0 ? "Incident count" : "Allocated grid count",

          Allocated_Service_Workload_sec: Number(group.workload.toFixed(2)),

          Average_FreeFlow_Time_sec: manualWeightedAverage(collection.features.filter(f => String(f.properties.Allocated_Station) === station), "FreeFlow_Time_sec", "Severity_Weight"),

          Average_Service_Time_sec: averageNumbers(group.service) == null ? null : Number(averageNumbers(group.service)?.toFixed(2)),

          Average_Effective_Path_Count_Under240: manualWeightedAverage(collection.features.filter(f => String(f.properties.Allocated_Station) === station), "Effective_Path_Count_Under240"),

          Average_Paths_Weighting: "Incident count",

        },

      })),

  };

}

function escapeHtml(value: unknown) {

  return String(value ?? "")

    .replace(/&/g, "&amp;")

    .replace(/</g, "&lt;")

    .replace(/>/g, "&gt;")

    .replace(/"/g, "&quot;")

    .replace(/'/g, "&#039;");

}

function popupRows(properties: Record<string, unknown>, fields: Array<[string, string]>) {

  return fields

    .filter(([, key]) => properties[key] !== null && properties[key] !== undefined && properties[key] !== "")

    .map(([label, key]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(displayAttribute(properties[key]))}</td></tr>`)

    .join("");

}

function popupHtml(layerId: string, properties: Record<string, unknown>) {

  let rows = "";

  if (layerId === "fire_stations") {

    rows = popupRows(properties, [

      ["Station", "STATION10"],

      ["Address", "ADDRESS5"],

      ["Year built", "YEAR_BU11"],

    ]);

  } else if (layerId === "service_area") {

    rows = popupRows(properties, [["Run area", "RUN_AREA"]]);

  } else if (layerId === "centrelines") {

    rows = popupRows(properties, [

      ["Street", "LINEAR_30"],

      ["Feature", "FEATURE36"],

    ]);

  } else if (layerId.startsWith(allocationLayerPrefix)) {

    rows = popupRows(properties, [

      ["Station", "Station_ID"],

      ["Baseline MVC travel time", "Baseline_MVC_Avg_sec"],

      ["S3 MVC travel time", "S3_MVC_Avg_sec"],

      ["Improvement (seconds)", "Improvement_sec"],

      ["Improvement (%)", "Improvement_pct"],

      ["Status", "Status"],

      ["Grids", "Grid_Count"],

      ["Grid", "Grid_ID"],

      ["Allocated station", "Allocated_Station"],

      ["Demand type", "Demand_Type"],

      ["Incidents", "Unique_Incidents"],

      ["Allocated demand", "Allocated_Demand"],

      ["Density basis", "Density_Basis"],

      ["Average free-flow time", "Average_FreeFlow_Time_sec"],

      ["Free-flow time", "FreeFlow_Time_sec"],

      ["Baseline grid travel time", "Baseline_FreeFlow_Time_sec"],

      ["Grid travel-time change (optimized − baseline)", "FreeFlow_Change_sec"],

      ["Workload", "Allocated_Service_Workload_sec"],

      ["Average service time", "Average_Service_Time_sec"],

      ["Weighted average MVC paths", "Average_Effective_Path_Count_Under240"],

      ["Path weighting", "Average_Paths_Weighting"],

    ]);

  } else if (layerId === "existing_mvc_incidents" || layerId === "existing_non_mvc_incidents") {

    rows = popupRows(properties, [

      ["Incident", "INCIDENT_N"],

      ["Type", "Final_Inci"],

      ["Station area", "Incident_S"],

      ["Ward", "Incident_W"],

      ["Response time", "Response_T"],

      ["Service time", "Service_Ti"],

    ]);

  } else if (layerId === "existing_mvc_response_time" || layerId === "existing_non_mvc_response_time") {

    rows = popupRows(properties, [

      ["Grid", "GRID_ID"],

      ["Category", "Category"],

      ["Incidents", "Grid_Total_Incidents"],

      ["Average response time", "Average_Response_Time_sec_GridBased"],

      ["Median response time", "Median_Response_Time_sec_GridBased"],

      ["Historical stations", "Number_of_Historical_Stations"],

    ]);

  } else if ((Object.values(manualAllocationSourceIds) as string[]).includes(layerId)) {

    rows = popupRows(properties, [

      ["Grids", "Grid_Count"],

      ["Grid", "GRID_ID"],

      ["Allocated station", "Allocated_Station"],

      ["Demand type", "Demand_Type"],

      ["Incidents", "Unique_Incidents"],

      ["Allocated demand", "Allocated_Demand"],

      ["Density basis", "Density_Basis"],

      ["Average free-flow time", "Average_FreeFlow_Time_sec"],

      ["Free-flow time", "FreeFlow_Time_sec"],

      ["MVC paths", "Effective_Path_Count_Under240"],

      ["Average MVC paths", "Average_Effective_Path_Count_Under240"],

    ]);

  }

  if (!rows) {

    rows = Object.entries(properties)

      .filter(([, value]) => value !== null && value !== "")

      .slice(0, 12)

      .map(([key, value]) => `<tr><th>${escapeHtml(attributeLabel(key))}</th><td>${escapeHtml(displayAttribute(value))}</td></tr>`)

      .join("");

  }

  return `<table class="popup-table">${rows || "<tr><td>No attributes</td></tr>"}</table>`;

}

function legendItems(layer: LayerDefinition) {

  if (layer.legend?.type === "ramp") return [];

  if (layer.colorBy && layer.colorMap) {

    return Object.entries(layer.colorMap)

      .filter(([value]) => !isStationZeroLabel(value))

      .map(([value, color]) => ({ label: value, color }));

  }

  return [{ label: layer.label, color: layer.lineColor ?? layer.color ?? "#64748b" }];

}

function MapLegend({

  layers,

  visibleLayers,

  manualColorMap,

}: {

  layers: LayerDefinition[];

  visibleLayers: Record<string, boolean>;

  manualColorMap?: Record<string, string>;

}) {

  const [collapsed, setCollapsed] = useState(false);

  const visible = layers.filter((layer) => visibleLayers[layer.id] ?? false);

  const manualItems = Object.entries(manualColorMap ?? {});

  const visibleManualItems = manualItems.slice(0, 18);

  const activeLayerCount = visible.length + (manualItems.length > 0 ? 1 : 0);

  if (visible.length === 0 && manualItems.length === 0) return null;

  return (

    <div className={`map-legend ${collapsed ? "collapsed" : ""}`} aria-label="Map legend">

      <div className="legend-head">

        <p className="eyebrow">Legend</p>

        <div className="legend-head-actions">

          <span>{activeLayerCount} active {activeLayerCount === 1 ? "layer" : "layers"}</span>

          <button type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed} title={collapsed ? "Expand legend" : "Collapse legend"}>

            {collapsed ? "+" : "-"}

          </button>

        </div>

      </div>

      {!collapsed && (

        <>

      {visible.map((layer) => {

        const items = legendItems(layer);

        const visibleItems = items.slice(0, 12);

        return (

          <div className="legend-layer" key={layer.id}>

            <h3>{layer.label}</h3>

            {layer.sizeBy && <p className="legend-stretch">Circle size: absolute travel-time change. Classes: ≤10, &gt;10–30, &gt;30–60, and &gt;60 seconds.</p>}

            {layer.legend?.type === "ramp" ? (

              <>

                <div className="legend-ramp" style={{ background: `linear-gradient(90deg, ${layer.legend.colors.join(", ")})` }} />

                <div className="legend-ramp-labels"><span>{layer.legend.min.toFixed(2)}</span><span>{layer.legend.max.toFixed(2)}</span></div>

                {layer.legend.stretch && <p className="legend-stretch">{layer.legend.stretch}</p>}

              </>

            ) : layer.legend?.type === "quantile" ? (

              <div className="legend-items quantile-legend-items">

                {layer.legend.colors.map((color, index) => (

                  <span className="legend-item" key={`${layer.id}-quantile-${index}`}>

                    <span className="legend-swatch" style={{ background: color, borderColor: color }} />

                    <span>{layer.legend?.type === "quantile" ? layer.legend.labels[index] : ""}</span>

                  </span>

                ))}

              </div>

            ) : (

              <div className="legend-items">

                {visibleItems.map((item) => (

                  <span className="legend-item" key={`${layer.id}-${item.label}`}>

                    <span className={layer.kind === "line" ? "legend-line" : "legend-swatch"} style={{ background: layer.kind === "line" ? undefined : item.color, borderColor: item.color }} />

                    <span>{item.label}</span>

                  </span>

                ))}

                {items.length > visibleItems.length && <span className="legend-more">+{items.length - visibleItems.length} more</span>}

              </div>

            )}

          </div>

        );

      })}

      {manualItems.length > 0 && (

        <div className="legend-layer">

          <h3>Manual allocation</h3>

          <div className="legend-items">

            {visibleManualItems.map(([station, color]) => (

              <span className="legend-item" key={`manual-${station}`}>

                <span className="legend-swatch" style={{ background: color, borderColor: color }} />

                <span>{station}</span>

              </span>

            ))}

            {manualItems.length > visibleManualItems.length && <span className="legend-more">+{manualItems.length - visibleManualItems.length} more</span>}

          </div>

        </div>

      )}

        </>

      )}

    </div>

  );

}

function MapPanel({

  study,

  layers,

  visibleLayers,

  workspace,

  manualResult,

  manualVisible,

  resetKey,

  onReset,

}: {

  study: Study | null;

  layers: LayerDefinition[];

  visibleLayers: Record<string, boolean>;

  workspace: Workspace;

  manualResult: ManualAllocationResult | null;

  manualVisible: Record<ManualVisibleKey, boolean>;

  resetKey: number;

  onReset: () => void;

}) {

  const mapNode = useRef<HTMLDivElement | null>(null);

  const mapWrap = useRef<HTMLDivElement | null>(null);

  const map = useRef<Map | null>(null);

  const [mapReady, setMapReady] = useState(false);

  const [showDataInfo, setShowDataInfo] = useState(false);

  const [basemapMode, setBasemapMode] = useState<BasemapMode>("osm");

  const [basemapMenuOpen, setBasemapMenuOpen] = useState(false);

  useEffect(() => {

    if (!mapNode.current || !study || map.current) return;

    setMapReady(false);

    const nextMap = new maplibregl.Map({

      container: mapNode.current,

      style: MAP_STYLE,

      center: study.map_center,

      zoom: study.default_zoom,

    });

    map.current = nextMap;

    nextMap.addControl(new maplibregl.NavigationControl(), "top-right");

    nextMap.once("load", () => setMapReady(true));

    return () => {

      nextMap.remove();

      map.current = null;

      setMapReady(false);

    };

  }, [study]);

  useEffect(() => {

    if (!map.current || !mapReady) return;

    const currentMap = map.current;

    if (basemapMode === "3d") {

      if (!currentMap.getLayer(BUILDING_3D_LAYER_ID) && currentMap.getSource("openmaptiles")) {

        currentMap.addLayer({

          id: BUILDING_3D_LAYER_ID,

          type: "fill-extrusion",

          source: "openmaptiles",

          "source-layer": "building",

          minzoom: 15,

          filter: ["!", ["has", "hide_3d"]],

          paint: {

            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],

            "fill-extrusion-color": "#d8d3ca",

            "fill-extrusion-height": ["coalesce", ["get", "render_height"], 0],

            "fill-extrusion-opacity": 0.78,

          },

        });

        bringReferenceLayersToFront(currentMap);

      }

      currentMap.easeTo({ pitch: 50, bearing: -15, zoom: Math.max(currentMap.getZoom(), 15), duration: 700 });

    } else {

      if (currentMap.getLayer(BUILDING_3D_LAYER_ID)) currentMap.removeLayer(BUILDING_3D_LAYER_ID);

      currentMap.easeTo({ pitch: 0, bearing: 0, duration: 500 });

    }

  }, [basemapMode, mapReady]);

  useEffect(() => {

    if (!map.current || !mapReady || layers.length === 0) return;

    const currentMap = map.current;

    const loadLayers = () => {

      layers.forEach((layer) => {

        const isVisible = visibleLayers[layer.id] ?? false;

        if (isVisible && !currentMap.getSource(layer.id)) addLayer(currentMap, layer);

        if (currentMap.getSource(layer.id)) setLayerVisibility(currentMap, layer, isVisible);

      });

      bringReferenceLayersToFront(currentMap);

    };

    loadLayers();

  }, [layers, visibleLayers, mapReady]);

  useEffect(() => {

    if (!map.current || !study) return;

    map.current.easeTo({ center: study.map_center, zoom: study.default_zoom, duration: 450 });

  }, [resetKey, study]);

  useEffect(() => {

    const resizeMap = () => window.setTimeout(() => map.current?.resize(), 120);

    document.addEventListener("fullscreenchange", resizeMap);

    return () => document.removeEventListener("fullscreenchange", resizeMap);

  }, []);

  async function toggleFullscreen() {

    const element = (mapWrap.current?.closest(".app-shell") as HTMLElement | null) ?? (mapWrap.current?.closest(".workspace") as HTMLElement | null) ?? mapWrap.current;

    if (!element) return;

    if (document.fullscreenElement) {

      await document.exitFullscreen();

    } else {

      await element.requestFullscreen();

    }

  }

  useEffect(() => {

    if (!map.current) return;

    const currentMap = map.current;

    const updateManualLayer = () => {

      const removeManualLayer = (sourceId: string) => {

        if (currentMap.getLayer(`${sourceId}-line`)) currentMap.removeLayer(`${sourceId}-line`);

        if (currentMap.getLayer(`${sourceId}-fill`)) currentMap.removeLayer(`${sourceId}-fill`);

        if (currentMap.getSource(sourceId)) currentMap.removeSource(sourceId);

      };

      const upsertManualLayer = (sourceId: string, data: ManualAllocationResult["mvcGeojson"], visible: boolean, fillColor: any, lineOpacity = 0.85, beforeId?: string) => {

        const source = currentMap.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;

        if (source) {

          source.setData(data as any);

          if (currentMap.getLayer(`${sourceId}-fill`)) {

            currentMap.setPaintProperty(`${sourceId}-fill`, "fill-color", fillColor);

            currentMap.setLayoutProperty(`${sourceId}-fill`, "visibility", visible ? "visible" : "none");

          }

          if (currentMap.getLayer(`${sourceId}-line`)) {

            currentMap.setPaintProperty(`${sourceId}-line`, "line-opacity", lineOpacity);

            currentMap.setLayoutProperty(`${sourceId}-line`, "visibility", visible ? "visible" : "none");

          }

          return;

        }

        currentMap.addSource(sourceId, { type: "geojson", data: data as any });

        currentMap.addLayer({

          id: `${sourceId}-fill`,

          type: "fill",

          source: sourceId,

          layout: { visibility: visible ? "visible" : "none" },

          paint: { "fill-color": fillColor, "fill-opacity": 0.58 },

        }, beforeId);

        currentMap.addLayer({

          id: `${sourceId}-line`,

          type: "line",

          source: sourceId,

          layout: { visibility: visible ? "visible" : "none" },

          paint: { "line-color": "#ffffff", "line-opacity": lineOpacity, "line-width": 0.7 },

        }, beforeId);

      };

      if (!manualResult) {

        Object.values(manualAllocationSourceIds).forEach(removeManualLayer);

        return;

      }

      const colorMap = manualStationColors(manualResult);

      const nonMvcDissolved = dissolveManualAllocation(manualResult.nonMvcGeojson);

      const mvcDissolved = dissolveManualAllocation(manualResult.mvcGeojson);

      const stationFill = manualFillColorExpression(colorMap);

      upsertManualLayer(manualAllocationSourceIds.nonMvc, nonMvcDissolved, manualVisible.nonMvc, stationFill, 0);

      upsertManualLayer(manualAllocationSourceIds.mvc, mvcDissolved, manualVisible.mvc, stationFill, 0);

      bringReferenceLayersToFront(currentMap);

    };

    if (currentMap.isStyleLoaded()) updateManualLayer();

    else currentMap.once("load", updateManualLayer);

  }, [manualResult, manualVisible]);

  useEffect(() => {

    if (!map.current || layers.length === 0) return;

    const currentMap = map.current;

    let highlightFrame: number | null = null;
    let popup: maplibregl.Popup | null = null;
    const highlightIds: string[] = [];
    const clearHighlight = () => {
      if (highlightFrame !== null) cancelAnimationFrame(highlightFrame);
      highlightFrame = null;
      highlightIds.splice(0).forEach(id => { if (currentMap.getLayer(id)) currentMap.removeLayer(id); });
    };
    const highlightStation = (station: string) => {
      const sources = layers.filter(layer => visibleLayers[layer.id] && layer.id.startsWith(allocationLayerPrefix) && layer.kind === "fill" && layer.label.toLowerCase().includes("area allocation") && currentMap.getSource(layer.id)).map(layer=>layer.id);
      Object.entries(manualAllocationSourceIds).forEach(([key,source])=>{if(manualResult && manualVisible[key as ManualVisibleKey] && currentMap.getSource(source)) sources.push(source);});
      if (!sources.length) return;
      const filter:any = ["==",["to-string",["get","Allocated_Station"]],station];
      const strokes:string[]=[];
      sources.forEach((source,index)=>{
        const halo=`station-highlight-${index}-halo`, line=`station-highlight-${index}-line`;
        currentMap.addLayer({id:halo,type:"line",source,filter,layout:{"line-join":"round","line-cap":"round"},paint:{"line-color":"#ffffff","line-width":7,"line-opacity":.9}});
        currentMap.addLayer({id:line,type:"line",source,filter,layout:{"line-join":"round","line-cap":"round"},paint:{"line-color":"#f5a623","line-width":3.5,"line-opacity":1}});
        highlightIds.push(halo,line);strokes.push(line);
      });
      bringFireStationsToFront(currentMap);
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const started=performance.now();
      const pulse=(now:number)=>{
        const progress=Math.min(1,(now-started)/2400);
        const opacity=progress===1?1:.55+.45*(1+Math.cos(progress*Math.PI*4))/2;
        strokes.forEach(id=>{if(currentMap.getLayer(id)){currentMap.setPaintProperty(id,"line-opacity",opacity);currentMap.setPaintProperty(id,"line-width",progress===1?3.5:3.5+1.5*Math.sin(progress*Math.PI*2)**2);}});
        highlightFrame=progress<1?requestAnimationFrame(pulse):null;
      };
      highlightFrame=requestAnimationFrame(pulse);
    };

    const onClick = (event: maplibregl.MapMouseEvent) => {

      const activeLayerIds = [

        ...Object.entries(manualAllocationSourceIds)

          .filter(([key, sourceId]) => manualResult && manualVisible[key as keyof typeof manualVisible] && currentMap.getLayer(`${sourceId}-fill`))

          .map(([, sourceId]) => `${sourceId}-fill`),

        ...clickableLayerIds(currentMap, layers, visibleLayers),

      ];

      const features = currentMap.queryRenderedFeatures(event.point, { layers: activeLayerIds });

      const feature = features.find(item => item.source === "fire_stations") ?? features[0];
      popup?.remove();
      clearHighlight();
      if (!feature?.properties) return;
      if (feature.source === "fire_stations") {
        const station = Number(feature.properties.STATION10);
        if (Number.isFinite(station)) highlightStation(String(station));
      }

      const layerId = String(feature.source);

      popup = new maplibregl.Popup({ maxWidth: "360px" })

        .setLngLat(event.lngLat)

        .setHTML(popupHtml(layerId, feature.properties))

        .addTo(currentMap);
      popup.on("close", clearHighlight);

    };

    const onMove = (event: maplibregl.MapMouseEvent) => {

      const activeLayerIds = [

        ...Object.entries(manualAllocationSourceIds)

          .filter(([key, sourceId]) => manualResult && manualVisible[key as keyof typeof manualVisible] && currentMap.getLayer(`${sourceId}-fill`))

          .map(([, sourceId]) => `${sourceId}-fill`),

        ...clickableLayerIds(currentMap, layers, visibleLayers),

      ];

      const features = currentMap.queryRenderedFeatures(event.point, { layers: activeLayerIds });

      currentMap.getCanvas().style.cursor = features.length > 0 ? "pointer" : "";

    };

    const onLeave = () => {

      currentMap.getCanvas().style.cursor = "";

    };

    currentMap.on("click", onClick);

    currentMap.on("mousemove", onMove);

    currentMap.on("mouseout", onLeave);

    return () => {

      popup?.remove();
      clearHighlight();
      currentMap.off("click", onClick);

      currentMap.off("mousemove", onMove);

      currentMap.off("mouseout", onLeave);

    };

  }, [layers, visibleLayers, manualResult, manualVisible, resetKey]);

  const manualStationLegend = workspace === "manual" && manualResult && (manualVisible.mvc || manualVisible.nonMvc)

    ? manualStationColors(manualResult)

    : undefined;

  return (

    <div className="map-wrap" ref={mapWrap}>

      <div className="map" ref={mapNode} aria-label="Interactive scenario map" />

      <div className="map-control-stack">

        <button type="button" className="map-icon-button map-info-button" onClick={() => setShowDataInfo((value) => !value)} title="Show data information">

          <span aria-hidden="true">i</span>

          <span className="sr-only">Show data information</span>

        </button>

        <button type="button" className="map-icon-button" onClick={onReset} title="Reset map to the opening layer state">

          <img src={assetUrl("icons/reset.png")} alt="" aria-hidden="true" />

          <span className="sr-only">Reset map</span>

        </button>

        <button type="button" className="map-icon-button" onClick={toggleFullscreen} title="Show workspace fullscreen">

          <img src={assetUrl("icons/fullscreen.png")} alt="" aria-hidden="true" />

          <span className="sr-only">Show workspace fullscreen</span>

        </button>

      </div>

      {showDataInfo && (

        <div className="map-info-popover" role="status">

          <span className="info-icon" aria-hidden="true">i</span>

          <div className="map-info-links">

            <span>Data Information: <a href="https://open.toronto.ca/" target="_blank" rel="noopener noreferrer">City of Toronto Open Portal</a></span>

            <span>Vision Zero: <a href="https://www.toronto.ca/services-payments/streets-parking-transportation/road-safety/vision-zero/safety-measures-and-mapping/" target="_blank" rel="noopener noreferrer">Safety Measures and Mapping</a></span>

          </div>

        </div>

      )}

      <div className={`basemap-control ${basemapMenuOpen ? "open" : ""}`}>

        <button

          type="button"

          className="basemap-control-toggle"

          aria-label="Choose basemap"

          title="Choose basemap"

          aria-expanded={basemapMenuOpen}

          onClick={() => setBasemapMenuOpen((value) => !value)}

        >

          <svg viewBox="0 0 32 32" aria-hidden="true">

            <path className="basemap-icon-top" d="M16 4 28 11 16 18 4 11 16 4Z" />

            <path d="m4 15 12 7 12-7" />

            <path d="m4 20 12 7 12-7" />

          </svg>

        </button>

        {basemapMenuOpen && (

          <div className="basemap-options" role="radiogroup" aria-label="Basemap">

            <label>

              <input type="radio" name="basemap" checked={basemapMode === "osm"} onChange={() => setBasemapMode("osm")} />

              <span><strong>OpenStreetMap</strong><small>Regular map · default</small></span>

            </label>

            <label>

              <input type="radio" name="basemap" checked={basemapMode === "3d"} onChange={() => setBasemapMode("3d")} />

              <span><strong>3D buildings</strong><small>Shown from zoom 15 · terrain off</small></span>

            </label>

          </div>

        )}

      </div>

      <MapLegend layers={layers} visibleLayers={visibleLayers} manualColorMap={manualStationLegend} />

    </div>

  );

}

function LayerRow({

  layer,

  checked,

  onToggle,

  onTable,

  indented = false,

}: {

  layer: LayerDefinition;

  checked: boolean;

  onToggle: (checked: boolean) => void;

  onTable: () => void;

  indented?: boolean;

}) {

  return (

    <div className={`layer-row ${indented ? "indented" : ""}`}>

      <label className="layer-toggle">

        <input type="checkbox" checked={checked} onChange={(event) => onToggle(event.target.checked)} />

        <span className="swatch" style={{ background: layer.color ?? "#64748b" }} />

        <span>{indented && layer.groupLabel ? layer.groupLabel : layer.label}</span>

        <small>{layer.featureCount.toLocaleString()}</small>

      </label>

      {layer.kind !== "raster" && <button type="button" onClick={onTable}>Table</button>}

    </div>

  );

}

function defaultVisibleLayers(layers: LayerDefinition[], workspace: Workspace) {

  const defaults = new Set(defaultVisibleLayerIds[workspace]);

  return Object.fromEntries(

    layers

      .filter((layer) => layerWorkspace(layer) === workspace)

      .map((layer) => [layer.id, defaults.has(layer.id)]),

  );

}

function openingVisibleLayers(layers: LayerDefinition[]) {

  return Object.fromEntries(layers.map((layer) => [layer.id, openingVisibleLayerIds.has(layer.id)]));

}

function ContextInformationPanel({ data }: { data?: ContextInfoData }) {

  const incidentComposition = data?.incidentComposition;

  const travel = data?.existingTravelTime;

  const response = data?.existingResponseTime;

  const stationRows = data?.stationExistingFreeFlow ?? [];

  const stationResponseRows = data?.stationExistingResponse ?? [];

  type CombinedStationInfo = { station: string; freeFlow?: number | null; mvcResponse?: number | null; nonMvcResponse?: number | null };

  const stationMap = new globalThis.Map<string, CombinedStationInfo>(

    stationRows

      .map((row) => ({ station: String(row.station ?? "").trim(), freeFlow: row.averageExistingFreeFlowTimeSec }))

      .filter((row) => row.station)

      .map((row) => [row.station, { station: row.station, freeFlow: row.freeFlow, mvcResponse: null, nonMvcResponse: null }]),

  );

  stationResponseRows.forEach((row) => {

    const station = String(row.station ?? "").trim();

    if (!station) return;

    const item = stationMap.get(station) ?? { station, freeFlow: null, mvcResponse: null as number | null, nonMvcResponse: null as number | null };

    if (row.category === "MVC") item.mvcResponse = row.averageResponseTimeSecGridBased ?? null;

    else item.nonMvcResponse = row.averageResponseTimeSecGridBased ?? null;

    stationMap.set(station, item);

  });

  const combinedStationRows = Array.from(stationMap.values()).sort((a, b) => Number(a.station) - Number(b.station) || a.station.localeCompare(b.station));

  return (

    <div className="analysis-panel info-panel">

      <div className="information-heading"><span className="analysis-icon" aria-hidden="true">i</span><p className="eyebrow">Information</p></div>

      <h3>Existing incident composition</h3>

      {incidentComposition ? (

        <div className="incident-overview">
          <div className="incident-share-bar" role="img" aria-label={`MVC ${valueLabel(incidentComposition.mvcPercent)}%; Non-MVC ${valueLabel(incidentComposition.nonMvcPercent)}%`}>
            <span className="incident-share-mvc" style={{width:`${incidentComposition.mvcPercent}%`}} />
            <span className="incident-share-nonmvc" style={{width:`${incidentComposition.nonMvcPercent}%`}} />
          </div>
          <div className="incident-cards">
            <div className="incident-card mvc"><span className="incident-card-label">MVC</span><span className="incident-card-count">{incidentComposition.mvcCount.toLocaleString()}</span><span className="incident-card-meta">Count <span>Percentage <strong>{valueLabel(incidentComposition.mvcPercent)}%</strong></span></span></div>
            <div className="incident-card nonmvc"><span className="incident-card-label">Non-MVC</span><span className="incident-card-count">{incidentComposition.nonMvcCount.toLocaleString()}</span><span className="incident-card-meta">Count <span>Percentage <strong>{valueLabel(incidentComposition.nonMvcPercent)}%</strong></span></span></div>
          </div>
          <div className="incident-total"><span>Total</span><strong>{incidentComposition.totalCount.toLocaleString()}</strong><span>100.00%</span></div>
        </div>

      ) : <p className="small">Incident composition is not available.</p>}

      <ExistingMetricLineChart title="Existing severity-weighted free-flow travel time" values={travel} />

      <ExistingMetricLineChart title="Existing incident-weighted average response time" values={response} />

      <h3>Average existing travel and response time by fire station</h3>

      {combinedStationRows.length > 0 ? (

        <div className="station-info-table">

          <table>

            <thead>

              <tr><th>Station</th><th>Free-flow time</th><th>MVC response</th><th>Non-MVC response</th></tr>

            </thead>

            <tbody>

              {combinedStationRows.map((row) => (

                <tr key={row.station}>

                  <td>{row.station}</td>

                  <td>{valueLabel(row.freeFlow)} sec</td>

                  <td>{valueLabel(row.mvcResponse)} sec</td>

                  <td>{valueLabel(row.nonMvcResponse)} sec</td>

                </tr>

              ))}

            </tbody>

          </table>

        </div>

      ) : (

        <p className="small">Station travel and response-time values are not available.</p>

      )}

    </div>

  );

}

function AnalysisPanel({

  workspace,

  data,

  manualRows,

  manualResult,

}: {

  workspace: Workspace;

  data: AnalysisData | null;

  manualRows: TravelTimeRow[];

  manualResult: ManualAllocationResult | null;

}) {

  const [showTravel, setShowTravel] = useState(true);


  const [showCapacity, setShowCapacity] = useState(false);

  const [showPaths, setShowPaths] = useState(false);
  const [showEntropy, setShowEntropy] = useState(false);
  const [showCoverage, setShowCoverage] = useState(false);
  const [showTraining, setShowTraining] = useState(false);

  const [showStation, setShowStation] = useState(false);

  useEffect(() => {

    if (workspace !== "historical" && workspace !== "ml") return;

    setShowTravel(true);


    setShowCapacity(false);

    setShowPaths(false);

    setShowStation(false);
    setShowTraining(false);

  }, [workspace]);

  if (workspace === "context") return <ContextInformationPanel data={data?.context} />;

  if (workspace === "manual") {

    return (

      <div className="analysis-panel">

        <div className="analysis-header">

          <span className="analysis-icon">S</span>

          <div>

            <p className="eyebrow">Scenario analysis</p>

            <h3>User-defined scenario results</h3>

          </div>

        </div>

        {manualRows.length > 0 && <TravelTimeChart rows={manualRows} />}

        <ManualScenarioSummary result={manualResult} />

        <ManualStationAnalysisChart result={manualResult} />

      </div>

    );

  }

  if (workspace !== "historical" && workspace !== "ml") return null;

  const tabData = data?.[workspace];

  return (

    <div className="analysis-panel">

      <div className="analysis-header">

        <span className="analysis-icon">A</span>

        <div>

          <p className="eyebrow">Analysis of Results</p>

          <h3>{workspace === "historical" ? "Historical scenario metrics" : "ML scenario metrics"}</h3>

        </div>

      </div>

      <div className="analysis-toggle-group" aria-label="Analysis views">

        <label className="analysis-toggle"><input type="checkbox" checked={showTravel} onChange={(e) => setShowTravel(e.target.checked)} /><span className="toggle-icon">T</span><span>Travel time analysis</span></label>

        <label className="analysis-toggle"><input type="checkbox" checked={showStation} onChange={(e) => setShowStation(e.target.checked)} /><span className="toggle-icon">S</span><span>Station analysis</span></label>



        <label className="analysis-toggle"><input type="checkbox" checked={showPaths} onChange={(e) => setShowPaths(e.target.checked)} /><span className="toggle-icon">P</span><span>Network weighted average MVC paths</span></label>
        <label className="analysis-toggle"><input type="checkbox" checked={showEntropy} onChange={(e) => setShowEntropy(e.target.checked)} /><span className="toggle-icon">H</span><span>MVC path entropy</span></label>
        <label className="analysis-toggle"><input type="checkbox" checked={showCoverage} onChange={(e) => setShowCoverage(e.target.checked)} /><span className="toggle-icon">C</span><span>Weighted travel-time coverage</span></label>
        {workspace === "ml" && <label className="analysis-toggle"><input type="checkbox" checked={showTraining} onChange={(e) => setShowTraining(e.target.checked)} /><span className="toggle-icon">ML</span><span>ML training and independent temporal test</span></label>}
        <label className="analysis-toggle"><input type="checkbox" checked={showCapacity} onChange={(e) => setShowCapacity(e.target.checked)} /><span className="toggle-icon">%</span><span>Median utilization (% of upper allowance)</span></label>

      </div>

      {!tabData ? <p className="small">Analysis is not available yet.</p> : null}

      {showTravel && tabData && <TravelTimeChart rows={tabData.travelTime} />}


      {showCapacity && tabData && <ScenarioBarChart rows={tabData.scenarioSummary ?? []} metric="medianCapacityUsedPercent" title="Median utilization (% of upper allowance)" unit="%" colorClass="slate" />}

      {showCapacity && tabData && <ScenarioBarChart rows={tabData.scenarioSummary ?? []} metric="medianBaselineAllocationPercent" title="Median allocation (% of baseline)" unit="%" colorClass="slate" />}

      {showPaths && tabData && <ScenarioBarChart rows={tabData.scenarioSummary ?? []} metric="averageMvcEffectivePaths" title="Network weighted average MVC paths" unit="" colorClass="green" />}

      {showPaths && tabData && <ScenarioBarChart rows={tabData.scenarioSummary ?? []} metric="medianStationWeightedPaths" title="Median station weighted average MVC paths" unit="" colorClass="green" />}

      {showStation && tabData && <StationAnalysisChart rows={tabData.stationAnalysis} />}

      {showTravel && <p className="chart-note">More candidate paths may slightly increase travel time because the model permits limited objective trade-offs.</p>}

      {showCapacity && <p className="chart-note">Utilization is measured against the upper allowance for {workspace === "historical" ? "service workload" : "combined territory area"}.</p>}

      {showEntropy && <div className="chart-block">
        <h3>MVC path entropy — all scenarios</h3>
        {(workspace === "historical" ? ["Historical"] : ["RF", "XGB"]).map(variant => <div className="diagnostic-scenario-group" key={variant}>
          <h4>{workspace === "historical" ? "Model 01" : `Model 02 · ${variant}`}</h4>
          <div className="change-table diagnostic-matrix"><table><thead><tr><th>Scenario</th><th>Stations</th><th>Median</th><th>Mean</th><th>Minimum</th></tr></thead>
            <tbody>{(data?.entropy ?? []).filter(r => r.Variant === variant).map(r => <tr key={`${variant}-${r.Scenario}`}><td>{r.Scenario}</td><td>{r.Stations_With_Valid_Entropy}</td><td style={{backgroundColor:`rgba(13,148,136,${.04+r.Median_Normalized_Shannon_Entropy*.15})`}}>{r.Median_Normalized_Shannon_Entropy.toFixed(2)}</td><td style={{backgroundColor:`rgba(13,148,136,${.04+r.Mean_Normalized_Shannon_Entropy*.15})`}}>{r.Mean_Normalized_Shannon_Entropy.toFixed(2)}</td><td style={{backgroundColor:`rgba(13,148,136,${.04+r.Minimum_Normalized_Shannon_Entropy*.15})`}}>{r.Minimum_Normalized_Shannon_Entropy.toFixed(2)}</td></tr>)}</tbody>
          </table></div>
        </div>)}
        <p className="chart-note">Entropy describes the distribution of path counts across assigned MVC grids, including zero-path grids. Higher values indicate a more even distribution, rather than more paths.</p>
      </div>}
      {showCoverage && <div className="chart-block">
        <h3>Weighted travel-time coverage — all scenarios</h3>
        {(workspace === "historical" ? ["Historical"] : ["RF", "XGB"]).flatMap(variant => ["MVC", "Non-MVC"].map(dataset => <CoverageLineChart key={`${variant}-${dataset}`} title={`${workspace === "historical" ? "Model 01" : `Model 02 · ${variant}`} · ${dataset}`} rows={(data?.coverage ?? []).filter(row=>row.Variant===variant && row.Dataset===dataset)} />))}
        <p className="chart-note">Historical demand is weighted by incident severity; ML demand by predicted risk. Each scenario is compared with its corresponding baseline.</p>
      </div>}

      {workspace === "ml" && showTraining && <div className="chart-block">

        <h3>ML training and independent temporal test</h3>



        <div className="change-table"><table><thead><tr><th>Dataset</th><th>Model</th><th>R²</th><th>RMSE</th><th>MAE</th><th>Pearson r</th></tr></thead><tbody>{(data?.testPerformance ?? []).map(r => <tr key={`${r.Dataset}-${r.Model}`}><td>{r.Dataset}</td><td>{r.Model}</td><td>{r.R2.toFixed(2)}</td><td>{r.RMSE.toFixed(2)}</td><td>{r.MAE.toFixed(2)}</td><td>{r["Pearson r"].toFixed(2)}</td></tr>)}</tbody></table></div>

      </div>}

    </div>

  );

}

export function App() {

  const [study, setStudy] = useState<Study | null>(null);

  const [layers, setLayers] = useState<LayerDefinition[]>([]);

  const [layersState, setLayersState] = useState<"loading" | "ready" | "error">("loading");
  const [analysisState, setAnalysisState] = useState<"loading" | "ready" | "error">("loading");
  const [layersAttempt, setLayersAttempt] = useState(0);
  const [analysisAttempt, setAnalysisAttempt] = useState(0);

  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);

  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({});

  const [workspace, setWorkspace] = useState<Workspace>("context");

  const [attributeLayerId, setAttributeLayerId] = useState<string | null>(null);

  const [manualResult, setManualResult] = useState<ManualAllocationResult | null>(null);

  const [manualVisible, setManualVisible] = useState<Record<ManualVisibleKey, boolean>>({

    mvc: true,

    nonMvc: true,

  });

  const [isRunning, setIsRunning] = useState(false);

  const [manualStage, setManualStage] = useState("");

  const [manualError, setManualError] = useState<string | null>(null);

  const manualAbort = useRef<AbortController | null>(null);

  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);

  const [manualSettings, setManualSettings] = useState(DEFAULT_MANUAL_SETTINGS);

  const bandsValid = [manualSettings.mvcLower, manualSettings.nonMvcLower].every(v => Number.isFinite(v) && v === 0) && [manualSettings.mvcUpper, manualSettings.nonMvcUpper].every(v => Number.isFinite(v) && v >= 1.3 && v <= 2);

  const [mapResetKey, setMapResetKey] = useState(0);

  const initializedWorkspaces = useRef<Set<Workspace>>(new Set(["context"]));

  useEffect(() => {

    if (!API_URL) {

      setStudy(FALLBACK_STUDY);

      return;

    }

    fetch(`${API_URL}/v1/study`)

      .then((response) => response.json())

      .then(setStudy)

      .catch(() => setStudy(FALLBACK_STUDY));

  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLayersState("loading");
    fetch(assetUrl("layers/manifest.json"), { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error("Layer request failed"); return response.json(); })
      .then((manifest: { layers: LayerDefinition[] }) => {
        if (!Array.isArray(manifest.layers) || !manifest.layers.length) throw new Error("No layers available");
        const webLayers = manifest.layers.map(layer => ({ ...layer,
          label: displayLabel(layer.label),
          groupLabel: layer.groupLabel ? displayLabel(layer.groupLabel) : undefined,
          scenarioTitle: layer.scenarioTitle ? displayLabel(layer.scenarioTitle) : undefined,
          url: /^https?:\/\//.test(layer.url) ? layer.url : assetUrl(layer.url),
        }));
        if (controller.signal.aborted) return;
        setLayers(webLayers);
        setVisibleLayers(openingVisibleLayers(webLayers));
        initializedWorkspaces.current = new Set(["context"]);
        setLayersState("ready");
      })
      .catch(() => { if (!controller.signal.aborted) setLayersState("error"); });
    return () => controller.abort();
  }, [layersAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    setAnalysisState("loading");
    fetch(assetUrl("layers/analysis.json"), { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error("Analysis request failed"); return response.json(); })
      .then((data: AnalysisData) => {
        if (!data?.historical || !data?.ml) throw new Error("Analysis unavailable");
        if (controller.signal.aborted) return;
        setAnalysis(data);
        setAnalysisState("ready");
      })
      .catch(() => { if (!controller.signal.aborted) setAnalysisState("error"); });
    return () => controller.abort();
  }, [analysisAttempt]);

  const weightTotal = weights.mvcTime + weights.mvcPaths + weights.nonMvcTime;

  const weightsValid = useMemo(

    () => [weights.mvcTime, weights.mvcPaths, weights.nonMvcTime].every((value) => value >= 0 && value <= 1) && Math.abs(weightTotal - 1) < 0.0001,

    [weights, weightTotal],

  );

  const attributeLayer = layers.find((layer) => layer.id === attributeLayerId) ?? layers[0] ?? null;

  const workspaceLayers = layers.filter((layer) => layerWorkspace(layer) === workspace).sort((a, b) => layerSortKey(a) - layerSortKey(b));

  const normalWorkspaceLayers = workspaceLayers.filter((layer) => !layer.id.startsWith(allocationLayerPrefix));

  const allocationWorkspaceLayers = workspaceLayers.filter((layer) => layer.id.startsWith(allocationLayerPrefix));

  const existingTravelRow = analysis?.historical.travelTime.find((row) => row.scenario.toLowerCase().includes("existing")) ?? null;

  const manualTravelRows = manualResult ? [...(existingTravelRow ? [existingTravelRow] : []), ...manualResult.travelTime] : [];

  function changeWorkspace(nextWorkspace: Workspace) {

    setWorkspace(nextWorkspace);

    setVisibleLayers((current) => {

      if (initializedWorkspaces.current.has(nextWorkspace)) return current;

      initializedWorkspaces.current.add(nextWorkspace);

      return { ...current, ...defaultVisibleLayers(layers, nextWorkspace) };

    });

    setAttributeLayerId(null);

  }

  function resetCurrentWorkspace() {

    setVisibleLayers(openingVisibleLayers(layers));

    setManualVisible({ mvc: true, nonMvc: true });

    setAttributeLayerId(null);

    setMapResetKey((value) => value + 1);

  }

  async function runManualScenario() {

    if (!study || !weightsValid || !bandsValid) return;

    setManualError(null);

    setManualStage("Loading scenario solver");

    setIsRunning(true);

    const controller = new AbortController();

    manualAbort.current = controller;

    try {

      const { runManualAllocation } = await import("./manualOptimizer");

      if (controller.signal.aborted) return;

      setManualResult(await runManualAllocation(weights, manualSettings, controller.signal, setManualStage));

    } catch (error) {

      setManualError(error instanceof Error ? error.message : "Unexpected scenario error.");

    } finally {

      manualAbort.current = null;

      setIsRunning(false);

    }

  }

  return (

    <main className="app-shell">

      <header>

        <div>

          <p className="eyebrow">Vision Zero Emergency Response Decision-Support Tool</p>

          <h1>{study?.label ?? "Vision Zero Mapper"}</h1>

        </div>

        <span className={`status ${layersState === "error" || analysisState === "error" ? "status-error" : ""}`} role="status">{layersState === "error" || analysisState === "error" ? "Some data could not load" : layersState === "loading" || analysisState === "loading" ? "Loading app data…" : "Ready"}</span>

      </header>

      <nav aria-label="Workspaces">

        {(Object.keys(workspaceCopy) as Workspace[]).map((item) => (

          <button key={item} className={workspace === item ? "active" : ""} onClick={() => changeWorkspace(item)}>

            {workspaceCopy[item].title}

          </button>

        ))}

      </nav>

      <section className={`workspace ${attributeLayerId ? "table-open" : ""}`}>

        <aside className="controls">
          {layersState === "error" && <div className="load-feedback" role="alert"><p>Could not load map layers. Check your connection and try again.</p><button type="button" onClick={() => setLayersAttempt(value => value + 1)}>Retry map layers</button></div>}

          <p className="eyebrow">{workspaceCopy[workspace].title}</p>

          {workspaceCopy[workspace].description && <h2>{workspaceCopy[workspace].description}</h2>}

          {(workspace === "context" || workspace === "historical" || workspace === "ml") && (

            <div className="layer-list">

              {workspaceLayers.length === 0 ? (

                <p className="small">{layersState === "loading" ? "Loading available map layers…" : layersState === "error" ? "Map layers are unavailable." : "No layers are available in this workspace."}</p>

              ) : (

                <>

                  {groupedLayerRows(normalWorkspaceLayers).map((row) => (

                    row.type === "single" ? (

                      <LayerRow

                        key={row.layer.id}

                        layer={row.layer}

                        checked={visibleLayers[row.layer.id] ?? false}

                        onToggle={(checked) => setVisibleLayers({ ...visibleLayers, [row.layer.id]: checked })}

                        onTable={() => setAttributeLayerId(row.layer.id)}

                      />

                    ) : (

                      <details className="scenario-group" key={row.title}>

                        <summary>{row.title}</summary>

                        {row.layers.map((layer) => (

                          <LayerRow

                            key={layer.id}

                            layer={layer}

                            checked={visibleLayers[layer.id] ?? false}

                            onToggle={(checked) => setVisibleLayers({ ...visibleLayers, [layer.id]: checked })}

                            onTable={() => setAttributeLayerId(layer.id)}

                            indented

                          />

                        ))}

                      </details>

                    )

                  ))}

                  {allocationWorkspaceLayers.length > 0 && (

                    <div className="layer-group">

                      <div className="layer-group-title">{allocationGroupTitle(workspace)}</div>

                      {scenarioModelDescription(workspace) && <p className="small scenario-description">{scenarioModelDescription(workspace)}</p>}

                      {allocationScenarioGroups(allocationWorkspaceLayers).map(([scenarioTitle, scenarioLayers]) => (

                        <details className="scenario-group" key={scenarioTitle}>

                          <summary>{scenarioTitle}</summary>

                          {scenarioLayers.map((layer) => (

                            <LayerRow

                              key={layer.id}

                              layer={layer}

                              checked={visibleLayers[layer.id] ?? false}

                              onToggle={(checked) => setVisibleLayers({ ...visibleLayers, [layer.id]: checked })}

                              onTable={() => setAttributeLayerId(layer.id)}

                              indented

                            />

                          ))}

                        </details>

                      ))}

                    </div>

                  )}

                </>

              )}

            </div>

          )}

          {workspace === "manual" && (

            <>

              <p className="small">Choose weights from 0 to 1 that add up to 1.00.</p>
              <label>MVC travel-time weight <input type="number" min="0" max="1" step="0.05" value={weights.mvcTime} onChange={(e) => setWeights({ ...weights, mvcTime: Math.min(1, Math.max(0, Number(e.target.value))) })} /></label>

              <label>MVC path-accessibility weight <input type="number" min="0" max="1" step="0.05" value={weights.mvcPaths} onChange={(e) => setWeights({ ...weights, mvcPaths: Math.min(1, Math.max(0, Number(e.target.value))) })} /></label>

              <label>Non-MVC travel-time weight <input type="number" min="0" max="1" step="0.05" value={weights.nonMvcTime} onChange={(e) => setWeights({ ...weights, nonMvcTime: Math.min(1, Math.max(0, Number(e.target.value))) })} /></label>

              <p className={`weight-total ${weightsValid ? "valid" : "warning"}`} role="status">Total weight: {weightTotal.toFixed(2)} / 1.00</p>
              <button type="button" className="restore-defaults" disabled={isRunning} onClick={() => { setWeights({ ...DEFAULT_WEIGHTS }); setManualSettings({ ...DEFAULT_MANUAL_SETTINGS }); setManualError(null); }}>Restore defaults</button>
              <p className="small">Upper workload limits: 130–200% of historical baseline; no lower bound.</p>

              {([

                ["MVC upper limit (%)", "mvcUpper", 130, 200],

                ["Non-MVC upper limit (%)", "nonMvcUpper", 130, 200],

              ] as const).map(([label, key, min, max]) => <label key={key}>{label}<input type="number" min={min} max={max} step="1" value={Math.round(manualSettings[key]*100)} onChange={e => setManualSettings({ ...manualSettings, [key]: Number(e.target.value)/100 })} /></label>)}

              <label>Maximum candidate paths<select value={manualSettings.maxPaths} onChange={e => setManualSettings({ ...manualSettings, maxPaths: Number(e.target.value) as 250 | 500 })}><option value="250">250</option><option value="500">500</option></select></label>

              {!bandsValid && <p className="small warning">Upper limits must be 130 to 200%.</p>}

              {!weightsValid && <p className="small warning">Weights must each be between 0 and 1 and sum to 1.00. Current total: {weightTotal.toFixed(2)}</p>}

              <div className="manual-layer-toggles" aria-label="Manual allocation layers">

                <label className="manual-layer-toggle"><input type="checkbox" checked={manualVisible.mvc} onChange={(e) => setManualVisible({ ...manualVisible, mvc: e.target.checked })} /><span>MVC allocation</span></label>

                <label className="manual-layer-toggle"><input type="checkbox" checked={manualVisible.nonMvc} onChange={(e) => setManualVisible({ ...manualVisible, nonMvc: e.target.checked })} /><span>Non-MVC allocation</span></label>

              </div>

              <button className="run" disabled={!study || !weightsValid || !bandsValid || isRunning} onClick={runManualScenario}>

                {isRunning ? <span className="running-label"><span className="spinner" aria-hidden="true" />{manualStage || "Starting allocation"}...</span> : "Run weighted scenario"}

              </button>

              {isRunning && <button className="run" type="button" onClick={() => manualAbort.current?.abort()}>Cancel run</button>}

              {manualError && <p className="small warning" role="alert">{manualError}</p>}

              <p className="small">Explore an approximate allocation using your weights and workload limits.</p>

            </>

          )}

        </aside>

        <MapPanel study={study} layers={layers} visibleLayers={visibleLayers} workspace={workspace} manualResult={workspace === "manual" ? manualResult : null} manualVisible={manualVisible} resetKey={mapResetKey} onReset={resetCurrentWorkspace} />

        <AttributeTable layer={attributeLayer} isOpen={attributeLayerId !== null} onClose={() => setAttributeLayerId(null)} />

        <aside className="results">

          {analysisState === "loading" && <p className="small" role="status">Loading analysis…</p>}
          {analysisState === "error" && <div className="load-feedback" role="alert"><p>Could not load analysis data. Check your connection and try again.</p><button type="button" onClick={() => setAnalysisAttempt(value => value + 1)}>Retry analysis</button></div>}
          {(analysisState === "ready" || workspace === "manual") && <AnalysisPanel workspace={workspace} data={analysis} manualRows={manualTravelRows} manualResult={manualResult} />}

        </aside>

      </section>

    </main>

  );

}

