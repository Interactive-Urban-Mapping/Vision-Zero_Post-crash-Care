import GLPK from "glpk.js";

export type ManualWeights = { mvcTime: number; mvcPaths: number; nonMvcTime: number };
export type ManualSettings = { mvcLower: number; mvcUpper: number; nonMvcLower: number; nonMvcUpper: number; maxPaths: 250 | 500 };
export type ManualAllocationFeature = { type: "Feature"; geometry: unknown; properties: Record<string, string | number | null> };
export type ManualAllocationGeoJSON = { type: "FeatureCollection"; features: ManualAllocationFeature[] };
export type ManualAllocationResult = { mvcGeojson: ManualAllocationGeoJSON; nonMvcGeojson: ManualAllocationGeoJSON; travelTime: Array<{ scenario: string; mvc: number | null; remaining: number | null; overall: number | null }>; assignedGrids: number; notes: string[]; diagnostics: Record<string, any> };
type Stats = [string, number, number, number, number];
type OD = Array<[string, Array<[string, number]>]>;
export type ManualInputs = { schemaVersion: number; mvcDemandStats: Stats[]; nonMvcDemandStats: Stats[]; mvcODByGrid: OD; nonMvcODByGrid: OD; mvcCapacity: Array<[string, number]>; nonMvcCapacity: Array<[string, number]>; mvcPaths250: Array<[string, string, number]>; mvcPaths500: Array<[string, string, number]>; zeroWorkloadSec: number };
type Decision = { variable: string; category: string; grid: string; station: string; count: number; workload: number; service: number; severityWeight: number; time: number; paths: number; coefficient: number };
const GAP = 0.02;
const total = (v: number[]) => v.reduce((s, x) => s + x, 0);
const key = (s: string, g: string) => `${s}|${g}`;
const assetUrl = (p: string) => `${import.meta.env.BASE_URL}${p.replace(/^\/+/, "")}`;

export function validateManualScenario(weights: ManualWeights, settings: ManualSettings) {
  const values = Object.values(weights);
  if (values.some(v => !Number.isFinite(v) || v < 0 || v > 1) || Math.abs(total(values)-1)>1e-6) throw new Error("Objective weights must be between 0 and 1 and sum to 1.00.");
  for (const [name, lower, upper] of [["MVC", settings.mvcLower, settings.mvcUpper], ["Non-MVC", settings.nonMvcLower, settings.nonMvcUpper]] as const) {
    if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower !== 0 || upper < 1.3 || upper > 2) throw new Error(`${name}: use no lower bound and an upper limit from 130 to 200%.`);
  }
  if (![250,500].includes(settings.maxPaths)) throw new Error("Choose 250 or 500 paths.");
}

