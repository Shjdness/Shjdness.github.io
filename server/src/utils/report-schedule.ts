import {reportWindow,type ReportKind} from './life-report';

type Schedule={ownerId:number;dailyEnabled:boolean;weeklyEnabled:boolean;dailyTime:string;weeklyTime:string;weeklyDay:number};
export const REPORT_CAPTURE_TIME='05:00';
/** Scheduled snapshots use the previous calendar day/week, not a 05-to-05 day. */
export function reportCaptureReady(now=new Date()){return Number.isFinite(now.getTime())&&new Date(now.getTime()+8*3600000).getUTCHours()>=5;}

/** Pure planner only. The worker must claim a durable occurrence key before
 * generating/sending anything. Does not read records, invoke AI or send mail. */
export function dueReportOccurrence(preferences:Schedule,now=new Date(),options:{captureTime?:string}={}){
  if(typeof preferences.dailyEnabled!=='boolean'||typeof preferences.weeklyEnabled!=='boolean'||!Number.isSafeInteger(preferences.ownerId)||preferences.ownerId<=0||!Number.isFinite(now.getTime())||!Number.isInteger(preferences.weeklyDay)||preferences.weeklyDay<1||preferences.weeklyDay>7||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.dailyTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(preferences.weeklyTime))throw Error('Invalid report schedule');
  const local=new Date(now.getTime()+8*3600000),weekday=local.getUTCDay()||7;
  const weekly=preferences.weeklyEnabled&&weekday===preferences.weeklyDay;
  if(!weekly&&!preferences.dailyEnabled)return null;
  // On the weekly day, hold the daily reminder for one combined delivery at
  // weeklyTime even if dailyTime differs. Never send two reminders that day.
  const kind:ReportKind=weekly?'weekly':'daily',clock=weekly?preferences.weeklyTime:preferences.dailyTime;
  const [hour,minute]=clock.split(':').map(Number);
  const scheduledAt=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),hour-8,minute));
  if(options.captureTime!==undefined&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(options.captureTime))throw Error('Invalid capture time');
  const [captureHour,captureMinute]=(options.captureTime??clock).split(':').map(Number);
  const captureAt=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),captureHour-8,captureMinute));
  if(now.getTime()<captureAt.getTime())return null;
  const period=reportWindow(kind,now);
  // Period-bound, independent of clock edits/restarts. Historical source data
  // is not synthesized for missed earlier dates; a queued job freezes this period.
  return {ownerId:preferences.ownerId,kind,period,scheduledAt:scheduledAt.toISOString(),includeDaily:weekly&&preferences.dailyEnabled,
    occurrenceKey:`report-schedule:v1:${preferences.ownerId}:${kind}:${period.start}:${period.end}`};
}
