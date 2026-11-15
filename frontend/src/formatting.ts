import type { ManualAllocationGeoJSON } from "./manualOptimizer";
export function isStationZeroLabel(value: string) {

  const normalized = value.trim().toLowerCase();

  return normalized === "0" || normalized === "0.0" || normalized === "station 0";

}

export function isFireStationZero(properties: Record<string, unknown>) {

  return isStationZeroLabel(String(properties.STATION10 ?? ""));

}

export function stationSortValue(value: string) {

  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : value;

}

export function averageNumbers(values: number[]) {

  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;

}

export function numericValue(value: unknown) {

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : null;

}

export function attributeLabel(key: string) {

  const labels: Record<string,string> = {

    WARD_NA13: "Ward", TYPE_DE14: "Facility type", LINEAR_30: "Street name", FEATURE36: "Street feature", OBJECTID_1: "Record ID",
    Predicted_Demand_Weight_SUM: "Predicted demand weight", Effective_Path_Count_Under240_Max250: "MVC paths within 240 sec (250 candidates)", Effective_Path_Count_Under240_Max500: "MVC paths within 240 sec (500 candidates)",
    GRID_ID: "Grid ID", Grid_ID: "Grid ID", OBJECTID: "Record ID", FID: "Feature ID",

    Station_ID: "Station ID", STATION10: "Station ID", ADDRESS5: "Address", YEAR_BU11: "Year built", RUN_AREA: "Service area ID",

    INCIDENT_N: "Incident ID", Final_Inci: "Incident type", Incident_S: "Station area", Incident_W: "Ward",

    Response_T: "Response time (sec)", Service_Ti: "Service time (sec)",

    Allocated_Station: "Allocated station", Unique_Incidents: "Incident count", Grid_Total_Incidents: "Incident count",

    Allocated_Demand: "Allocated demand", Density_Basis: "Demand basis", Demand_Type: "Demand type",

    FreeFlow_Time_sec: "Free-flow travel time (sec)", Average_FreeFlow_Time_sec: "Average free-flow travel time (sec)",

    Baseline_FreeFlow_Time_sec: "Baseline travel time (sec)", FreeFlow_Change_sec: "Travel-time change (sec)",

    Average_Response_Time_sec_GridBased: "Average response time (sec)", Median_Response_Time_sec_GridBased: "Median response time (sec)",

    Allocated_Service_Workload_sec: "Allocated service workload (sec)", Average_Service_Time_sec: "Average service time (sec)",

    Effective_Path_Count_Under240: "MVC paths within 240 sec", Average_Effective_Path_Count_Under240: "Weighted average MVC paths",

    Average_Paths_Weighting: "Path weighting", Baseline_MVC_Avg_sec: "Baseline MVC travel time (sec)", Scenario_MVC_Avg_sec: "Scenario MVC travel time (sec)",

    Improvement_sec: "Improvement (sec)", Improvement_pct: "Improvement (%)", Abs_Change: "Absolute change (sec)",

    Shape_Area: "Area (m²)", Shape_Length: "Boundary length (m)", Grid_Area_m2: "Grid area (m²)", SUM: "Total predicted demand",

  };

  if (labels[key]) return labels[key];

  const acronyms: Record<string,string> = {mvc:"MVC",nonmvc:"Non-MVC",rf:"RF",xgb:"XGB",id:"ID",od:"OD",rts:"response time"};

  const words=key.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/_/g," ").trim().split(/\s+/);

  return words.map((word,index)=>acronyms[word.toLowerCase()] ?? (word.toLowerCase()==="sec" ? "(sec)" : word.toLowerCase()==="pct" ? "(%)" : word.toLowerCase()==="m2" ? "(m²)" : index===0 ? word.charAt(0).toUpperCase()+word.slice(1).toLowerCase() : word.toLowerCase())).join(" ");

}

export function displayAttribute(value: unknown) {

  if (typeof value === "number" && Number.isFinite(value)) return Number.isInteger(value) ? String(value) : value.toFixed(2);

  if (typeof value === "string" && /^-?\d+\.\d+$/.test(value)) return Number(value).toFixed(2);

  return displayLabel(String(value ?? ""));

}

export function displayLabel(value: string) {
  return value.replace(/non[_-]mvc/gi, "Non-MVC");
}

export function manualWeightedAverage(

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
