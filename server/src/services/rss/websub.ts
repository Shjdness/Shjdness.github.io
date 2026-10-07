import { eq } from "drizzle-orm";
import type { DB } from "../../_worker";
import { rssSubscriptions } from "../../db/schema";

const HUB = "https://pubsubhubbub.appspot.com/subscribe";

export async function subscribeWebSub(
  db: DB,
  subscription: typeof rssSubscriptions.$inferSelect,
  origin?: string,
) {
  const key = subscription.websubKey || crypto.randomUUID().replace(/-/g, "");
  const callback = origin
    ? `${origin}/rss/websub/${subscription.id}/${key}`
    : subscription.websubCallback;
  if (!callback) return false;
  // The hub can verify the callback immediately. Persist the secret first so
  // that the verification request cannot race the database update.
  await db
    .update(rssSubscriptions)
    .set({ websubKey: key, websubCallback: callback, updatedAt: new Date() })
    .where(eq(rssSubscriptions.id, subscription.id));
  const form = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.topic": subscription.feedUrl,
    "hub.callback": callback,
    "hub.verify": "async",
    "hub.lease_seconds": "864000",
  });
  const response = await fetch(HUB, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (!response.ok && response.status !== 202)
    throw new Error(`WebSub 订阅失败：${response.status}`);
  return true;
}

