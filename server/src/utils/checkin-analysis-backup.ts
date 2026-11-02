import type {CheckinVault} from './checkin-vault';
import {reportArchiveParentValue,type ReportArchiveParent} from './report-checkin-backup-format';
import {decodeReportCheckins,type ReportCheckinRow} from './report-checkin-snapshot';
import {checkinAIAnalysis,checkinAIInput} from './checkin-ai-format';
import type {CheckinAnalysisArchive} from './checkin-analysis-backup-format';
import {reportAIRequestKey} from './report-analysis-format';
/** All arguments are from the SAME backup read transaction. Pending/unknown
 * jobs and spend/consent are deliberately not portable or retryable content. */
export async function exportCheckinAnalysisArchives(rows:unknown[],reports:unknown[],extensions:unknown[],vault:CheckinVault,owner:number){
 const parents=new Map(reports.map(r=>{const p=r as ReportArchiveParent;return [p.id,p];})),sources=new Map(extensions.map(r=>{const p=r as Record<string,unknown>;return [Number(p.reportId),p];})),output:CheckinAnalysisArchive[]=[];
 for(const entry of rows){const r=entry as Record<string,unknown>,parent=parents.get(Number(r.reportId)),e=sources.get(Number(r.reportId));if(!parent||!e||r.ownerId!==owner||r.reportSha256!==parent.snapshotSha256||r.scopeVersion!==2)throw Error('Analysis backup binding mismatch');const key=await reportAIRequestKey({id:parent.id,ownerId:owner,sha256:parent.snapshotSha256});if(r.requestKey!==key||r.snapshotHmac!==e.contentHmac)throw Error('Analysis backup snapshot mismatch');
  if(r.state!=='succeeded'){if(!['pending','unknown','statistics'].includes(String(r.state))||r.sealedJson!==null||r.resultHmac!==null)throw Error('Invalid analysis backup state');continue;}
  if(typeof r.sealedJson!=='string'||typeof r.resultHmac!=='string'||r.reason!==null)throw Error('Invalid analysis backup result');const report=await reportArchiveParentValue(owner,parent),row:ReportCheckinRow={report_id:parent.id,owner_id:owner,report_sha256:String(e.reportSha256),version:Number(e.version),outbound_eligible:Number(e.outboundEligible),sealed_json:String(e.sealedJson),content_hmac:String(e.contentHmac),created_at:Number(e.createdAt)};
  const snapshot=await decodeReportCheckins(vault,owner,{id:parent.id,sha256:parent.snapshotSha256,report},row),analysis=checkinAIAnalysis(await vault.openPayload(owner,'report-analysis',key,r.sealedJson),checkinAIInput(report,snapshot));if(await vault.payloadDigest(owner,'report-analysis',key,analysis)!==r.resultHmac)throw Error('Analysis backup authentication failed');output.push({reportId:parent.id,ownerId:owner,reportSha256:parent.snapshotSha256,scopeVersion:2,archiveOnly:true,analysis});
 }return output;
}
