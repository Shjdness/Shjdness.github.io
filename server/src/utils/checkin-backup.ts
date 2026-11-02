import {checkinDate,checkinValue,type Checkin} from './checkin-format';
import type {CheckinVault} from './checkin-vault';
export type CheckinBackupRow={ownerId:number;recordDate:string;revision:number;updatedAt:number;record:Checkin};
type SealedRow={ownerId:number;recordDate:string;revision:number;updatedAt:number;sealedJson:string};
/** Export portable facts, not key-dependent ciphertext, request keys or grants.
 * The containing download is encrypted by the user's backup passphrase. */
export async function exportCheckinRows(rows:unknown[],vault:CheckinVault,owner:number){
  const output:CheckinBackupRow[]=[];
  for(const entry of rows){const r=entry as SealedRow;if(!r||r.ownerId!==owner||typeof r.sealedJson!=='string'||!Number.isSafeInteger(r.updatedAt))throw Error('Check-in backup owner mismatch');output.push({ownerId:owner,recordDate:r.recordDate,revision:r.revision,updatedAt:r.updatedAt,record:withoutCheckinGrants(await vault.open(owner,r.recordDate,r.revision,r.sealedJson))});}return output;
}
export function withoutCheckinGrants(v:Checkin):Checkin{return {...v,state:'draft',items:v.items.map(i=>({...i,email:false,ai:false})),meals:v.meals.map(m=>({...m,email:false,ai:false})),sleep:{...v.sleep,email:false,ai:false}};}
export function validateCheckinBackup(rows:unknown[],history:unknown[],owner:number){
  const parse=(value:unknown)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid check-in backup');const r=value as CheckinBackupRow;
    if(Object.keys(r).sort().join(',')!=='ownerId,record,recordDate,revision,updatedAt'||r.ownerId!==owner||!Number.isSafeInteger(r.revision)||r.revision<1||!Number.isSafeInteger(r.updatedAt)||r.updatedAt<0)throw Error('Invalid check-in backup identity');checkinDate(r.recordDate);const record=checkinValue(r.record,r.recordDate);if(JSON.stringify(record)!==JSON.stringify(withoutCheckinGrants(record)))throw Error('Check-in backup must not restore external grants');return r;};
  const latest=new Map<string,CheckinBackupRow>();for(const value of rows){const r=parse(value);if(latest.has(r.recordDate))throw Error('Duplicate check-in backup');latest.set(r.recordDate,r);}
  const seen=new Set<string>(),counts=new Map<string,number>();for(const value of history){const r=parse(value),parent=latest.get(r.recordDate),key=r.recordDate+':'+r.revision;if(!parent||r.revision>parent.revision||seen.has(key))throw Error('Invalid check-in history');seen.add(key);counts.set(r.recordDate,(counts.get(r.recordDate)??0)+1);if(counts.get(r.recordDate)!>10)throw Error('Check-in history exceeds retention');if(r.revision===parent.revision&&JSON.stringify(r)!==JSON.stringify(parent))throw Error('Check-in history disagrees with current');}
  for(const r of latest.values())if(!seen.has(r.recordDate+':'+r.revision))throw Error('Check-in history missing current revision');
}
/** Browser-local copies are a portable section, NOT a SQL table or replay queue. */
export function validateCheckinDraftCopies(rows:unknown[],owner:number){
  if(rows.length>1000)throw Error('Too many check-in draft copies');
  for(const entry of rows){if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('Invalid check-in draft copy');const r=entry as {ownerId:number;recordDate:string;updatedAt:number;record:Checkin};if(Object.keys(r).sort().join(',')!=='ownerId,record,recordDate,updatedAt'||r.ownerId!==owner||!Number.isSafeInteger(r.updatedAt)||r.updatedAt<0)throw Error('Invalid check-in draft owner');checkinDate(r.recordDate);const record=checkinValue(r.record,r.recordDate);if(JSON.stringify(record)!==JSON.stringify(withoutCheckinGrants(record)))throw Error('Draft copy cannot restore outbound grants');}
}
