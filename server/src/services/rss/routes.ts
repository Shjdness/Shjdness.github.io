import { and, count, desc, eq, inArray, sql, SQL } from "drizzle-orm";
import Elysia, { t } from "elysia";
import type { DB } from "../../_worker";
import { rssItems, rssSourceGroups, rssSubscriptions } from "../../db/schema";
import { setup } from "../../setup";
import { getDB, getEnv } from "../../utils/di";
import { canonicalFeed, ingest, refreshMany, refreshOne } from "./sync";
import { resolveYouTubeSource } from "./youtube";
import { subscribeWebSub } from "./websub";
import { historyRoutes } from './history';
import { rssStorage } from './storage';

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
    group.use(historyRoutes(db, syncAuthorized))
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
          etag: string;
          lastModified: string;
        }> = [];
        for (const source of rows) {
          try {
            sources.push({
              id: source.id,
              title: source.alias || source.title,
              feedUrl: await canonicalFeed(db, source),
              etag: source.etag,
              lastModified: source.lastModified,
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
            const result = body.notModified ? {added:0,updated:0,unchanged:0,rowsWritten:0} : await ingest(db, source, body.feed);
            await db.update(rssSubscriptions).set({etag:body.etag ?? source.etag,lastModified:body.lastModified ?? source.lastModified,lastFetchedAt:new Date(),lastError:''}).where(eq(rssSubscriptions.id,source.id));
            try {
              await subscribeWebSub(db, source, new URL(request.url).origin);
            } catch {
              // The single daily reconciliation remains the fallback.
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
            notModified: t.Optional(t.Boolean()),
            etag: t.Optional(t.String({maxLength:500})),
            lastModified: t.Optional(t.String({maxLength:100})),
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
            await ingest(db, source, await request.text(), 'push');
          return "OK";
        } catch {
          set.status = 422;
          return "Invalid notification";
        }
      })
      .get("/storage", async ({ uid, lifeAccess, set }) => {
        if (!requireLife({ uid, lifeAccess, set }))
          return "Private Life access is required";
        return rssStorage(getEnv().DB, uid!);
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
          const years = await db.selectDistinct({year:sql<string>`strftime('%Y',${rssItems.publishedAt},'unixepoch')`}).from(rssItems).where(and(...conditions,sql`${rssItems.publishedPrecision} <> 'unknown'`)).orderBy(sql`1 DESC`);
          if (query.q?.trim()) {
            const needle = query.q.trim().slice(0,120);
            // Literal substring matching also avoids D1's short LIKE-pattern
            // byte limit for longer Chinese keywords.
            conditions.push(sql`(instr(lower(${rssItems.title}),lower(${needle}))>0 OR instr(lower(${rssItems.summary}),lower(${needle}))>0 OR instr(lower(${rssItems.author}),lower(${needle}))>0)`);
          }
          if (query.year === 'unknown') conditions.push(eq(rssItems.publishedPrecision,'unknown'));
          else if (query.year) {
            const year = Number(query.year);
            if (!Number.isInteger(year) || year < 2005 || year > 2100) { set.status=400; return 'Invalid year'; }
            conditions.push(sql`${rssItems.publishedAt} >= ${Math.floor(Date.UTC(year,0,1)/1000)} AND ${rssItems.publishedAt} < ${Math.floor(Date.UTC(year+1,0,1)/1000)} AND ${rssItems.publishedPrecision} <> 'unknown'`);
          }
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
            years: years.map(value=>value.year).filter(Boolean),
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
            q: t.Optional(t.String({maxLength:120})),
            year: t.Optional(t.String({maxLength:7})),
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

