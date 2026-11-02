/** Pure portable archive validation, shared with the browser. No D1 or keys. */
import {reportSnapshot,type LifeReportPreview} from './life-report';
import {reportDigest} from './report-analysis-format';
import {reportCheckinArchiveValue,type ReportCheckinArchive} from './report-checkin-format';
export type ReportArchiveParent={id:number;ownerId:number;snapshotJson:string;snapshotSha256:string};
export type ReportCheckinBackupRow={reportId:number;ownerId:number;reportSha256:string;archive:ReportCheckinArchive};
export async function reportArchiveParentValue(owner:number,parent:ReportArchiveParent){if(parent.ownerId!==owner||typeof parent.snapshotJson!=='string'||await reportDigest(parent.snapshotJson)!==parent.snapshotSha256)throw Error('Report archive parent mismatch');return reportSnapshot(owner,JSON.parse(parent.snapshotJson) as LifeReportPreview);}
/** Archives cannot contain source HMACs, eligible flags, claims or queue keys. */
export async function validateReportCheckinArchives(rows:unknown[],reports:unknown[],owner:number){
 const parents=new Map(reports.map(r=>{const p=r as ReportArchiveParent;return [p.id,p];})),seen=new Set<number>();
 for(const entry of rows){if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('Invalid report archive');const r=entry as ReportCheckinBackupRow,parent=parents.get(r.reportId);if(Object.keys(r).sort().join(',')!=='archive,ownerId,reportId,reportSha256'||r.ownerId!==owner||!parent||seen.has(r.reportId)||r.reportSha256!==parent.snapshotSha256)throw Error('Invalid report archive binding');seen.add(r.reportId);reportCheckinArchiveValue(r.archive,await reportArchiveParentValue(owner,parent));}
}
