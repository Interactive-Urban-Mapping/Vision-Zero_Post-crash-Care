import GLPK from "glpk.js";

const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;

export type ManualWeights = {
  mvcTime: number;
  mvcPaths: number;
  nonMvcTime: number;
};

export type ManualAllocationFeature = {
  type: "Feature";
  geometry: unknown;
  properties: Record<string, string | number | null>;
};

export type ManualAllocationGeoJSON = {
  type: "FeatureCollection";
  features: ManualAllocationFeature[];
};

export type ManualTravelTimeRow = {
  scenario: string;
  mvc?: number | null;
  remaining?: number | null;
  overall?: number | null;
};

export type ManualAllocationResult = {
  mvcGeojson: ManualAllocationGeoJSON;
  nonMvcGeojson: ManualAllocationGeoJSON;
  travelTime: ManualTravelTimeRow[];
  assignedGrids: number;
  notes: string[];
  diagnostics?: Record<string, unknown>;
};

type DemandType = "MVC" | "Non-MVC" | "Zero-Incident Territory";
type DemandStatTuple = [string, number, number, number];
type CandidateTuple = [string, number];
type CapacityTuple = [string, number];

type ManualInputs = {
  mvcDemandStats?: DemandStatTuple[];
  nonMvcDemandStats?: DemandStatTuple[];
  mvcIncidentCounts?: Array<[string, number]>;
  nonMvcIncidentCounts?: Array<[string, number]>;
  mvcODByGrid: Array<[string, CandidateTuple[]]>;
  nonMvcODByGrid: Array<[string, CandidateTuple[]]>;
  mvcPaths: Array<[string, string, number]>;
  mvcCapacity?: CapacityTuple[];
  nonMvcCapacity?: CapacityTuple[];
  capacityBasis?: string;
};

type DemandStat = {
  gridId: string;
  incidentCount: number;
  workloadSec: number;
  meanServiceTimeSec: number | null;
};

type Decision = DemandStat & {
  variable: string;
  demandKey: string;
  demandType: DemandType;
  stationId: string;
  freeFlowTimeSec: number;
  pathCount: number | null;
  coefficient: number;
};

type AllocationRow = {
  Demand_Type: DemandType;
  Allocation_Basis: string;
  Grid_ID: string;
  Allocated_Station: string;
  Unique_Incidents: number;
  Demand_Equivalent: number;
  Average_Service_Time_sec: number | null;
  Allocated_Service_Workload_sec: number;
  FreeFlow_Time_sec: number;
  Total_FreeFlow_Time_sec: number;
  DemandEquivalent_Total_FreeFlow_Time_sec?: number;
  Effective_Path_Count_Under240: number | null;
  Total_IncidentWeighted_Path_Count: number;
};

type LpModel = {
  decisions: Decision[];
  lp: any;
};

const MIP_GAP = 0.02;
const INPUT_CAPACITY_MULTIPLIER = 1.5;
const ZERO_GRID_SERVICE_TIME_QUANTILE = 0.10;
const ZERO_GRID_DEMAND_EQUIVALENT = 0.10;

function cleanId(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text || ["nan", "none", "null", "<na>"].includes(text.toLowerCase())) return "";
  return text.replace(/^([+-]?\d+)\.0+$/, "$1");
}

function finiteNumber(value: unknown) {
  const numberValue = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(numberValue) ? numberValue : null;
}

function stationCompare(a: string, b: string) {
  const aNum = Number(a);
  const bNum = Number(b);
  if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
  return a.localeCompare(b);
}

function average(values: number[]) {
  const valid = values.filter(Number.isFinite);
  return valid.length
    ? valid.reduce((total, value) => total + value, 0) / valid.length
    : null;
}

function sum(values: number[]) {
  return values
    .filter(Number.isFinite)
    .reduce((total, value) => total + value, 0);
}

function normalizeWeights(weights: ManualWeights) {
  const mvcTravel = Math.max(0, Number(weights.mvcTime) || 0);
  const mvcPath = Math.max(0, Number(weights.mvcPaths) || 0);
  const nonMvcTravel = Math.max(0, Number(weights.nonMvcTime) || 0);
  const total = mvcTravel + mvcPath + nonMvcTravel;

  if (total <= 0) {
    throw new Error("At least one weight must be greater than zero.");
  }

  return {
    mvcTravel: mvcTravel / total,
    mvcPath: mvcPath / total,
    nonMvcTravel: nonMvcTravel / total,
  };
}

function pathKey(station: string, grid: string) {
  return `${station}|${grid}`;
}

function gridIdFromProperties(properties: Record<string, unknown>) {
  return cleanId(
    properties.GRID_ID ??
      properties.Grid_ID ??
      properties.Grid_Label ??
      properties.grid_id,
  );
}

