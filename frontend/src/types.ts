export type Workspace = "context" | "historical" | "ml" | "manual";

export type BasemapMode = "osm" | "3d";

export type Study = { id: string; label: string; map_center: [number, number]; default_zoom: number };

export type LayerDefinition = {

  id: string;

  label: string;

  kind: "fill" | "line" | "circle" | "raster";

  url: string;

  color?: string;

  colorBy?: string;

  colorMap?: Record<string, string>;

  colorRampBy?: string;

  sizeBy?: string;

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

  lineWidth?: number;

  opacity: number;

  featureCount: number;

};

export type GeoJsonFeature = {

  type: "Feature";

  geometry: unknown;

  properties: Record<string, string | number | null>;

};

export type GeoJsonCollection = {

  type: "FeatureCollection";

  features: GeoJsonFeature[];

};

export type TravelTimeRow = {

  scenario: string;

  mvc?: number | null;

  remaining?: number | null;

  overall?: number | null;

};

export type StationAnalysisRow = {

  scenario: string;

  station: string;

  mvcTravel?: number | null;

  remainingTravel?: number | null;

  capacityUsedPercent?: number | null;

  mvcEffectivePaths?: number | null;

};

export type ScenarioSummaryRow = {

  scenario: string;

  medianCapacityUsedPercent?: number | null;

  medianBaselineAllocationPercent?: number | null;

  medianStationWeightedPaths?: number | null;

  averageMvcEffectivePaths?: number | null;

};

export type StationChangeRow = {

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

export type ContextInfoData = {

  manualBaselineTravelTime?: TravelTimeRow;

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

export type TestPerformance = { Dataset: string; Model: string; R2: number; RMSE: number; MAE: number; "Pearson r": number };

export type CoverageRow = { Variant: string; Dataset: string; Model: string; Scenario: string; Coverage: number[] };

export type EntropyRow = { Model: string; Variant: string; Scenario: string; Stations_With_Valid_Entropy: number; Median_Normalized_Shannon_Entropy: number; Mean_Normalized_Shannon_Entropy: number; Minimum_Normalized_Shannon_Entropy: number };

export type AnalysisData = {

  testPerformance?: TestPerformance[];

  coverage?: CoverageRow[];

  entropy?: EntropyRow[];

  context?: ContextInfoData;

  historical: { travelTime: TravelTimeRow[]; stationAnalysis: StationAnalysisRow[]; scenarioSummary: ScenarioSummaryRow[]; stationChange?: StationChangeRow[] };

  ml: { travelTime: TravelTimeRow[]; stationAnalysis: StationAnalysisRow[]; scenarioSummary: ScenarioSummaryRow[]; stationChange?: StationChangeRow[] };

};
