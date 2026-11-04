import type {D1Database} from '@cloudflare/workers-types';
import type {CheckinVault} from './checkin-vault';
import {checkinKeyGuard} from './checkin-key-guard';
import {reportSnapshot,type LifeReportPreview,type ReportWindow} from './life-report';
import {reportQueries,reportFromAggregateRows} from './report-data';
import {findReportForPeriod,decodeReportRow} from './report-history';
import {reportDigest} from './report-analysis-format';
import {reportCheckinsValue,reportCheckinArchiveValue,reportRangeFrom,selectedCheckin,type ReportCheckins,type CheckinSourceProof} from './report-checkin-format';
import {reserveReportWrite} from './report-settings';
import {rssCaptureStatement,type RssCaptureStatus} from './rss-daily-cycle';
import {briefFactQueries,briefFactsFromRows,type BriefContext} from './report-brief-data';
import {rssDigestQuery,rssDigestFromRows,type RssDigest} from './report-rss-digest';
import {briefInsertStatement,sealBriefSnapshot} from './report-brief-snapshot';
type Source={record_date:string;revision:number;sealed_json:string;content_hmac:string;updated_at:number};
type Saved={id:number;sha256:string;report:LifeReportPreview};
export type ReportCheckinRow={report_id:number;owner_id:number;report_sha256:string;version:number;outbound_eligible:number;sealed_json:string;content_hmac:string;created_at:number};
function sourcesQuery(db:D1Database,owner:number,from:string,to:string){return db.prepare('SELECT record_date,revision,sealed_json,content_hmac,updated_at FROM life_checkins WHERE owner_id=? AND record_date>=? AND record_date<? ORDER BY record_date LIMIT 8').bind(owner,from,to);}
/** Included in the SAME atomic claim/admission SQL as external work. A changed
 * record, withdrawn flag, restore, deletion, or newly added day fails closed. */
