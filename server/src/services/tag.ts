import { eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import type { DB } from "../_worker";
import { feedHashtags, hashtags } from "../db/schema";
import { getDB } from "../utils/di";
import { setup } from "../setup";

export function TagService() {
  const db: DB = getDB();
  return new Elysia({ aot: false }).use(setup()).group("/tag", (group) =>
    group
      .get(
        "/",
        async ({ admin, writer, uid, query }) => {
          const kind = query.kind || "article";
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
          });
        },
        {
          query: t.Object({
            kind: t.Optional(
              t.Union([t.Literal("article"), t.Literal("essay"), t.Literal("diary"), t.Literal("memo")]),
            ),
          }),
        },
      )
      .delete("/:name", async ({ admin, set, params: { name } }) => {
        if (!admin) {
          set.status = 403;
          return "Permission denied";
        }
        const nameDecoded = decodeURI(name);
        const tag = await db.query.hashtags.findFirst({
          where: eq(hashtags.name, nameDecoded),
        });
        if (!tag) {
          set.status = 404;
          return "Not found";
        }
        await db.delete(hashtags).where(eq(hashtags.id, tag.id));
        return "OK";
      }),
  );
}

export async function bindTagToPost(db: DB, feedId: number, tags: string[]) {
  await db.delete(feedHashtags).where(eq(feedHashtags.feedId, feedId));
  for (const tag of tags) {
    const tagId = await getTagIdOrCreate(db, tag);
    await db.insert(feedHashtags).values({
      feedId: feedId,
      hashtagId: tagId,
    });
  }
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
