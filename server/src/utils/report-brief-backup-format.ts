/** Portable read-only facts. No ciphertext, HMAC, eligibility or consent. */
import {briefFactsValue,type BriefFacts} from './report-brief-data';
import {rssDigestValue,type RssDigest} from './report-rss-digest';
import {reportArchiveParentValue,type ReportArchiveParent} from './report-checkin-backup-format';
import type {LifeReportPreview} from './life-report';
export type ReportBriefArchive={version:1;archiveOnly:true;scheduledFor:string;facts:BriefFacts;rss:RssDigest|null};
export function reportBriefArchiveValue(value:unknown,owner:number,report:LifeReportPreview):ReportBriefArchive{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid brief archive');
 const v=value as ReportBriefArchive;
 if(Object.keys(v).sort().join(',')!=='archiveOnly,facts,rss,scheduledFor,version'||v.version!==1||v.archiveOnly!==true||typeof v.scheduledFor!=='string'||!Number.isFinite(Date.parse(v.scheduledFor))||new Date(v.scheduledFor).toISOString()!==v.scheduledFor||report.ownerId!==owner)throw Error('Invalid brief archive scope');
 const facts=briefFactsValue(v.facts,{owner,period:report.period,capturedAt:new Date(report.generatedAt),scheduledFor:new Date(v.scheduledFor)}),rss=v.rss===null?null:rssDigestValue(v.rss);
 if(rss&&Date.parse(rss.toExclusive)!==Math.floor(Date.parse(report.generatedAt)/1000)*1000)throw Error('Invalid brief archive capture');
 return {version:1,archiveOnly:true,scheduledFor:v.scheduledFor,facts,rss};
}
export async function validateReportBriefArchives(rows:unknown[],reports:unknown[],owner:number){
 const parents=new Map(reports.map(r=>{const p=r as ReportArchiveParent;return [p.id,p];})),seen=new Set<number>();
 for(const value of rows){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid brief backup');const r=value as {ownerId:number;reportId:number;reportSha256:string;archive:ReportBriefArchive},parent=parents.get(r.reportId);
  if(Object.keys(r).sort().join(',')!=='archive,ownerId,reportId,reportSha256'||r.ownerId!==owner||!parent||seen.has(r.reportId)||r.reportSha256!==parent.snapshotSha256)throw Error('Invalid brief backup binding');
  seen.add(r.reportId);reportBriefArchiveValue(r.archive,owner,await reportArchiveParentValue(owner,parent));
 }
}
