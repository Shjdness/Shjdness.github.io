import { and, asc, eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import type { DB } from "../_worker";
import { feedHashtags, hashtags, writingTagOptions } from "../db/schema";
import { getDB } from "../utils/di";
import { setup } from "../setup";

export function TagService() {
  const db: DB = getDB();
  return new Elysia({ aot: false }).use(setup()).group("/tag", (group) =>
    group
      .get("/options", async ({ uid, writer, admin, query, set }) => {
        if (!uid || (!writer && !admin)) { set.status = 403; return "Permission denied"; }
        return db.select({ name: writingTagOptions.name }).from(writingTagOptions)
          .where(and(eq(writingTagOptions.ownerId, uid), eq(writingTagOptions.scope, query.scope)))
          .orderBy(asc(writingTagOptions.name));
      }, { query: t.Object({ scope: t.Union([t.Literal("blog"), t.Literal("diary"), t.Literal("memo")]) }) })
      .post("/options", async ({ uid, writer, admin, body, set }) => {
        if (!uid || (!writer && !admin)) { set.status = 403; return "Permission denied"; }
        const name = normalizeTagName(body.name);
        if (!name) { set.status = 400; return "Invalid tag name"; }
        await db.insert(writingTagOptions).values({ ownerId: uid, scope: body.scope, name }).onConflictDoNothing();
        return { name };
      }, { body: t.Object({ scope: t.Union([t.Literal("blog"), t.Literal("diary"), t.Literal("memo")]), name: t.String() }) })
      .get(
        "/",
        async ({ admin, writer, uid, query }) => {
          const kind = query.kind || "article";
          if ((kind === 'diary' || kind === 'memo') && (!uid || (!writer && !admin))) return [];
          const tag_list = await db.query.hashtags.findMany({
            with: {
              feeds: {
                with: {
                  feed: {
                    columns: {
                      uid: true,
                      draft: true,
                      listed: true,
                      kind: true,
                    },
                  },
                },
              },
            },
          });
          return tag_list.map((tag) => {
            return {
              ...tag,
              feeds: tag.feeds.filter(({ feed }) => {
                if (kind === "article" ? !["article", "essay"].includes(feed.kind) : feed.kind !== kind) return false;
                if (uid && (admin || writer)) return feed.uid === uid;
                return feed.draft === 0 && feed.listed === 1;
              }).length,
            };
          }).filter(tag => tag.feeds > 0);
        },
        {
          query: t.Object({
            kind: t.Optional(
              t.Union([t.Literal("article"), t.Literal("essay"), t.Literal("diary"), t.Literal("memo")]),
            ),
          }),
        },
      )
      .delete("/:name", ({ set }) => { set.status = 409; return "Edit the related posts to remove this tag"; }),
  );
}

export function normalizeTagName(value: string): string | null {
  const name = value.trim().replace(/^#/, '').trim();
  return name && name.length <= 64 && !/[#\u0000-\u001f\u007f]/.test(name) ? name : null;
}

export function normalizeTagNames(tags: string[]): string[] | null {
  const names = tags.map(normalizeTagName);
  if (names.includes(null) || names.length > 20) return null;
  return [...new Set(names as string[])];
}

export async function bindTagToPost(db: DB, feedId: number, ownerId: number, kind: string, tags: string[]) {
  const scope = kind === 'diary' || kind === 'memo' ? kind : 'blog';
  const names = normalizeTagNames(tags);
  if (!names) throw new Error('Invalid tags');
  for (const name of names) {
    await db.insert(writingTagOptions).values({ ownerId, scope, name }).onConflictDoNothing();
  }
  const tagIds: number[] = [];
  for (const name of names) tagIds.push(await getTagIdOrCreate(db, name));
  await db.batch([
    db.delete(feedHashtags).where(eq(feedHashtags.feedId, feedId)),
    ...tagIds.map(hashtagId => db.insert(feedHashtags).values({ feedId, hashtagId })),
  ]);
}

async function getTagByName(db: DB, name: string) {
  return await db.query.hashtags.findFirst({ where: eq(hashtags.name, name) });
}

async function getTagIdOrCreate(db: DB, name: string) {
  const tag = await getTagByName(db, name);
  if (tag) {
    return tag.id;
  } else {
    const result = await db
      .insert(hashtags)
      .values({
        name,
      })
      .returning({ insertedId: hashtags.id });
    if (result.length === 0) {
      throw new Error("Failed to insert");
    } else {
      return result[0].insertedId;
    }
  }
}
