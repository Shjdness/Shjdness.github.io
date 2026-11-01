export type ReportAIJobGuard={jobKey:string;consentedAt:number;ownerId:number;reportId:number;seconds:number};
/** Rechecked in both durable claim and monthly admission transactions. */
export const reportAIJobGuardSQL=`EXISTS(SELECT 1 FROM life_report_jobs j
  JOIN life_report_preferences p ON p.owner_id=j.owner_id AND p.ai_enabled=1
  JOIN life_report_ai_consent c ON c.owner_id=j.owner_id AND c.scope_version=1
  JOIN users u ON u.id=j.owner_id AND u.permission=1 AND (u.access_expires_at IS NULL OR u.access_expires_at>?)
  WHERE j.job_key=? AND j.owner_id=? AND j.report_id=? AND j.state='ready' AND c.enabled_at=? AND c.enabled_at<=j.anchor_at
  AND j.anchor_at>=? AND j.anchor_at<=? AND ((j.kind='daily' AND p.daily_enabled=1) OR (j.kind='weekly' AND p.weekly_enabled=1)) AND (j.include_daily=0 OR p.daily_enabled=1))`;
export function reportAIJobGuardValues(g:ReportAIJobGuard){
  if(!/^[a-f0-9]{64}$/.test(g.jobKey)||![g.consentedAt,g.ownerId,g.reportId,g.seconds].every(Number.isSafeInteger)||g.ownerId<1||g.reportId<1||g.consentedAt<0||g.seconds<0)throw Error('Invalid automatic AI proof');
  return [g.seconds,g.jobKey,g.ownerId,g.reportId,g.consentedAt,g.seconds-86400,g.seconds];
}
