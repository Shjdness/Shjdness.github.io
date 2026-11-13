import { and, count, desc, eq, gte, lt, or } from "drizzle-orm";
import Elysia, { t } from "elysia";
import type { DB } from "../_worker";
import { feeds, feedHashtags, hashtags, visits } from "../db/schema";
import { setup } from "../setup";
import { ClientConfig, PublicCache } from "../utils/cache";
import { getDB, getEnv } from "../utils/di";
import { reserveBackgroundWrites } from '../utils/write-budget';
import { allowBurst } from '../utils/rate-limit';
import { sql } from 'drizzle-orm';
import { extractImage } from "../utils/image";
import { canMutateFeed, canReadFeed } from "../utils/feed-permissions";
import { normalizeTagNames, prepareTagBinding, prepareTagIds } from "./tag";
import { createPostWithTags,findPostCreate,postRequestHash,PostCreateConflictError,deletePostWithReceipts } from '../utils/post-create';

const timelineVisibility = and(eq(feeds.draft, 0), eq(feeds.listed, 1),
  or(eq(feeds.kind, 'article'), eq(feeds.kind, 'essay')));
const timelineYear = t.String({ pattern: '^[0-9]{4}$' });
const timelineYearRange = (year: string) => {
  const start = new Date(`${year}-01-01T00:00:00+08:00`);
  const end = new Date(start);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  return and(gte(feeds.createdAt, start), lt(feeds.createdAt, end));
};

