import { useState } from "react";
import type { ManualAllocationResult } from "../manualOptimizer";
import type { TravelTimeRow, StationAnalysisRow, ScenarioSummaryRow, CoverageRow } from "../types";
import { manualWeightedAverage, numericValue, averageNumbers, isStationZeroLabel, stationSortValue } from "../formatting";

function shortScenarioName(value: string) {

  return value.replace("Scenario ", "S").replace("Allocation_under_", "");

}

export function valueLabel(value?: number | null) {

  return value == null ? "—" : value.toFixed(2);

}

function percentChangeLabel(baseline?: number | null, value?: number | null) {

  if (!baseline || value == null) return "";

  const change = ((baseline - value) / baseline) * 100;

  const direction = change >= 0 ? "improvement" : "worse";

  return `${Math.abs(change).toFixed(2)}% ${direction} (${value.toFixed(2)} sec)`;

}

function travelLegendLabel(row: TravelTimeRow) {

  return `MVC ${valueLabel(row.mvc)} | Non-MVC ${valueLabel(row.remaining)} | Overall ${valueLabel(row.overall)} sec`;

}

export function CoverageLineChart({ rows, title }: { rows: CoverageRow[]; title: string }) {
  const [highlight,setHighlight]=useState<string|null>(null);
  const thresholds=[120,180,240,300,360];
  const styles=[{color:"#64748b",dash:"7 4"},{color:"#356fc3",dash:""},{color:"#8b5cbd",dash:"3 3"},{color:"#078895",dash:""},{color:"#c77727",dash:"9 3 2 3"}];
  const x=(index:number)=>40+index*65;
  const y=(coverage:number)=>186-coverage*156;
  return <div className="diagnostic-scenario-group coverage-line-group">
    <h4>{title}</h4>
    <svg className="coverage-line-chart" viewBox="0 0 320 235" role="img" aria-label={`${title}: weighted travel-time coverage by threshold`}>
      <text x="40" y="14" className="coverage-axis-title">Coverage (%)</text>
      {[0,25,50,75,100].map(t=><g key={t}><line x1="40" x2="300" y1={y(t/100)} y2={y(t/100)} className="coverage-grid"/><text x="32" y={y(t/100)+3} textAnchor="end" className="coverage-tick">{t}</text></g>)}
      {thresholds.map((t,index)=><text key={t} x={x(index)} y="204" textAnchor="middle" className="coverage-tick">{t}</text>)}
      <text x="170" y="225" textAnchor="middle" className="coverage-axis-title">Travel-time threshold (sec)</text>
      {rows.map((row,index)=>{
        const style=styles[index%styles.length];
        return <g key={row.Scenario} opacity={highlight && highlight!==row.Scenario?.toString() ? .14 : 1}>
          <polyline points={row.Coverage.map((v,i)=>`${x(i)},${y(v)}`).join(" ")} fill="none" stroke={style.color} strokeWidth={highlight===row.Scenario?3:2} strokeDasharray={style.dash} strokeLinejoin="round" strokeLinecap="round"/>
          {row.Coverage.map((value,i)=><circle key={i} data-coverage={value} data-threshold={thresholds[i]} tabIndex={0} aria-label={`${row.Scenario}, within ${thresholds[i]} seconds: ${(value*100).toFixed(2)}% coverage`} cx={x(i)} cy={y(value)} r={highlight===row.Scenario?4:2.7} fill="#fff" stroke={style.color} strokeWidth="1.5"><title>{row.Scenario}: ≤{thresholds[i]} sec — {(value*100).toFixed(2)}%</title></circle>)}
        </g>;
      })}
    </svg>
    <div className="coverage-line-legend" role="group" aria-label={`${title} scenario highlighting`}>
      {rows.map((row,index)=><button key={row.Scenario} type="button" aria-pressed={highlight===row.Scenario} onClick={()=>setHighlight(highlight===row.Scenario?null:row.Scenario)}><svg width="22" height="10" aria-hidden="true"><line x1="1" x2="21" y1="5" y2="5" stroke={styles[index%styles.length].color} strokeWidth="2" strokeDasharray={styles[index%styles.length].dash}/></svg>{row.Scenario}</button>)}
    </div>
    <p className="chart-note">Select a scenario to highlight its line; hover over a point for its exact percentage.</p>

  </div>;
}

