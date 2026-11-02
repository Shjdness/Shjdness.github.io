import type {CheckinVault} from './checkin-vault';
import {decodeReportCheckins,type ReportCheckinRow} from './report-checkin-snapshot';
import {archiveReportCheckins} from './report-checkin-format';
import {reportArchiveParentValue,type ReportArchiveParent,type ReportCheckinBackupRow} from './report-checkin-backup-format';
export async function exportReportCheckinArchives(rows:unknown[],reports:unknown[],vault:CheckinVault,owner:number){
 const parents=new Map(reports.map(r=>{const p=r as ReportArchiveParent;return [p.id,p];})),output:ReportCheckinBackupRow[]=[];
 for(const entry of rows){const row=entry as Record<string,unknown>,parent=parents.get(Number(row.reportId));if(!parent)throw Error('Report archive parent missing');const report=await reportArchiveParentValue(owner,parent);
  const stored:ReportCheckinRow={report_id:Number(row.reportId),owner_id:Number(row.ownerId),report_sha256:String(row.reportSha256),version:Number(row.version),outbound_eligible:Number(row.outboundEligible),sealed_json:String(row.sealedJson),content_hmac:String(row.contentHmac),created_at:Number(row.createdAt)};
  const snapshot=await decodeReportCheckins(vault,owner,{id:parent.id,sha256:parent.snapshotSha256,report},stored);
  output.push({reportId:parent.id,ownerId:owner,reportSha256:parent.snapshotSha256,archive:'sources' in snapshot?archiveReportCheckins(snapshot,report):snapshot});
 }return output;
}