export function FeedService() {
  const db: DB = getDB();
  return new Elysia({ aot: false })
    .use(setup())
    .group("/feed", (group) =>
      group
        .get(
          "/",
          async ({
            admin,
            writer,
            uid,
            set,
            query: { page, limit, type, contentType },
          }) => {
            const privateList = type === "draft";
            if (privateList && !writer) {
              set.status = 403;
              return "Permission denied";
            }
            const cache = PublicCache();
            const page_num = (page ? (page > 0 ? page : 1) : 1) - 1;
            const limit_num = limit ? (+limit > 50 ? 50 : +limit) : 20;
            const cacheKey = `feeds_${type}_${contentType || "all"}_${page_num}_${limit_num}`;
            const loadPage=async()=>{
            const visibility =
              type === "draft"
                ? eq(feeds.draft, 1)
                : and(eq(feeds.draft, 0), eq(feeds.listed, 1));
            const contentFilter =
              contentType === "normal" ? or(eq(feeds.kind, "article"), eq(feeds.kind, "essay")) : undefined;
            const ownerFilter =
              privateList && !admin ? eq(feeds.uid, uid!) : undefined;
            const where = and(visibility, ownerFilter, contentFilter);
            const size = await db
              .select({ count: count() })
              .from(feeds)
              .where(where);
            if (size[0].count === 0) {
              return {
                size: 0,
                data: [],
                hasNext: false,
              };
            }
            const feed_list = (
              await db.query.feeds.findMany({
                where: where,
                columns:
                  admin || privateList
                    ? undefined
                    : {
                        draft: false,
                        listed: false,
                      },
                with: {
                  hashtags: {
                    columns: {},
                    with: {
                      hashtag: {
                        columns: { id: true, name: true },
                      },
                    },
                  },
                  user: {
                    columns: { id: true, username: true, avatar: true },
                  },
                },
                orderBy: [
                  desc(feeds.top),
                  desc(feeds.createdAt),
                  desc(feeds.updatedAt),
                ],
                offset: page_num * limit_num,
                limit: limit_num + 1,
              })
            ).map(({ content, hashtags, summary, ...other }) => {
              // 提取首图
              const avatar = extractImage(content);
              return {
                summary:
                  summary.length > 0
                    ? summary
                    : content.length > 100
                      ? content.slice(0, 100)
                      : content,
                hashtags: hashtags.map(({ hashtag }) => hashtag),
                avatar,
                ...other,
              };
            });
            let hasNext = false;
            if (feed_list.length === limit_num + 1) {
              feed_list.pop();
              hasNext = true;
            }
            const data = {
              size: size[0].count,
              data: feed_list,
              hasNext,
            };
            return data;
            };
            return privateList ? loadPage() : cache.getOrSet(cacheKey,loadPage);
          },
          {
            query: t.Object({
              page: t.Optional(t.Numeric({minimum:1,maximum:10000,multipleOf:1})),
              limit: t.Optional(t.Numeric({minimum:1,maximum:50,multipleOf:1})),
              type: t.Optional(t.Union([t.Literal('draft'),t.Literal('normal')])),
              contentType: t.Optional(t.Literal("normal")),
            }),
          },
        )
        .get("/timeline/options", async () => {
          const year = sql<string>`strftime('%Y', ${feeds.createdAt}, 'unixepoch', '+8 hours')`;
          const [years, tags] = await Promise.all([
            db.select({ year }).from(feeds).where(timelineVisibility).groupBy(year).orderBy(desc(year)),
            db.selectDistinct({ name: hashtags.name }).from(feeds)
              .innerJoin(feedHashtags, eq(feeds.id, feedHashtags.feedId))
              .innerJoin(hashtags, eq(feedHashtags.hashtagId, hashtags.id))
              .where(timelineVisibility).orderBy(hashtags.name),
          ]);
          return { years: years.map(row => row.year), tags: tags.map(row => row.name) };
        })
        .get("/timeline/activity", async ({ query }) => {
          const day = sql<string>`date(${feeds.createdAt}, 'unixepoch', '+8 hours')`;
          const rows = await db.select({ day, count: count() }).from(feeds)
            .where(and(timelineVisibility, timelineYearRange(query.year))).groupBy(day);
          return { days: rows };
        }, { query: t.Object({ year: timelineYear }) })
        .get("/timeline/page", async ({ query, set }) => {
          const limit = query.limit ?? 24;
          const tags = [...new Set(query.tags ?? [])];
          const cursor = query.before?.split(':').map(Number);
          if (cursor && (!Number.isSafeInteger(cursor[0]) || !Number.isSafeInteger(cursor[1])
            || !Number.isFinite(new Date(cursor[0] * 1000).getTime()))) {
            set.status = 400;
            return 'Invalid timeline cursor';
          }
          const before = cursor ? new Date(cursor[0] * 1000) : undefined;
          const where = and(timelineVisibility, query.year ? timelineYearRange(query.year) : undefined,
            before && cursor ? or(lt(feeds.createdAt, before),
              and(eq(feeds.createdAt, before), lt(feeds.id, cursor[1]))) : undefined,
            ...tags.map(tag => sql`EXISTS (SELECT 1 FROM ${feedHashtags} JOIN ${hashtags}
              ON ${hashtags.id} = ${feedHashtags.hashtagId}
              WHERE ${feedHashtags.feedId} = ${feeds.id} AND ${hashtags.name} = ${tag})`));
          const rows = await db.select({ id: feeds.id, title: feeds.title, createdAt: feeds.createdAt })
            .from(feeds).where(where).orderBy(desc(feeds.createdAt), desc(feeds.id)).limit(limit + 1);
          const items = rows.slice(0, limit);
          const tail = items.at(-1);
          return { items, next: rows.length > limit && tail ? `${tail.createdAt.getTime() / 1000}:${tail.id}` : null };
        }, { query: t.Object({
          year: t.Optional(timelineYear),
          before: t.Optional(t.String({ maxLength: 40, pattern: '^-?[0-9]+:[1-9][0-9]*$' })),
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50, multipleOf: 1 })),
          tags: t.Optional(t.ArrayString(t.String({ minLength: 1, maxLength: 100 }), { maxItems: 30 })),
        }) })
        .get("/timeline", async () => {
          return (
            await db.query.feeds.findMany({
              where: timelineVisibility,
              columns: {
                id: true,
                title: true,
                createdAt: true,
              },
              with: {
                hashtags: {
                  columns: {},
                  with: { hashtag: { columns: { name: true } } },
                },
              },
              orderBy: [desc(feeds.createdAt), desc(feeds.updatedAt)],
            })
          ).map(({ hashtags, ...feed }) => ({
            ...feed,
            hashtags: hashtags.map(({ hashtag }) => hashtag),
          }));
        })
        .get("/diary", async ({ uid, writer, admin, set }) => {
          if (!uid || (!writer && !admin)) {
            set.status = 403;
            return "Permission denied";
          }
          return (
            await db.query.feeds.findMany({
              where: and(
                eq(feeds.uid, uid),
                eq(feeds.kind, "diary"),
                eq(feeds.draft, 0),
              ),
              with: {
                hashtags: {
                  columns: {},
                  with: { hashtag: { columns: { id: true, name: true } } },
                },
                user: { columns: { id: true, username: true, avatar: true } },
              },
              orderBy: [desc(feeds.createdAt), desc(feeds.updatedAt)],
            })
          ).map(({ hashtags, ...feed }) => ({
            ...feed,
            hashtags: hashtags.map(({ hashtag }) => hashtag),
          }));
        })
        .get("/memo", async ({ uid, writer, admin, set }) => {
          if (!uid || (!writer && !admin)) {
            set.status = 403;
            return "Permission denied";
          }
          return (
            await db.query.feeds.findMany({
              where: and(eq(feeds.uid, uid), eq(feeds.kind, "memo"), eq(feeds.draft, 0)),
              with: {
                hashtags: { columns: {}, with: { hashtag: { columns: { id: true, name: true } } } },
                user: { columns: { id: true, username: true, avatar: true } },
              },
              orderBy: [desc(feeds.updatedAt), desc(feeds.createdAt)],
            })
          ).map(({ content, hashtags, summary, ...feed }) => ({
            ...feed,
            content,
            summary: summary || (content.length > 160 ? `${content.slice(0, 160)}…` : content),
            hashtags: hashtags.map(({ hashtag }) => hashtag),
          }));
        })
        .get("/drafts", async ({ uid, writer, admin, set }) => {
          if (!uid || (!writer && !admin)) {
            set.status = 403;
            return "Permission denied";
          }
          const ownerFilter = admin ? undefined : eq(feeds.uid, uid);
          return (
            await db.query.feeds.findMany({
              where: and(eq(feeds.draft, 1), ownerFilter),
              with: {
                hashtags: { columns: {}, with: { hashtag: { columns: { id: true, name: true } } } },
                user: { columns: { id: true, username: true, avatar: true } },
              },
              orderBy: [desc(feeds.updatedAt), desc(feeds.createdAt)],
            })
          ).map(({ content, hashtags, summary, ...feed }) => ({
            ...feed,
            summary: summary || (content.length > 100 ? `${content.slice(0, 100)}…` : content),
            avatar: extractImage(content),
            hashtags: hashtags.map(({ hashtag }) => hashtag),
          }));
        })
        .post(
          "/",
          async ({
            writer,
            set,
            uid,
            body: {
              title,
              alias,
              content,
              summary,
              draft,
              kind,
              tags,
              createdAt,
              clientKey,
            },
          }) => {
            if (!writer || !uid) {
              set.status = 403;
              return "Permission denied";
            }
            const normalizedTags = normalizeTagNames(tags);
            if (!normalizedTags) { set.status = 400; return "Invalid tags"; }
            // input check
            if (!draft && !title) {
              set.status = 400;
              return "Title is required";
            }
            if (!draft && !content) {
              set.status = 400;
              return "Content is required";
            }

            const normalizedKind = kind === "diary" || kind === "essay" || kind === "memo" ? kind : "article";
            const operation=clientKey?{ownerId:uid,clientKey,requestHash:await postRequestHash({
              title:title||'未命名草稿',content:content||'',summary,alias:alias??null,draft,kind:normalizedKind,
              tags:[...normalizedTags].sort(),createdAt:createdAt?new Date(createdAt).toISOString():null,
            })}:undefined;
            if(operation) {
              try{const saved=await findPostCreate(getEnv().DB,operation);if(saved){await PublicCache().deletePrefix('feeds_');return saved;}}
              catch(error){if(error instanceof PostCreateConflictError){set.status=409;return error.message;}throw error;}
            }
            // check exist
            const exist = draft
              ? null
              : await db.query.feeds.findFirst({
                  // Duplicate checks must not disclose another account's private
                  // title/content through a different create response.
                  where: and(eq(feeds.uid, uid), or(eq(feeds.title, title), eq(feeds.content, content))),
                });
            if (exist) {
              if(operation) {
                try{const saved=await findPostCreate(getEnv().DB,operation);if(saved){await PublicCache().deletePrefix('feeds_');return saved;}}
                catch(error){if(error instanceof PostCreateConflictError){set.status=409;return error.message;}throw error;}
              }
              set.status = 400;
              return "Content already exists";
            }
            const date = createdAt ? new Date(createdAt) : new Date();
            const privateKind = normalizedKind === "diary" || normalizedKind === "memo";
            const tagIds=await prepareTagIds(db, uid, normalizedKind, normalizedTags);
            const insert = db
              .insert(feeds)
              .values({
                title: title || "未命名草稿",
                content: content || "",
                summary,
                uid,
                alias,
                listed: privateKind || draft ? 0 : 1,
                draft: draft ? 1 : 0,
                kind: normalizedKind,
                createdAt: date,
                updatedAt: date,
              })
              .returning({ id: feeds.id }).toSQL();
            let result:{insertedId:number};
            try{result=await createPostWithTags(getEnv().DB,insert,tagIds,operation);}
            catch(error){if(error instanceof PostCreateConflictError){set.status=409;return error.message;}throw error;}
            await PublicCache().deletePrefix("feeds_");
            return result;
          },
          {
            body: t.Object({
              title: t.String({maxLength:500}),
              content: t.String({maxLength:1000000}),
              summary: t.String({maxLength:5000}),
              alias: t.Optional(t.String({maxLength:200})),
              draft: t.Boolean(),
              listed: t.Optional(t.Boolean()),
              createdAt: t.Optional(t.Date()),
              tags: t.Array(t.String({maxLength:64}),{maxItems:20}),
              clientKey:t.Optional(t.String({pattern:'^[A-Za-z0-9_-]{16,80}$'})),
              kind: t.Optional(
                t.Union([t.Literal("article"), t.Literal("essay"), t.Literal("diary"), t.Literal("memo")]),
              ),
            }),
          },
        )
        .get("/:id", async ({ uid, admin, set, headers, params: { id } }) => {
          const id_num = parseInt(id);
          const feed = await db.query.feeds.findFirst({
              where: or(eq(feeds.id, id_num), eq(feeds.alias, id)),
              with: {
                hashtags: {
                  columns: {},
                  with: {
                    hashtag: {
                      columns: { id: true, name: true },
                    },
                  },
                },
                user: {
                  columns: { id: true, username: true, avatar: true },
                },
              },
            });
          if (!feed) {
            set.status = 404;
            return "Not found";
          }
          // permission check
          if (!canReadFeed({ ownerId: feed.uid, viewerId: uid, admin, draft: feed.draft, kind: feed.kind })) {
            set.status = 403;
            return "Permission denied";
          }

          const { hashtags, ...other } = feed;
          const hashtags_flatten = hashtags.map((f) => f.hashtag);

          // update visits
          const config = ClientConfig();
          const enableVisit = await config.getOrDefault(
            "counter.enabled",
            true,
          );
          let pv = 0;
          let uv = 0;
          if (enableVisit) {
            const ip =
              headers["cf-connecting-ip"] || headers["x-real-ip"] || "UNK";
            if(allowBurst(`visit:${feed.id}:${ip}`,1)) {
              try {
                await reserveBackgroundWrites(getEnv().DB,'visits',8,8000);
                await db.insert(visits).values({feedId:feed.id,ip});
              } catch { /* Optional statistics must never block article reading. */ }
            }
            const [visit] = await db.select({pv:sql<number>`count(*)`,uv:sql<number>`count(distinct ${visits.ip})`}).from(visits).where(eq(visits.feedId,feed.id));
            pv = visit?.pv || 0;
            uv = visit?.uv || 0;
          }
          const data = {
            ...other,
            hashtags: hashtags_flatten,
            pv,
            uv,
          };
          return data;
        })
        .post(
          "/:id",
          async ({
            admin,
            writer,
            set,
            uid,
            params: { id },
            body: {
              title,
              content,
              summary,
              alias,
              draft,
              kind,
              top,
              tags,
              createdAt,
            },
          }) => {
            const id_num = parseInt(id);
            const feed = await db.query.feeds.findFirst({
              where: eq(feeds.id, id_num),
              with: {
                hashtags: {
                  columns: {},
                  with: { hashtag: { columns: { name: true } } },
                },
              },
            });
            if (!feed) {
              set.status = 404;
              return "Not found";
            }
            if (!canMutateFeed({ ownerId: feed.uid, viewerId: uid, admin, writer })) {
              set.status = 403;
              return "Permission denied";
            }
            const normalizedTags = tags === undefined ? undefined : normalizeTagNames(tags);
            if (normalizedTags === null) { set.status = 400; return "Invalid tags"; }
            const nextKind = kind === "diary" || kind === "essay" || kind === "memo" || kind === "article" ? kind : feed.kind;
            const privateKind = nextKind === "diary" || nextKind === "memo";
            const update = db
              .update(feeds)
              .set({
                title,
                content,
                summary,
                alias,
                top: admin ? top : undefined,
                listed: privateKind || draft === true ? 0 : 1,
                draft: draft === undefined ? undefined : draft ? 1 : 0,
                kind: nextKind,
                createdAt: createdAt ? new Date(createdAt) : undefined,
                updatedAt: new Date(),
              })
              .where(eq(feeds.id, id_num));
            if (normalizedTags !== undefined) {
              const binding = await prepareTagBinding(db, id_num, feed.uid, nextKind, normalizedTags);
              await db.batch([update, ...binding]);
            } else await update;
            await clearFeedCache(id_num, feed.alias, alias || null);
            return "Updated";
          },
          {
            body: t.Object({
              title: t.Optional(t.String({maxLength:500})),
              alias: t.Optional(t.String({maxLength:200})),
              content: t.Optional(t.String({maxLength:1000000})),
              summary: t.Optional(t.String({maxLength:5000})),
              listed: t.Optional(t.Boolean()),
              draft: t.Optional(t.Boolean()),
              createdAt: t.Optional(t.Date()),
              tags: t.Optional(t.Array(t.String({maxLength:64}),{maxItems:20})),
              kind: t.Optional(
                t.Union([t.Literal("article"), t.Literal("essay"), t.Literal("diary"), t.Literal("memo")]),
              ),
              top: t.Optional(t.Integer()),
            }),
          },
        )
        .post(
          "/top/:id",
          async ({ admin, set, params: { id }, body: { top } }) => {
            if (!admin) {
              set.status = 403;
              return "Permission denied";
            }
            const id_num = parseInt(id);
            const feed = await db.query.feeds.findFirst({
              where: eq(feeds.id, id_num),
            });
            if (!feed) {
              set.status = 404;
              return "Not found";
            }
            await db
              .update(feeds)
              .set({
                top,
              })
              .where(eq(feeds.id, feed.id));
            await clearFeedCache(feed.id, null, null);
            return "Updated";
          },
          {
            body: t.Object({
              top: t.Integer(),
            }),
          },
        )
        .delete("/:id", async ({ admin, writer, set, uid, params: { id }, query: {draftOnly} }) => {
          const id_num = parseInt(id);
          const feed = await db.query.feeds.findFirst({
            where: eq(feeds.id, id_num),
          });
          if (!feed) {
            set.status = 404;
            return "Not found";
          }
          if (!canMutateFeed({ ownerId: feed.uid, viewerId: uid, admin, writer })) {
            set.status = 403;
            return "Permission denied";
          }
          const deleted=await deletePostWithReceipts(getEnv().DB,feed.uid,id_num,draftOnly==='1');
          if(draftOnly==='1'&&!deleted) {
            set.status=409;
            return '草稿状态已变化，未执行删除；请保留本地内容并核对云端记录';
          }
          await clearFeedCache(id_num, feed.alias, null);
          return "Deleted";
        },{query:t.Object({draftOnly:t.Optional(t.Literal('1'))})}),
    );
}

async function clearFeedCache(
  id: number,
  alias: string | null,
  newAlias: string | null,
) {
  const cache = PublicCache();
  await cache.deletePrefix("feeds_");
  await cache.delete(`feed_${id}`, false);
  if (alias === newAlias) return;
  if (alias) await cache.delete(`feed_${alias}`, false);
  if (newAlias) await cache.delete(`feed_${newAlias}`, false);
}