function demandStatsFromCounts(
  counts: Array<[string, number]> | undefined,
): DemandStatTuple[] {
  return (counts ?? []).map(([grid, count]) => [grid, count, count, 1]);
}

function buildDemandStats(
  stats: DemandStatTuple[] | undefined,
  counts: Array<[string, number]> | undefined,
) {
  const result = new Map<string, DemandStat>();

  (stats?.length ? stats : demandStatsFromCounts(counts)).forEach(
    ([rawGridId, rawIncidentCount, rawWorkload, rawMeanService]) => {
      const gridId = cleanId(rawGridId);
      const incidentCount = finiteNumber(rawIncidentCount);
      const workloadSec = finiteNumber(rawWorkload);
      const meanServiceTimeSec = finiteNumber(rawMeanService);

      if (
        !gridId ||
        incidentCount === null ||
        incidentCount < 0 ||
        workloadSec === null ||
        workloadSec < 0
      ) {
        return;
      }

      result.set(gridId, {
        gridId,
        incidentCount,
        workloadSec,
        meanServiceTimeSec,
      });
    },
  );

  return result;
}

function buildCapacityMap(pairs: CapacityTuple[] | undefined) {
  const capacity = new Map<string, number>();

  (pairs ?? []).forEach(([rawStation, rawValue]) => {
    const station = cleanId(rawStation);
    const value = finiteNumber(rawValue);

    if (!station || station === "0" || value === null || value <= 0) {
      return;
    }

    capacity.set(station, (capacity.get(station) ?? 0) + value);
  });

  return capacity;
}

function scaleCapacityMap(capacity: Map<string, number>, factor: number) {
  return new Map(
    [...capacity.entries()].map(([station, value]) => [station, value * factor]),
  );
}

function buildODByGrid(
  pairs: Array<[string, CandidateTuple[]]> | undefined,
) {
  const shortest = new Map<string, { station: string; grid: string; travel: number }>();

  (pairs ?? []).forEach(([rawGrid, rawCandidates]) => {
    const grid = cleanId(rawGrid);

    if (!grid) {
      return;
    }

    (rawCandidates ?? []).forEach(([rawStation, rawTravel]) => {
      const station = cleanId(rawStation);
      const travel = finiteNumber(rawTravel);

      if (!station || station === "0" || travel === null || travel < 0) {
        return;
      }

      const key = pathKey(station, grid);
      const old = shortest.get(key);

      if (!old || travel < old.travel) {
        shortest.set(key, { station, grid, travel });
      }
    });
  });

  const result = new Map<string, CandidateTuple[]>();

  shortest.forEach(({ station, grid, travel }) => {
    result.set(grid, [...(result.get(grid) ?? []), [station, travel]]);
  });

  result.forEach((candidates) => {
    candidates.sort(
      (a, b) => a[1] - b[1] || stationCompare(a[0], b[0]),
    );
  });

  return result;
}

function buildPathLookup(rows: Array<[string, string, number]>) {
  const lookup = new Map<string, number>();

  (rows ?? []).forEach(([rawStation, rawGrid, rawPaths]) => {
    const station = cleanId(rawStation);
    const grid = cleanId(rawGrid);
    const paths = finiteNumber(rawPaths);

    if (!station || station === "0" || !grid || paths === null) {
      return;
    }

    const key = pathKey(station, grid);
    lookup.set(key, Math.max(paths, lookup.get(key) ?? 0));
  });

  return lookup;
}

function capacityFromDemand(
  stats: Map<string, DemandStat>,
  odByGrid: Map<string, CandidateTuple[]>,
  multiplier = 1.5,
) {
  const workloadByStation = new Map<string, number>();

  stats.forEach((row, grid) => {
    const closest = (odByGrid.get(grid) ?? [])[0];

    if (!closest) {
      return;
    }

    workloadByStation.set(
      closest[0],
      (workloadByStation.get(closest[0]) ?? 0) + row.workloadSec,
    );
  });

  return new Map(
    [...workloadByStation.entries()].map(([station, workload]) => [
      station,
      workload * multiplier,
    ]),
  );
}

function quantile(values: number[], quantileValue: number) {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  if (!sorted.length) {
    throw new Error("Cannot calculate a zero-grid service-time quantile.");
  }

  const position = (sorted.length - 1) * quantileValue;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) {
    return sorted[lower];
  }

  return (
    sorted[lower] +
    (sorted[upper] - sorted[lower]) * (position - lower)
  );
}

