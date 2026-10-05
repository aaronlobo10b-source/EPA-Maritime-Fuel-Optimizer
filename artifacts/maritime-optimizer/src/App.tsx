import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useForm, useFormContext } from 'react-hook-form';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { Activity, Anchor, ArrowDownToLine, ArrowLeftRight, BadgeAlert, BarChart3, BookOpen, Check, ChevronRight, CircleHelp, Database, Download, FilePlus2, Fuel, Gauge, LoaderCircle, Plus, RefreshCw, Ship, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Form } from '@/components/ui/form';
import NotFound from '@/pages/not-found';
import {
  getListVesselsQueryKey, useCreateVessel, useDeleteVessel, useGetMaritimeCatalog,
  useGetFuelCastValidation, useListVessels, useOptimizeVoyage, useUpdateVessel,
} from '@workspace/api-client-react';
import type { FuelCastValidation, OptimizationResponse, OptimizeInput, Vessel, VesselInput } from '@workspace/api-client-react';

const queryClient = new QueryClient();
const iconSize = 16;
type AnyRecord = Record<string, string>;

const numberFields: [string, string, string][] = [
  ['deadweightTonnes','Deadweight','t'],['lightshipTonnes','Lightship','t'],['cargoCapacityTonnes','Cargo capacity','t'],
  ['designServiceSpeedKnots','Design service speed','kn'],['maxSpeedKnots','Maximum speed','kn'],['maxEnginePowerKw','Maximum engine power','kW'],
  ['engineEfficiency','Engine efficiency','fraction'],['blockCoefficient','Block coefficient','fraction'],['lengthOverallM','Length overall','m'],
  ['beamM','Beam','m'],['designDraftM','Design draft','m'],['windageAreaM2','Windage area','m²'],['windDragCoefficient','Wind drag coefficient',''],
];
const blankProfile = (): AnyRecord => Object.fromEntries([
  'name','vesselClass',...numberFields.map(f=>f[0]),'sourceName','sourceUrl','fuelTankVolumesM3','alternativeFuelWeightPenaltyTonnes',
].map(k=>[k,'']));
const optimizationInputs: [string,string,string][] = [
  ['distanceNm','Voyage distance','nautical miles'],['cargoTonnes','Cargo carried','tonnes'],['actualDraftM','Actual draft','m'],
  ['minSpeedKnots','Minimum speed','knots'],['maxSpeedKnots','Maximum speed','knots'],['speedStepKnots','Speed step','knots'],
  ['windBeaufort','Wind force','Beaufort'],['waveHeightM','Significant wave height','m'],['waveRelativeDirectionDeg','Wave direction relative to course','degrees'],
  ['currentAlongTrackKnots','Along-track current','knots'],['berthWindowStartHour','Berth window opens','hour from departure'],
  ['berthWindowEndHour','Berth window closes','hour from departure'],['carbonPriceInrPerTonne','Carbon price','₹/tonne CO₂e'],
  ['portFeesInr','Port fees','₹/voyage'],['evaluationBudget','Evaluation budget','evaluations'],['randomSeed','Optimizer seed','integer'],
];
const fuelLabels: [string,string,string][] = [
  ['bunkerPriceInrPerTonne','Fuel price','₹/tonne'],['densityKgPerM3','Density','kg / m³'],['wellToTankKgCo2ePerKg','Well-to-tank emissions','kg CO₂e / kg'],
];
const fmt = (n: number | undefined | null, digits=1) => n == null || !Number.isFinite(n) ? '—' : new Intl.NumberFormat('en-US',{maximumFractionDigits:digits}).format(n);
const prettyClass = (s?: string) => s ? s.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()) : 'Class not set';
function Field({label,unit,value,onChange,type='number',required=false,placeholder='',min,max,step,testId}: {label:string;unit?:string;value:string;onChange:(v:string)=>void;type?:string;required?:boolean;placeholder?:string;min?:string;max?:string;step?:string;testId:string}) {
  const { register } = useFormContext<AnyRecord>();
  const registration = register(testId,{required:required?'This field is required':false,min:min!==undefined?Number(min):undefined,max:max!==undefined?Number(max):undefined});
  return <div className="field"><label htmlFor={testId}>{label}{unit ? ` · ${unit}` : ''}</label><input id={testId} data-testid={testId} name={registration.name} ref={registration.ref} onBlur={registration.onBlur} type={type} value={value} onChange={e=>{registration.onChange(e);onChange(e.target.value);}} required={required} placeholder={placeholder} min={min} max={max} step={step ?? (type==='number'?'any':undefined)} /></div>;
}
function Panel({title,caption,number,children,action}: {title:string;caption?:string;number?:string;children:React.ReactNode;action?:React.ReactNode}) {
  return <section className="card"><div className="card-head"><div><h2 className="card-title">{number&&<span className="section-index">{number}</span>}{title}</h2>{caption&&<div className="card-caption">{caption}</div>}</div>{action}</div><div className="card-body">{children}</div></section>;
}
function LoadingBlock() { return <div className="loading-lines" aria-label="Loading"><div className="skeleton" style={{width:'41%'}}/><div className="skeleton" style={{width:'88%'}}/><div className="skeleton" style={{width:'72%'}}/></div>; }
function DownloadButton({data,filename}: {data:unknown;filename:string}) {
  const exportFile=()=>{ const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url); };
  return <button className="btn small" onClick={exportFile} data-testid="button-export-json"><Download size={14}/> Export JSON</button>;
}
function AppShell({children}: {children:React.ReactNode}) {
  const [path]=useLocation();
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><span>MF</span></div><div><div className="brand-title">Maritime Fuel</div><div className="brand-sub">OPTIMIZATION SYSTEM</div></div></div>
      <div className="nav-group"><div className="nav-label">Planning</div><Link href="/" data-testid="link-workspace" className={`nav-link ${path==='/'?'active':''}`}><SlidersHorizontal size={16}/>Voyage workspace</Link><Link href="/fleet" data-testid="link-fleet" className={`nav-link ${path==='/fleet'?'active':''}`}><Ship size={16}/>Vessel profiles</Link></div>
      <div className="side-foot">DECISION SUPPORT / 01<br/>Source-backed inputs only<br/><span style={{color:'#d6aa68'}}>NO AUTOFILLED ASSUMPTIONS</span></div>
    </aside>
    <div className="main-area"><nav className="mobile-nav" aria-label="Main navigation"><Link href="/" data-testid="mobile-nav-workspace" className={path==='/'?'active':''}>Workspace</Link><Link href="/fleet" data-testid="mobile-nav-fleet" className={path==='/fleet'?'active':''}>Vessel profiles</Link></nav>
      <header className="topbar"><div className="crumb">Fleet engineering <ChevronRight size={13} style={{verticalAlign:'middle',margin:'0 5px'}}/> {path==='/fleet'?'Vessel profiles':'Voyage workspace'}</div><div className="top-meta"><span className="live-dot"/><span>CALCULATION READY WHEN INPUTS ARE COMPLETE</span></div></header>{children}
    </div>
  </div>;
}
function Workspace() {
  const catalogQuery=useGetMaritimeCatalog();
  const fuelcastQuery=useGetFuelCastValidation();
  const vesselsQuery=useListVessels({query:{queryKey:getListVesselsQueryKey(),retry:false,retryOnMount:false,refetchOnWindowFocus:false}});
  const optimize=useOptimizeVoyage();
  const workspaceForm=useForm<AnyRecord>();
  const [vesselId,setVesselId]=useState('');
  const [values,setValues]=useState<AnyRecord>({});
  const [weights,setWeights]=useState<AnyRecord>({});
  const [fuelValues,setFuelValues]=useState<Record<string,AnyRecord>>({});
  const [availability,setAvailability]=useState<Record<string,string>>({});
  const [fuelEstimator,setFuelEstimator]=useState<'physics_baseline'|'fuelcast_ml'>('physics_baseline');
  const [fuelCastInputs,setFuelCastInputs]=useState<AnyRecord>({});
  const [fuelCastFuelId,setFuelCastFuelId]=useState('');
  const [result,setResult]=useState<OptimizationResponse|null>(null);
  const [submittedScenario,setSubmittedScenario]=useState<OptimizeInput|null>(null);
  const vessels=vesselsQuery.data??[];
  const selected=vessels.find(v=>v.id===vesselId);
  const catalog=catalogQuery.data;
  const compatible=useMemo(()=>selected&&catalog ? catalog.fuels.filter(f=>selected.fuelCompatibility.includes(f.fuelId)) : [],[selected,catalog]);
  const update=(key:string,value:string)=>setValues(prev=>({...prev,[key]:value}));
  const updateFuel=(id:string,key:string,value:string)=>setFuelValues(prev=>({...prev,[id]:{...prev[id],[key]:value}}));
  const updateFuelCast=(key:string,value:string)=>setFuelCastInputs(prev=>({...prev,[key]:value}));
  const weightTotal=['cost','emissions','duration'].reduce((s,k)=>s+(Number(weights[k])||0),0);
  const submit=()=>{
    if(!selected||compatible.length===0) return;
    const selectedFuels=fuelEstimator==='fuelcast_ml'?compatible.filter(f=>f.fuelId===fuelCastFuelId):compatible;
    if(selectedFuels.length===0)return;
    const input:OptimizeInput={
      vesselId,
      distanceNm:Number(values.distanceNm),cargoTonnes:Number(values.cargoTonnes),actualDraftM:Number(values.actualDraftM),
      minSpeedKnots:Number(values.minSpeedKnots),maxSpeedKnots:Number(values.maxSpeedKnots),speedStepKnots:Number(values.speedStepKnots),
      windBeaufort:Number(values.windBeaufort),waveHeightM:Number(values.waveHeightM),waveRelativeDirectionDeg:Number(values.waveRelativeDirectionDeg),
      currentAlongTrackKnots:Number(values.currentAlongTrackKnots),berthWindowStartHour:Number(values.berthWindowStartHour),berthWindowEndHour:Number(values.berthWindowEndHour),
      carbonPriceInrPerTonne:Number(values.carbonPriceInrPerTonne),carbonPriceSource:values.carbonPriceSource,portFeesInr:Number(values.portFeesInr),portFeesSource:values.portFeesSource,
      objectiveWeights:{cost:Number(weights.cost),emissions:Number(weights.emissions),duration:Number(weights.duration)},
      fuels:selectedFuels.map(f=>({fuelId:f.fuelId,bunkerPriceInrPerTonne:Number(fuelValues[f.fuelId]?.bunkerPriceInrPerTonne),densityKgPerM3:Number(fuelValues[f.fuelId]?.densityKgPerM3),wellToTankKgCo2ePerKg:Number(fuelValues[f.fuelId]?.wellToTankKgCo2ePerKg),nonCo2TankToWakeKgCo2ePerKg:Number(fuelValues[f.fuelId]?.nonCo2TankToWakeKgCo2ePerKg),methaneSlipPercent:f.methaneSlipInputRequired?Number(fuelValues[f.fuelId]?.methaneSlipPercent):null,bunkerPriceSource:fuelValues[f.fuelId]?.bunkerPriceSource??'',bunkerPriceAsOfDate:fuelValues[f.fuelId]?.bunkerPriceAsOfDate??'',wellToTankSource:fuelValues[f.fuelId]?.wellToTankSource??'',availableAtBunkeringPort:availability[f.fuelId]==='yes'})),
      evaluationBudget:Number(values.evaluationBudget),randomSeed:Number(values.randomSeed),
      fuelEstimator,
      ...(fuelEstimator==='fuelcast_ml'?{fuelCastFeatures:{
        referenceSpeedKnots:Number(fuelCastInputs.referenceSpeedKnots),
        shipSpeedOverGroundAtReferenceSpeed:Number(fuelCastInputs.shipSpeedOverGroundAtReferenceSpeed),
        totalShaftPowerAtReferenceSpeed:Number(fuelCastInputs.totalShaftPowerAtReferenceSpeed),
        windSpeed10m:Number(fuelCastInputs.windSpeed10m),waveHeight:Number(fuelCastInputs.waveHeight),
        oceanCurrentVelocity:Number(fuelCastInputs.oceanCurrentVelocity),
      }}:{})
    };
    setSubmittedScenario(input);
    setResult(null);
    optimize.mutate({data:input},{onSuccess:data=>setResult(data)});
  };
  const exportCsv=()=>{ if(!result)return; const rows=[['fuel','speed_knots','fuel_rate_kg_per_s','fuel_estimator','fuel_mass_tonnes','fuel_volume_m3','total_cost_inr_per_voyage','well_to_wake_kg_co2e','tank_to_wake_kg_co2e','duration_hours','engine_load_fraction','feasible'],...result.paretoFront.map(p=>[p.fuelName,p.speedKnots,p.fuelRateKgPerSecond,p.fuelEstimator,p.fuelMassTonnes,p.fuelVolumeM3,p.totalCostInr,p.wellToWakeKgCo2e,p.tankToWakeKgCo2e,p.durationHours,p.engineLoadFraction,p.feasible])]; const csv=rows.map(r=>r.map(c=>`"${String(c).replaceAll('"','""')}"`).join(',')).join('\n'); const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); const a=document.createElement('a');a.href=url;a.download='voyage-pareto.csv';a.click();URL.revokeObjectURL(url); };
  return <main className="page">
    <div className="page-heading"><div><div className="eyebrow">VOYAGE DECISION SYSTEM / 01</div><h1>Voyage optimization</h1><p className="page-intro">Compare fuel, cost, lifecycle emissions and schedule against your vessel's source data.</p></div><div className="actions"><span className="status">Inputs remain operator-owned</span></div></div>
    <FuelCastValidationPanel status={fuelcastQuery.data} loading={fuelcastQuery.isLoading} error={fuelcastQuery.isError} onRetry={()=>fuelcastQuery.refetch()}/>
    {catalogQuery.isLoading||vesselsQuery.isLoading ? <Panel title="Loading planning data"><LoadingBlock/></Panel> :
      (catalogQuery.isError||vesselsQuery.isError) ? <div className="error-box" role="alert" data-testid="status-workspace-error">{vesselsQuery.isError&&!catalogQuery.isError?'Vessel profiles and voyage optimization require DATABASE_URL. FuelCast validation remains available.':'Maritime planning reference data could not be loaded.'} <button className="btn small" onClick={()=>{catalogQuery.refetch();vesselsQuery.refetch();}} data-testid="button-retry-workspace"><RefreshCw size={13}/> Retry</button></div> :
      <Form {...workspaceForm}><form onSubmit={workspaceForm.handleSubmit(submit)}>
        <div className="workspace-grid">
          <div className="stack">
            <Panel title="Vessel & voyage" number="01" caption="Choose a saved source-backed profile and enter voyage conditions.">
              {vessels.length===0 ? <div className="empty-state"><div className="empty-symbol"><Ship size={19}/></div><h3>No vessel profiles available</h3><p>Add vessel particulars and their citations before running an optimization. No example vessels are supplied.</p><Link href="/fleet" className="btn primary" data-testid="link-add-first-vessel"><Plus size={14}/>Open vessel profiles</Link></div> : <>
                <div className="field-grid" style={{marginBottom:17}}><div className="field"><label htmlFor="vessel-select">Vessel profile</label><select id="vessel-select" data-testid="select-vessel" {...workspaceForm.register('vesselId',{required:true})} value={vesselId} required onChange={e=>{workspaceForm.register('vesselId').onChange(e);setVesselId(e.target.value);setResult(null);}}><option value="">Select a vessel profile</option>{vessels.map(v=><option key={v.id} value={v.id}>{v.name} · {prettyClass(v.vesselClass)}</option>)}</select></div>
                  <div className="assumption" style={{alignSelf:'end'}}><Database size={14}/><span>{selected?`${selected.sourceName} · ${selected.sourceUrl||'No source URL supplied'}`:'Select a profile to inspect its provenance.'}</span></div></div>
                <div className="field-grid">{optimizationInputs.slice(0,6).map(([key,label,unit])=><Field key={key} testId={`input-${key}`} label={label} unit={unit} value={values[key]??''} onChange={v=>update(key,v)} required min=".001" step="any"/>)}</div>
              </>}
            </Panel>
            <Panel title="Operating conditions" number="02" caption="Enter current forecast and port-window assumptions for this comparison.">
              <div className="field-grid three">{optimizationInputs.slice(6,12).map(([key,label,unit])=><Field key={key} testId={`input-${key}`} label={label} unit={unit} value={values[key]??''} onChange={v=>update(key,v)} required min={key==='currentAlongTrackKnots'?'-10':key==='berthWindowEndHour'?'.001':'0'} max={key==='windBeaufort'?'12':key==='waveRelativeDirectionDeg'?'180':key==='currentAlongTrackKnots'?'10':undefined} step="any"/>)}</div>
              <div className="notice" style={{marginTop:15}}><strong>Forecast provenance.</strong> Weather, waves and current are supplied by the operator. These fields are not fetched, inferred or replaced with example conditions.</div>
            </Panel>
            <Panel title="Fuel assumptions" number="03" caption="Every fuel is evaluated from the values entered below; catalog properties are references only.">
              <div className="notice" style={{marginBottom:12}}><strong>INR scenario pricing.</strong> Enter fuel in ₹/tonne, carbon in ₹/tonne CO₂e and port charges in ₹/voyage. Prices are operator-sourced; no current Indian marine-fuel market price is prefilled.</div>
              {!selected ? <div className="assumption"><CircleHelp size={15}/>Choose a vessel profile first to see compatible fuel options.</div> : compatible.length===0 ? <div className="assumption"><BadgeAlert size={15}/>No catalog fuels match this vessel's compatibility list. Update vessel compatibility or review catalog data.</div> :
                <>{compatible.map(f=><div key={f.fuelId} data-testid={`fuel-assumptions-${f.fuelId}`} style={{padding:'13px 0',borderBottom:'1px solid #e5e9e5'}}>
                  <div className="fuel-row">
                  <div className="field"><label>{f.name}</label><div className="helper">Reference LHV {f.lowerHeatingValueMjKg==null?'not supplied':`${fmt(f.lowerHeatingValueMjKg,2)} MJ/kg`} · TtW {f.tankToWakeKgCo2PerKg==null?'not supplied':`${fmt(f.tankToWakeKgCo2PerKg,3)} kg/kg`} · storage penalty {f.volumetricStoragePenalty==null?'not supplied':fmt(f.volumetricStoragePenalty,3)}</div>{f.reference&&<div className="helper">Catalog reference: {f.reference}</div>}</div>
                  {fuelLabels.map(([key,label,unit])=><Field key={key} testId={`input-${f.fuelId}-${key}`} label={label} unit={unit} value={fuelValues[f.fuelId]?.[key]??''} onChange={v=>updateFuel(f.fuelId,key,v)} required min={key==='wellToTankKgCo2ePerKg'?'-10':key==='densityKgPerM3'?'.001':'0'}/>)}
                  {f.methaneSlipInputRequired&&<Field testId={`input-${f.fuelId}-methaneSlipPercent`} label="Methane slip" unit="%" value={fuelValues[f.fuelId]?.methaneSlipPercent??''} onChange={v=>updateFuel(f.fuelId,'methaneSlipPercent',v)} required min="0" max="100" step="any"/>}
                  <div className="field"><label htmlFor={`available-${f.fuelId}`}>At bunkering port</label><select id={`available-${f.fuelId}`} data-testid={`select-availability-${f.fuelId}`} value={availability[f.fuelId]??''} onChange={e=>setAvailability(p=>({...p,[f.fuelId]:e.target.value}))} required><option value="">Specify availability</option><option value="yes">Available</option><option value="no">Not available</option></select></div>
                  </div>
                  <div className="field-grid three" style={{marginTop:12}}>
                    <Field testId={`input-${f.fuelId}-nonCo2TankToWake`} label="Non-CO₂ tank-to-wake" unit="kg CO₂e / kg" value={fuelValues[f.fuelId]?.nonCo2TankToWakeKgCo2ePerKg??''} onChange={v=>updateFuel(f.fuelId,'nonCo2TankToWakeKgCo2ePerKg',v)} required min="0"/>
                    <Field testId={`input-${f.fuelId}-bunkerPriceSource`} label="Bunker price source" type="text" value={fuelValues[f.fuelId]?.bunkerPriceSource??''} onChange={v=>updateFuel(f.fuelId,'bunkerPriceSource',v)} required placeholder="Source and location"/>
                    <Field testId={`input-${f.fuelId}-bunkerPriceAsOfDate`} label="Price as of" type="date" value={fuelValues[f.fuelId]?.bunkerPriceAsOfDate??''} onChange={v=>updateFuel(f.fuelId,'bunkerPriceAsOfDate',v)} required/>
                    <Field testId={`input-${f.fuelId}-wellToTankSource`} label="Well-to-tank source" type="text" value={fuelValues[f.fuelId]?.wellToTankSource??''} onChange={v=>updateFuel(f.fuelId,'wellToTankSource',v)} required placeholder="Source reference"/>
                  </div>
                </div>)}
                <div className="helper" style={{marginTop:12}}>Catalog values are shown as references; they are not silently used as scenario inputs. {catalog?.provenanceNotice}</div></>}
            </Panel>
          </div>
          <div className="stack">
              <Panel title="Fuel rate estimator" caption="Choose the measured-data model only when its source features match this scenario.">
                <div className="field"><label htmlFor="fuel-estimator">Fuel estimate method</label><select id="fuel-estimator" data-testid="select-fuel-estimator" value={fuelEstimator} onChange={e=>setFuelEstimator(e.target.value as 'physics_baseline'|'fuelcast_ml')}><option value="physics_baseline">Physics-based engineering baseline</option><option value="fuelcast_ml" disabled={!fuelcastQuery.data?.modelAvailable}>FuelCast real-data ML</option></select></div>
                {fuelEstimator==='physics_baseline' ? <div className="assumption" style={{marginTop:12}}><Gauge size={15}/><span>The existing SFOC and vessel-physics estimate remains active. FuelCast is an optional measured-data alternative.</span></div> : <>
                  <div className="notice" style={{marginTop:12}}><strong>REAL-WORLD MEASURED DATA.</strong> FuelCast predicts aggregate measured fuel rate. Select one priced fuel scenario only. Source speed and shaft power use the recorded dataset scale; their values are adjusted across candidate speeds using the existing engineering model's relative power ratios.</div>
                  <div className="field" style={{marginTop:12}}><label htmlFor="fuelcast-priced-fuel">Priced fuel scenario</label><select id="fuelcast-priced-fuel" data-testid="select-fuelcast-fuel" value={fuelCastFuelId} onChange={e=>setFuelCastFuelId(e.target.value)} required><option value="">Select one compatible fuel</option>{compatible.map(f=><option key={f.fuelId} value={f.fuelId}>{f.name}</option>)}</select></div>
                  <div className="field-grid three" style={{marginTop:12}}>
                    <Field testId="input-fuelcast-reference-speed" label="Reference speed" unit="knots" value={fuelCastInputs.referenceSpeedKnots??''} onChange={v=>updateFuelCast('referenceSpeedKnots',v)} required min=".001"/>
                    <Field testId="input-fuelcast-speed-over-ground" label="Ship speed over ground at reference" unit="m/s" value={fuelCastInputs.shipSpeedOverGroundAtReferenceSpeed??''} onChange={v=>updateFuelCast('shipSpeedOverGroundAtReferenceSpeed',v)} required min=".001"/>
                    <Field testId="input-fuelcast-shaft-power" label="Total shaft power at reference" unit="W" value={fuelCastInputs.totalShaftPowerAtReferenceSpeed??''} onChange={v=>updateFuelCast('totalShaftPowerAtReferenceSpeed',v)} required min=".001"/>
                    <Field testId="input-fuelcast-wind" label="10 m wind speed" unit="m/s" value={fuelCastInputs.windSpeed10m??''} onChange={v=>updateFuelCast('windSpeed10m',v)} required min="0"/>
                    <Field testId="input-fuelcast-wave" label="Wave height" unit="m" value={fuelCastInputs.waveHeight??''} onChange={v=>updateFuelCast('waveHeight',v)} required min="0"/>
                    <Field testId="input-fuelcast-current" label="Ocean current velocity" unit="m/s" value={fuelCastInputs.oceanCurrentVelocity??''} onChange={v=>updateFuelCast('oceanCurrentVelocity',v)} required min="0"/>
                  </div>
                  <div className="helper" style={{marginTop:10}}>Units follow the official FuelCast data card. Ship speed and shaft power are scaled across candidate speeds using dimensionless ratios; voyage distance, cargo, capacity, schedule, fuel price and density remain separate scenario inputs.</div>
                </>}
              </Panel>
            <Panel title="Decision objective" number="04" caption="Weights express relative priorities and must sum to 1.00.">
              <div>{[['cost','Cost'],['emissions','Lifecycle emissions'],['duration','Schedule duration']].map(([key,label])=>{const registration=workspaceForm.register(`weight-${key}`,{required:true,min:0,max:1});return <div className="weight-row" key={key}><label htmlFor={`weight-${key}`}>{label}</label><input id={`weight-${key}`} data-testid={`input-weight-${key}`} type="number" min="0" max="1" step=".01" required name={registration.name} ref={registration.ref} onBlur={registration.onBlur} value={weights[key]??''} onChange={e=>{registration.onChange(e);setWeights(v=>({...v,[key]:e.target.value}));}}/><span className="mono">{weights[key]||'—'}</span></div>;})}</div>
              <div className="assumption"><Activity size={15}/><span>Entered total: <strong className="mono">{weightTotal?fmt(weightTotal,2):'—'}</strong>. Objective weights are not normalized automatically.</span></div>
              <div className="field-grid" style={{marginTop:15}}>{optimizationInputs.slice(12).map(([key,label,unit])=><Field key={key} testId={`input-${key}`} label={label} unit={unit} value={values[key]??''} onChange={v=>update(key,v)} required min={key==='evaluationBudget'?'64':'0'} max={key==='evaluationBudget'?'4096':key==='randomSeed'?'2147483647':undefined} step={key==='randomSeed'||key==='evaluationBudget'?'1':'any'}/>)}
                <Field testId="input-carbonPriceSource" label="Carbon price source" type="text" value={values.carbonPriceSource??''} onChange={v=>update('carbonPriceSource',v)} required placeholder="Source and effective date"/>
                <Field testId="input-portFeesSource" label="Port fee source" type="text" value={values.portFeesSource??''} onChange={v=>update('portFeesSource',v)} required placeholder="Tariff, port and effective date"/>
              </div>
            </Panel>
            <Panel title="Review before calculation" number="05">
              <div className="assumption" style={{marginBottom:13}}><BookOpen size={15}/><span>{catalog?.provenanceNotice||'Catalog provenance notice unavailable.'}</span></div>
              <p className="helper" style={{fontSize:11,marginBottom:16}}>Calculation requires one vessel, complete fuel assumptions, non-negative objective weights totaling 1.00, and a complete voyage scenario. No recommendation is shown until the optimizer responds.</p>
              {optimize.isError&&<div className="error-box" role="alert" data-testid="status-optimization-error" style={{marginBottom:12}}>Optimization request failed. Review the inputs and retry. The API response has not been replaced with an estimate.</div>}
              <button className="btn primary" type="submit" disabled={!selected||compatible.length===0||optimize.isPending||Math.abs(weightTotal-1)>0.001||(fuelEstimator==='fuelcast_ml'&&(!fuelcastQuery.data?.modelAvailable||!fuelCastFuelId||['referenceSpeedKnots','shipSpeedOverGroundAtReferenceSpeed','totalShaftPowerAtReferenceSpeed','windSpeed10m','waveHeight','oceanCurrentVelocity'].some(key=>fuelCastInputs[key]===''||fuelCastInputs[key]===undefined||!Number.isFinite(Number(fuelCastInputs[key])))))} data-testid="button-run-optimization">{optimize.isPending?<><LoaderCircle size={15}/>Calculating</>:<><BarChart3 size={15}/>Run comparison</>}</button>
              {optimize.isPending&&<div style={{marginTop:15}}><LoadingBlock/></div>}
            </Panel>
            <Panel title="Model boundary" caption="Transparent inputs, traceable outputs.">
              <div className="bars"><div className="assumption"><Anchor size={15}/><span>Vessel performance depends on saved particulars and the linked source citation.</span></div><div className="assumption"><Fuel size={15}/><span>Fuel price, density, well-to-tank factor, availability and required methane slip are scenario inputs.</span></div><div className="assumption"><Gauge size={15}/><span>Missing reference properties stay marked as unavailable; no fallback values are applied.</span></div></div>
            </Panel>
          </div>
        </div>
      </form></Form>}
    {result&&<ResultView result={result} scenario={submittedScenario} onCsv={exportCsv}/>}
  </main>;
}
function FuelCastValidationPanel({status,loading,error,onRetry}: {status:FuelCastValidation|undefined;loading:boolean;error:boolean;onRetry:()=>void}) {
  return <div style={{marginBottom:16}} data-testid="panel-fuelcast-validation">
    <Panel title="FuelCast measured-data validation" caption="REAL-WORLD MEASURED DATA · Dataset FuelCast · Validation: time-block + unseen-vessel · CC BY-NC-ND 4.0 · files and model remain local">
      {loading?<LoadingBlock/>:error||!status?<div className="notice"><strong>Local validation not available.</strong> Licensed data and trained weights are not bundled. Place the three Parquet files in <code>.local/fuelcast/data</code>, install <code>scripts/requirements-fuelcast.txt</code>, then run <code>python3 scripts/fuelcast_model.py train</code>. <button className="btn small" onClick={onRetry} data-testid="button-retry-fuelcast"><RefreshCw size={13}/> Retry</button></div>:<>
        <div className="result-hero">
          <div className="metric primary-metric"><div className="metric-label">Dataset · {status.dataset}</div><div className="metric-value">{status.observationsLoaded==null?'—':fmt(status.observationsLoaded,0)}<span className="metric-unit">observations</span></div></div>
          <div className="metric"><div className="metric-label">Target</div><div className="metric-value" style={{fontSize:15}}>Measured fuel rate<span className="metric-unit">{status.targetUnit}</span></div></div>
          <div className="metric"><div className="metric-label">Vessels</div><div className="metric-value">{status.vesselCount??'—'}</div></div>
          <div className="metric"><div className="metric-label">Model</div><div className="metric-value" style={{fontSize:15}}>{status.modelAvailable?status.model:'Not trained locally'}</div></div>
        </div>
        <div className="assumption" style={{marginTop:12}}><Database size={15}/><span>{fmt(status.observationsUsable,0)} complete observations used · {status.trainingObservations==null?'—':fmt(status.trainingObservations,0)} train · {status.testObservations==null?'—':fmt(status.testObservations,0)} test · {status.features?.join(' · ')}</span></div>
        {status.timeBlockMetrics&&<div className="workspace-grid" style={{marginTop:13}}>
          <Panel title="Time-block validation" caption="Final 20% of each vessel's stored row sequence; no random row split.">
            <div className="profile-facts"><div><div className="fact-label">MAE · kg/s</div><div className="fact-value">{fmt(status.timeBlockMetrics.maeKgPerSecond,4)}</div></div><div><div className="fact-label">RMSE · kg/s</div><div className="fact-value">{fmt(status.timeBlockMetrics.rmseKgPerSecond,4)}</div></div><div><div className="fact-label">R²</div><div className="fact-value">{fmt(status.timeBlockMetrics.r2,4)}</div></div><div><div className="fact-label">MAPE</div><div className="fact-value">{status.timeBlockMetrics.mapePercent==null?'N/A':`${fmt(status.timeBlockMetrics.mapePercent,2)}%`}</div></div></div>
            {status.timeBlocks&&<div className="table-wrap" style={{marginTop:12}}><table><thead><tr><th>Vessel / ordered block</th><th>Rows</th><th>MAE · kg/s</th><th>RMSE · kg/s</th><th>R²</th></tr></thead><tbody>{status.timeBlocks.map(block=><tr key={block.vessel}><td>{block.vessel}<div className="helper">Source rows {fmt(block.sourceOrderStart,0)}–{fmt(block.sourceOrderEnd,0)}</div></td><td>{fmt(block.observations,0)}</td><td>{fmt(block.maeKgPerSecond,4)}</td><td>{fmt(block.rmseKgPerSecond,4)}</td><td>{fmt(block.r2,4)}</td></tr>)}</tbody></table></div>}
          </Panel>
          {status.unseenVesselMetrics&&<Panel title="Unseen-vessel validation" caption="Each fold trains on two vessels and tests on the third.">
            <div className="profile-facts"><div><div className="fact-label">MAE · kg/s</div><div className="fact-value">{fmt(status.unseenVesselMetrics.maeKgPerSecond,4)}</div></div><div><div className="fact-label">RMSE · kg/s</div><div className="fact-value">{fmt(status.unseenVesselMetrics.rmseKgPerSecond,4)}</div></div><div><div className="fact-label">R²</div><div className="fact-value">{fmt(status.unseenVesselMetrics.r2,4)}</div></div></div>
            {status.unseenVesselFolds&&<div className="table-wrap" style={{marginTop:12}}><table><thead><tr><th>Held-out vessel</th><th>Train / test</th><th>MAE · kg/s</th><th>RMSE · kg/s</th><th>R²</th></tr></thead><tbody>{status.unseenVesselFolds.map(fold=><tr key={fold.heldOutVessel}><td>{fold.heldOutVessel}</td><td>{fmt(fold.trainingObservations,0)} / {fmt(fold.testObservations,0)}</td><td>{fmt(fold.maeKgPerSecond,4)}</td><td>{fmt(fold.rmseKgPerSecond,4)}</td><td>{fmt(fold.r2,4)}</td></tr>)}</tbody></table></div>}
          </Panel>}
        </div>}
        <div className="notice" style={{marginTop:13}}><strong>Physics baseline comparison: {status.physicsBaselineStatus}.</strong> {status.physicsBaselineReason}</div>
        {status.limitations?.map((limitation,index)=><div className="helper" key={index} style={{marginTop:5}}>· {limitation}</div>)}
      </>}
    </Panel>
  </div>;
}
function ResultView({result,scenario,onCsv}: {result:OptimizationResponse;scenario:OptimizeInput|null;onCsv:()=>void}) {
  const plan=result.recommendedPlan;
  const conv=result.benchmarkResults.flatMap(b=>b.convergence.map(c=>({algorithm:b.algorithm,...c})));
  const maxCost=Math.max(...result.paretoFront.map(p=>p.totalCostInr),1);
  const maxEmissions=Math.max(...result.paretoFront.map(p=>p.wellToWakeKgCo2e),1);
  return <section style={{marginTop:20}} data-testid="content-optimization-results">
    <div className="page-heading" style={{marginBottom:12}}><div><div className="eyebrow">OPTIMIZER RESPONSE / TRACEABLE RESULT</div><h2 className="card-title" style={{fontSize:19}}>Comparison results · {result.vessel.name}</h2></div><div className="actions"><button className="btn small" onClick={onCsv} data-testid="button-export-csv"><ArrowDownToLine size={14}/> Export Pareto CSV</button><DownloadButton data={{scenario,sourceDetails:{vessel:{id:result.vessel.id,name:result.vessel.name,sourceName:result.vessel.sourceName,sourceUrl:result.vessel.sourceUrl}},results:result}} filename="voyage-optimization.json"/></div></div>
    {result.warnings.length>0&&<div className="notice" style={{marginBottom:13}}><strong>Optimizer warnings</strong><ul style={{margin:'5px 0 0',paddingLeft:18}}>{result.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></div>}
    <div className="result-hero">
      <div className="metric primary-metric"><div className="metric-label">Selected plan · {plan.fuelName}</div><div className="metric-value">{fmt(plan.speedKnots)}<span className="metric-unit">kn</span></div></div>
      <div className="metric"><div className="metric-label">Total voyage cost · ₹/voyage</div><div className="metric-value">₹{fmt(plan.totalCostInr,0)}</div></div>
      <div className="metric"><div className="metric-label">Fuel rate · kg/s</div><div className="metric-value">{fmt(plan.fuelRateKgPerSecond,4)}</div></div>
      <div className="metric"><div className="metric-label">Well-to-wake</div><div className="metric-value">{fmt(plan.wellToWakeKgCo2e/1000)}<span className="metric-unit">tCO₂e</span></div></div>
      <div className="metric"><div className="metric-label">Duration</div><div className="metric-value">{fmt(plan.durationHours)}<span className="metric-unit">hours</span></div></div>
    </div>
    <div className="assumption" style={{marginTop:10}}><Gauge size={15}/><span>Fuel estimate: <strong>{plan.fuelEstimator}</strong>. FuelCast rate is integrated over sailing time; fuel price, density and voyage constraints remain separate scenario inputs.</span></div>
    <div className="workspace-grid" style={{marginTop:15}}>
      <Panel title="Pareto comparison" caption="Non-dominated alternatives returned by the optimizer.">
        {result.paretoFront.length===0?<div className="empty-state"><h3>No Pareto points returned</h3><p>The optimizer returned no comparison points for this scenario.</p></div>:<div className="table-wrap"><table data-testid="table-pareto"><thead><tr><th>Fuel / speed</th><th>Cost · ₹/voyage</th><th>Rate · kg/s</th><th>WTW · kg CO₂e</th><th>TTW · kg CO₂e</th><th>Duration · h</th><th>Fuel · t</th><th>Feasible</th></tr></thead><tbody>{result.paretoFront.map((p,i)=><tr key={`${p.fuelId}-${p.speedKnots}-${i}`} data-testid={`row-pareto-${i}`}><td><strong>{p.fuelName}</strong><div className="helper">{fmt(p.speedKnots)} kn · {fmt(p.engineLoadFraction*100)}% load</div></td><td className="mono">{fmt(p.totalCostInr,0)}</td><td className="mono">{fmt(p.fuelRateKgPerSecond,4)}</td><td className="mono">{fmt(p.wellToWakeKgCo2e,0)}</td><td className="mono">{fmt(p.tankToWakeKgCo2e,0)}</td><td className="mono">{fmt(p.durationHours)}</td><td className="mono">{fmt(p.fuelMassTonnes,2)}</td><td><span className="pill">{p.feasible?'Feasible':'Infeasible'}</span></td></tr>)}</tbody></table></div>}
      </Panel>
      <div className="stack">
        <Panel title="Decision frontier" caption="Cost and lifecycle emissions for each returned option.">
          {result.paretoFront.length ? <div className="bars">{result.paretoFront.map((p,i)=><div className="bar-row" key={i}><span>{p.fuelName} · {fmt(p.speedKnots)} kn</span><div><div className="bar-track" title={`Cost ${fmt(p.totalCostInr,0)} ₹/voyage`}><div className="bar-fill warm" style={{width:`${Math.max(2,p.totalCostInr/maxCost*100)}%`}}/></div><div className="bar-track" style={{marginTop:5}} title={`Emissions ${fmt(p.wellToWakeKgCo2e,0)} kg`}><div className="bar-fill green" style={{width:`${Math.max(2,p.wellToWakeKgCo2e/maxEmissions*100)}%`}}/></div></div><span className="mono">{fmt(p.durationHours)} h</span></div>)}</div>:<div className="empty-state">No comparison data.</div>}
          <div className="helper" style={{marginTop:13}}>Amber = relative cost · green = relative well-to-wake emissions. Bars are scaled to returned points.</div>
        </Panel>
        <Panel title="Convergence" caption="Benchmark algorithm progress returned by the optimizer.">
          {conv.length===0?<div className="empty-state"><h3>No convergence trace</h3><p>The response contains no iteration history.</p></div>:<div className="table-wrap"><table data-testid="table-convergence"><thead><tr><th>Algorithm</th><th>Iteration</th><th>Best cost · ₹/voyage</th><th>Best WTW · kg</th><th>Best duration · h</th></tr></thead><tbody>{conv.map((c,i)=><tr key={`${c.algorithm}-${c.iteration}-${i}`}><td>{c.algorithm}</td><td className="mono">{c.iteration}</td><td className="mono">{fmt(c.bestCostInr,0)}</td><td className="mono">{fmt(c.bestWellToWakeKgCo2e,0)}</td><td className="mono">{fmt(c.bestDurationHours)}</td></tr>)}</tbody></table></div>}
        </Panel>
      </div>
    </div>
    <div className="card" style={{marginTop:15}}><div className="card-head"><div><h2 className="card-title">Benchmark runs</h2><div className="card-caption">Optimizer runtime and convergence metrics from this request.</div></div></div><div className="table-wrap"><table><thead><tr><th>Algorithm</th><th>Runtime · s</th><th>Evaluations</th><th>Iterations</th><th>Pareto hypervolume</th></tr></thead><tbody>{result.benchmarkResults.map((b,i)=><tr key={i}><td>{b.algorithm}</td><td className="mono">{fmt(b.runtimeSeconds,3)}</td><td className="mono">{fmt(b.evaluations,0)}</td><td className="mono">{fmt(b.convergenceIterations,0)}</td><td className="mono">{fmt(b.paretoHypervolume,4)}</td></tr>)}</tbody></table></div></div>
    <div className="assumption" style={{marginTop:12}}><ArrowLeftRight size={15}/>Engine power: {fmt(result.physics.basePowerKw)} kW base · wind {fmt(result.physics.windAddedPowerKw)} kW · waves {fmt(result.physics.waveAddedPowerKw)} kW · adjusted current speed {fmt(result.physics.currentAdjustedSpeedKnots)} kn · draft power factor {fmt(result.physics.draftPowerFactor,3)}. These are response physics values.</div>
  </section>;
}

function Fleet() {
  const query=useListVessels();
  const catalogQuery=useGetMaritimeCatalog();
  const client=useQueryClient();
  const create=useCreateVessel();
  const update=useUpdateVessel();
  const remove=useDeleteVessel();
  const profileForm=useForm<AnyRecord>();
  const [modal,setModal]=useState(false);
  const [editing,setEditing]=useState<Vessel|null>(null);
  const [form,setForm]=useState<AnyRecord>(blankProfile());
  const [compatible,setCompatible]=useState<string[]>([]);
  const [sfoc,setSfoc]=useState<{loadFraction:string;gramsPerKwh:string}[]>([]);
  const [formError,setFormError]=useState('');
  const [mutationError,setMutationError]=useState('');
  const vessels=query.data??[];
  const openCreate=()=>{setEditing(null);const empty=blankProfile();setForm(empty);profileForm.reset(empty);setCompatible([]);setSfoc([]);setFormError('');setMutationError('');setModal(true);};
  const openEdit=(v:Vessel)=>{setEditing(v);const profile={...Object.fromEntries(Object.keys(blankProfile()).map(k=>[k,String((v as unknown as Record<string,unknown>)[k]??'')])),fuelTankVolumesM3:JSON.stringify(v.fuelTankVolumesM3),alternativeFuelWeightPenaltyTonnes:JSON.stringify(v.alternativeFuelWeightPenaltyTonnes)};setForm(profile);profileForm.reset(profile);setCompatible([...v.fuelCompatibility]);setSfoc(v.sfocCurve.map(p=>({loadFraction:String(p.loadFraction),gramsPerKwh:String(p.gramsPerKwh)})));setFormError('');setMutationError('');setModal(true);};
  const close=()=>{if(create.isPending||update.isPending)return;setModal(false);};
  const commit=()=>{setFormError('');setMutationError('');
    try {
      if(compatible.length===0)throw new Error('Choose at least one compatible catalog fuel.');
      if(sfoc.length<2)throw new Error('Enter at least two SFOC curve points.');
      const tanks=JSON.parse(form.fuelTankVolumesM3||'{}');
      const penalties=JSON.parse(form.alternativeFuelWeightPenaltyTonnes||'{}');
      const input:VesselInput={
        name:form.name,vesselClass:form.vesselClass as VesselInput['vesselClass'],
        deadweightTonnes:Number(form.deadweightTonnes),lightshipTonnes:Number(form.lightshipTonnes),cargoCapacityTonnes:Number(form.cargoCapacityTonnes),
        designServiceSpeedKnots:Number(form.designServiceSpeedKnots),maxSpeedKnots:Number(form.maxSpeedKnots),maxEnginePowerKw:Number(form.maxEnginePowerKw),engineEfficiency:Number(form.engineEfficiency),
        sfocCurve:sfoc.map(p=>({loadFraction:Number(p.loadFraction),gramsPerKwh:Number(p.gramsPerKwh)})),blockCoefficient:Number(form.blockCoefficient),
        lengthOverallM:Number(form.lengthOverallM),beamM:Number(form.beamM),designDraftM:Number(form.designDraftM),fuelCompatibility:compatible,
        fuelTankVolumesM3:tanks,alternativeFuelWeightPenaltyTonnes:penalties,windageAreaM2:Number(form.windageAreaM2),windDragCoefficient:Number(form.windDragCoefficient),
        sourceName:form.sourceName,sourceUrl:form.sourceUrl||'',
      };
      const onSuccess=()=>{client.invalidateQueries({queryKey:getListVesselsQueryKey()});setModal(false);};
      if(editing)update.mutate({vesselId:editing.id,data:input},{onSuccess,onError:()=>setMutationError('Profile update failed. Your edits remain available; retry when the service is available.')});
      else create.mutate({data:input},{onSuccess,onError:()=>setMutationError('Profile could not be saved. Your entered data remains available; retry when the service is available.')});
    }catch(err){setFormError(err instanceof Error?err.message:'Check the profile fields and JSON maps.');}
  };
  const removeVessel=(v:Vessel)=>{if(window.confirm(`Delete vessel profile “${v.name}”? This cannot be undone.`)){setMutationError('');remove.mutate({vesselId:v.id},{onSuccess:()=>client.invalidateQueries({queryKey:getListVesselsQueryKey()}),onError:()=>setMutationError(`Could not delete ${v.name}. Retry when the service is available.`)});}};
  return <main className="page">
    <div className="page-heading"><div><div className="eyebrow">FLEET DATA / SOURCE REGISTER</div><h1>Vessel profiles</h1><p className="page-intro">Manage the particulars and source citations behind every planning result.</p></div><button className="btn primary" onClick={openCreate} data-testid="button-create-vessel"><FilePlus2 size={15}/>Add vessel profile</button></div>
    <div className="notice" style={{marginBottom:17}}><strong>Source discipline.</strong> Only operator-entered vessel information is stored here. Cite a specification, survey or other source for each profile; optimizer results remain traceable to that record.</div>
    {mutationError&&<div className="error-box" role="alert" data-testid="status-fleet-mutation-error" style={{marginBottom:14}}>{mutationError}</div>}
    {catalogQuery.isLoading||query.isLoading?<Panel title="Loading fleet register"><LoadingBlock/></Panel>:catalogQuery.isError||query.isError?<div className="error-box" role="alert" data-testid="status-fleet-error">Vessel profiles could not be loaded. <button className="btn small" onClick={()=>{query.refetch();catalogQuery.refetch();}} data-testid="button-retry-fleet"><RefreshCw size={13}/>Retry</button></div>:
      vessels.length===0?<div className="card"><div className="empty-state"><div className="empty-symbol"><Ship size={19}/></div><h3>No saved vessel profiles</h3><p>Create the first record from verified vessel particulars. There are no example records in this fleet register.</p><button className="btn primary" onClick={openCreate} data-testid="button-create-empty-vessel"><Plus size={14}/>Create vessel profile</button></div></div>:
        <div className="profile-grid" data-testid="list-vessel-profiles">{vessels.map(v=><article className="profile" key={v.id} data-testid={`card-vessel-${v.id}`}>
          <div className="profile-top"><div><h3>{v.name}</h3><div className="profile-class">{prettyClass(v.vesselClass)} · ID {v.id}</div></div><span className="status">Source cited</span></div>
          <div className="profile-facts"><div><div className="fact-label">Deadweight</div><div className="fact-value">{fmt(v.deadweightTonnes,0)} t</div></div><div><div className="fact-label">Design speed</div><div className="fact-value">{fmt(v.designServiceSpeedKnots)} kn</div></div><div><div className="fact-label">Engine max</div><div className="fact-value">{fmt(v.maxEnginePowerKw,0)} kW</div></div></div>
          <div className="source-line">SOURCE · {v.sourceName}{v.sourceUrl&&<> · <a href={v.sourceUrl} target="_blank" rel="noreferrer">{v.sourceUrl}</a></>}</div>
          <div className="actions"><button className="btn small" onClick={()=>openEdit(v)} data-testid={`button-edit-vessel-${v.id}`}>Edit profile</button><button className="btn small danger" onClick={()=>removeVessel(v)} disabled={remove.isPending} data-testid={`button-delete-vessel-${v.id}`}><Trash2 size={13}/>Delete</button><span className="helper" style={{marginLeft:'auto'}}>Updated {new Date(v.updatedAt).toLocaleDateString()}</span></div>
        </article>)}</div>}
    {modal&&<div className="modal-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)close();}}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="vessel-modal-title">
      <div className="modal-head"><div><div className="eyebrow" style={{marginBottom:4}}>FLEET DATA / {editing?'EDIT RECORD':'NEW RECORD'}</div><h2 id="vessel-modal-title" className="card-title">{editing?'Edit vessel profile':'Add vessel profile'}</h2></div><button className="btn small" onClick={close} aria-label="Close profile form" data-testid="button-close-vessel-form"><X size={15}/></button></div>
      <Form {...profileForm}><form className="modal-body" onSubmit={profileForm.handleSubmit(commit)}>
        <div className="form-section"><h3>Identity & source citation</h3><div className="field-grid"><Field testId="input-vessel-name" label="Vessel name" type="text" value={form.name} onChange={v=>setForm(p=>({...p,name:v}))} required placeholder="Enter registered vessel name"/><div className="field"><label htmlFor="vessel-class">Vessel class</label><select id="vessel-class" data-testid="select-vessel-class" {...profileForm.register('vesselClass',{required:true})} value={form.vesselClass} onChange={e=>{profileForm.register('vesselClass').onChange(e);setForm(p=>({...p,vesselClass:e.target.value}));}} required><option value="">Select class</option>{(catalogQuery.data?.vesselClasses??[]).map(c=><option key={c} value={c}>{prettyClass(c)}</option>)}</select></div><Field testId="input-source-name" label="Source name / document" type="text" value={form.sourceName} onChange={v=>setForm(p=>({...p,sourceName:v}))} required placeholder="Source title, issuer or survey"/><Field testId="input-source-url" label="Source URL" type="url" value={form.sourceUrl} onChange={v=>setForm(p=>({...p,sourceUrl:v}))} placeholder="https://..."/></div></div>
        <div className="form-section"><h3>Principal particulars & performance</h3><div className="field-grid three">{numberFields.map(([key,label,unit])=><Field key={key} testId={`input-profile-${key}`} label={label} unit={unit} value={form[key]??''} onChange={v=>setForm(p=>({...p,[key]:v}))} required min=".001" step="any"/>)}</div></div>
        <div className="form-section"><h3>SFOC curve</h3><div className="helper">Enter source-backed load fraction and specific fuel consumption points. At least two points are required.</div>
          {sfoc.map((p,i)=><div className="sfoc-row" key={i}><Field testId={`input-sfoc-load-${i}`} label={`Point ${i+1} · load fraction`} value={p.loadFraction} onChange={v=>setSfoc(rows=>rows.map((r,j)=>j===i?{...r,loadFraction:v}:r))} required min=".1" max="1"/><Field testId={`input-sfoc-grams-${i}`} label="SFOC · g/kWh" value={p.gramsPerKwh} onChange={v=>setSfoc(rows=>rows.map((r,j)=>j===i?{...r,gramsPerKwh:v}:r))} required min=".001" step="any"/><button type="button" className="btn small danger" onClick={()=>setSfoc(rows=>rows.filter((_,j)=>j!==i))} data-testid={`button-remove-sfoc-${i}`} aria-label={`Remove SFOC point ${i+1}`}><Trash2 size={13}/></button></div>)}
          <button type="button" className="btn small" onClick={()=>setSfoc(rows=>[...rows,{loadFraction:'',gramsPerKwh:''}])} data-testid="button-add-sfoc"><Plus size={13}/>Add SFOC point</button>
        </div>
        <div className="form-section"><h3>Fuel compatibility & storage</h3><div className="field-grid"><div className="field"><label>Compatible fuels</label>{catalogQuery.data?.fuels.map(f=>{const name=`fuelCompatibility.${f.fuelId}`;const registration=profileForm.register(name);return <label key={f.fuelId} style={{display:'flex',alignItems:'center',gap:8,margin:'8px 0',fontFamily:'var(--app-font-sans)',fontSize:12}}><input data-testid={`checkbox-compatible-${f.fuelId}`} type="checkbox" name={registration.name} ref={registration.ref} onBlur={registration.onBlur} checked={compatible.includes(f.fuelId)} onChange={e=>{registration.onChange(e);setCompatible(s=>e.target.checked?[...s,f.fuelId]:s.filter(x=>x!==f.fuelId));}}/>{f.name} <span className="helper">({f.fuelId})</span></label>;})}</div><div className="field"><label htmlFor="fuel-tanks">Fuel tank volumes · JSON by fuel ID</label><textarea id="fuel-tanks" data-testid="input-fuel-tank-volumes" {...profileForm.register('fuelTankVolumesM3')} rows={4} value={form.fuelTankVolumesM3??''} onChange={e=>{profileForm.register('fuelTankVolumesM3').onChange(e);setForm(p=>({...p,fuelTankVolumesM3:e.target.value}));}} placeholder={'{"fuel-id": 0}'} /><div className="helper">Map fuel ID to m³; provide values from the vessel source.</div></div><div className="field"><label htmlFor="fuel-penalty">Alternative fuel weight penalties · JSON by fuel ID</label><textarea id="fuel-penalty" data-testid="input-alternative-fuel-penalty" {...profileForm.register('alternativeFuelWeightPenaltyTonnes')} rows={3} value={form.alternativeFuelWeightPenaltyTonnes??''} onChange={e=>{profileForm.register('alternativeFuelWeightPenaltyTonnes').onChange(e);setForm(p=>({...p,alternativeFuelWeightPenaltyTonnes:e.target.value}));}} placeholder={'{"fuel-id": 0}'} /></div></div></div>
        <div className="form-section"><h3>Windage & provenance notice</h3><div className="notice">{catalogQuery.data?.provenanceNotice||'Catalog provenance notice unavailable.'}</div></div>
        {formError&&<div className="error-box" role="alert" data-testid="status-vessel-form-error" style={{marginBottom:12}}>{formError}</div>}
        {mutationError&&<div className="error-box" role="alert" data-testid="status-vessel-save-error" style={{marginBottom:12}}>{mutationError}</div>}
        <div className="actions" style={{justifyContent:'flex-end',borderTop:'1px solid #dce4df',paddingTop:16}}><button type="button" className="btn" onClick={close} data-testid="button-cancel-vessel">Cancel</button><button className="btn primary" type="submit" disabled={create.isPending||update.isPending} data-testid="button-save-vessel">{create.isPending||update.isPending?<><LoaderCircle size={14}/>Saving</>:<><Check size={14}/>{editing?'Save changes':'Save vessel profile'}</>}</button></div>
      </form></Form>
    </section></div>}
  </main>;
}
function Router() {
  const [location]=useLocation();
  return <ErrorBoundary resetKey={location}><AppShell><Switch><Route path="/" component={Workspace}/><Route path="/fleet" component={Fleet}/><Route component={NotFound}/></Switch></AppShell></ErrorBoundary>;
}
function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/,'')}><Router/></WouterRouter><Toaster/></TooltipProvider></QueryClientProvider>;
}
export default App;