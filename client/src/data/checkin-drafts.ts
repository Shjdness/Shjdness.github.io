import type {Checkin} from '../../../server/src/utils/checkin-format';
export type CheckinDraft={value:Checkin;baseRevision:number;clientKey:string;dirty:boolean};
export type CheckinDraftCopy={owner:number;date:string;editor:string;updatedAt:number;draft:CheckinDraft};
/** Separate per-editor copies: one tab must never replace another tab's
 * unsent draft. No migrations, deletes or clears in the existing Life DB. */
function database(){return new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('summer-radio-checkin-drafts',1);r.onupgradeneeded=()=>{const s=r.result.createObjectStore('drafts',{keyPath:['owner','date','editor']});s.createIndex('byDay',['owner','date','updatedAt']);};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
export async function saveCheckinDraft(owner:number,date:string,editor:string,draft:CheckinDraft){
  const db=await database();return new Promise<void>((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put({owner,date,editor,updatedAt:Date.now(),draft} satisfies CheckinDraftCopy);tx.oncomplete=()=>{db.close();resolve();};tx.onabort=tx.onerror=()=>{db.close();reject(Error('Check-in draft not committed'));};});
}
export async function loadCheckinDrafts(owner:number,date:string){
  const db=await database();return new Promise<CheckinDraftCopy[]>((resolve,reject)=>{const tx=db.transaction('drafts','readonly'),rows:CheckinDraftCopy[]=[];const range=IDBKeyRange.bound([owner,date,0],[owner,date,Number.MAX_SAFE_INTEGER]);const request=tx.objectStore('drafts').index('byDay').openCursor(range,'prev');request.onsuccess=()=>{const c=request.result;if(c&&rows.length<20){rows.push(c.value);c.continue();}};tx.oncomplete=()=>{db.close();resolve(rows);};tx.onabort=tx.onerror=()=>{db.close();reject(Error('Check-in drafts unavailable'));};});
}
export async function checkinDraftCopiesForBackup(owner:number){
  const db=await database();return new Promise<CheckinDraftCopy[]>((resolve,reject)=>{const tx=db.transaction('drafts','readonly');const req=tx.objectStore('drafts').index('byDay').getAll(IDBKeyRange.bound([owner],[owner+1],false,true),1001);let rows:CheckinDraftCopy[]=[];req.onsuccess=()=>{rows=req.result;};tx.oncomplete=()=>{db.close();if(rows.length>1000)reject(Error('本机复盘副本超过单份备份范围，请先分批核对；没有删除任何草稿'));else resolve(rows.filter(r=>r.draft.dirty));};tx.onabort=tx.onerror=()=>{db.close();reject(Error('无法读取完整本机复盘草稿，已停止不完整备份'));};});
}