class ManualAllocator {
  private readonly mvcStats: Map<string, DemandStat>;
  private readonly nonMvcStats: Map<string, DemandStat>;
  private readonly mvcODByGrid: Map<string, CandidateTuple[]>;
  private readonly nonMvcODByGrid: Map<string, CandidateTuple[]>;
  private readonly zeroODByGrid: Map<string, CandidateTuple[]>;
  private readonly mvcCapacity: Map<string, number>;
  private readonly nonMvcCapacity: Map<string, number>;
  private readonly pathLookup: Map<string, number>;
  private readonly baselineGeoJSON: ManualAllocationGeoJSON;
  private readonly zeroStats: Map<string, DemandStat>;
  private readonly zeroGridsWithoutOD: string[];
  private readonly notes: string[];
  private readonly capacityLeeway: number;

  constructor(
    inputs: ManualInputs,
    baselineGeoJSON: ManualAllocationGeoJSON,
    capacityLeeway: number,
  ) {
    if (capacityLeeway < 1.4 || capacityLeeway > 2.0) {
      throw new Error("Capacity leeway must be between 1.4 and 2.0.");
    }
    this.capacityLeeway = capacityLeeway;
    this.mvcStats = buildDemandStats(
      inputs.mvcDemandStats,
      inputs.mvcIncidentCounts,
    );
    this.nonMvcStats = buildDemandStats(
      inputs.nonMvcDemandStats,
      inputs.nonMvcIncidentCounts,
    );

    this.mvcODByGrid = buildODByGrid(inputs.mvcODByGrid);
    this.nonMvcODByGrid = buildODByGrid(inputs.nonMvcODByGrid);

    this.mvcCapacity = inputs.mvcCapacity?.length
      ? scaleCapacityMap(
          buildCapacityMap(inputs.mvcCapacity),
          capacityLeeway / INPUT_CAPACITY_MULTIPLIER,
        )
      : capacityFromDemand(this.mvcStats, this.mvcODByGrid, capacityLeeway);

    this.nonMvcCapacity = inputs.nonMvcCapacity?.length
      ? scaleCapacityMap(
          buildCapacityMap(inputs.nonMvcCapacity),
          capacityLeeway / INPUT_CAPACITY_MULTIPLIER,
        )
      : capacityFromDemand(this.nonMvcStats, this.nonMvcODByGrid, capacityLeeway);

    this.pathLookup = buildPathLookup(inputs.mvcPaths);
    this.baselineGeoJSON = baselineGeoJSON;

    this.assertDemandCoverage(
      this.mvcStats,
      this.mvcODByGrid,
      this.mvcCapacity,
      "MVC",
    );

    this.assertDemandCoverage(
      this.nonMvcStats,
      this.nonMvcODByGrid,
      this.nonMvcCapacity,
      "Non-MVC",
    );

    const zeroInfo = this.buildZeroStatsAndCandidates();
    this.zeroStats = zeroInfo.stats;
    this.zeroODByGrid = zeroInfo.candidates;
    this.zeroGridsWithoutOD = zeroInfo.withoutCandidates;

    this.notes = [
      `Historical MVC and non_MVC allocations are solved as binary GLPK models in the browser with ${capacityLeeway.toFixed(1)} capacity leeway and a 500-path limit.`,
    ];
  }

