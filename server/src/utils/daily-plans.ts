import type {D1Database} from '@cloudflare/workers-types';

export function validPlanDay(value:string){
 return /^\d{4}-\d{2}-\d{2}$/.test(value)&&value>='2000-01-01'&&value<='2100-12-31'&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
}
type PlanCreate={date:string;content:string;sortOrder:number;clientKey?:string;todoId?:number|null};
type PlanPatch={date?:string;content?:string;sortOrder?:number;completed?:boolean;todoId?:number|null;baseRevision?:number};
function ownerRequired(owner:number){if(!Number.isSafeInteger(owner)||owner<1)throw Error('Plan owner required');}
function validate(value:PlanPatch){
 if(value.date!==undefined&&!validPlanDay(value.date))throw Error('日期无效');
 if(value.content!==undefined&&(!value.content.trim()||value.content.trim().length>240))throw Error('事项内容不能为空或超过240字');
 if(value.sortOrder!==undefined&&(!Number.isInteger(value.sortOrder)||value.sortOrder<0||value.sortOrder>100))throw Error('事项排序无效');
 if(value.todoId!==undefined&&value.todoId!==null&&(!Number.isSafeInteger(value.todoId)||value.todoId<1))throw Error('关联待办无效');
 if(value.baseRevision!==undefined&&(!Number.isSafeInteger(value.baseRevision)||value.baseRevision<0))throw Error('事项版本无效');
}
/** One INSERT...SELECT enforces the limit inside the write itself. Read/count
 * then INSERT would let simultaneous devices exceed three. Existing rows stay. */
export async function createDailyPlan(db:D1Database,owner:number,value:PlanCreate){
 ownerRequired(owner);validate(value);const content=value.content.trim();
 const duplicate=await db.prepare('SELECT id FROM daily_basics WHERE owner_id=? AND ((client_key IS NOT NULL AND client_key=?) OR (date=? AND content=?)) ORDER BY CASE WHEN client_key=? THEN 0 ELSE 1 END LIMIT 1').bind(owner,value.clientKey??null,value.date,content,value.clientKey??null).all<{id:number}>();
 if(!duplicate.success)throw Error('事项读取失败');if(duplicate.results[0])return {insertedId:duplicate.results[0].id};
 const rows=await db.prepare(`INSERT INTO daily_basics(owner_id,date,content,sort_order,client_key,todo_id)
   SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM daily_basics WHERE owner_id=? AND date=?)<3
   AND (? IS NULL OR EXISTS(SELECT 1 FROM life_todos WHERE id=? AND owner_id=?))
   ON CONFLICT DO NOTHING RETURNING id`).bind(owner,value.date,content,value.sortOrder,value.clientKey??null,value.todoId??null,owner,value.date,value.todoId??null,value.todoId??null,owner).all<{id:number}>();
 if(!rows.success)throw Error('事项保存未确认');if(rows.results[0])return {insertedId:rows.results[0].id};
 const raced=await db.prepare('SELECT id FROM daily_basics WHERE owner_id=? AND ((client_key IS NOT NULL AND client_key=?) OR (date=? AND content=?)) LIMIT 1').bind(owner,value.clientKey??null,value.date,content).all<{id:number}>();
 if(!raced.success)throw Error('事项读取失败');if(raced.results[0])return {insertedId:raced.results[0].id};
 return {conflict:true as const,message:'该日期已有三件事，或关联待办不可用；本地内容已保留，请核对后重试。'};
}
/** Move/edit is one statement: capacity, duplicate, owner and optional revision
 * are checked at commit. Actual completion time is independent of plan date. */
export async function updateDailyPlan(db:D1Database,owner:number,id:number,value:PlanPatch,now=new Date()){
 ownerRequired(owner);validate(value);if(!Number.isSafeInteger(id)||id<1||!Number.isFinite(now.getTime()))throw Error('事项无效');
 const seconds=Math.floor(now.getTime()/1000),done=value.completed===undefined?null:value.completed?1:0;
 const rows=await db.prepare(`UPDATE daily_basics SET date=COALESCE(?,date),content=COALESCE(?,content),sort_order=COALESCE(?,sort_order),
   completed_at=CASE WHEN ?=1 AND completed=0 THEN ? WHEN ?=0 THEN NULL ELSE completed_at END,
   completed=COALESCE(?,completed),todo_id=CASE WHEN ?=1 THEN ? ELSE todo_id END,revision=revision+1,updated_at=?
   WHERE id=? AND owner_id=? AND (? IS NULL OR revision=?)
   AND (? IS NULL OR date=? OR (SELECT COUNT(*) FROM daily_basics other WHERE other.owner_id=? AND other.date=? AND other.id!=?)<3)
   AND NOT EXISTS(SELECT 1 FROM daily_basics other WHERE other.owner_id=? AND other.date=COALESCE(?,daily_basics.date) AND other.content=COALESCE(?,daily_basics.content) AND other.id!=daily_basics.id)
   AND (? IS NULL OR EXISTS(SELECT 1 FROM life_todos WHERE id=? AND owner_id=?)) RETURNING id,revision`).bind(
    value.date??null,value.content?.trim()??null,value.sortOrder??null,done,seconds,done,done,value.todoId===undefined?0:1,value.todoId??null,seconds,
    id,owner,value.baseRevision??null,value.baseRevision??null,value.date??null,value.date??null,owner,value.date??null,id,
    owner,value.date??null,value.content?.trim()??null,value.todoId??null,value.todoId??null,owner).all<{id:number;revision:number}>();
 if(!rows.success)throw Error('事项更新未确认');if(rows.results[0])return {saved:true as const,...rows.results[0]};
 const existing=await db.prepare('SELECT id FROM daily_basics WHERE id=? AND owner_id=?').bind(id,owner).all();
 if(!existing.success)throw Error('事项读取失败');return {saved:false as const,missing:existing.results.length===0,message:'事项已在其他设备更改、目标日期已满或关联待办不可用；请刷新后核对。'};
}

/** Normalize the day's order and swap adjacent ranks in one materialized
 * statement. Equal legacy sort values cannot make a direction button a no-op. */
export async function reorderDailyPlan(db:D1Database,owner:number,id:number,direction:-1|1,now=new Date()){
 ownerRequired(owner);if(!Number.isSafeInteger(id)||id<1||![-1,1].includes(direction))throw Error('事项排序无效');
 const rows=await db.prepare(`WITH ranked AS MATERIALIZED (
   SELECT id,ROW_NUMBER() OVER(ORDER BY sort_order,id)-1 AS rank FROM daily_basics
   WHERE owner_id=? AND date=(SELECT date FROM daily_basics WHERE owner_id=? AND id=?)
 ), target AS MATERIALIZED (SELECT rank,rank+? AS next FROM ranked WHERE id=?)
 UPDATE daily_basics SET sort_order=CASE WHEN id=? THEN (SELECT next FROM target)
   WHEN (SELECT rank FROM ranked WHERE ranked.id=daily_basics.id)=(SELECT next FROM target) THEN (SELECT rank FROM target)
   ELSE (SELECT rank FROM ranked WHERE ranked.id=daily_basics.id) END,revision=revision+1,updated_at=?
 WHERE owner_id=? AND id IN(SELECT id FROM ranked) AND (SELECT next FROM target)>=0
   AND (SELECT next FROM target)<(SELECT COUNT(*) FROM ranked) AND (SELECT COUNT(*) FROM ranked)<=100 RETURNING id`).bind(owner,owner,id,direction,id,id,Math.floor(now.getTime()/1000),owner).all();
 if(!rows.success)throw Error('排序未确认');return {saved:rows.results.length>0};
}
