import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { Map } from "maplibre-gl";
import { ManualAllocationGeoJSON, ManualAllocationResult, runManualAllocation } from "./manualAllocator";

type Workspace = "context" | "historical" | "ml" | "manual";

type Study = { id: string; label: string; map_center: [number, number]; default_zoom: number };

type LayerDefinition = {
  id: string;
  label: string;
  kind: "fill" | "line" | "circle" | "raster";
  url: string;
  color?: string;
  colorBy?: string;
  colorMap?: Record<string, string>;
  colorRampBy?: string;
  coordinates?: [[number, number], [number, number], [number, number], [number, number]];
  legend?:
    | { type: "ramp"; min: number; max: number; colors: string[]; stretch?: string }
    | { type: "quantile"; breaks: number[]; colors: string[]; labels: string[] };
  workspace?: Workspace;
  scenario?: string;
  scenarioTitle?: string;
  layerGroup?: string;
  groupLabel?: string;
  lineColor?: string;
  lineOpacity?: number;
  opacity: number;
  featureCount: number;
};

type GeoJsonFeature = {
  type: "Feature";
  geometry: unknown;
  properties: Record<string, string | number | null>;
};

type GeoJsonCollection = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
};

type ManualResponse = {
  summary: {
    assigned_demand_records: number;
    unassigned_demand_records: number;
    metrics: Record<string, number | null>;
    notes: string[];
  };
  assignments: Array<Record<string, string | number | null>>;
  station_summary: Array<Record<string, string | number>>;
};

type TravelTimeRow = {
  scenario: string;
  mvc?: number | null;
  remaining?: number | null;
  overall?: number | null;
};

type StationAnalysisRow = {
  scenario: string;
  station: string;
  mvcTravel?: number | null;
  remainingTravel?: number | null;
  capacityUsedPercent?: number | null;
  mvcEffectivePaths?: number | null;
};

type ScenarioSummaryRow = {
  scenario: string;
  medianCapacityUsedPercent?: number | null;
  averageMvcEffectivePaths?: number | null;
};

type StationChangeRow = {
  scenario: string;
  station: string;
  averageChangeSec?: number | null;
  averageBaselineSec?: number | null;
  averageOptimizedSec?: number | null;
  weight?: number | null;
  gridCount?: number | null;
  improvedGridCount?: number | null;
  worsenedGridCount?: number | null;
  source?: string | null;
};

type ContextInfoData = {
  incidentComposition?: {
    mvcCount: number;
    nonMvcCount: number;
    totalCount: number;
    mvcPercent?: number | null;
    nonMvcPercent?: number | null;
  };
  existingTravelTime?: {
    mvc?: number | null;
    remaining?: number | null;
    overall?: number | null;
  };
  existingResponseTime?: {
    mvc?: number | null;
    remaining?: number | null;
    overall?: number | null;
  };
  stationExistingFreeFlow?: Array<{
    station: string;
    averageExistingFreeFlowTimeSec?: number | null;
  }>;
  stationExistingResponse?: Array<{
    station: string;
    category: string;
    averageResponseTimeSecGridBased?: number | null;
  }>;
};

type AnalysisData = {
  context?: ContextInfoData;
  historical: { travelTime: TravelTimeRow[]; stationAnalysis: StationAnalysisRow[]; scenarioSummary: ScenarioSummaryRow[]; stationChange?: StationChangeRow[] };
  ml: { travelTime: TravelTimeRow[]; stationAnalysis: StationAnalysisRow[]; scenarioSummary: ScenarioSummaryRow[]; stationChange?: StationChangeRow[] };
};

const API_URL = import.meta.env.VITE_API_URL as string | undefined;
const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
const FALLBACK_STUDY: Study = {
  id: "toronto",
  label: "A Decision-Intelligence Framework for Resilient Emergency Response to Motor Vehicle Collisions within Vision Zero Post-Crash Care",
  map_center: [-79.38, 43.70],
  default_zoom: 10,
};
const OPENSTREETMAP_STYLE = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    openStreetMap: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "openstreetmap", type: "raster", source: "openStreetMap" }],
} as const;
const MAP_STYLE = import.meta.env.VITE_MAP_STYLE_URL ?? OPENSTREETMAP_STYLE;

const workspaceCopy: Record<Workspace, { title: string; description: string }> = {
  context: {
    title: "City context",
    description: "",
  },
  historical: {
    title: "Model 01: Historical Allocation",
    description: "Historical-based incidents polygon layer",
  },
  ml: {
    title: "Model 02: Proactive Allocation",
    description: "Machine learning prediction raster",
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
    return "This model is solved uses the multi-objective incident-based capacity-constrained with less than a 0.05% gap.";
  }
  if (workspace === "ml") {
    return "This model is solved uses the multi-objective predicted risk area-based capacity-constrained with less than a 0.05% gap";
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
    rows.push({ type: "group", title: layer.layerGroup, layers: layers.filter((item) => item.layerGroup === layer.layerGroup) });
  });
  return rows;
}

function isStationZeroLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "0.0" || normalized === "station 0";
}

function isFireStationZero(properties: Record<string, unknown>) {
  return isStationZeroLabel(String(properties.STATION10 ?? ""));
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
      paint: { "line-color": layer.lineColor ?? layer.color ?? "#64748b", "line-width": 1.2, "line-opacity": layer.lineOpacity ?? 0.85 },
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
        "circle-radius": layer.id === "fire_stations"
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

function stationSortValue(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
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

function averageNumbers(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function numericValue(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
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
          Unique_Incidents: Number(group.incidents.toFixed(3)),
          Allocated_Demand: Number((group.incidents > 0 ? group.incidents : group.gridCount).toFixed(3)),
          Density_Basis: group.incidents > 0 ? "Incident count" : "Allocated grid count",
          Allocated_Service_Workload_sec: Number(group.workload.toFixed(3)),
          Average_FreeFlow_Time_sec: averageNumbers(group.freeFlow) == null ? null : Number(averageNumbers(group.freeFlow)?.toFixed(3)),
          Average_Service_Time_sec: averageNumbers(group.service) == null ? null : Number(averageNumbers(group.service)?.toFixed(3)),
          Average_Effective_Path_Count_Under240: averageNumbers(group.paths) == null ? null : Number(averageNumbers(group.paths)?.toFixed(3)),
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
    .map(([label, key]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(properties[key])}</td></tr>`)
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
      ["Grids", "Grid_Count"],
      ["Grid", "Grid_ID"],
      ["Allocated station", "Allocated_Station"],
      ["Demand type", "Demand_Type"],
      ["Incidents", "Unique_Incidents"],
      ["Allocated demand", "Allocated_Demand"],
      ["Density basis", "Density_Basis"],
      ["Average free-flow time", "Average_FreeFlow_Time_sec"],
      ["Free-flow time", "FreeFlow_Time_sec"],
      ["Workload", "Allocated_Service_Workload_sec"],
      ["Average service time", "Average_Service_Time_sec"],
      ["Average MVC paths", "Average_Effective_Path_Count_Under240"],
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
      .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`)
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
            {layer.legend?.type === "ramp" ? (
              <>
                <div className="legend-ramp" style={{ background: `linear-gradient(90deg, ${layer.legend.colors.join(", ")})` }} />
                <div className="legend-ramp-labels"><span>{layer.legend.min}</span><span>{layer.legend.max}</span></div>
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
    if (currentMap.isStyleLoaded()) loadLayers();
    else currentMap.once("load", loadLayers);
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
    const onClick = (event: maplibregl.MapMouseEvent) => {
      const activeLayerIds = [
        ...Object.entries(manualAllocationSourceIds)
          .filter(([key, sourceId]) => manualResult && manualVisible[key as keyof typeof manualVisible] && currentMap.getLayer(`${sourceId}-fill`))
          .map(([, sourceId]) => `${sourceId}-fill`),
        ...clickableLayerIds(currentMap, layers, visibleLayers),
      ];
      const features = currentMap.queryRenderedFeatures(event.point, { layers: activeLayerIds });
      const feature = features[0];
      if (!feature?.properties) return;
      const layerId = String(feature.source);
      new maplibregl.Popup({ maxWidth: "360px" })
        .setLngLat(event.lngLat)
        .setHTML(popupHtml(layerId, feature.properties))
        .addTo(currentMap);
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
      currentMap.off("click", onClick);
      currentMap.off("mousemove", onMove);
      currentMap.off("mouseout", onLeave);
    };
  }, [layers, visibleLayers, manualResult, manualVisible]);

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
      <MapLegend layers={layers} visibleLayers={visibleLayers} manualColorMap={manualStationLegend} />
    </div>
  );
}

function AttributeTable({ layer, isOpen, onClose }: { layer: LayerDefinition | null; isOpen: boolean; onClose: () => void }) {
  const [features, setFeatures] = useState<GeoJsonFeature[]>([]);

  useEffect(() => {
    if (!isOpen || !layer) return;
    fetch(layer.url)
      .then((response) => response.json())
      .then((geojson: GeoJsonCollection) => {
        const nextFeatures = geojson.features ?? [];
        setFeatures(layer.id === "fire_stations" ? nextFeatures.filter((feature) => !isFireStationZero(feature.properties ?? {})) : nextFeatures);
      })
      .catch(() => setFeatures([]));
  }, [isOpen, layer]);

  const columns = useMemo(() => {
    const names = new Set<string>();
    features.slice(0, 200).forEach((feature) => {
      Object.keys(feature.properties ?? {}).forEach((key) => names.add(key));
    });
    return Array.from(names).slice(0, 16);
  }, [features]);

  if (!isOpen || !layer) return null;

  return (
    <section className="attribute-table" aria-label="Attribute table">
      <div className="attribute-head">
        <div>
          <p className="eyebrow">Attribute table</p>
          <h2>{layer.label}</h2>
        </div>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              {columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {features.slice(0, 500).map((feature, index) => (
              <tr key={index}>
                <td>{index + 1}</td>
                {columns.map((column) => <td key={column}>{feature.properties?.[column] ?? ""}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">Showing {Math.min(features.length, 500).toLocaleString()} of {features.length.toLocaleString()} features.</p>
    </section>
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

function shortScenarioName(value: string) {
  return value.replace("Scenario ", "S").replace("Allocation_under_", "");
}

function valueLabel(value?: number | null) {
  return value == null ? "" : value.toFixed(1);
}

function percentChangeLabel(baseline?: number | null, value?: number | null) {
  if (!baseline || value == null) return "";
  const change = ((baseline - value) / baseline) * 100;
  const direction = change >= 0 ? "improvement" : "worse";
  return `${Math.abs(change).toFixed(1)}% ${direction} (${value.toFixed(1)} sec)`;
}

function travelLegendLabel(row: TravelTimeRow) {
  return `MVC ${valueLabel(row.mvc)} | non_MVC ${valueLabel(row.remaining)} | Overall ${valueLabel(row.overall)} sec`;
}
function TravelTimeChart({ rows }: { rows: TravelTimeRow[] }) {
  const series = [
    { key: "mvc" as const, label: "MVC", angle: -90 },
    { key: "remaining" as const, label: "non_MVC", angle: 30 },
    { key: "overall" as const, label: "Overall", angle: 150 },
  ];
  const colors = ["#111827", "#7c3aed", "#0891b2", "#dc2626", "#16a34a", "#f59e0b", "#2563eb", "#db2777", "#64748b", "#14b8a6"];
  const dashPatterns = ["", "8 3", "4 3", "10 4 2 4", "2 3", "12 3", "6 2 2 2", "3 5", "9 2 2 2", "5 2"];
  const minValue = 120;
  const tickMax = 160;
  const tickValues = Array.from({ length: Math.floor((tickMax - minValue) / 10) + 1 }, (_, index) => minValue + index * 10);
  const isBaselineRow = (row: TravelTimeRow) => {
    const scenario = row.scenario.trim().toLowerCase();
    return scenario.includes("existing condition") || scenario === "baseline" || scenario.startsWith("baseline ");
  };
  const baselineRows = rows.filter(isBaselineRow);
  const fallbackBaseline = baselineRows[0] ?? rows[0];
  const scenarioRows = rows.filter((row) => !isBaselineRow(row));
  const baselineForScenario = (row: TravelTimeRow) => {
    const upper = row.scenario.toUpperCase();
    if (upper.includes("XGB")) return baselineRows.find((item) => item.scenario.toUpperCase().includes("XGB")) ?? fallbackBaseline;
    if (upper.includes("RF")) return baselineRows.find((item) => item.scenario.toUpperCase().includes("RF")) ?? fallbackBaseline;
    return fallbackBaseline;
  };
  const center = 160;
  const innerRadius = 30;
  const radius = 112;
  const point = (angle: number, value: number) => {
    const radians = (angle * Math.PI) / 180;
    const clamped = Math.min(tickMax, Math.max(value, minValue));
    const scaled = innerRadius + ((clamped - minValue) / (tickMax - minValue)) * (radius - innerRadius);
    return [center + Math.cos(radians) * scaled, center + Math.sin(radians) * scaled];
  };
  const labelPoint = (angle: number) => {
    const radians = (angle * Math.PI) / 180;
    const labelRadius = radius + 20;
    return [center + Math.cos(radians) * labelRadius, center + Math.sin(radians) * labelRadius];
  };
  return (
    <div className="chart-block radar-block">
      <svg className="radar-chart" viewBox="0 0 320 320" role="img" aria-label="Average travel time radar chart">
        {tickValues.map((tick) => (
          <polygon
            key={tick}
            className="radar-grid"
            points={series.map((item) => point(item.angle, tick).join(",")).join(" ")}
          />
        ))}
        {tickValues.map((tick) => {
          const [, y] = point(-90, tick);
          return <text className="radar-tick-label" key={`tick-${tick}`} x={center + 5} y={y + 3}>{tick}</text>;
        })}
        {series.map((item) => {
          const [x, y] = point(item.angle, tickMax);
          const [labelX, labelY] = labelPoint(item.angle);
          return (
            <g key={item.key}>
              <line className="radar-axis" x1={center} y1={center} x2={x} y2={y} />
              <text className="radar-axis-label" x={labelX} y={labelY} textAnchor="middle">{item.label}</text>
            </g>
          );
        })}
        {rows.map((row, index) => {
          const points = series.map((item) => point(item.angle, Number(row[item.key] ?? 0)).join(",")).join(" ");
          return (
            <polygon
              key={row.scenario}
              points={points}
              fill={colors[index % colors.length]}
              stroke={colors[index % colors.length]}
              strokeDasharray={dashPatterns[index % dashPatterns.length]}
              strokeDashoffset={index * 1.5}
              className="radar-series"
            />
          );
        })}
      </svg>
      <div className="chart-legend radar-legend">
        {rows.map((row, index) => (
          <span className="radar-legend-item" key={row.scenario} title={row.scenario}>
            <i style={{ background: colors[index % colors.length] }} />
            <strong>{shortScenarioName(row.scenario)}</strong>
            <em>{travelLegendLabel(row)}</em>
          </span>
        ))}
        <span className="chart-note">Radar scale spans 120-160 sec in 10-sec intervals; lower travel time plots closer to the center.</span>
      </div>
      {fallbackBaseline && scenarioRows.length > 0 && (
        <div className="change-table">
          <table>
            <thead>
              <tr>
                <th>Scenario</th>
                <th>MVC avg travel</th>
                <th>non_MVC avg travel</th>
                <th>Overall avg travel</th>
              </tr>
            </thead>
            <tbody>
              {scenarioRows.map((row) => {
                const baseline = baselineForScenario(row);
                return (
                  <tr key={row.scenario}>
                    <td>{shortScenarioName(row.scenario)}</td>
                    <td>{percentChangeLabel(baseline?.mvc, row.mvc)}</td>
                    <td>{percentChangeLabel(baseline?.remaining, row.remaining)}</td>
                    <td>{percentChangeLabel(baseline?.overall, row.overall)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StationAnalysisChart({ rows }: { rows: StationAnalysisRow[] }) {
  const scenarioNames = Array.from(new Set(rows.map((row) => row.scenario)));
  const maxTravel = Math.max(1, ...rows.flatMap((row) => [Number(row.mvcTravel ?? 0), Number(row.remainingTravel ?? 0)]));
  const maxPaths = Math.max(1, ...rows.map((row) => Number(row.mvcEffectivePaths ?? 0)));
  return (
    <div className="chart-block station-chart">
      {scenarioNames.map((scenario) => {
        const scenarioRows = rows.filter((row) => row.scenario === scenario);
        return (
          <details className="station-scenario" key={scenario}>
            <summary>{shortScenarioName(scenario)} <span>{scenarioRows.length} stations</span></summary>
            <div className="station-table">
              {scenarioRows.map((row) => (
                <div className="station-row" key={`${row.scenario}-${row.station}`}>
                  <span className="station-id">{row.station}</span>
                  <span className="mini-bar purple" style={{ width: `${((row.mvcTravel ?? 0) / maxTravel) * 100}%` }} title={`MVC travel: ${valueLabel(row.mvcTravel)} sec`} />
                  <span className="mini-bar cyan" style={{ width: `${((row.remainingTravel ?? 0) / maxTravel) * 100}%` }} title={`non_MVC travel: ${valueLabel(row.remainingTravel)} sec`} />
                  <span className="mini-bar slate" style={{ width: `${Math.min(row.capacityUsedPercent ?? 0, 100)}%` }} title={`Capacity used: ${valueLabel(row.capacityUsedPercent)}%`} />
                  <span className="mini-bar green" style={{ width: `${((row.mvcEffectivePaths ?? 0) / maxPaths) * 100}%` }} title={`MVC effective paths: ${valueLabel(row.mvcEffectivePaths)}`} />
                </div>
              ))}
            </div>
          </details>
        );
      })}
      <div className="chart-legend">
        <span><i className="purple" />MVC travel</span>
        <span><i className="cyan" />non_MVC travel</span>
        <span><i className="slate" />Capacity %</span>
        <span><i className="green" />MVC paths</span>
      </div>
    </div>
  );
}

function StationChangeChart({ rows }: { rows: StationChangeRow[] }) {
  const scenarioNames = Array.from(new Set(rows.map((row) => row.scenario)));
  if (scenarioNames.length === 0) return <p className="small">No station change rows are available for this tab.</p>;
  const maxAbsChange = Math.max(1, ...rows.map((row) => Math.abs(Number(row.averageChangeSec ?? 0))));
  return (
    <div className="chart-block station-change-chart">
      {scenarioNames.map((scenario) => {
        const scenarioRows = rows
          .filter((row) => row.scenario === scenario && row.averageChangeSec != null)
          .sort((a, b) => Math.abs(Number(b.averageChangeSec ?? 0)) - Math.abs(Number(a.averageChangeSec ?? 0)));
        return (
          <details className="station-scenario" key={scenario}>
            <summary>{shortScenarioName(scenario)} <span>{scenarioRows.length} stations</span></summary>
            <div className="change-bar-table">
              {scenarioRows.map((row) => {
                const change = Number(row.averageChangeSec ?? 0);
                const width = `${(Math.abs(change) / maxAbsChange) * 50}%`;
                return (
                  <div className="change-bar-row" key={`${scenario}-${row.station}`}>
                    <span className="station-id">{row.station}</span>
                    <span className="change-bar-track">
                      <span
                        className={`change-bar-fill ${change <= 0 ? "improved" : "worsened"}`}
                        style={change <= 0 ? { right: "50%", width } : { left: "50%", width }}
                        title={`Baseline ${valueLabel(row.averageBaselineSec)} sec | Optimized ${valueLabel(row.averageOptimizedSec)} sec`}
                      />
                    </span>
                    <span className={`change-bar-value ${change <= 0 ? "improved-text" : "worsened-text"}`}>
                      {change > 0 ? "+" : ""}{change.toFixed(1)} sec
                    </span>
                  </div>
                );
              })}
            </div>
          </details>
        );
      })}
      <div className="chart-legend">
        <span><i className="green" />Improved travel time</span>
        <span><i className="red" />Worse travel time</span>
      </div>
      <p className="chart-note">Bars show weighted average optimized free-flow time minus baseline free-flow time by optimized station. Negative values are improvements.</p>
    </div>
  );
}

function manualWeightedAverage(
  features: ManualAllocationGeoJSON["features"],
  valueField: string,
  weightField = "Unique_Incidents",
) {
  let weightedTotal = 0;
  let weightTotal = 0;
  const unweightedValues: number[] = [];

  features.forEach((feature) => {
    const value = numericValue(feature.properties[valueField]);
    if (value === null) return;
    const weight = numericValue(feature.properties[weightField]) ?? 0;
    if (weight > 0) {
      weightedTotal += value * weight;
      weightTotal += weight;
    }
    unweightedValues.push(value);
  });

  if (weightTotal > 0) return weightedTotal / weightTotal;
  return averageNumbers(unweightedValues);
}

function manualCapacitySummaryMap(result: ManualAllocationResult) {
  const rows = result.diagnostics?.capacitySummary;
  const map = new globalThis.Map<string, number | null>();
  if (!Array.isArray(rows)) return map;

  rows.forEach((item) => {
    const row = item as Record<string, unknown>;
    const station = String(row.station ?? "").trim();
    if (!station || isStationZeroLabel(station)) return;
    const mvcWorkload = numericValue(row.mvcWorkload) ?? 0;
    const nonMvcWorkload = numericValue(row.nonMvcHistoricalWorkload) ?? 0;
    const mvcCapacity = numericValue(row.mvcCapacity) ?? 0;
    const nonMvcCapacity = numericValue(row.nonMvcCapacity) ?? 0;
    const totalCapacity = mvcCapacity + nonMvcCapacity;

    if (totalCapacity > 0) {
      map.set(station, ((mvcWorkload + nonMvcWorkload) / totalCapacity) * 100);
      return;
    }

    const fallbackValues = [
      numericValue(row.mvcCapacityUsedPercent),
      numericValue(row.nonMvcHistoricalCapacityUsedPercent),
    ].filter((value): value is number => value !== null);
    map.set(station, averageNumbers(fallbackValues));
  });

  return map;
}

function manualStationAnalysisRows(result: ManualAllocationResult | null): StationAnalysisRow[] {
  if (!result) return [];
  const capacityByStation = manualCapacitySummaryMap(result);
  const stations = new Set<string>();
  [...result.mvcGeojson.features, ...result.nonMvcGeojson.features].forEach((feature) => {
    const station = String(feature.properties.Allocated_Station ?? "").trim();
    if (station && !isStationZeroLabel(station)) stations.add(station);
  });
  capacityByStation.forEach((_, station) => stations.add(station));

  return Array.from(stations)
    .sort((a, b) => {
      const aValue = stationSortValue(a);
      const bValue = stationSortValue(b);
      return typeof aValue === "number" && typeof bValue === "number" ? aValue - bValue : String(aValue).localeCompare(String(bValue));
    })
    .map((station) => {
      const mvcFeatures = result.mvcGeojson.features.filter((feature) => String(feature.properties.Allocated_Station ?? "").trim() === station);
      const nonMvcFeatures = result.nonMvcGeojson.features.filter((feature) => {
        const properties = feature.properties;
        return String(properties.Allocated_Station ?? "").trim() === station && String(properties.Demand_Type ?? "") !== "Zero-Incident Territory";
      });

      return {
        scenario: "Manual weighted allocation",
        station,
        mvcTravel: manualWeightedAverage(mvcFeatures, "FreeFlow_Time_sec"),
        remainingTravel: manualWeightedAverage(nonMvcFeatures, "FreeFlow_Time_sec"),
        capacityUsedPercent: capacityByStation.get(station) ?? null,
        mvcEffectivePaths: manualWeightedAverage(mvcFeatures, "Effective_Path_Count_Under240"),
      };
    })
    .filter((row) => row.mvcTravel !== null || row.remainingTravel !== null || row.capacityUsedPercent !== null || row.mvcEffectivePaths !== null);
}

function ManualStationAnalysisChart({ result }: { result: ManualAllocationResult | null }) {
  const rows = manualStationAnalysisRows(result);
  if (!rows.length) return null;
  return (
    <div className="chart-block manual-station-analysis">
      <h3>Station analysis</h3>
      <StationAnalysisChart rows={rows} />
    </div>
  );
}

function ScenarioBarChart({ rows, metric, title, unit, colorClass }: { rows: ScenarioSummaryRow[]; metric: "medianCapacityUsedPercent" | "averageMvcEffectivePaths"; title: string; unit: string; colorClass: string }) {
  const visibleRows = rows.filter((row) => row[metric] != null);
  const maxValue = Math.max(1, ...visibleRows.map((row) => Number(row[metric] ?? 0)));
  if (visibleRows.length === 0) return <p className="small">No scenario summary values available for {title.toLowerCase()}.</p>;
  return (
    <div className="chart-block scenario-bar-chart">
      <h3>{title}</h3>
      {visibleRows.map((row) => {
        const value = Number(row[metric] ?? 0);
        return (
          <div className="scenario-bar-row" key={`${title}-${row.scenario}`}>
            <span className="scenario-bar-label" title={row.scenario}>{shortScenarioName(row.scenario)}</span>
            <span className="scenario-bar-track"><span className={`scenario-bar-fill ${colorClass}`} style={{ width: `${(value / maxValue) * 100}%` }} /></span>
            <span className="scenario-bar-value">{value.toFixed(1)}{unit}</span>
          </div>
        );
      })}
    </div>
  );
}

function ExistingMetricLineChart({ title, values }: { title: string; values?: { mvc?: number | null; remaining?: number | null; overall?: number | null } }) {
  const points = [
    { key: "mvc", label: "MVC", value: values?.mvc },
    { key: "remaining", label: "non_MVC", value: values?.remaining },
    { key: "overall", label: "Overall", value: values?.overall },
  ].filter((point) => point.value != null) as Array<{ key: string; label: string; value: number }>;
  if (points.length === 0) return <p className="small">{title} is not available.</p>;
  const maxValue = Math.max(...points.map((point) => point.value));
  const minValue = Math.min(...points.map((point) => point.value));
  const range = Math.max(1, maxValue - minValue);
  const x = (index: number) => 24 + index * 90;
  const y = (value: number) => 118 - ((value - minValue) / range) * 74;
  const polyline = points.map((point, index) => `${x(index)},${y(point.value)}`).join(" ");
  return (
    <div className="context-line-chart">
      <h3>{title}</h3>
      <svg viewBox="0 0 230 150" role="img" aria-label={title}>
        <line className="context-chart-axis" x1="24" y1="118" x2="205" y2="118" />
        <line className="context-chart-axis" x1="24" y1="36" x2="24" y2="118" />
        <polyline className="context-chart-line" points={polyline} />
        {points.map((point, index) => (
          <g key={point.key}>
            <circle className="context-chart-point" cx={x(index)} cy={y(point.value)} r="4" />
            <text className="context-chart-value" x={x(index)} y={y(point.value) - 8} textAnchor="middle">{valueLabel(point.value)}</text>
            <text className="context-chart-label" x={x(index)} y="137" textAnchor="middle">{point.label}</text>
          </g>
        ))}
      </svg>
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
      <p className="eyebrow">Information</p>
      <h3>Existing incident composition</h3>
      {incidentComposition ? (
        <div className="incident-share-table">
          <table>
            <thead><tr><th>Incident type</th><th>Count</th><th>Percentage</th></tr></thead>
            <tbody>
              <tr><td>MVC</td><td>{incidentComposition.mvcCount.toLocaleString()}</td><td>{valueLabel(incidentComposition.mvcPercent)}%</td></tr>
              <tr><td>Non-MVC</td><td>{incidentComposition.nonMvcCount.toLocaleString()}</td><td>{valueLabel(incidentComposition.nonMvcPercent)}%</td></tr>
              <tr className="total-row"><td>Total</td><td>{incidentComposition.totalCount.toLocaleString()}</td><td>100.0%</td></tr>
            </tbody>
          </table>
        </div>
      ) : <p className="small">Incident composition is not available.</p>}
      <ExistingMetricLineChart title="Existing average free-flow travel time" values={travel} />
      <ExistingMetricLineChart title="Existing average response time" values={response} />
      <h3>Average existing travel and response time by fire station</h3>
      {combinedStationRows.length > 0 ? (
        <div className="station-info-table">
          <table>
            <thead>
              <tr><th>Station</th><th>Free-flow time</th><th>MVC response</th><th>non_MVC response</th></tr>
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
  manualNotes,
  manualResult,
}: {
  workspace: Workspace;
  data: AnalysisData | null;
  manualRows: TravelTimeRow[];
  manualNotes: string[];
  manualResult: ManualAllocationResult | null;
}) {
  const [showTravel, setShowTravel] = useState(true);
  const [showChange, setShowChange] = useState(false);
  const [showCapacity, setShowCapacity] = useState(false);
  const [showPaths, setShowPaths] = useState(false);
  const [showStation, setShowStation] = useState(false);
  useEffect(() => {
    if (workspace !== "historical" && workspace !== "ml") return;
    setShowTravel(true);
    setShowChange(false);
    setShowCapacity(false);
    setShowPaths(false);
    setShowStation(false);
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
        <ManualStationAnalysisChart result={manualResult} />
        {manualNotes.map((note) => <p className="small" key={note}>{note}</p>)}
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
        <label className="analysis-toggle"><input type="checkbox" checked={showCapacity} onChange={(e) => setShowCapacity(e.target.checked)} /><span className="toggle-icon">%</span><span>Overall median capacity utilization</span></label>
        <label className="analysis-toggle"><input type="checkbox" checked={showChange} onChange={(e) => setShowChange(e.target.checked)} /><span className="toggle-icon">M</span><span>MVC travel time change by station</span></label>
        <label className="analysis-toggle"><input type="checkbox" checked={showPaths} onChange={(e) => setShowPaths(e.target.checked)} /><span className="toggle-icon">P</span><span>Average MVC effective paths</span></label>
      </div>
      {!tabData ? <p className="small">Run the layer export to generate analysis data.</p> : null}
      {showTravel && tabData && <TravelTimeChart rows={tabData.travelTime} />}
      {showChange && tabData && <StationChangeChart rows={tabData.stationChange ?? []} />}
      {showCapacity && tabData && <ScenarioBarChart rows={tabData.scenarioSummary ?? []} metric="medianCapacityUsedPercent" title="Median capacity utilization" unit="%" colorClass="slate" />}
      {showPaths && tabData && <ScenarioBarChart rows={tabData.scenarioSummary ?? []} metric="averageMvcEffectivePaths" title="Average MVC effective paths" unit="" colorClass="green" />}
      {showStation && tabData && <StationAnalysisChart rows={tabData.stationAnalysis} />}
    </div>
  );
}

export function App() {
  const [study, setStudy] = useState<Study | null>(null);
  const [layers, setLayers] = useState<LayerDefinition[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({});
  const [workspace, setWorkspace] = useState<Workspace>("context");
  const [attributeLayerId, setAttributeLayerId] = useState<string | null>(null);
  const [result, setResult] = useState<ManualResponse | null>(null);
  const [manualResult, setManualResult] = useState<ManualAllocationResult | null>(null);
  const [manualVisible, setManualVisible] = useState<Record<ManualVisibleKey, boolean>>({
    mvc: true,
    nonMvc: true,
  });
  const [isRunning, setIsRunning] = useState(false);
  const [weights, setWeights] = useState({ mvcTime: 0.60, mvcPaths: 0.20, nonMvcTime: 0.20 });
  const [manualCapacityLeeway, setManualCapacityLeeway] = useState(1.5);
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
    fetch(assetUrl("layers/manifest.json"))
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((manifest: { layers: LayerDefinition[] }) => {
        const webLayers = manifest.layers.map((layer) => ({ ...layer, url: assetUrl(layer.url) }));
        setLayers(webLayers);
        setVisibleLayers(openingVisibleLayers(webLayers));
      })
      .catch(() => setLayers([]));
  }, []);

  useEffect(() => {
    fetch(assetUrl("layers/analysis.json"))
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then(setAnalysis)
      .catch(() => setAnalysis(null));
  }, []);

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
    if (!study || !weightsValid) return;
    setIsRunning(true);
    try {
      setManualResult(await runManualAllocation(weights, manualCapacityLeeway));
      setResult(null);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Unexpected scenario error.");
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="app-shell">
      <header>
        <div>
          <p className="eyebrow">MapLibre Vision Zero Emergency Response Decision-Support Tool</p>
          <h1>{study?.label ?? "Vision Zero Mapper"}</h1>
        </div>
        <span className="status">{layers.length > 0 ? `${layers.length} layers ready` : "Run layer export"}</span>
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
          <p className="eyebrow">{workspaceCopy[workspace].title}</p>
          {workspaceCopy[workspace].description && <h2>{workspaceCopy[workspace].description}</h2>}
          {(workspace === "context" || workspace === "historical" || workspace === "ml") && (
            <div className="layer-list">
              {workspaceLayers.length === 0 ? (
                <p className="small">No exported layers found. Run `python tools/export_map_layers.py` from the project root.</p>
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
              <label>MVC response-time weight <input type="number" min="0" max="1" step="0.05" value={weights.mvcTime} onChange={(e) => setWeights({ ...weights, mvcTime: Math.min(1, Math.max(0, Number(e.target.value))) })} /></label>
              <label>MVC path-accessibility weight <input type="number" min="0" max="1" step="0.05" value={weights.mvcPaths} onChange={(e) => setWeights({ ...weights, mvcPaths: Math.min(1, Math.max(0, Number(e.target.value))) })} /></label>
              <label>Non-MVC response-time weight <input type="number" min="0" max="1" step="0.05" value={weights.nonMvcTime} onChange={(e) => setWeights({ ...weights, nonMvcTime: Math.min(1, Math.max(0, Number(e.target.value))) })} /></label>
              <label>Capacity leeway
                <select value={manualCapacityLeeway.toFixed(1)} onChange={(e) => setManualCapacityLeeway(Number(e.target.value))}>
                  {[1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0].map((value) => <option key={value} value={value.toFixed(1)}>{value.toFixed(1)}</option>)}
                </select>
              </label>
              {!weightsValid && <p className="small warning">Weights must each be between 0 and 1 and sum to 1.00. Current total: {weightTotal.toFixed(2)}</p>}
              <div className="manual-layer-toggles" aria-label="Manual allocation layers">
                <label className="manual-layer-toggle"><input type="checkbox" checked={manualVisible.mvc} onChange={(e) => setManualVisible({ ...manualVisible, mvc: e.target.checked })} /><span>MVC allocation</span></label>
                <label className="manual-layer-toggle"><input type="checkbox" checked={manualVisible.nonMvc} onChange={(e) => setManualVisible({ ...manualVisible, nonMvc: e.target.checked })} /><span>Non-MVC allocation</span></label>
              </div>
              <button className="run" disabled={!study || !weightsValid || isRunning} onClick={runManualScenario}>
                {isRunning ? <span className="running-label"><span className="spinner" aria-hidden="true" />Running...</span> : "Run weighted scenario"}
              </button>
              <p className="small">This manual run uses the weighted multi-objective capacity-constrained JavaScript allocator with the selected {manualCapacityLeeway.toFixed(1)} capacity leeway and a 2% gap. It could take a couple of minutes to solve.</p>
            </>
          )}
        </aside>
        <MapPanel study={study} layers={layers} visibleLayers={visibleLayers} workspace={workspace} manualResult={workspace === "manual" ? manualResult : null} manualVisible={manualVisible} resetKey={mapResetKey} onReset={resetCurrentWorkspace} />
        <AttributeTable layer={attributeLayer} isOpen={attributeLayerId !== null} onClose={() => setAttributeLayerId(null)} />
        <aside className="results">
          <AnalysisPanel workspace={workspace} data={analysis} manualRows={manualTravelRows} manualNotes={manualResult?.notes ?? []} manualResult={manualResult} />
        </aside>
      </section>
    </main>
  );
}




