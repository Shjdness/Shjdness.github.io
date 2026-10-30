import { eq } from "drizzle-orm";
import type { DB } from "../../_worker";
import { rssSubscriptions } from "../../db/schema";
import { getEnv } from '../../utils/di';
import {reserveBackgroundWrites} from '../../utils/write-budget';

const HUB = "https://pubsubhubbub.appspot.com/subscribe";

export async function websubSecret(id:number,key:string,secret=getEnv().JWT_SECRET) {
  const encoder=new TextEncoder();
  const signingKey=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=await crypto.subtle.sign('HMAC',signingKey,encoder.encode(`websub/v2:${id}:${key}`));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

export async function verifyWebsub(body:Uint8Array,signature:string|null,secret:string) {
  const match=signature?.match(/^(sha1|sha256)=([a-fA-F0-9]+)$/);
  if(!match || match[2].length!==(match[1]==='sha1'?40:64))return false;
  const bytes=Uint8Array.from(match[2].match(/../g)!,byte=>parseInt(byte,16));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:match[1]==='sha1'?'SHA-1':'SHA-256'},false,['verify']);
  return crypto.subtle.verify('HMAC',key,bytes,new Uint8Array(body));
}

export async function subscribeWebSub(
  db: DB,
  subscription: typeof rssSubscriptions.$inferSelect,
  origin?: string,
) {
  // Prefix identifies signed leases without changing the stored schema or routes.
  const prefix='v2_'+(await websubSecret(0,'lease-version')).slice(0,16)+'_';
  const key = subscription.websubKey.startsWith(prefix) ? subscription.websubKey : prefix+crypto.randomUUID().replace(/-/g, "");
  const callbackOrigin=origin || (subscription.websubCallback ? new URL(subscription.websubCallback).origin : '');
  const callback = callbackOrigin ? `${callbackOrigin}/rss/websub/${subscription.id}/${key}` : '';
  if (!callback) return false;
  // A healthy lease lasts ten days; do not renew it on every daily feed read.
  if (subscription.websubCallback === callback && subscription.websubLeaseExpiresAt && subscription.websubLeaseExpiresAt.getTime() > Date.now() + 2 * 86400000) return true;
  await reserveBackgroundWrites(getEnv().DB,'rss-websub',8,1000);
  // The hub can verify the callback immediately. Persist the secret first so
  // that the verification request cannot race the database update.
  await db
    .update(rssSubscriptions)
    .set({ websubKey: key, websubCallback: callback, websubLeaseExpiresAt:null, updatedAt: new Date() })
    .where(eq(rssSubscriptions.id, subscription.id));
  const form = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.topic": subscription.feedUrl,
    "hub.callback": callback,
    "hub.verify": "async",
    "hub.secret": await websubSecret(subscription.id,key),
    "hub.lease_seconds": "864000",
  });
  const response = await fetch(HUB, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal:AbortSignal.timeout(15000),
  });
  if (!response.ok && response.status !== 202)
    throw new Error(`WebSub 订阅失败：${response.status}`);
  return true;
}

