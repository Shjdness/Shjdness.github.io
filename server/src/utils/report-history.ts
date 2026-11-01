import type {D1Database} from '@cloudflare/workers-types';
import type {LifeReportPreview} from './life-report';

import {reportSnapshot} from './life-report';
export {reportSnapshot} from './life-report';
async function hash(text:string){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}

export async function decodeReportRow(ownerId:number,stored:Record<string,unknown>){
  if(!Number.isSafeInteger(stored.id)||Number(stored.id)<=0||typeof stored.snapshot_json!=='string'||stored.snapshot_json.length>16384||typeof stored.snapshot_sha256!=='string'||await hash(stored.snapshot_json)!==stored.snapshot_sha256)throw Error('Stored report is missing or damaged');
  const report=reportSnapshot(ownerId,JSON.parse(stored.snapshot_json));
  if(('kind' in stored&&stored.kind!==report.period.kind)||('period_start' in stored&&Number(stored.period_start)*1000!==Date.parse(report.period.start))||('period_end' in stored&&Number(stored.period_end)*1000!==Date.parse(report.period.end)))throw Error('Stored report period mismatch');
  return {id:Number(stored.id),sha256:stored.snapshot_sha256,report};
}

export async function findReportForPeriod(db:D1Database,ownerId:number,period:LifeReportPreview['period']){
  const result=await db.prepare('SELECT id,kind,period_start,period_end,snapshot_json,snapshot_sha256 FROM life_reports WHERE owner_id=? AND kind=? AND period_start=? AND period_end=? AND template_version=1').bind(ownerId,period.kind,Date.parse(period.start)/1000,Date.parse(period.end)/1000).all<Record<string,unknown>>();
  if(!result.success)throw Error('Report read failed');
  return result.results[0]?decodeReportRow(ownerId,result.results[0]):null;
}

/** Immutable owner-scoped snapshots; the first committed period always wins. */
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