  async solve(rawWeights: ManualWeights): Promise<ManualAllocationResult> {
    const glpk = await GLPK();
    const weights = normalizeWeights(rawWeights);
    const denominators = this.denominators();

    if (this.zeroGridsWithoutOD.length) {
      throw new Error(
        `${this.zeroGridsWithoutOD.length} zero-incident baseline grids have no eligible OD candidate. Examples: ${this.zeroGridsWithoutOD
          .slice(0, 10)
          .join(", ")}`,
      );
    }

    // No tmlim is passed. The prior hard tmlim: 30 stopped large
    // non-MVC searches before GLPK produced a feasible incumbent.
    const options = {
      msglev: glpk.GLP_MSG_OFF,
      presol: true,
      mipgap: MIP_GAP,
    };

    const solverDiagnostics: Record<string, any> = {
      name: "glpk.js",
      mipGap: MIP_GAP,
      timeLimitSeconds: null,
      mvc: {
        status: "not_run",
        objective: null,
        usedFallback: false,
        message: "",
      },
      nonMvc: {
        status: "not_run",
        objective: null,
        usedFallback: false,
        message: "",
      },
      zeroGridMethod: "closest-station post-processing; reporting only",
    };

    const mvcModel = this.buildMvcModel(glpk, weights, denominators);
    const mvcResult = await glpk.solve(mvcModel.lp, options);
    this.assertFeasible(glpk, mvcResult, "MVC model");

    solverDiagnostics.mvc.status = mvcResult.result.status;
    solverDiagnostics.mvc.objective = mvcResult.result.z;

    const nonMvcModel = this.buildNonMvcModel(
      glpk,
      weights,
      denominators,
    );
    const nonMvcResult = await glpk.solve(nonMvcModel.lp, options);
    this.assertFeasible(glpk, nonMvcResult, "Non-MVC model");

    solverDiagnostics.nonMvc.status = nonMvcResult.result.status;
    solverDiagnostics.nonMvc.objective = nonMvcResult.result.z;

    const mvcSelected = this.selectedRows(
      mvcModel.decisions,
      mvcResult,
      "MVC",
    );

    const nonMvcSelected = this.selectedRows(
      nonMvcModel.decisions,
      nonMvcResult,
      "Non-MVC",
    );

    const zeroSelected = this.closestZeroRows();

    const mvcRows = mvcSelected.map((entry) =>
      this.toAllocationRow(
        entry,
        "Historical_TriObjective_MVC_Travel_and_Path_With_ServiceCapacity",
      ),
    );

    const nonMvcHistoricalRows = nonMvcSelected.map((entry) =>
      this.toAllocationRow(
        entry,
        "Historical_TriObjective_NonMVC_Travel_With_ServiceCapacity",
      ),
    );

    const zeroRows = zeroSelected.map((entry) =>
      this.toAllocationRow(
        entry,
        "PostOptimization_Closest_Station_ReportingOnly",
      ),
    );

    const nonMvcRows = [...nonMvcHistoricalRows, ...zeroRows];
    const allRows = [...mvcRows, ...nonMvcRows];

    const detailedTravelSummary = {
      MVC: this.travelMetrics(mvcRows),
      NonMVC_Historical: this.travelMetrics(nonMvcHistoricalRows),
      NonMVC_ZeroTerritory: this.travelMetrics(zeroRows),
      Combined_Historical: this.travelMetrics([
        ...mvcRows,
        ...nonMvcHistoricalRows,
      ]),
    };

    const travelSummary = {
      mvc: detailedTravelSummary.MVC.incidentWeightedMean,
      remaining:
        detailedTravelSummary.NonMVC_Historical.incidentWeightedMean,
      overall:
        detailedTravelSummary.Combined_Historical.incidentWeightedMean,
    };

    const objectiveComponents = this.objectiveComponents(
      mvcRows,
      nonMvcHistoricalRows,
      zeroRows,
      weights,
      denominators,
    );

    return {
      mvcGeojson: this.attachRows(mvcRows),
      nonMvcGeojson: this.attachRows(nonMvcRows),
      travelTime: [
        {
          scenario: `Manual allocation (capacity leeway ${this.capacityLeeway.toFixed(1)})`,
          ...travelSummary,
        },
      ],
      assignedGrids: allRows.length,
      notes: this.notes,
      diagnostics: {
        weights,
        solver: solverDiagnostics,
        normalizationDenominators: denominators,
        capacityScenario: {
          capacityLeeway: this.capacityLeeway,
          mvcCapacityStations: this.mvcCapacity.size,
          nonMvcCapacityStations: this.nonMvcCapacity.size,
          zeroGridServiceTimeQuantile: ZERO_GRID_SERVICE_TIME_QUANTILE,
          zeroGridDemandEquivalent: ZERO_GRID_DEMAND_EQUIVALENT,
          zeroGridCount: this.zeroStats.size,
        },
        allocationCounts: {
          mvc: mvcRows.length,
          nonMvcHistorical: nonMvcHistoricalRows.length,
          zeroTerritory: zeroRows.length,
          totalMapped: allRows.length,
        },
        travelSummary,
        detailedTravelSummary,
        objectiveComponents,
        capacitySummary: this.capacitySummary(
          mvcRows,
          nonMvcHistoricalRows,
          zeroRows,
        ),
        zeroGridDiagnostics: {
          candidatesBuilt: this.zeroODByGrid.size,
          allocated: zeroRows.length,
          unallocated: this.zeroStats.size - zeroRows.length,
        },
      },
    };
  }

  private filteredCandidates(
    odByGrid: Map<string, CandidateTuple[]>,
    gridId: string,
    capacity: Map<string, number>,
  ) {
    return (odByGrid.get(gridId) ?? []).filter(
      ([station]) => (capacity.get(station) ?? 0) > 0,
    );
  }

  private assertDemandCoverage(
    stats: Map<string, DemandStat>,
    odByGrid: Map<string, CandidateTuple[]>,
    capacity: Map<string, number>,
    label: string,
  ) {
    const missing = [...stats.keys()].filter(
      (gridId) =>
        !this.filteredCandidates(odByGrid, gridId, capacity).length,
    );

    if (missing.length) {
      throw new Error(
        `${label}: ${missing.length} demand grids have no eligible station. Examples: ${missing
          .slice(0, 10)
          .join(", ")}`,
      );
    }
  }