function ScenarioTravelComparison({ rows }: { rows: TravelTimeRow[] }) {
  const [metric, setMetric] = useState<"mvc" | "remaining" | "overall">("mvc");
  const metrics = [{key:"mvc" as const,label:"MVC",color:"#078895"},{key:"remaining" as const,label:"Non-MVC",color:"#356fc3"},{key:"overall" as const,label:"Overall",color:"#8260b8"}];
  const selected = metrics.find(m=>m.key===metric)!;
  const values=rows.flatMap(row=>metrics.map(m=>row[m.key])).filter((v):v is number=>v!=null && Number.isFinite(v));
  const minimum=Math.floor(Math.min(...values)/5)*5;
  const maximum=Math.max(minimum+5,Math.ceil(Math.max(...values)/5)*5);
  const x=(value:number)=>72+(value-minimum)/(maximum-minimum)*206;
  return <div className="scenario-travel-comparison">
    <div className="travel-metric-picker" role="group" aria-label="Travel-time measure">
      {metrics.map(m=><button key={m.key} type="button" aria-pressed={metric===m.key} onClick={()=>setMetric(m.key)}>{m.label}</button>)}
    </div>
    <p className="chart-note">Travel time (sec). All scenarios use the same scale; lower values indicate shorter travel times.</p>
    {(rows.some(row=>row.scenario.toUpperCase().includes("RF")) ? ["RF","XGB"] : ["Historical"]).map(variant=>{
      const group=variant==="Historical" ? rows : rows.filter(r=>r.scenario.toUpperCase().includes(variant));
      const baseline=group.find(r=>r.scenario.toLowerCase().includes("existing condition"));
      const baselineValue=baseline?.[metric];
      return <section className="chart-block travel-comparison-card" key={variant} aria-label={`${variant} travel-time comparison`}>
        <div className="travel-comparison-heading"><h3>{variant}</h3><span>{selected.label} · sec</span></div>
        {baseline && <p className="travel-baseline"><span>{baseline.scenario}</span><strong>{valueLabel(baselineValue)} sec</strong></p>}
        <svg viewBox={`0 0 310 ${group.length*34+36}`} className="travel-dot-chart" role="img" aria-label={`${variant} ${selected.label} travel times by scenario`}>
          {[minimum,(minimum+maximum)/2,maximum].map(t=><g key={t}><line x1={x(t)} x2={x(t)} y1="7" y2={group.length*34} className="travel-dot-grid"/><text x={x(t)} y={group.length*34+22} textAnchor="middle" className="travel-dot-tick">{valueLabel(t)}</text></g>)}
          {baselineValue!=null && <line x1={x(baselineValue)} x2={x(baselineValue)} y1="7" y2={group.length*34} className="travel-baseline-rule"/>}
          {group.map((row,index)=>{
            const value=row[metric]; const y=22+index*34;const isBaseline=row===baseline;
            const short=row.scenario.match(/Scenario (\d+(?:\.\d+)?)/);
            const label=isBaseline ? "Existing" : short ? `S${short[1]}` : shortScenarioName(row.scenario);
            return <g key={row.scenario}><title>{row.scenario}: {selected.label} {valueLabel(value)} sec</title><text x="4" y={y+4} className={`travel-dot-label ${isBaseline ? "baseline" : ""}`}>{label}</text>{value!=null && <><line x1="72" x2={x(value)} y1={y} y2={y} className="travel-dot-guide"/><circle cx={x(value)} cy={y} r={isBaseline?4:5} fill={isBaseline?"#fff":selected.color} stroke={isBaseline?"#6b7b8b":selected.color} strokeWidth="2"/><text x={x(value)} y={y-10} textAnchor="middle" className="travel-dot-value">{valueLabel(value)}</text></>}</g>;
          })}
        </svg>

        {baseline && <details className="travel-value-details"><summary>Improvement (%)</summary><div className="change-table"><table><thead><tr><th>Scenario</th><th>MVC improvement (%)</th><th>Non-MVC improvement (%)</th><th>Overall improvement (%)</th></tr></thead><tbody>{group.filter(row=>row!==baseline).map(row=><tr key={row.scenario}><td>{shortScenarioName(row.scenario)}</td>{metrics.map(m=><td key={m.key}>{percentChangeLabel(baseline[m.key],row[m.key])}</td>)}</tr>)}</tbody></table></div></details>}
      </section>;
    })}
  </div>;
}

