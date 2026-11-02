import {reportArchiveParentValue,type ReportArchiveParent,type ReportCheckinBackupRow} from './report-checkin-backup-format';
import {checkinAIAnalysis,checkinAIInput,type CheckinAIAnalysis} from './checkin-ai-format';
export type CheckinAnalysisArchive={reportId:number;ownerId:number;reportSha256:string;scopeVersion:2;archiveOnly:true;analysis:CheckinAIAnalysis};
/** Read-only result content, never the operational result ledger. No request
 * key, claim token, scope proof, budget reservation or send authority travels. */
export async function validateCheckinAnalysisArchives(rows:unknown[],reports:unknown[],extensions:unknown[],owner:number){
 const parents=new Map(reports.map(r=>{const p=r as ReportArchiveParent;return [p.id,p];})),snapshots=new Map(extensions.map(r=>{const p=r as ReportCheckinBackupRow;return [p.reportId,p];})),seen=new Set<number>();
 for(const entry of rows){if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('Invalid analysis archive');const r=entry as CheckinAnalysisArchive,parent=parents.get(r.reportId),snapshot=snapshots.get(r.reportId);
  if(Object.keys(r).sort().join(',')!=='analysis,archiveOnly,ownerId,reportId,reportSha256,scopeVersion'||r.ownerId!==owner||r.scopeVersion!==2||r.archiveOnly!==true||!parent||!snapshot||r.reportSha256!==parent.snapshotSha256||snapshot.reportSha256!==r.reportSha256||snapshot.ownerId!==owner||seen.has(r.reportId))throw Error('Analysis archive binding mismatch');seen.add(r.reportId);
  checkinAIAnalysis(r.analysis,checkinAIInput(await reportArchiveParentValue(owner,parent),snapshot.archive));
 }
}