  private buildZeroStatsAndCandidates() {
    const historicalGridIds = new Set([
      ...this.mvcStats.keys(),
      ...this.nonMvcStats.keys(),
    ]);

    const zeroServiceTime = quantile(
      [...this.nonMvcStats.values()].map(
        (row) => row.meanServiceTimeSec ?? Number.NaN,
      ),
      ZERO_GRID_SERVICE_TIME_QUANTILE,
    );

    const zeroWorkload =
      ZERO_GRID_DEMAND_EQUIVALENT * zeroServiceTime;

    const mergedShortest = new Map<
      string,
      { station: string; grid: string; travel: number }
    >();

    const mergeOD = (odByGrid: Map<string, CandidateTuple[]>) => {
      odByGrid.forEach((candidates, grid) => {
        candidates.forEach(([station, travel]) => {
          if ((this.nonMvcCapacity.get(station) ?? 0) <= 0) {
            return;
          }

          const key = pathKey(station, grid);
          const old = mergedShortest.get(key);

          if (!old || travel < old.travel) {
            mergedShortest.set(key, {
              station,
              grid,
              travel,
            });
          }
        });
      });
    };

    mergeOD(this.mvcODByGrid);
    mergeOD(this.nonMvcODByGrid);

    const candidates = new Map<string, CandidateTuple[]>();

    mergedShortest.forEach(({ station, grid, travel }) => {
      candidates.set(grid, [
        ...(candidates.get(grid) ?? []),
        [station, travel],
      ]);
    });

    candidates.forEach((rows) => {
      rows.sort(
        (a, b) => a[1] - b[1] || stationCompare(a[0], b[0]),
      );
    });

    const stats = new Map<string, DemandStat>();
    const zeroCandidates = new Map<string, CandidateTuple[]>();
    const withoutCandidates: string[] = [];

    this.baselineGeoJSON.features.forEach((feature) => {
      const gridId = gridIdFromProperties(feature.properties ?? {});

      if (!gridId || historicalGridIds.has(gridId)) {
        return;
      }

      stats.set(gridId, {
        gridId,
        incidentCount: 0,
        workloadSec: zeroWorkload,
        meanServiceTimeSec: zeroServiceTime,
      });

      const gridCandidates = candidates.get(gridId) ?? [];

      if (gridCandidates.length) {
        zeroCandidates.set(gridId, gridCandidates);
      } else {
        withoutCandidates.push(gridId);
      }
    });

    return {
      stats,
      candidates: zeroCandidates,
      withoutCandidates,
    };
  }

  private denominators() {
    let mvcTravel = 0;
    let mvcPaths = 0;
    let nonMvcTravel = 0;

    this.mvcStats.forEach((stats, gridId) => {
      const candidates = this.filteredCandidates(
        this.mvcODByGrid,
        gridId,
        this.mvcCapacity,
      );

      mvcTravel +=
        stats.incidentCount *
        Math.min(...candidates.map(([, travel]) => travel));

      mvcPaths +=
        stats.incidentCount *
        Math.max(
          ...candidates.map(
            ([station]) =>
              this.pathLookup.get(pathKey(station, gridId)) ?? 0,
          ),
        );
    });

    this.nonMvcStats.forEach((stats, gridId) => {
      const candidates = this.filteredCandidates(
        this.nonMvcODByGrid,
        gridId,
        this.nonMvcCapacity,
      );

      nonMvcTravel +=
        stats.incidentCount *
        Math.min(...candidates.map(([, travel]) => travel));
    });

    if (
      mvcTravel <= 0 ||
      mvcPaths <= 0 ||
      nonMvcTravel <= 0
    ) {
      throw new Error(
        "One or more historical normalization denominators are zero.",
      );
    }

    return {
      mvcTravel,
      mvcPaths,
      nonMvcTravel,
    };
  }

