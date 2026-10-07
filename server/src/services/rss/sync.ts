import { and, eq } from "drizzle-orm";
import type { DB } from "../../_worker";
import { rssItems, rssSubscriptions } from "../../db/schema";
import { FEED, channelIdFromUrl, fetchText, isChannelId, parseYouTubeFeed, resolveChannelId } from "./youtube";
import { subscribeWebSub } from "./websub";

export async function ingest(
  db: DB,
  subscription: typeof rssSubscriptions.$inferSelect,
  xml: string,
) {
  const parsed = parseYouTubeFeed(xml);
  // Older imported records did not always store YouTube's canonical UC… id.
  // The official Atom feed is the source of truth, so repair legacy metadata
  // instead of rejecting every otherwise valid refresh.
  let canonicalExternalId = subscription.externalId;
  if (parsed.channelId && parsed.channelId !== subscription.externalId) {
    const duplicate = await db.query.rssSubscriptions.findFirst({
      where: and(
        eq(rssSubscriptions.ownerId, subscription.ownerId),
        eq(rssSubscriptions.externalId, parsed.channelId),
      ),
    });
    if (!duplicate || duplicate.id === subscription.id)
      canonicalExternalId = parsed.channelId;
  }
  let added = 0;
  const now = new Date();
  for (const video of parsed.videos) {
    const before = await db.query.rssItems.findFirst({
      where: and(
        eq(rssItems.subscriptionId, subscription.id),
        eq(rssItems.externalId, video.externalId),
      ),
    });
    await db
      .insert(rssItems)
      .values({
        subscriptionId: subscription.id,
        ownerId: subscription.ownerId,
        externalId: video.externalId,
        title: video.title,
        url: video.url,
        summary: video.summary,
        author: video.author,
        embedUrl: video.embedUrl,
        thumbnailUrl: video.thumbnailUrl,
        publishedAt: video.publishedAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [rssItems.subscriptionId, rssItems.externalId],
        set: {
          title: video.title,
          summary: video.summary,
          author: video.author,
          url: video.url,
          embedUrl: video.embedUrl,
          thumbnailUrl: video.thumbnailUrl,
          publishedAt: video.publishedAt,
          updatedAt: now,
        },
      });
    if (!before) added += 1;
  }
  await db
    .update(rssSubscriptions)
    .set({
      title: parsed.title || subscription.title,
      platform: "youtube",
      provider: "native",
      externalId: canonicalExternalId,
      lastFetchedAt: now,
      lastError: "",
      updatedAt: now,
    })
    .where(eq(rssSubscriptions.id, subscription.id));
  return { added, unchanged: added === 0 };
}

export async function canonicalFeed(
  db: DB,
  subscription: typeof rssSubscriptions.$inferSelect,
) {
  const candidates = [
    channelIdFromUrl(subscription.siteUrl),
    channelIdFromUrl(subscription.sourceUrl),
    channelIdFromUrl(subscription.feedUrl),
    subscription.externalId,
  ];
  let channelId = candidates.find(isChannelId) || "";
  if (!channelId) {
    for (const url of [subscription.siteUrl, subscription.sourceUrl]) {
      try {
        if (!url || !/(^|\.)youtube\.com$/i.test(new URL(url).hostname))
          continue;
        channelId = (await resolveChannelId(url)).channelId;
        if (channelId) break;
      } catch {
        // Try the next stored YouTube URL before reporting an invalid source.
      }
    }
  }
  if (!isChannelId(channelId))
    throw new Error("无法恢复该频道的 YouTube Channel ID");

  const feedUrl = `${FEED}${channelId}`;
  const siteUrl = `https://www.youtube.com/channel/${channelId}`;
  if (
    subscription.feedUrl !== feedUrl ||
    subscription.siteUrl !== siteUrl ||
    subscription.provider !== "native"
  )
    await db
      .update(rssSubscriptions)
      .set({
        feedUrl,
        siteUrl,
        provider: "native",
        platform: "youtube",
        updatedAt: new Date(),
      })
      .where(eq(rssSubscriptions.id, subscription.id));

  // Keep the in-memory row in sync so WebSub immediately uses the repaired
  // official topic instead of an obsolete imported URL.
  subscription.feedUrl = feedUrl;
  subscription.siteUrl = siteUrl;
  subscription.provider = "native";
  subscription.platform = "youtube";
  return feedUrl;
}

export async function refreshOne(
  db: DB,
  subscription: typeof rssSubscriptions.$inferSelect,
) {
  try {
    const feedUrl = await canonicalFeed(db, subscription);
    return await ingest(
      db,
      subscription,
      (await fetchText(feedUrl)).body,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 240) : "更新失败";
    await db
      .update(rssSubscriptions)
      .set({
        lastFetchedAt: new Date(),
        lastError: message,
        updatedAt: new Date(),
      })
      .where(eq(rssSubscriptions.id, subscription.id));
    throw error;
  }
}


export async function refreshMany(
  db: DB,
  subscriptions: Array<typeof rssSubscriptions.$inferSelect>,
  origin?: string,
) {
  let added = 0;
  const failures: Array<{ id: number; title: string; error: string }> = [];
  for (const source of subscriptions) {
    try {
      added += (await refreshOne(db, source)).added;
      try {
        await subscribeWebSub(db, source, origin);
      } catch {
        /* Daily feed refresh remains the fallback. */
      }
    } catch (error) {
      failures.push({
        id: source.id,
        title: source.alias || source.title,
        error: error instanceof Error ? error.message : "更新失败",
      });
    }
  }
  return {
    refreshed: subscriptions.length - failures.length,
    total: subscriptions.length,
    added,
    failed: failures.length,
    failures,
  };
}

export async function refreshYouTubeSubscriptions(db: DB) {
  const subscriptions = await db.query.rssSubscriptions.findMany({
    where: and(
      eq(rssSubscriptions.active, 1),
      eq(rssSubscriptions.platform, "youtube"),
    ),
  });
  return refreshMany(db, subscriptions);
}
