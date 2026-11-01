import type {D1Database} from '@cloudflare/workers-types';
export type ReportPreferences={dailyTime:string;weeklyTime:string;weeklyDay:number;revision:number;dailyEnabled:boolean;weeklyEnabled:boolean};
const defaults:ReportPreferences={dailyTime:'08:00',weeklyTime:'08:00',weeklyDay:1,revision:0,dailyEnabled:false,weeklyEnabled:false};

export async function readReportPreferences(db:D1Database,ownerId:number):Promise<ReportPreferences>{
  const result=await db.prepare('SELECT daily_time,weekly_time,weekly_day,revision,daily_enabled,weekly_enabled FROM life_report_preferences WHERE owner_id=?').bind(ownerId).all<{daily_time:string;weekly_time:string;weekly_day:number;revision:number;daily_enabled:number;weekly_enabled:number}>();
  if(!result.success)throw Error('Report preferences unavailable');
  const row=result.results[0];
  return row?{dailyTime:row.daily_time,weeklyTime:row.weekly_time,weeklyDay:row.weekly_day,revision:row.revision,dailyEnabled:row.daily_enabled===1,weeklyEnabled:row.weekly_enabled===1}:{...defaults};
}

export async function reserveReportWrite(db:D1Database){
  const key='reports:'+new Date().toISOString().slice(0,10);
  const result=await db.prepare(`INSERT INTO rss_write_budget(day,reserved) VALUES(?,8)
    ON CONFLICT(day) DO UPDATE SET reserved=reserved+8 WHERE reserved+8<=2000 RETURNING reserved`).bind(key).all();
  if(!result.success)throw Error('Report write budget unavailable');
  return result.results.length>0;
}

export async function updateReportPreferences(db:D1Database,ownerId:number,patch:Pick<ReportPreferences,'dailyTime'|'weeklyTime'|'weeklyDay'>&{baseRevision:number}){
  const current=await readReportPreferences(db,ownerId);
  const equal=(v:ReportPreferences)=>v.dailyTime===patch.dailyTime&&v.weeklyTime===patch.weeklyTime&&v.weeklyDay===patch.weeklyDay;
  if(equal(current))return {saved:true,preferences:current};
  if(current.revision!==patch.baseRevision)return {saved:false,preferences:current};
  if(!await reserveReportWrite(db))return {saved:false,paused:true,preferences:current};
  const result=await db.prepare(`INSERT INTO life_report_preferences(owner_id,daily_time,weekly_time,weekly_day,revision)
    SELECT ?,?,?,?,1 WHERE ?=0 OR EXISTS(SELECT 1 FROM life_report_preferences WHERE owner_id=?)
    ON CONFLICT(owner_id) DO UPDATE SET daily_time=excluded.daily_time,weekly_time=excluded.weekly_time,weekly_day=excluded.weekly_day,revision=revision+1,updated_at=unixepoch()
    WHERE revision=? RETURNING revision`).bind(ownerId,patch.dailyTime,patch.weeklyTime,patch.weeklyDay,patch.baseRevision,ownerId,patch.baseRevision).all();
  if(!result.success)throw Error('Report preferences save unconfirmed');
  const latest=await readReportPreferences(db,ownerId);
  return {saved:equal(latest),preferences:latest};
}


export async function updateReportAutomation(db:D1Database,ownerId:number,patch:{dailyEnabled:boolean;weeklyEnabled:boolean;baseRevision:number}){
  const current=await readReportPreferences(db,ownerId);
  const equal=(p:ReportPreferences)=>p.dailyEnabled===patch.dailyEnabled&&p.weeklyEnabled===patch.weeklyEnabled;
  if(equal(current))return {saved:true,preferences:current};
  if(current.revision!==patch.baseRevision)return {saved:false,preferences:current};
  if(!await reserveReportWrite(db))return {saved:false,paused:true,preferences:current};
  const result=await db.prepare(`INSERT INTO life_report_preferences(owner_id,daily_enabled,weekly_enabled,revision)
    SELECT ?,?,?,1 WHERE ?=0 OR EXISTS(SELECT 1 FROM life_report_preferences WHERE owner_id=?)
    ON CONFLICT(owner_id) DO UPDATE SET daily_enabled=excluded.daily_enabled,weekly_enabled=excluded.weekly_enabled,revision=revision+1,updated_at=unixepoch()
    WHERE revision=? RETURNING revision`).bind(ownerId,patch.dailyEnabled?1:0,patch.weeklyEnabled?1:0,patch.baseRevision,ownerId,patch.baseRevision).all();
  if(!result.success)throw Error('Report automation save unconfirmed');
  const latest=await readReportPreferences(db,ownerId);
  return {saved:equal(latest),preferences:latest};
}