export function TravelTimeChart({ rows }: { rows: TravelTimeRow[] }) {

  const series = [

    { key: "mvc" as const, label: "MVC", angle: -90 },

    { key: "remaining" as const, label: "Non-MVC", angle: 30 },

    { key: "overall" as const, label: "Overall", angle: 150 },

  ];

  const colors = ["#111827", "#7c3aed", "#0891b2", "#dc2626", "#16a34a", "#f59e0b", "#2563eb", "#db2777", "#64748b", "#14b8a6"];

  const dashPatterns = ["", "8 3", "4 3", "10 4 2 4", "2 3", "12 3", "6 2 2 2", "3 5", "9 2 2 2", "5 2"];

  const custom = rows.some(row => row.scenario.startsWith("Custom:"));

  const values = rows.flatMap(row => [row.mvc, row.remaining, row.overall]).filter((v): v is number => v != null && Number.isFinite(v));

  const minValue = custom ? Math.max(0, Math.floor(Math.min(...values)/10)*10-10) : 110;

  const tickMax = custom ? Math.max(minValue+20, Math.ceil(Math.max(...values)/10)*10) : 160;

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

  if (!custom) return <ScenarioTravelComparison rows={rows} />;

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

        <span className="chart-note">Radar scale spans {minValue}–{tickMax} sec in 10-sec intervals; lower travel time plots closer to the center.</span>

      </div>

      {fallbackBaseline && scenarioRows.length > 0 && (

        <div className="change-table">

          <table>

            <thead>

              <tr>

                <th>Scenario</th>

                <th>MVC improvement (%)</th>

                <th>Non-MVC improvement (%)</th>

                <th>Overall improvement (%)</th>

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

export function StationAnalysisChart({ rows }: { rows: StationAnalysisRow[] }) {

  const scenarioNames = Array.from(new Set(rows.map((row) => row.scenario)));

  const maxTravel = Math.max(1, ...rows.flatMap((row) => [Number(row.mvcTravel ?? 0), Number(row.remainingTravel ?? 0)]));

  const maxPaths = Math.max(1, ...rows.map((row) => Number(row.mvcEffectivePaths ?? 0)));

  return (

    <div className="chart-block station-chart">
      <p className="scenario-selection-prompt">Please select a scenario to view its station results.</p>

      {scenarioNames.map((scenario) => {

        const scenarioRows = rows.filter((row) => row.scenario === scenario);

        return (

          <details className="station-scenario" key={scenario}>

            <summary>{shortScenarioName(scenario)} <span>{scenarioRows.length} stations</span></summary>

            <div className="station-table">
              <div className="station-row station-column-headings">
                <span>Station</span>
                <span className="station-heading-mvc" title="Weighted average MVC travel time">MVC travel<br />(sec)</span>
                <span className="station-heading-nonmvc" title="Weighted average Non-MVC travel time">Non-MVC travel<br />(sec)</span>
                <span className="station-heading-capacity" title="Allocation relative to the upper capacity allowance">Capacity<br />(% of upper allowance)</span>
                <span className="station-heading-paths" title="Demand-weighted average number of MVC paths within 240 seconds">Weighted MVC paths<br />(≤240 sec)</span>
              </div>


              {scenarioRows.map((row) => (

                <div className="station-row" key={`${row.scenario}-${row.station}`}>

                  <span className="station-id">{row.station}</span>

                  <span className="mini-bar purple" style={{ width: `${((row.mvcTravel ?? 0) / maxTravel) * 100}%` }} title={`MVC travel: ${valueLabel(row.mvcTravel)} sec`} />

                  <span className="mini-bar cyan" style={{ width: `${((row.remainingTravel ?? 0) / maxTravel) * 100}%` }} title={`Non-MVC travel: ${valueLabel(row.remainingTravel)} sec`} />

                  <span className="mini-bar slate" style={{ width: `${Math.min(row.capacityUsedPercent ?? 0, 100)}%` }} title={`Capacity used: ${valueLabel(row.capacityUsedPercent)}%`} />

                  <span className="mini-bar green" style={{ width: `${((row.mvcEffectivePaths ?? 0) / maxPaths) * 100}%` }} title={`MVC effective paths: ${valueLabel(row.mvcEffectivePaths)}`} />

                </div>

              ))}

            </div>

          </details>

        );

      })}

      <div className="chart-legend">

        <span><i className="purple" />MVC travel time (sec)</span>

        <span><i className="cyan" />Non-MVC travel time (sec)</span>

        <span><i className="slate" />Capacity (% of upper allowance)</span>

        <span><i className="green" />Weighted MVC paths (≤240 sec)</span>

      </div>

    </div>

  );

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

      map.set(station, ((mvcWorkload + nonMvcWorkload + (numericValue(row.zeroWorkload) ?? 0)) / totalCapacity) * 100);

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

        mvcTravel: manualWeightedAverage(mvcFeatures, "FreeFlow_Time_sec", "Severity_Weight"),

        remainingTravel: manualWeightedAverage(nonMvcFeatures, "FreeFlow_Time_sec", "Severity_Weight"),

        capacityUsedPercent: capacityByStation.get(station) ?? null,

        mvcEffectivePaths: manualWeightedAverage(mvcFeatures, "Effective_Path_Count_Under240"),

      };

    })

    .filter((row) => row.mvcTravel !== null || row.remainingTravel !== null || row.capacityUsedPercent !== null || row.mvcEffectivePaths !== null);

}