export function checkinSourceGuard(owner:number,from:string,to:string,sources:CheckinSourceProof[]){
 if(!Number.isSafeInteger(owner)||owner<1||!Array.isArray(sources)||sources.length>7||Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')!==7*86400000||sources.some(s=>typeof s.date!=='string'||s.date<from||s.date>=to||!Number.isSafeInteger(s.revision)||s.revision<1||! /^[A-Za-z0-9+/]{43}=$/.test(s.hmac)))throw Error('Invalid check-in source guard');
 const clauses=sources.map(()=>'(record_date=? AND revision=? AND content_hmac=?)').join(' OR ');
 return {sql:`((SELECT COUNT(*) FROM life_checkins WHERE owner_id=? AND record_date>=? AND record_date<?)=? ${sources.length?'AND NOT EXISTS(SELECT 1 FROM life_checkins WHERE owner_id=? AND record_date>=? AND record_date<? AND NOT ('+clauses+'))':''})`,args:[owner,from,to,sources.length,...(sources.length?[owner,from,to,...sources.flatMap(s=>[s.date,s.revision,s.hmac])]:[])]};
}
export async function decodeReportCheckins(vault:CheckinVault,owner:number,saved:Saved,row:ReportCheckinRow){
 if(saved.report.ownerId!==owner||row.owner_id!==owner||row.report_id!==saved.id||row.version!==1||row.report_sha256!==saved.sha256||![0,1].includes(row.outbound_eligible)||!Number.isSafeInteger(row.created_at)||row.created_at*1000<Date.parse(saved.report.generatedAt)-1000)throw Error('Report extension binding mismatch');
 const payload=await vault.openPayload(owner,'report-snapshot',saved.sha256,row.sealed_json);
 const value=row.outbound_eligible===0&&Boolean((payload as {archiveOnly?:unknown})?.archiveOnly)?reportCheckinArchiveValue(payload,saved.report):reportCheckinsValue(payload,saved.report);
 if(await vault.payloadDigest(owner,'report-snapshot',saved.sha256,value)!==row.content_hmac)throw Error('Report extension authentication failed');return value;
}
export async function readReportCheckins(db:D1Database,vault:CheckinVault,owner:number,saved:Saved){
 if(saved.report.ownerId!==owner)throw Error('Report owner mismatch');const rows=await db.prepare('SELECT * FROM life_report_checkin_snapshots WHERE owner_id=? AND report_id=?').bind(owner,saved.id).all<ReportCheckinRow>();if(!rows.success)throw Error('Report extension read unavailable');if(!rows.results[0])return null;
 const snapshot=await decodeReportCheckins(vault,owner,saved,rows.results[0]);if(!('sources' in snapshot)||rows.results[0].outbound_eligible!==1)return {snapshot,current:false};const guard=checkinSourceGuard(owner,snapshot.rangeFrom,snapshot.toDateExclusive,snapshot.sources);
 const status=await db.prepare('SELECT 1 AS current WHERE '+guard.sql).bind(...guard.args).all();if(!status.success)throw Error('Report extension scope unavailable');return {snapshot,current:rows.results[0].outbound_eligible===1&&status.results.length===1};
}
/** No attachment/backfill to old report IDs. Numeric facts, source rows, RSS
 * events and selected current tasks come from one D1 read transaction. A guarded
 * second transaction commits BOTH immutable records or NEITHER. */
export async function saveReportWithCheckins(db:D1Database,vault:CheckinVault,owner:number,period:ReportWindow,now=new Date(),rss?:RssCaptureStatus,options:{scheduledFor?:Date}={}):Promise<Saved&{created?:boolean}>{
 const generatedAt=now.toISOString();reportSnapshot(owner,{version:1,ownerId:owner,generatedAt,period,coverage:'server-synced-only',mode:'statistics-preview',achievementsRecorded:0,tasksCompleted:0,ideasCreated:0,focus:{completedSessions:0,recordedMinutes:0,earlySessions:0},habitCompletions:0,daysWithNotes:0,aiEnabled:false,emailEnabled:false});
 const previous=await findReportForPeriod(db,owner,period);if(previous)return previous;
 await checkinKeyGuard(db,vault,true);
 const range=reportRangeFrom({period}),first=await sourcesQuery(db,owner,range,period.toDateExclusive).all<Source>();if(!first.success||first.results.length>7)throw Error('Check-in source unavailable');
 const selectedIds=new Set<number>();for(const r of first.results){const record=await vault.open(owner,r.record_date,r.revision,r.sealed_json);if(record.state==='confirmed')for(const i of record.items)if(i.email&&i.source?.kind==='todo')selectedIds.add(i.source.id);}
 const ids=[...selectedIds],start=Date.parse(period.start)/1000,end=Date.parse(period.end)/1000;
 let briefContext:BriefContext|undefined,briefQueries:ReturnType<typeof briefFactQueries>=[],readingQuery:ReturnType<typeof rssDigestQuery>|undefined;
 if(options.scheduledFor){
  try{const context={owner,period,capturedAt:now,scheduledFor:options.scheduledFor};briefQueries=briefFactQueries(context);briefContext=context;}catch{/* An old recovered occurrence cannot attach today's plans. */}
  if(briefContext){
   try{
    const captureSecond=Math.floor(now.getTime()/1000);
    const prior=await db.prepare(`SELECT MAX(CAST(strftime('%s',json_extract(snapshot_json,'$.generatedAt')) AS INTEGER)) AS at FROM life_reports
      WHERE owner_id=? AND kind='daily' AND created_at>=? AND CAST(strftime('%s',json_extract(snapshot_json,'$.generatedAt')) AS INTEGER)<?`).bind(owner,captureSecond-8*86400,captureSecond).all<{at:number|null}>();
    if(!prior.success)throw Error('RSS interval unavailable');
    const since=prior.results[0]?.at??captureSecond-86400;
    readingQuery=rssDigestQuery(owner,new Date(Math.max(since,captureSecond-8*86400)*1000),now);
   }catch{/* RSS unavailability is preserved as null, never a false zero. */}
  }
 }
 const rows=await db.batch<Record<string,unknown>>([
  ...reportQueries(owner,period).map(q=>db.prepare(q.sql).bind(...q.args)),sourcesQuery(db,owner,range,period.toDateExclusive),
  db.prepare(`SELECT id,deadline_at FROM life_todos WHERE owner_id=? AND completed=0 AND type='task' AND id IN (${ids.length?ids.map(()=>'?').join(','):'NULL'}) ORDER BY deadline_at IS NULL,deadline_at,id LIMIT 3`).bind(owner,...ids),
  db.prepare("SELECT COUNT(*) AS n FROM life_todos WHERE owner_id=? AND type='task' AND completed=0").bind(owner),
  db.prepare('SELECT COALESCE(SUM(CASE WHEN read=1 AND read_at>=? AND read_at<? THEN 1 ELSE 0 END),0) AS marked,COALESCE(SUM(CASE WHEN starred=1 AND starred_at>=? AND starred_at<? THEN 1 ELSE 0 END),0) AS starred FROM rss_items WHERE owner_id=? AND ((read_at>=? AND read_at<?) OR (starred_at>=? AND starred_at<?))').bind(start,end,start,end,owner,start,end,start,end),
  ...briefQueries.map(q=>db.prepare(q.sql).bind(...q.args)),...(readingQuery?[db.prepare(readingQuery.sql).bind(...readingQuery.args)]:[]),
 ]);if(rows.some(r=>!r.success))throw Error('Combined snapshot unavailable');
 const sources=rows[4].results as unknown as Source[];
 if(sources.length!==first.results.length||sources.some((r,i)=>r.record_date!==first.results[i].record_date||r.revision!==first.results[i].revision||r.content_hmac!==first.results[i].content_hmac))throw Error('Check-in source changed; capture again');
 const report=reportFromAggregateRows(owner,period,now,rows.slice(0,4).map(r=>r.results[0] as Record<string,number>)),entries:ReportCheckins['entries']=[],names=new Map<number,string>();
 for(const r of sources){const record=await vault.open(owner,r.record_date,r.revision,r.sealed_json);if(record.state!=='confirmed')continue;const selected=selectedCheckin(record,r.record_date);entries.push({date:r.record_date,revision:r.revision,updatedAt:r.updated_at,record:selected});for(const i of selected.items)if(i.email&&i.source?.kind==='todo')names.set(i.source.id,i.name);}
 const snapshot=reportCheckinsValue({version:1,scopeVersion:2,generatedAt,fromDate:period.fromDate,toDateExclusive:period.toDateExclusive,rangeFrom:range,sources:sources.map(r=>({date:r.record_date,revision:r.revision,hmac:r.content_hmac})),entries,current:{asOf:generatedAt,pendingTasks:rows[6].results[0]?.n,todos:rows[5].results.map(r=>({id:r.id,name:names.get(Number(r.id)),deadlineAt:r.deadline_at}))},reading:{markedRead:rows[7].results[0]?.marked,starred:rows[7].results[0]?.starred}},report);
 const json=JSON.stringify(report),sha=await reportDigest(json),sealed=await vault.sealPayload(owner,'report-snapshot',sha,snapshot),hmac=await vault.payloadDigest(owner,'report-snapshot',sha,snapshot),guard=checkinSourceGuard(owner,range,period.toDateExclusive,snapshot.sources);
 let brief:Awaited<ReturnType<typeof sealBriefSnapshot>>|undefined;
 if(briefContext){
  try{
   const facts=briefFactsFromRows(briefContext,rows.slice(8,8+briefQueries.length).map(r=>r.results));let reading:RssDigest|null=null;
   if(readingQuery){try{reading=rssDigestFromRows(owner,new Date(readingQuery.from),new Date(readingQuery.toExclusive),rows[8+briefQueries.length].results);}catch{/* Bounded overflow uses an explicit unavailable RSS section. */}}
   brief=await sealBriefSnapshot(vault,briefContext,sha,facts,reading,hmac);
  }catch{/* Invalid/oversized detail degrades to the unchanged statistics snapshot. No raw error logged. */}
 }
 if(!await reserveReportWrite(db))throw Error('Report write budget unavailable');
 const committed=await db.batch<Record<string,unknown>>([
  db.prepare(`INSERT INTO life_reports(owner_id,kind,period_start,period_end,snapshot_json,snapshot_sha256) SELECT ?,?,?,?,?,? WHERE ${guard.sql} ON CONFLICT(owner_id,kind,period_start,period_end,template_version) DO NOTHING RETURNING id`).bind(owner,period.kind,start,end,json,sha,...guard.args),
  db.prepare('INSERT INTO life_report_checkin_snapshots(report_id,owner_id,report_sha256,version,outbound_eligible,sealed_json,content_hmac,created_at) SELECT id,owner_id,snapshot_sha256,1,1,?,?,? FROM life_reports WHERE owner_id=? AND kind=? AND period_start=? AND period_end=? AND snapshot_sha256=? AND changes()>0').bind(sealed,hmac,Math.floor(now.getTime()/1000),owner,period.kind,start,end,sha),
  db.prepare('SELECT id,kind,period_start,period_end,snapshot_json,snapshot_sha256 FROM life_reports WHERE owner_id=? AND kind=? AND period_start=? AND period_end=? AND template_version=1').bind(owner,period.kind,start,end),
  ...(brief?[briefInsertStatement(db,owner,report,sha,brief)]:[]),
  ...(rss?[rssCaptureStatement(db,owner,period.kind,start,end,sha,rss)]:[]),
 ]);if(committed.some(r=>!r.success)||!committed[2].results[0])throw Error('Report snapshot not committed');return {...await decodeReportRow(owner,committed[2].results[0]),created:committed[0].results.length===1};
}