export async function solveManualInputs(inputs: ManualInputs, geometry: ManualAllocationGeoJSON, weights: ManualWeights, settings: ManualSettings, solver?: any, onProgress?: (stage:string)=>void): Promise<ManualAllocationResult> {
  onProgress?.("Preparing allocation model");
  validateManualScenario(weights, settings);
  if (inputs.schemaVersion !== 2) throw new Error("Manual inputs need the current severity-weighted schema.");
  const glpk = solver ?? await GLPK();
  try {
  const capacities = { MVC: new Map(inputs.mvcCapacity), "Non-MVC": new Map(inputs.nonMvcCapacity) };
  const pathLookup = new Map((settings.maxPaths === 250 ? inputs.mvcPaths250 : inputs.mvcPaths500).map(([s,g,n]) => [key(s,g),n]));
  const options = { msglev: glpk.GLP_MSG_OFF, presol: true, mipgap: GAP, tmlim: 20 };
  const decisions: Decision[] = [];
  const constraints: any[] = [];
  const denominators = { mvcTravel: 0, mvcPaths: 0, nonMvcTravel: 0 };
  const stationVars = new Map<string, Decision[]>();
  for (const [category, stats, od, lower, upper] of [
    ["MVC", inputs.mvcDemandStats, inputs.mvcODByGrid, settings.mvcLower, settings.mvcUpper],
    ["Non-MVC", inputs.nonMvcDemandStats, inputs.nonMvcODByGrid, settings.nonMvcLower, settings.nonMvcUpper],
  ] as const) {
    const candidates = new Map(od);
    for (const [grid,count,workload,service,severityMean] of stats) {
      const eligible = (candidates.get(grid) ?? []).filter(([s,t]) => s !== "0" && (capacities[category].get(s)??0)>0 && (capacities[category].get(s)??0)*upper+0.01>=workload && Number.isFinite(t) && t >= 0);
      if (!eligible.length) throw new Error(`${category} grid ${grid} has no eligible station.`);
      if (!(count>0 && workload>=0 && severityMean>0)) throw new Error(`Invalid historical demand for ${category} grid ${grid}.`);
      const severityWeight = count * severityMean;
      if (category === "MVC") {
        denominators.mvcTravel += severityWeight*Math.min(...eligible.map(([,t])=>t));
        denominators.mvcPaths += count*Math.max(...eligible.map(([s])=>pathLookup.get(key(s,grid))??0));
      } else denominators.nonMvcTravel += severityWeight*Math.min(...eligible.map(([,t])=>t));
      const gridVars: any[] = [];
      for (const [station,time] of eligible) {
        const d: Decision = { variable: `x_${decisions.length}`, category, grid, station, count, workload, service, severityWeight, time, paths: category === "MVC" ? pathLookup.get(key(station,grid))??0 : 0, coefficient: 0 };
        decisions.push(d); gridVars.push({name:d.variable,coef:1});
        const sk = key(category,station); let stationEntries = stationVars.get(sk); if (!stationEntries) { stationEntries = []; stationVars.set(sk, stationEntries); } stationEntries.push(d);
      }
      constraints.push({name:`assign_${category}_${grid}`,vars:gridVars,bnds:{type:glpk.GLP_FX,lb:1,ub:1}});
    }
    for (const [station,base] of capacities[category]) {
      const entries = stationVars.get(key(category,station))??[];
      if (!entries.length && base*lower>0) throw new Error(`${category} station ${station} cannot meet the lower workload bound: no eligible grids.`);
      if (!entries.length) continue;
      constraints.push({name:`band_${category}_${station}`,vars:entries.map(d=>({name:d.variable,coef:d.workload})),bnds:{type:glpk.GLP_UP,lb:0,ub:base*upper}});
    }
  }
  for (const d of decisions) d.coefficient = 1e6 * (d.category === "MVC"
    ? weights.mvcTime*d.severityWeight*d.time/Math.max(denominators.mvcTravel,1) - weights.mvcPaths*d.count*d.paths/Math.max(denominators.mvcPaths,1)
    : weights.nonMvcTime*d.severityWeight*d.time/Math.max(denominators.nonMvcTravel,1));
  const shortlist = (ds: Decision[], limit=16) => {
    const byGrid = new Map<string, Decision[]>();
    for (const d of ds) { const list=byGrid.get(d.grid)??[]; list.push(d); byGrid.set(d.grid,list); }
    return [...byGrid.values()].flatMap(list=>list.sort((a,b)=>a.coefficient-b.coefficient || a.time-b.time).slice(0,limit));
  };
  const makeLP = (name: string, ds: Decision[], subjectTo: any[]) => {
    const included=new Set(ds.map(d=>d.variable));
    return {name,objective:{direction:glpk.GLP_MIN,name:"weighted_objective",vars:ds.map(d=>({name:d.variable,coef:d.coefficient}))},subjectTo:subjectTo.map(c=>({...c,vars:c.vars.filter((v:any)=>included.has(v.name))})).filter(c=>c.vars.length),binaries:ds.map(d=>d.variable)}; };
  const feasible = (result: any, label: string) => { if (![glpk.GLP_OPT,glpk.GLP_FEAS].includes(result?.result?.status)) throw new Error(`${label} has no feasible allocation under these upper limits. Widen the upper limits and try again.`); };
  const select = (ds: Decision[], result: any) => ds.filter(d=>(result.result.vars[d.variable]??0)>0.5);
  const solveCategory = async (category: "MVC" | "Non-MVC") => {
    const ds=shortlist(decisions.filter(d=>d.category===category),16);
    const rows=constraints.filter(c=>c.name.startsWith(`assign_${category}_`) || c.name.startsWith(`band_${category}_`));
    const upper=category==="MVC" ? settings.mvcUpper : settings.nonMvcUpper;
    const groups=new Map<string,Decision[]>();
    for(const d of ds){const list=groups.get(d.grid)??[];list.push(d);groups.set(d.grid,list);}
    const ranked=[...groups.values()].map(list=>list.sort((a,b)=>a.coefficient-b.coefficient || a.time-b.time));
    let fallback:Decision[]|null=null;
    for(const ordering of ["regret","workload"]) {
      const remaining=new Map([...capacities[category]].map(([s,base])=>[s,base*upper]));
      const regret=(list:Decision[])=>list.length>1 ? list[1].coefficient-list[0].coefficient : Infinity;
      const ordered=[...ranked].sort((a,b)=> ordering==="regret" ? regret(b)-regret(a) || b[0].workload-a[0].workload : b[0].workload-a[0].workload || regret(b)-regret(a));
      const chosen:Decision[]=[];
      for(const list of ordered){const d=list.find(v=>(remaining.get(v.station)??0)+0.001>=v.workload);if(!d)break;chosen.push(d);remaining.set(d.station,(remaining.get(d.station)??0)-d.workload);}
      if(chosen.length===ranked.length){fallback=chosen;break;}
    }
    onProgress?.(`Solving ${category} allocation`);
    const started=performance.now();
    const value=await glpk.solve(makeLP(`Custom_${category}_Weighted_Allocation`,ds,rows),options);
    const elapsedSeconds=(performance.now()-started)/1000;
    if ([glpk.GLP_OPT,glpk.GLP_FEAS].includes(value?.result?.status)) {value.elapsedSeconds=elapsedSeconds;value.searchLimitReached=value.result.status!==glpk.GLP_OPT && elapsedSeconds>=20;return value;}
    if(fallback) return {result:{status:glpk.GLP_FEAS,z:total(fallback.map(d=>d.coefficient)),vars:Object.fromEntries(fallback.map(d=>[d.variable,1]))},elapsedSeconds,searchLimitReached:true,heuristicFallback:true};
    throw new Error(`${category}: no feasible result found within the fast search. Increase the upper limit or change the weights. This does not prove the full model is infeasible.`);
  };
  const mvcResult = await solveCategory("MVC");
  const nonResult = await solveCategory("Non-MVC");
  const result = {result:{status:mvcResult.result.status===glpk.GLP_OPT && nonResult.result.status===glpk.GLP_OPT ? glpk.GLP_OPT : glpk.GLP_FEAS,z:mvcResult.result.z+nonResult.result.z,vars:{...mvcResult.result.vars,...nonResult.result.vars}}};
  const selected = select(decisions,result);
  const expected = inputs.mvcDemandStats.length+inputs.nonMvcDemandStats.length;
  if (selected.length!==expected || new Set(selected.map(d=>key(d.category,d.grid))).size!==expected) throw new Error("Solver returned incomplete or duplicate assignments.");
  const consumed = (category: string, station: string) => total(selected.filter(d=>d.category===category && d.station===station).map(d=>d.workload));
  for (const [category,lower,upper] of [["MVC",settings.mvcLower,settings.mvcUpper],["Non-MVC",settings.nonMvcLower,settings.nonMvcUpper]] as const) for (const [station,base] of capacities[category]) {
    const value=consumed(category,station), tolerance=Math.max(0.01,base*1e-7);
    if (value<base*lower-tolerance || value>base*upper+tolerance) throw new Error(`Workload upper-limit verification failed for ${category} station ${station}.`);
  }
  const historical = new Set([...inputs.mvcDemandStats,...inputs.nonMvcDemandStats].map(r=>r[0]));
  const allOD = new Map<string, Map<string,number>>();
  for (const [grid,rows] of [...inputs.mvcODByGrid,...inputs.nonMvcODByGrid]) for (const [station,time] of rows) {
    if (station==="0" || !Number.isFinite(time) || (!capacities.MVC.has(station) && !capacities["Non-MVC"].has(station)))continue;
    const map=allOD.get(grid)??new Map();map.set(station,Math.min(time,map.get(station)??Infinity));allOD.set(grid,map);
  }
  const stations=new Set([...capacities.MVC.keys(),...capacities["Non-MVC"].keys()]);
  const residual=new Map([...stations].map(s=>[s,(capacities.MVC.get(s)??0)*settings.mvcUpper+(capacities["Non-MVC"].get(s)??0)*settings.nonMvcUpper-consumed("MVC",s)-consumed("Non-MVC",s)]));
  const zero: Decision[]=[]; const zeroConstraints:any[]=[]; const zeroGridIds=new Set(geometry.features.map(f=>String(f.properties.GRID_ID??f.properties.Grid_ID??"")).filter(g=>g&&!historical.has(g)));
  for (const grid of zeroGridIds) {
    const vars:any[]=[];
    for (const [station,time] of allOD.get(grid)??[]) if ((residual.get(station)??0)+0.01>=inputs.zeroWorkloadSec) {
      const d:Decision={variable:`z_${zero.length}`,category:"Zero-Incident Territory",grid,station,count:0,workload:inputs.zeroWorkloadSec,service:inputs.zeroWorkloadSec,severityWeight:0,time,paths:0,coefficient:time};
      zero.push(d); vars.push({name:d.variable,coef:1});
    }
    if (!vars.length) throw new Error(`Zero-incident grid ${grid} has no station with enough residual capacity. Widen the upper upper limits.`);
    zeroConstraints.push({name:`zero_assign_${grid}`,vars,bnds:{type:glpk.GLP_FX,lb:1,ub:1}});
  }
  for (const station of stations) {
    const ds=zero.filter(d=>d.station===station);
    if (ds.length)zeroConstraints.push({name:`zero_capacity_${station}`,vars:ds.map(d=>({name:d.variable,coef:1})),bnds:{type:glpk.GLP_UP,lb:0,ub:Math.floor((Math.max(0,residual.get(station)??0)+0.001)/inputs.zeroWorkloadSec)}});
  }
  onProgress?.("Allocating zero-incident grids");
  let zeroResult:any=null; let zeroSelected:Decision[]=[];
  if (zero.length) {const zeroLP=makeLP("Residual_Zero_Incident_Allocation",zero,zeroConstraints); zeroLP.binaries=[]; zeroResult=await glpk.solve(zeroLP,options);feasible(zeroResult,"Zero-incident territory");zeroSelected=select(zero,zeroResult);}
  if (zeroSelected.length!==zeroGridIds.size)throw new Error("Zero-incident territory assignment is incomplete.");
  for (const station of stations) if (total(zeroSelected.filter(d=>d.station===station).map(d=>d.workload))>(residual.get(station)??0)+0.01)throw new Error("Residual capacity verification failed.");
  onProgress?.("Checking capacities and preparing results");
  const props=(d:Decision)=>({Demand_Type:d.category,Allocation_Basis:d.category==="Zero-Incident Territory"?"Residual capacity post-solve":"Custom severity-weighted historical allocation",Grid_ID:d.grid,Allocated_Station:d.station,Unique_Incidents:d.count,Severity_Weight:d.severityWeight,Demand_Equivalent:d.count,Average_Service_Time_sec:d.service,Allocated_Service_Workload_sec:d.workload,FreeFlow_Time_sec:d.time,Total_FreeFlow_Time_sec:d.count*d.time,Total_SeverityWeighted_FreeFlow_Time_sec:d.severityWeight*d.time,Effective_Path_Count_Under240:d.category==="MVC"?d.paths:null,Total_IncidentWeighted_Path_Count:d.count*d.paths});
  const geo=(ds:Decision[]):ManualAllocationGeoJSON=>{const byGrid=new Map(ds.map(d=>[d.grid,d]));return {type:"FeatureCollection",features:geometry.features.flatMap(f=>{const d=byGrid.get(String(f.properties.GRID_ID??f.properties.Grid_ID));return d?[{...f,properties:{...f.properties,...props(d)}}]:[];})};};
  const mvc=selected.filter(d=>d.category==="MVC"),non=selected.filter(d=>d.category==="Non-MVC");
  const travel=(ds:Decision[])=>{const w=total(ds.map(d=>d.severityWeight));return w?total(ds.map(d=>d.severityWeight*d.time))/w:null;};
  const capacitySummary=[...stations].sort((x,y)=>Number(x)-Number(y)).map(station=>{const mvcWorkload=consumed("MVC",station),nonMvcHistoricalWorkload=consumed("Non-MVC",station),zeroWorkload=total(zeroSelected.filter(d=>d.station===station).map(d=>d.workload));return {station,mvcWorkload,nonMvcHistoricalWorkload,zeroWorkload,mvcBaseline:capacities.MVC.get(station)??0,nonMvcBaseline:capacities["Non-MVC"].get(station)??0,mvcCapacity:(capacities.MVC.get(station)??0)*settings.mvcUpper,nonMvcCapacity:(capacities["Non-MVC"].get(station)??0)*settings.nonMvcUpper};});
  const scenario=`Custom: MVC up to ${100*settings.mvcUpper}%; non-MVC up to ${100*settings.nonMvcUpper}%; Max${settings.maxPaths}`;
  return {mvcGeojson:geo(mvc),nonMvcGeojson:geo([...non,...zeroSelected]),travelTime:[{scenario,mvc:travel(mvc),remaining:travel(non),overall:travel(selected)}],assignedGrids:selected.length+zeroSelected.length,notes:["Fast approximate search: the 16 best stations per grid under the selected weights; a 20-second solver search limit per stage. The 2% gap is a target for the reduced model, not a guarantee for all station candidates.","Travel times use incident count × mean severity; MVC paths use incident counts. Capacity uses historical service workload.","Zero-incident grids consume only residual combined workload capacity after historical demand is solved.","Separate MVC/non-MVC upper limits make their allocations independent. The MVC travel/path weight ratio controls the MVC trade-off; a positive non-MVC travel weight minimizes non-MVC travel."],diagnostics:{weights,capacityScenario:settings,normalizationDenominators:denominators,solver:{name:"glpk.js",method:"candidate shortlist",approximate:true,candidateLimits:[16],heuristicFallback:!!(mvcResult.heuristicFallback || nonResult.heuristicFallback),searchLimitReached:!!(mvcResult.searchLimitReached || nonResult.searchLimitReached),stageSeconds:{mvc:mvcResult.elapsedSeconds,nonMvc:nonResult.elapsedSeconds},timeLimitPerSolveSec:20,mipGap:GAP,status:result.result.status,objective:result.result.z,zeroStatus:zeroResult?.result?.status??null},capacitySummary,allocationCounts:{mvc:mvc.length,nonMvcHistorical:non.length,zeroTerritory:zeroSelected.length,totalMapped:selected.length+zeroSelected.length}}};
  } finally {
    if (!solver) glpk.terminate();
  }
}

export async function runManualAllocation(weights:ManualWeights,settings:ManualSettings,signal?:AbortSignal,onProgress?:(stage:string)=>void):Promise<ManualAllocationResult> {
  onProgress?.("Loading inputs");
  const [inputs,geometry]=await Promise.all([fetch(assetUrl("layers/manual/manual_inputs.json"),{signal}),fetch(assetUrl("layers/baseline_grids.geojson"),{signal})]);
  if (!inputs.ok || !geometry.ok)throw new Error("Could not load current manual optimizer inputs.");
  const glpk=await GLPK();
  let terminated=false;
  const terminate=()=>{if(!terminated){terminated=true;glpk.terminate();}};
  let cancel:()=>void=()=>{};
  const cancelled=new Promise<never>((_,reject)=>{cancel=()=>{terminate();reject(new Error("Scenario cancelled."));};});
  signal?.addEventListener("abort",cancel,{once:true});
  try {
    if(signal?.aborted)throw new Error("Scenario cancelled.");
    return await Promise.race([solveManualInputs(await inputs.json(),await geometry.json(),weights,settings,glpk,onProgress),cancelled]);
  } finally {
    signal?.removeEventListener("abort",cancel);
    terminate();
  }
}