export function ManualScenarioSummary({ result }: { result: ManualAllocationResult | null }) {

  if (!result) return null;

  const rows = (result.diagnostics.capacitySummary ?? []) as Array<{station:string; mvcWorkload:number; nonMvcHistoricalWorkload:number; zeroWorkload:number; mvcBaseline:number; nonMvcBaseline:number; mvcCapacity:number; nonMvcCapacity:number}>;

  const settings = result.diagnostics.capacityScenario;

  const weights = result.diagnostics.weights;

  const counts = result.diagnostics.allocationCounts;

  const validPaths = result.mvcGeojson.features;

  const incidents = validPaths.reduce((sum,f) => sum + Number(f.properties.Unique_Incidents ?? 0), 0);

  const paths = incidents ? validPaths.reduce((sum,f) => sum + Number(f.properties.Total_IncidentWeighted_Path_Count ?? 0),0)/incidents : 0;

  return <div className="chart-block">

    <h3>Approximate allocation</h3>

    <p className="small" role="status">{result.diagnostics.solver?.heuristicFallback ? "The search limit was reached; a capacity-checked heuristic allocation is displayed." : result.diagnostics.solver?.searchLimitReached ? "A stage reached its search time limit; the displayed allocation is feasible and passes capacity checks." : "Search completed with a feasible allocation."} Global optimality is not guaranteed.</p>

    <p className="small">MVC up to {(settings.mvcUpper*100).toFixed(0)}%; Non-MVC up to {(settings.nonMvcUpper*100).toFixed(0)}%; {settings.maxPaths} paths. Weights: MVC travel {weights.mvcTime.toFixed(2)}, paths {weights.mvcPaths.toFixed(2)}, Non-MVC travel {weights.nonMvcTime.toFixed(2)}.</p>

    <p className="small">Network weighted MVC paths: {paths.toFixed(2)}. Assigned grids: {counts.mvc} MVC, {counts.nonMvcHistorical} Non-MVC and {counts.zeroTerritory} zero-incident territory.</p>

    <details className="station-scenario"><summary>Station workload limits and utilization</summary>

      <div className="change-table"><table><thead><tr><th>Station</th><th>MVC (% baseline)</th><th>Non-MVC (% baseline)</th><th>Combined utilization (% upper allowance, including zero grids)</th></tr></thead>

        <tbody>{rows.map(r => <tr key={r.station}><td>{r.station}</td><td>{r.mvcBaseline ? (100*r.mvcWorkload/r.mvcBaseline).toFixed(2)+"%" : "—"}</td><td>{r.nonMvcBaseline ? (100*r.nonMvcHistoricalWorkload/r.nonMvcBaseline).toFixed(2)+"%" : "—"}</td><td>{r.mvcCapacity+r.nonMvcCapacity ? (100*(r.mvcWorkload+r.nonMvcHistoricalWorkload+r.zeroWorkload)/(r.mvcCapacity+r.nonMvcCapacity)).toFixed(2)+"%" : "—"}</td></tr>)}</tbody>

      </table></div>

    </details>

  </div>;

}

export function ManualStationAnalysisChart({ result }: { result: ManualAllocationResult | null }) {

  const rows = manualStationAnalysisRows(result);

  if (!rows.length) return null;

  return (

    <div className="chart-block manual-station-analysis">

      <h3>Station analysis</h3>

      <StationAnalysisChart rows={rows} />

    </div>

  );

}

export function ScenarioBarChart({ rows, metric, title, unit, colorClass }: { rows: ScenarioSummaryRow[]; metric: "medianCapacityUsedPercent" | "averageMvcEffectivePaths" | "medianBaselineAllocationPercent" | "medianStationWeightedPaths"; title: string; unit: string; colorClass: string }) {

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

            <span className="scenario-bar-value">{value.toFixed(2)}{unit}</span>

          </div>

        );

      })}

    </div>

  );

}

export function ExistingMetricLineChart({ title, values }: { title: string; values?: { mvc?: number | null; remaining?: number | null; overall?: number | null } }) {

  const points = [

    { key: "mvc", label: "MVC", value: values?.mvc },

    { key: "remaining", label: "Non-MVC", value: values?.remaining },

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
