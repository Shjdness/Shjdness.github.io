import type {CheckinVault} from './checkin-vault';
import {decodeBriefRow,type BriefRow} from './report-brief-snapshot';
import {reportArchiveParentValue,type ReportArchiveParent} from './report-checkin-backup-format';
import {reportBriefArchiveValue} from './report-brief-backup-format';
/** Inputs are all from the same export transaction, never a later live lookup. */
export async function exportReportBriefArchives(rows:unknown[],reports:unknown[],extensions:unknown[],vault:CheckinVault,owner:number){
 const parents=new Map(reports.map(r=>{const p=r as ReportArchiveParent;return [p.id,p];})),checkins=new Map(extensions.map(r=>{const e=r as {reportId:number;ownerId:number;contentHmac:string};return [e.reportId,e];})),output=[];
 for(const value of rows){
  const r=value as {reportId:number;ownerId:number;reportSha256:string;version:number;outboundEligible:number;scheduledAt:number;factsSealed:string;factsHmac:string;rssSealed:string|null;rssHmac:string|null;checkinHmac:string;contentHmac:string;createdAt:number},parent=parents.get(r.reportId),selected=checkins.get(r.reportId);
  if(r.ownerId!==owner||!parent||!selected||selected.ownerId!==owner||selected.contentHmac!==r.checkinHmac)throw Error('Brief archive parent mismatch');
  const report=await reportArchiveParentValue(owner,parent),row:BriefRow={report_id:r.reportId,owner_id:r.ownerId,report_sha256:r.reportSha256,version:r.version,outbound_eligible:r.outboundEligible,scheduled_at:r.scheduledAt,facts_sealed:r.factsSealed,facts_hmac:r.factsHmac,rss_sealed:r.rssSealed,rss_hmac:r.rssHmac,checkin_hmac:r.checkinHmac,content_hmac:r.contentHmac,created_at:r.createdAt};
  const decoded=await decodeBriefRow(vault,owner,{id:parent.id,sha256:parent.snapshotSha256,report},row);
  output.push({ownerId:owner,reportId:parent.id,reportSha256:parent.snapshotSha256,archive:reportBriefArchiveValue({version:1,archiveOnly:true,scheduledFor:decoded.facts.scheduledFor,facts:decoded.facts,rss:decoded.rss},owner,report)});
 }
 return output;
}
