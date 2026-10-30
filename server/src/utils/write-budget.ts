import type { D1Database } from '@cloudflare/workers-types';

export class WriteBudgetError extends Error {
  constructor(public retryAt = Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate()+1)) {
    super('RSS 后台写入已达今日安全预算，已暂停，私人数据不受此后台预算限制');
  }
}

// Conservative reservations include index maintenance, ledger and budget writes.
// This is an RSS safety envelope, not an assertion about account-wide usage.
export async function reserveRssWrites(db: D1Database, changed: number, history: boolean, now = Date.now()) {
  return reserveBackgroundWrites(db,'rss',changed*24+16,history?25000:40000,now);
}

export async function reserveBackgroundWrites(db: D1Database, scope:string, cost:number, cap:number, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0,10);
  if(!Number.isSafeInteger(cost)||cost<1||cost>cap)throw new WriteBudgetError(Date.parse(day+'T00:00:00Z')+86400000);
  const result = await db.prepare(`INSERT INTO rss_write_budget(day,reserved) VALUES(?,?)
    ON CONFLICT(day) DO UPDATE SET reserved=reserved+excluded.reserved
    WHERE reserved+excluded.reserved<=? RETURNING reserved`).bind(scope+':'+day,cost,cap).all();
  if (!result.results.length) throw new WriteBudgetError(Date.parse(day+'T00:00:00Z')+86400000);
}

function errorChain(error:unknown):unknown[] {
  const chain:unknown[]=[],seen=new Set<unknown>();
  for(let depth=0;error!=null && depth<8 && !seen.has(error);depth++) {
    seen.add(error);chain.push(error);
    error=error instanceof Error?error.cause:undefined;
  }
  return chain;
}

export function isD1QuotaError(error: unknown) {
  return errorChain(error).some(cause=>/exceeded D1.*daily.*(?:write|read).*limit|daily row (?:write|read) limit/i.test(cause instanceof Error ? cause.message : String(cause)));
}

export function quotaResponse(error:unknown):Response|undefined {
  const budget=errorChain(error).find((cause):cause is WriteBudgetError=>cause instanceof WriteBudgetError);
  if(!budget&&!isD1QuotaError(error))return;
  const retryAt=budget?budget.retryAt:Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth(),new Date().getUTCDate()+1);
  return Response.json({code:budget?'RSS_BUDGET_PAUSED':'D1_QUOTA_PAUSED',message:budget?budget.message:'数据库今日额度已耗尽，本地更改已保留，请在额度重置后同步',retryAt},{status:503,headers:{'Cache-Control':'no-store','Retry-After':String(Math.max(1,Math.ceil((retryAt-Date.now())/1000)))}});
}
