import type {D1Database} from '@cloudflare/workers-types';
import {reserveBackgroundWrites,WriteBudgetError} from './write-budget';

export class GuestLimitError extends Error {
  constructor(public retryAt:number){super('Too many guest login attempts. Try again later');}
}

/** Atomic fixed-window attempts across isolates, plus a small daily write envelope. */
export async function reserveGuestAttempt(db:D1Database,ip:string,now=Date.now()) {
  try{await reserveBackgroundWrites(db,'guest-login',8,1600,now);}
  catch(error){if(error instanceof WriteBudgetError)throw new GuestLimitError(error.retryAt);throw error;}
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip));
  const key='guest_login:v2:'+Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
  const windowMs=15*60*1000;
  const result=await db.prepare(`INSERT INTO info(key,value) VALUES(?,json_object('attempts',1,'windowStart',?))
    ON CONFLICT(key) DO UPDATE SET value=CASE
      WHEN json_extract(info.value,'$.windowStart')<=? THEN excluded.value
      ELSE json_object('attempts',json_extract(info.value,'$.attempts')+1,'windowStart',json_extract(info.value,'$.windowStart')) END
    WHERE json_extract(info.value,'$.windowStart')<=? OR json_extract(info.value,'$.attempts')<5
    RETURNING value`).bind(key,now,now-windowMs,now-windowMs).all();
  if(!result.results.length)throw new GuestLimitError(now+windowMs);
}