  private buildMvcModel(
    glpk: any,
    weights: ReturnType<typeof normalizeWeights>,
    denominators: ReturnType<ManualAllocator["denominators"]>,
  ): LpModel {
    const decisions: Decision[] = [];
    const subjectTo: any[] = [];
    const stationDecisionMap = new Map<string, Decision[]>();
    let index = 0;

    this.mvcStats.forEach((stats, gridId) => {
      const assignmentVars: Array<{ name: string; coef: number }> = [];

      this.filteredCandidates(
        this.mvcODByGrid,
        gridId,
        this.mvcCapacity,
      ).forEach(([stationId, freeFlowTimeSec]) => {
        const variable = `mvc_x_${index++}`;
        const pathCount =
          this.pathLookup.get(pathKey(stationId, gridId)) ?? 0;

        const coefficient =
          (weights.mvcTravel *
            stats.incidentCount *
            freeFlowTimeSec) /
            denominators.mvcTravel -
          (weights.mvcPath *
            stats.incidentCount *
            pathCount) /
            denominators.mvcPaths;

        const decision: Decision = {
          ...stats,
          variable,
          demandKey: gridId,
          demandType: "MVC",
          stationId,
          freeFlowTimeSec,
          pathCount,
          coefficient,
        };

        decisions.push(decision);
        assignmentVars.push({ name: variable, coef: 1 });

        stationDecisionMap.set(stationId, [
          ...(stationDecisionMap.get(stationId) ?? []),
          decision,
        ]);
      });

      subjectTo.push({
        name: `mvc_assign_${gridId}`,
        vars: assignmentVars,
        bnds: {
          type: glpk.GLP_FX,
          lb: 1,
          ub: 1,
        },
      });
    });

    stationDecisionMap.forEach((entries, stationId) => {
      subjectTo.push({
        name: `mvc_capacity_${stationId}`,
        vars: entries.map((entry) => ({
          name: entry.variable,
          coef: entry.workloadSec,
        })),
        bnds: {
          type: glpk.GLP_UP,
          lb: 0,
          ub: this.mvcCapacity.get(stationId),
        },
      });
    });

    return {
      decisions,
      lp: {
        name: "Historical_MVC_Travel_and_Path_Model",
        objective: {
          direction: glpk.GLP_MIN,
          name: "MVC_weighted_objective",
          vars: decisions.map((entry) => ({
            name: entry.variable,
            coef: entry.coefficient,
          })),
        },
        subjectTo,
        binaries: decisions.map((entry) => entry.variable),
      },
    };
  }

  private buildNonMvcModel(
    glpk: any,
    weights: ReturnType<typeof normalizeWeights>,
    denominators: ReturnType<ManualAllocator["denominators"]>,
  ): LpModel {
    const decisions: Decision[] = [];
    const subjectTo: any[] = [];
    const stationDecisionMap = new Map<string, Decision[]>();
    let index = 0;

    this.nonMvcStats.forEach((stats, gridId) => {
      const assignmentVars: Array<{ name: string; coef: number }> = [];

      this.filteredCandidates(
        this.nonMvcODByGrid,
        gridId,
        this.nonMvcCapacity,
      ).forEach(([stationId, freeFlowTimeSec]) => {
        const variable = `nonmvc_x_${index++}`;

        const coefficient =
          (weights.nonMvcTravel *
            stats.incidentCount *
            freeFlowTimeSec) /
          denominators.nonMvcTravel;

        const decision: Decision = {
          ...stats,
          variable,
          demandKey: gridId,
          demandType: "Non-MVC",
          stationId,
          freeFlowTimeSec,
          pathCount: null,
          coefficient,
        };

        decisions.push(decision);
        assignmentVars.push({ name: variable, coef: 1 });

        stationDecisionMap.set(stationId, [
          ...(stationDecisionMap.get(stationId) ?? []),
          decision,
        ]);
      });

      subjectTo.push({
        name: `nonmvc_assign_${gridId}`,
        vars: assignmentVars,
        bnds: {
          type: glpk.GLP_FX,
          lb: 1,
          ub: 1,
        },
      });
    });

    stationDecisionMap.forEach((entries, stationId) => {
      subjectTo.push({
        name: `nonmvc_capacity_${stationId}`,
        vars: entries.map((entry) => ({
          name: entry.variable,
          coef: entry.workloadSec,
        })),
        bnds: {
          type: glpk.GLP_UP,
          lb: 0,
          ub: this.nonMvcCapacity.get(stationId),
        },
      });
    });

    return {
      decisions,
      lp: {
        name: "Historical_NonMVC_Travel_Model",
        objective: {
          direction: glpk.GLP_MIN,
          name: "NonMVC_weighted_objective",
          vars: decisions.map((entry) => ({
            name: entry.variable,
            coef: entry.coefficient,
          })),
        },
        subjectTo,
        binaries: decisions.map((entry) => entry.variable),
      },
    };
  }

  private assertFeasible(glpk: any, result: any, label: string) {
    const status = result?.result?.status;

    if (
      status !== glpk.GLP_OPT &&
      status !== glpk.GLP_FEAS
    ) {
      throw new Error(
        `${label} did not produce a feasible solution. GLPK status: ${status}`,
      );
    }
  }

