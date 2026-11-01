import type {D1Database} from '@cloudflare/workers-types';
import type {LifeReportPreview} from './life-report';

const DAY=86400000,OFFSET=8*3600000;
/** Strict projection prevents new caller fields (e.g. diary text) entering history. */
export function reportSnapshot(ownerId:number,value:LifeReportPreview):LifeReportPreview {
  if(!Number.isSafeInteger(ownerId)||ownerId<=0||value?.ownerId!==ownerId)throw Error('Report owner mismatch');
  const p=value.period;
  const start=Date.parse(p?.start),end=Date.parse(p?.end),generated=Date.parse(value.generatedAt);
  const duration=p?.kind==='daily'?DAY:p?.kind==='weekly'?7*DAY:NaN;
  if(value.version!==1||p?.timezone!=='Asia/Shanghai'||!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(generated)||end-start!==duration||generated<end||(start+OFFSET)%DAY!==0||
    (p.kind==='weekly'&&new Date(start+OFFSET).getUTCDay()!==1)||
    p.fromDate!==new Date(start+OFFSET).toISOString().slice(0,10)||p.toDateExclusive!==new Date(end+OFFSET).toISOString().slice(0,10))throw Error('Invalid report period');
  const counts=[value.achievementsRecorded,value.tasksCompleted,value.ideasCreated,value.habitCompletions,value.daysWithNotes,value.focus?.completedSessions,value.focus?.recordedMinutes,value.focus?.earlySessions];
  if(value.coverage!=='server-synced-only'||value.mode!=='statistics-preview'||value.aiEnabled!==false||value.emailEnabled!==false||counts.some(n=>!Number.isSafeInteger(n)||n<0)||value.tasksCompleted>value.achievementsRecorded||value.focus.earlySessions>value.focus.completedSessions)throw Error('Invalid report facts');
  return {version:1,ownerId,generatedAt:value.generatedAt,
    period:{kind:p.kind,timezone:'Asia/Shanghai',fromDate:p.fromDate,toDateExclusive:p.toDateExclusive,start:p.start,end:p.end},
    coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:value.achievementsRecorded,tasksCompleted:value.tasksCompleted,ideasCreated:value.ideasCreated,
    focus:{completedSessions:value.focus.completedSessions,recordedMinutes:value.focus.recordedMinutes,earlySessions:value.focus.earlySessions},
    habitCompletions:value.habitCompletions,daysWithNotes:value.daysWithNotes,aiEnabled:false,emailEnabled:false};
}

async function hash(text:string){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}

/** Server-internal only. No HTTP write route until backup/recovery is integrated. */
export async function saveReportSnapshot(db:D1Database,ownerId:number,input:LifeReportPreview){
  const snapshot=reportSnapshot(ownerId,input),json=JSON.stringify(snapshot),digest=await hash(json);
  const {period}=snapshot,start=Date.parse(period.start)/1000,end=Date.parse(period.end)/1000;
  const rows=await db.batch<Record<string,unknown>>([
    db.prepare(`INSERT INTO life_reports(owner_id,kind,period_start,period_end,snapshot_json,snapshot_sha256)
      VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,kind,period_start,period_end,template_version) DO NOTHING RETURNING id`).bind(ownerId,period.kind,start,end,json,digest),
    db.prepare('SELECT id,snapshot_json,snapshot_sha256 FROM life_reports WHERE owner_id=? AND kind=? AND period_start=? AND period_end=? AND template_version=1').bind(ownerId,period.kind,start,end),
  ]);
  if(rows.some(row=>!row.success))throw Error('Report save was not confirmed');
  const stored=rows[1]?.results[0];
  if(!stored||typeof stored.id!=='number'||typeof stored.snapshot_json!=='string'||typeof stored.snapshot_sha256!=='string'||await hash(stored.snapshot_json)!==stored.snapshot_sha256)throw Error('Stored report is missing or damaged');
  const report=reportSnapshot(ownerId,JSON.parse(stored.snapshot_json));
  if(report.period.start!==period.start||report.period.end!==period.end||report.period.kind!==period.kind)throw Error('Stored report period mismatch');
  // The first committed snapshot wins. Never silently regenerate a historical report.
  return {id:stored.id,created:rows[0].results.length>0,sha256:stored.snapshot_sha256,report};
}
