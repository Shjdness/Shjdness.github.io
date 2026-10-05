import { XMLParser } from "fast-xml-parser";
import { and, count, desc, eq, inArray, SQL } from "drizzle-orm";
import Elysia, { t } from "elysia";
import type { DB } from "../_worker";
import { rssItems, rssSourceGroups, rssSubscriptions } from "../db/schema";
import { setup } from "../setup";
import { getDB, getEnv } from "../utils/di";

const HUB = "https://pubsubhubbub.appspot.com/subscribe";
const FEED = "https://www.youtube.com/feeds/videos.xml?channel_id=";
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});
const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const clean = (value: unknown, max = 4000) =>
  text(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

function channelIdFromFeed(value: string) {
  try {
    return new URL(value).searchParams.get("channel_id") || "";
  } catch {
    return "";
  }
}

function channelIdFromUrl(value: string) {
  try {
    const source = new URL(value);
    return (
      source.searchParams.get("channel_id") ||
      source.pathname.match(/^\/channel\/(UC[\w-]+)/)?.[1] ||
      ""
    );
  } catch {
    return "";
  }
}

function isChannelId(value: string) {
  return /^UC[\w-]{20,}$/.test(value);
}

function parseYouTubeFeed(xml: string) {
  const root = parser.parse(xml)?.feed || {};
  const author = clean(root.author?.name, 200);
  const videos = list<Record<string, any>>(root.entry)
    .map((entry) => {
      const id = clean(
        entry["yt:videoId"] || text(entry.id).replace("yt:video:", ""),
        100,
      );
      const media = entry["media:group"] || {};
      const alternate = list<Record<string, any>>(entry.link).find(
        (link) => link?.["@_rel"] === "alternate",
      );
      const url =
        text(alternate?.["@_href"]) || `https://www.youtube.com/watch?v=${id}`;
      return {
        externalId: id,
        title: clean(entry.title || media["media:title"] || "未命名视频", 500),
        url,
        summary: clean(media["media:description"] || entry.content || "", 4000),
        author: clean(entry.author?.name || author, 200),
        publishedAt: new Date(entry.published || entry.updated || Date.now()),
        thumbnailUrl:
          text(media["media:thumbnail"]?.["@_url"]) ||
          `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
      };
    })
    .filter(
      (video) =>
        video.externalId &&
        !/youtube\.com\/shorts\//i.test(video.url) &&
        !/(^|\s)#shorts?(\s|$)/i.test(`${video.title} ${video.summary}`),
    );
  const self = list<Record<string, any>>(root.link).find(
    (link) => link?.["@_rel"] === "self",
  );
  return {
    channelId: clean(
      root["yt:channelId"] || channelIdFromFeed(text(self?.["@_href"])),
      100,
    ),
    title: clean(root.title || author || "YouTube", 160),
    videos,
  };
}

async function fetchText(
  url: string,
  accept = "application/atom+xml,text/html",
) {
  let lastStatus = 0;
  // YouTube's Atom endpoint intermittently returns 404/5xx for an otherwise
  // valid channel (including from non-browser data-centre egress). Treat every
  // non-success response as transient for a few short attempts; a genuinely
  // missing channel will still fail with the last status.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        Accept: accept,
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok)
      return { body: await response.text(), finalUrl: response.url };
    lastStatus = response.status;
    if (response.status === 401 || response.status === 403) break;
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  throw new Error(`YouTube 返回 ${lastStatus || "网络错误"}`);
}

async function resolveChannelId(input: string) {
  let source: URL;
  try {
    source = new URL(input.trim());
  } catch {
    throw new Error("请粘贴 YouTube 频道或官方 Feed 地址");
  }
  if (
    source.protocol !== "https:" ||
    !/(^|\.)youtube\.com$/.test(source.hostname)
  )
    throw new Error("目前仅支持 YouTube 频道");
  const fromFeed =
    source.pathname === "/feeds/videos.xml"
      ? source.searchParams.get("channel_id")
      : "";
  const fromChannel =
    source.pathname.match(/^\/channel\/(UC[\w-]+)/)?.[1] || "";
  if (fromFeed || fromChannel)
    return { channelId: fromFeed || fromChannel, sourceUrl: source.toString() };
  const page = await fetchText(source.toString(), "text/html");
  const id =
    page.body.match(/"channelId":"(UC[\w-]+)"/)?.[1] ||
    page.body.match(/<meta itemprop="channelId" content="(UC[\w-]+)"/)?.[1] ||
    page.body.match(/youtube\.com\/channel\/(UC[\w-]+)/)?.[1];
  if (!id)
    throw new Error(
      "无法识别频道 ID；请使用 /channel/UC… 或 feeds/videos.xml?channel_id=UC…",
    );
  return { channelId: id, sourceUrl: source.toString() };
}

export async function resolveYouTubeSource(input: string) {
  const { channelId, sourceUrl } = await resolveChannelId(input);
  const feedUrl = `${FEED}${channelId}`;
  const parsed = parseYouTubeFeed((await fetchText(feedUrl)).body);
  return {
    sourceUrl,
    feedUrl,
    provider: "native",
    platform: "youtube",
    externalId: channelId,
    title: parsed.title,
    description: "",
    siteUrl: `https://www.youtube.com/channel/${channelId}`,
    icon: "",
    category: "视频",
    preview: parsed.videos
      .slice(0, 3)
      .map((video) => ({ ...video })),
  };
}

async function ingest(
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

async function canonicalFeed(
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

async function refreshOne(
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

async function subscribeWebSub(
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

async function refreshMany(
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

export function RssService() {
  const db: DB = getDB();
  const syncAuthorized = (authorization?: string) =>
    Boolean(
      getEnv().RSS_SYNC_TOKEN &&
        authorization === `Bearer ${getEnv().RSS_SYNC_TOKEN}`,
    );
  const requireLife = ({
    uid,
    lifeAccess,
    set,
  }: {
    uid?: number;
    lifeAccess?: boolean;
    set: { status?: number | string };
  }) => {
    if (!uid || !lifeAccess) {
      set.status = 403;
      return false;
    }
    return true;
  };
  return new Elysia({ aot: false }).use(setup()).group("/rss", (group) =>
    group
      .get("/sync/sources", async ({ headers, set }) => {
        if (!syncAuthorized(headers.authorization)) {
          set.status = 401;
          return "Unauthorized";
        }
        const rows = await db.query.rssSubscriptions.findMany({
          where: and(
            eq(rssSubscriptions.active, 1),
            eq(rssSubscriptions.platform, "youtube"),
          ),
        });
        const sources: Array<{
          id: number;
          title: string;
          feedUrl: string;
        }> = [];
        for (const source of rows) {
          try {
            sources.push({
              id: source.id,
              title: source.alias || source.title,
              feedUrl: await canonicalFeed(db, source),
            });
          } catch {
            // Invalid legacy rows stay visible in source settings for manual
            // correction, but must not abort reconciliation of valid rows.
          }
        }
        return { sources };
      })
      .post(
        "/sync/ingest",
        async ({ headers, set, body, request }) => {
          if (!syncAuthorized(headers.authorization)) {
            set.status = 401;
            return "Unauthorized";
          }
          const source = await db.query.rssSubscriptions.findFirst({
            where: and(
              eq(rssSubscriptions.id, body.subscriptionId),
              eq(rssSubscriptions.active, 1),
              eq(rssSubscriptions.platform, "youtube"),
            ),
          });
          if (!source) {
            set.status = 404;
            return "Source not found";
          }
          try {
            await canonicalFeed(db, source);
            const result = await ingest(db, source, body.feed);
            try {
              await subscribeWebSub(db, source, new URL(request.url).origin);
            } catch {
              // The two-hour reconciliation remains the fallback.
            }
            return result;
          } catch (error) {
            const message =
              error instanceof Error ? error.message.slice(0, 240) : "解析失败";
            await db
              .update(rssSubscriptions)
              .set({
                lastFetchedAt: new Date(),
                lastError: message,
                updatedAt: new Date(),
              })
              .where(eq(rssSubscriptions.id, source.id));
            set.status = 422;
            return message;
          }
        },
        {
          body: t.Object({
            subscriptionId: t.Number(),
            feed: t.String({ maxLength: 2_000_000 }),
          }),
        },
      )
      .post(
        "/sync/error",
        async ({ headers, set, body }) => {
          if (!syncAuthorized(headers.authorization)) {
            set.status = 401;
            return "Unauthorized";
          }
          await db
            .update(rssSubscriptions)
            .set({
              lastFetchedAt: new Date(),
              lastError: body.error.slice(0, 240),
              updatedAt: new Date(),
            })
            .where(eq(rssSubscriptions.id, body.subscriptionId));
          return "OK";
        },
        {
          body: t.Object({
            subscriptionId: t.Number(),
            error: t.String({ maxLength: 500 }),
          }),
        },
      )
      .get("/websub/:id/:key", async ({ params, request, set }) => {
        const source = await db.query.rssSubscriptions.findFirst({
          where: eq(rssSubscriptions.id, Number(params.id)),
        });
        const query = new URL(request.url).searchParams;
        const challenge = query.get("hub.challenge");
        if (
          !source ||
          source.websubKey !== params.key ||
          query.get("hub.topic") !== source.feedUrl ||
          !challenge
        ) {
          set.status = 404;
          return "Not found";
        }
        const lease = Number(query.get("hub.lease_seconds") || 0);
        await db
          .update(rssSubscriptions)
          .set({
            websubLeaseExpiresAt: lease
              ? new Date(Date.now() + lease * 1000)
              : source.websubLeaseExpiresAt,
            updatedAt: new Date(),
          })
          .where(eq(rssSubscriptions.id, source.id));
        return challenge;
      })
      .post("/websub/:id/:key", async ({ params, request, set }) => {
        const source = await db.query.rssSubscriptions.findFirst({
          where: eq(rssSubscriptions.id, Number(params.id)),
        });
        if (
          !source ||
          source.websubKey !== params.key ||
          source.platform !== "youtube"
        ) {
          set.status = 404;
          return "Not found";
        }
        try {
          await ingest(db, source, await request.text());
          return "OK";
        } catch {
          set.status = 422;
          return "Invalid notification";
        }
      })
      .get("/storage", async ({ uid, lifeAccess, set }) => {
        if (!requireLife({ uid, lifeAccess, set }))
          return "Private Life access is required";
        const estimate = await getEnv()
          .DB.prepare(
            "SELECT COALESCE(SUM(length(title)+length(url)+length(summary)+length(author)+length(embed_url)+length(thumbnail_url)), 0) AS bytes FROM rss_items WHERE owner_id = ?",
          )
          .bind(uid!)
          .first<{ bytes: number }>();
        return {
          backend: {
            usedBytes: Number(estimate?.bytes || 0),
            limitBytes: 500 * 1024 * 1024,
          },
          rssBytes: Number(estimate?.bytes || 0),
        };
      })
      .get(
        "/",
        async ({ uid, lifeAccess, set, query }) => {
          if (!requireLife({ uid, lifeAccess, set }))
            return "Private Life access is required";
          const limit = Math.min(200, Math.max(10, Number(query.limit || 90)));
          const offset = Math.max(0, Number(query.offset || 0));
          const subscriptions = await db.query.rssSubscriptions.findMany({
            where: and(
              eq(rssSubscriptions.ownerId, uid!),
              eq(rssSubscriptions.platform, "youtube"),
            ),
            orderBy: [desc(rssSubscriptions.updatedAt)],
          });
          const sourceIds = subscriptions
            .filter(
              (source) =>
                (!query.sourceId || source.id === Number(query.sourceId)) &&
                (!query.category || source.category === query.category),
            )
            .map((source) => source.id);
          const conditions: SQL[] = [eq(rssItems.ownerId, uid!)];
          if (query.filter === "unread") conditions.push(eq(rssItems.read, 0));
          if (query.filter === "starred")
            conditions.push(eq(rssItems.starred, 1));
          if (query.sourceId || query.category)
            conditions.push(
              sourceIds.length
                ? inArray(rssItems.subscriptionId, sourceIds)
                : eq(rssItems.subscriptionId, -1),
            );
          const where = and(...conditions);
          const [groups, items, filtered, all, unread, starred] =
            await Promise.all([
              db
                .select()
                .from(rssSourceGroups)
                .where(eq(rssSourceGroups.ownerId, uid!))
                .orderBy(rssSourceGroups.sortOrder),
              db
                .select()
                .from(rssItems)
                .where(where)
                .orderBy(desc(rssItems.publishedAt), desc(rssItems.id))
                .limit(limit)
                .offset(offset),
              db.select({ value: count() }).from(rssItems).where(where),
              db
                .select({ value: count() })
                .from(rssItems)
                .where(eq(rssItems.ownerId, uid!)),
              db
                .select({ value: count() })
                .from(rssItems)
                .where(and(eq(rssItems.ownerId, uid!), eq(rssItems.read, 0))),
              db
                .select({ value: count() })
                .from(rssItems)
                .where(
                  and(eq(rssItems.ownerId, uid!), eq(rssItems.starred, 1)),
                ),
            ]);
          const total = filtered[0]?.value || 0;
          return {
            subscriptions,
            groups,
            items,
            counts: {
              all: all[0]?.value || 0,
              unread: unread[0]?.value || 0,
              starred: starred[0]?.value || 0,
            },
            page: {
              limit,
              offset,
              total,
              hasMore: offset + items.length < total,
            },
          };
        },
        {
          query: t.Object({
            filter: t.Optional(t.String()),
            sourceId: t.Optional(t.String()),
            category: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            offset: t.Optional(t.String()),
          }),
        },
      )
      .post(
        "/resolve",
        async ({ uid, lifeAccess, set, body }) => {
          if (!requireLife({ uid, lifeAccess, set }))
            return "Private Life access is required";
          try {
            return { candidates: [await resolveYouTubeSource(body.sourceUrl)] };
          } catch (error) {
            set.status = 422;
            return error instanceof Error
              ? error.message
              : "无法识别 YouTube 频道";
          }
        },
        { body: t.Object({ sourceUrl: t.String({ maxLength: 2000 }) }) },
      )
      .post(
        "/subscriptions",
        async ({ uid, lifeAccess, set, body, request }) => {
          if (!requireLife({ uid, lifeAccess, set }))
            return "Private Life access is required";
          const resolved = await resolveYouTubeSource(
            body.sourceUrl || body.feedUrl,
          );
          const existing = await db.query.rssSubscriptions.findFirst({
            where: and(
              eq(rssSubscriptions.ownerId, uid!),
              eq(rssSubscriptions.externalId, resolved.externalId),
            ),
          });
          if (existing) {
            set.status = 409;
            return "该 YouTube 频道已订阅";
          }
          const category = body.category?.trim() || "视频";
          await db
            .insert(rssSourceGroups)
            .values({ ownerId: uid!, name: category })
            .onConflictDoNothing({
              target: [rssSourceGroups.ownerId, rssSourceGroups.name],
            });
          const inserted = await db
            .insert(rssSubscriptions)
            .values({
              ownerId: uid!,
              sourceUrl: resolved.sourceUrl,
              feedUrl: resolved.feedUrl,
              provider: resolved.provider,
              platform: resolved.platform,
              externalId: resolved.externalId,
              title: resolved.title,
              description: resolved.description,
              siteUrl: resolved.siteUrl,
              favicon: resolved.icon,
              alias: body.alias?.trim() || "",
              category,
            })
            .returning();
          const source = inserted[0];
          const first = await refreshOne(db, source);
          let websubActive = false;
          try {
            websubActive = await subscribeWebSub(
              db,
              source,
              new URL(request.url).origin,
            );
          } catch {
            /* The daily reconciliation job keeps the subscription usable. */
          }
          return { subscriptionId: source.id, websubActive, ...first };
        },
        {
          body: t.Object({
            feedUrl: t.String(),
            sourceUrl: t.Optional(t.String()),
            title: t.Optional(t.String()),
            alias: t.Optional(t.String()),
            description: t.Optional(t.String()),
            category: t.Optional(t.String()),
            provider: t.Optional(t.String()),
            platform: t.Optional(t.String()),
            externalId: t.Optional(t.String()),
            icon: t.Optional(t.String()),
          }),
        },
      )
      .post(
        "/subscriptions/:id",
        async ({ uid, lifeAccess, set, params, body }) => {
          if (!requireLife({ uid, lifeAccess, set }))
            return "Private Life access is required";
          const category = body.category?.trim();
          if (category)
            await db
              .insert(rssSourceGroups)
              .values({ ownerId: uid!, name: category })
              .onConflictDoNothing({
                target: [rssSourceGroups.ownerId, rssSourceGroups.name],
              });
          await db
            .update(rssSubscriptions)
            .set({
              alias: body.alias?.trim(),
              description: body.description?.trim(),
              category,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(rssSubscriptions.id, Number(params.id)),
                eq(rssSubscriptions.ownerId, uid!),
              ),
            );
          return "OK";
        },
        {
          body: t.Object({
            alias: t.Optional(t.String()),
            description: t.Optional(t.String()),
            category: t.Optional(t.String()),
          }),
        },
      )
      .post(
        "/groups",
        async ({ uid, lifeAccess, set, body }) => {
          if (!requireLife({ uid, lifeAccess, set }))
            return "Private Life access is required";
          const inserted = await db
            .insert(rssSourceGroups)
            .values({ ownerId: uid!, name: body.name.trim() })
            .onConflictDoNothing({
              target: [rssSourceGroups.ownerId, rssSourceGroups.name],
            })
            .returning();
          return inserted[0] || { name: body.name };
        },
        { body: t.Object({ name: t.String({ minLength: 1, maxLength: 80 }) }) },
      )
      .post(
        "/groups/reorder",
        async ({ uid, lifeAccess, set, body }) => {
          if (!requireLife({ uid, lifeAccess, set }))
            return "Private Life access is required";
          await Promise.all(
            body.ids.map((id, sortOrder) =>
              db
                .update(rssSourceGroups)
                .set({ sortOrder })
                .where(
                  and(
                    eq(rssSourceGroups.id, id),
                    eq(rssSourceGroups.ownerId, uid!),
                  ),
                ),
            ),
          );
          return "OK";
        },
        { body: t.Object({ ids: t.Array(t.Number()) }) },
      )
      .post(
        "/groups/:id",
        async ({ uid, lifeAccess, set, params, body }) => {
          if (!requireLife({ uid, lifeAccess, set }))
            return "Private Life access is required";
          const groupItem = await db.query.rssSourceGroups.findFirst({
            where: and(
              eq(rssSourceGroups.id, Number(params.id)),
              eq(rssSourceGroups.ownerId, uid!),
            ),
          });
          if (!groupItem) {
            set.status = 404;
            return "分组不存在";
          }
          await db
            .update(rssSourceGroups)
            .set({ name: body.name })
            .where(eq(rssSourceGroups.id, groupItem.id));
          await db
            .update(rssSubscriptions)
            .set({ category: body.name })
            .where(
              and(
                eq(rssSubscriptions.ownerId, uid!),
                eq(rssSubscriptions.category, groupItem.name),
              ),
            );
          return "OK";
        },
        { body: t.Object({ name: t.String() }) },
      )
      .delete("/groups/:id", async ({ uid, lifeAccess, set, params }) => {
        if (!requireLife({ uid, lifeAccess, set }))
          return "Private Life access is required";
        const item = await db.query.rssSourceGroups.findFirst({
          where: and(
            eq(rssSourceGroups.id, Number(params.id)),
            eq(rssSourceGroups.ownerId, uid!),
          ),
        });
        if (item) {
          await db
            .update(rssSubscriptions)
            .set({ category: "其他" })
            .where(
              and(
                eq(rssSubscriptions.ownerId, uid!),
                eq(rssSubscriptions.category, item.name),
              ),
            );
          await db
            .delete(rssSourceGroups)
            .where(eq(rssSourceGroups.id, item.id));
        }
        return "OK";
      })
      .post("/refresh", async ({ uid, lifeAccess, set, request }) => {
        if (!requireLife({ uid, lifeAccess, set }))
          return "Private Life access is required";
        const sources = await db.query.rssSubscriptions.findMany({
          where: and(
            eq(rssSubscriptions.ownerId, uid!),
            eq(rssSubscriptions.platform, "youtube"),
            eq(rssSubscriptions.active, 1),
          ),
        });
        return refreshMany(db, sources, new URL(request.url).origin);
      })
      .post(
        "/subscriptions/:id/refresh",
        async ({ uid, lifeAccess, set, params, request }) => {
          if (!requireLife({ uid, lifeAccess, set }))
            return "Private Life access is required";
          const source = await db.query.rssSubscriptions.findFirst({
            where: and(
              eq(rssSubscriptions.id, Number(params.id)),
              eq(rssSubscriptions.ownerId, uid!),
              eq(rssSubscriptions.platform, "youtube"),
            ),
          });
          if (!source) {
            set.status = 404;
            return "订阅不存在";
          }
          const result = await refreshOne(db, source);
          await subscribeWebSub(db, source, new URL(request.url).origin);
          return result;
        },
      )
      .post("/items/mark-all-read", async ({ uid, lifeAccess, set }) => {
        if (!requireLife({ uid, lifeAccess, set }))
          return "Private Life access is required";
        const now = new Date();
        await db
          .update(rssItems)
          .set({ read: 1, readAt: now, updatedAt: now })
          .where(and(eq(rssItems.ownerId, uid!), eq(rssItems.read, 0)));
        return "OK";
      })
      .post(
        "/items/:id",
        async ({ uid, lifeAccess, set, params, body }) => {
          if (!requireLife({ uid, lifeAccess, set }))
            return "Private Life access is required";
          const item = await db.query.rssItems.findFirst({
            where: and(
              eq(rssItems.id, Number(params.id)),
              eq(rssItems.ownerId, uid!),
            ),
          });
          if (!item) {
            set.status = 404;
            return "条目不存在";
          }
          const now = new Date();
          await db
            .update(rssItems)
            .set({
              ...(body.read === undefined
                ? {}
                : {
                    read: body.read ? 1 : 0,
                    readAt: body.read ? item.readAt || now : null,
                  }),
              ...(body.starred === undefined
                ? {}
                : {
                    starred: body.starred ? 1 : 0,
                    starredAt: body.starred ? item.starredAt || now : null,
                  }),
              updatedAt: now,
            })
            .where(eq(rssItems.id, item.id));
          return "OK";
        },
        {
          body: t.Object({
            read: t.Optional(t.Boolean()),
            starred: t.Optional(t.Boolean()),
          }),
        },
      )
      .delete(
        "/subscriptions/:id",
        async ({ uid, lifeAccess, set, params }) => {
          if (!requireLife({ uid, lifeAccess, set }))
            return "Private Life access is required";
          await db
            .delete(rssSubscriptions)
            .where(
              and(
                eq(rssSubscriptions.id, Number(params.id)),
                eq(rssSubscriptions.ownerId, uid!),
              ),
            );
          return "OK";
        },
      ),
  );
}