  private selectedRows(
    decisions: Decision[],
    solverResult: any,
    label: string,
  ) {
    const selected = new Map<string, Decision>();

    decisions.forEach((decision) => {
      const value =
        solverResult.result.vars[decision.variable] ?? 0;

      if (value > 0.5) {
        if (selected.has(decision.demandKey)) {
          throw new Error(
            `${label}: more than one station selected for ${decision.demandKey}.`,
          );
        }

        selected.set(decision.demandKey, decision);
      }
    });

    const allDemandKeys = new Set(
      decisions.map((decision) => decision.demandKey),
    );

    const missing = [...allDemandKeys].filter(
      (demandKey) => !selected.has(demandKey),
    );

    if (missing.length) {
      throw new Error(
        `${label}: no station selected for ${missing
          .slice(0, 10)
          .join(", ")}.`,
      );
    }

    return [...selected.values()];
  }

  private closestZeroRows() {
    const rows: Decision[] = [];
    let index = 0;

    this.zeroStats.forEach((stats, gridId) => {
      const closest = this.zeroODByGrid.get(gridId)?.[0];

      if (!closest) {
        return;
      }

      rows.push({
        ...stats,
        variable: `zero_x_${index++}`,
        demandKey: gridId,
        demandType: "Zero-Incident Territory",
        stationId: closest[0],
        freeFlowTimeSec: closest[1],
        pathCount: null,
        coefficient:
          ZERO_GRID_DEMAND_EQUIVALENT * closest[1],
      });
    });

    return rows;
  }

  private toAllocationRow(
    entry: Decision,
    allocationBasis: string,
  ): AllocationRow {
    const isZero =
      entry.demandType === "Zero-Incident Territory";

    return {
      Demand_Type: entry.demandType,
      Allocation_Basis: allocationBasis,
      Grid_ID: entry.gridId,
      Allocated_Station: entry.stationId,
      Unique_Incidents: entry.incidentCount,
      Demand_Equivalent: isZero
        ? ZERO_GRID_DEMAND_EQUIVALENT
        : entry.incidentCount,
      Average_Service_Time_sec:
        entry.meanServiceTimeSec,
      Allocated_Service_Workload_sec:
        entry.workloadSec,
      FreeFlow_Time_sec: entry.freeFlowTimeSec,
      Total_FreeFlow_Time_sec: isZero
        ? 0
        : entry.incidentCount * entry.freeFlowTimeSec,
      DemandEquivalent_Total_FreeFlow_Time_sec: isZero
        ? ZERO_GRID_DEMAND_EQUIVALENT *
          entry.freeFlowTimeSec
        : undefined,
      Effective_Path_Count_Under240: entry.pathCount,
      Total_IncidentWeighted_Path_Count:
        entry.incidentCount * (entry.pathCount ?? 0),
    };
  }

  private travelMetrics(rows: AllocationRow[]) {
    const incidentCount = sum(
      rows.map((row) => row.Unique_Incidents),
    );

    const incidentWeightedTravel = sum(
      rows.map((row) => row.Total_FreeFlow_Time_sec),
    );

    return {
      gridCount: rows.length,
      incidentCount,
      gridUnweightedMean: average(
        rows.map((row) => row.FreeFlow_Time_sec),
      ),
      incidentWeightedMean:
        incidentCount > 0
          ? incidentWeightedTravel / incidentCount
          : null,
    };
  }

  private objectiveComponents(
    mvcRows: AllocationRow[],
    nonMvcHistoricalRows: AllocationRow[],
    zeroRows: AllocationRow[],
    weights: ReturnType<typeof normalizeWeights>,
    denominators: ReturnType<ManualAllocator["denominators"]>,
  ) {
    const mvcTravelRaw = sum(
      mvcRows.map((row) => row.Total_FreeFlow_Time_sec),
    );

    const mvcPathRaw = sum(
      mvcRows.map(
        (row) => row.Total_IncidentWeighted_Path_Count,
      ),
    );

    const nonMvcTravelRaw = sum(
      nonMvcHistoricalRows.map(
        (row) => row.Total_FreeFlow_Time_sec,
      ),
    );

    const zeroTravelRaw = sum(
      zeroRows.map(
        (row) =>
          row.DemandEquivalent_Total_FreeFlow_Time_sec ?? 0,
      ),
    );

    return [
      {
        component:
          "MVC incident-weighted travel minimization",
        rawValue: mvcTravelRaw,
        denominator: denominators.mvcTravel,
        normalizedValue: mvcTravelRaw / denominators.mvcTravel,
        weight: weights.mvcTravel,
        weightedContribution:
          (weights.mvcTravel * mvcTravelRaw) /
          denominators.mvcTravel,
      },
      {
        component:
          "MVC incident-weighted path maximization under 240",
        rawValue: mvcPathRaw,
        denominator: denominators.mvcPaths,
        normalizedValue: mvcPathRaw / denominators.mvcPaths,
        weight: weights.mvcPath,
        weightedContribution:
          (-weights.mvcPath * mvcPathRaw) /
          denominators.mvcPaths,
      },
      {
        component:
          "non_MVC incident-weighted travel minimization",
        rawValue: nonMvcTravelRaw,
        denominator: denominators.nonMvcTravel,
        normalizedValue:
          nonMvcTravelRaw / denominators.nonMvcTravel,
        weight: weights.nonMvcTravel,
        weightedContribution:
          (weights.nonMvcTravel * nonMvcTravelRaw) /
          denominators.nonMvcTravel,
      },
      {
        component:
          "Zero territory demand-equivalent travel (reporting only)",
        rawValue: zeroTravelRaw,
        denominator: 1,
        normalizedValue: zeroTravelRaw,
        weight: null,
        weightedContribution: null,
      },
    ];
  }

