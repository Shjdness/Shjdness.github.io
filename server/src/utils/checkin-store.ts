import type {D1Database} from '@cloudflare/workers-types';
import {checkinDate,checkinKey,checkinValue,shanghaiDate} from './checkin-format';
import type {CheckinVault} from './checkin-vault';
import {reserveReportWrite} from './report-settings';
import {checkinKeyGuard} from './checkin-key-guard';
type Row={record_date:string;revision:number;sealed_json:string;content_hmac:string;client_key:string;updated_at:number};
export async function readCheckin(db:D1Database,vault:CheckinVault,owner:number,date:string){
  const rows=await db.prepare('SELECT * FROM life_checkins WHERE owner_id=? AND record_date=?').bind(owner,checkinDate(date)).all<Row>();if(!rows.success)throw Error('Check-in read unavailable');const r=rows.results[0];return r?{date,revision:r.revision,updatedAt:r.updated_at,value:await vault.open(owner,date,r.revision,r.sealed_json)}:null;
}
export async function saveCheckin(db:D1Database,vault:CheckinVault,owner:number,date:string,input:{baseRevision:number;clientKey:string;value:unknown},now=Date.now()){
  checkinDate(date);checkinKey(input.clientKey);if(date>shanghaiDate(now)||!Number.isSafeInteger(input.baseRevision)||input.baseRevision<0)throw Error('Invalid check-in date or revision');
  const value=checkinValue(input.value,date),digest=await vault.digest(owner,date,value);
  await checkinKeyGuard(db,vault,true);
  const rows=await db.prepare('SELECT * FROM life_checkins WHERE owner_id=? AND record_date=?').bind(owner,date).all<Row>();if(!rows.success)throw Error('Check-in read unavailable');const current=rows.results[0];
  // A syntactically valid but wrong replacement Secret must never overwrite an
  // unreadable existing record, even with a caller-supplied current revision.
  if(current)await vault.open(owner,date,current.revision,current.sealed_json);
  if(current?.content_hmac===digest)return {saved:true,revision:current.revision};
  // A retry from a lost response must not overwrite a subsequent device edit.
  if((current?.revision??0)!==input.baseRevision||current?.client_key===input.clientKey)return {saved:false,reason:'conflict' as const};
  if(!await reserveReportWrite(db))return {saved:false,reason:'budget' as const};
  const revision=input.baseRevision+1,sealed=await vault.seal(owner,date,revision,value);
  const result=current
    ?await db.prepare('UPDATE life_checkins SET revision=?,client_key=?,sealed_json=?,content_hmac=?,updated_at=? WHERE owner_id=? AND record_date=? AND revision=? RETURNING revision').bind(revision,input.clientKey,sealed,digest,Math.floor(now/1000),owner,date,input.baseRevision).all<{revision:number}>()
    :await db.prepare('INSERT INTO life_checkins(owner_id,record_date,revision,client_key,sealed_json,content_hmac,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner_id,record_date) DO NOTHING RETURNING revision').bind(owner,date,revision,input.clientKey,sealed,digest,Math.floor(now/1000)).all<{revision:number}>();
  if(!result.success)throw Error('Check-in save unconfirmed');
  if(result.results.length)return {saved:true,revision};
  const latest=await db.prepare('SELECT revision,content_hmac FROM life_checkins WHERE owner_id=? AND record_date=?').bind(owner,date).all<Row>();if(!latest.success)throw Error('Check-in verification unavailable');return latest.results[0]?.content_hmac===digest?{saved:true,revision:latest.results[0].revision}:{saved:false,reason:'conflict' as const};
}