  private capacitySummary(
    mvcRows: AllocationRow[],
    nonMvcHistoricalRows: AllocationRow[],
    zeroRows: AllocationRow[],
  ) {
    const stationIds = new Set([
      ...this.mvcCapacity.keys(),
      ...this.nonMvcCapacity.keys(),
    ]);

    return [...stationIds]
      .sort(stationCompare)
      .map((stationId) => {
        const mvcWorkload = sum(
          mvcRows
            .filter(
              (row) => row.Allocated_Station === stationId,
            )
            .map((row) => row.Allocated_Service_Workload_sec),
        );

        const nonMvcHistoricalWorkload = sum(
          nonMvcHistoricalRows
            .filter(
              (row) => row.Allocated_Station === stationId,
            )
            .map((row) => row.Allocated_Service_Workload_sec),
        );

        const zeroReportingWorkload = sum(
          zeroRows
            .filter(
              (row) => row.Allocated_Station === stationId,
            )
            .map((row) => row.Allocated_Service_Workload_sec),
        );

        const mvcCapacity =
          this.mvcCapacity.get(stationId) ?? null;

        const nonMvcCapacity =
          this.nonMvcCapacity.get(stationId) ?? null;

        return {
          station: stationId,
          mvcWorkload,
          mvcCapacity,
          mvcCapacityUsedPercent:
            mvcCapacity && mvcCapacity > 0
              ? (mvcWorkload / mvcCapacity) * 100
              : null,
          nonMvcHistoricalWorkload,
          nonMvcCapacity,
          nonMvcHistoricalCapacityUsedPercent:
            nonMvcCapacity && nonMvcCapacity > 0
              ? (nonMvcHistoricalWorkload / nonMvcCapacity) *
                100
              : null,
          zeroReportingOnlyWorkload:
            zeroReportingWorkload,
          nonMvcIncludingZeroReportingOnlyWorkload:
            nonMvcHistoricalWorkload +
            zeroReportingWorkload,
        };
      });
  }

  private attachRows(rows: AllocationRow[]): ManualAllocationGeoJSON {
    const byGrid = new Map(
      rows.map((row) => [row.Grid_ID, row]),
    );

    return {
      type: "FeatureCollection",
      features: this.baselineGeoJSON.features.flatMap(
        (feature) => {
          const gridId = gridIdFromProperties(
            feature.properties ?? {},
          );
          const row = byGrid.get(gridId);

          if (!row) {
            return [];
          }

          return {
            ...feature,
            properties: {
              ...(feature.properties ?? {}),
              ...row,
            },
          };
        },
      ),
    };
  }
}

export async function runManualAllocation(
  weights: ManualWeights,
  capacityLeeway: number,
): Promise<ManualAllocationResult> {
  const [inputs, baselineGeoJSON] = await Promise.all([
    fetch(assetUrl("layers/manual/manual_inputs.json")).then(
      (response) => {
        if (!response.ok) {
          throw new Error(
            "Run tools/export_manual_optimization.py to create manual optimization inputs.",
          );
        }

        return response.json() as Promise<ManualInputs>;
      },
    ),

    fetch(assetUrl("layers/baseline_grids.geojson")).then(
      (response) => {
        if (!response.ok) {
          throw new Error(
            "Missing baseline grid GeoJSON. Run the map layer export first.",
          );
        }

        return response.json() as Promise<ManualAllocationGeoJSON>;
      },
    ),
  ]);

  return new ManualAllocator(inputs, baselineGeoJSON, capacityLeeway).solve(
    weights,
  );
}
