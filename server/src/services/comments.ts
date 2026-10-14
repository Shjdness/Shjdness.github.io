import { desc, eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import type { DB } from "../_worker";
import type { Env } from "../db/db";
import { comments, feeds, users } from "../db/schema";
import { setup } from "../setup";
import { ServerConfig } from "../utils/cache";
import { Config } from "../utils/config";
import { getDB, getEnv } from "../utils/di";
import { notify } from "../utils/webhook";
import { canReadFeed } from "../utils/feed-permissions";

export function CommentService() {
    const db: DB = getDB();
    const env: Env = getEnv();
    return new Elysia({ aot: false })
        .use(setup())
        .group('/feed/comment', (group) =>
            group
                .get('/:feed', async ({ uid, admin, set, params: { feed } }) => {
                    const feedId = parseInt(feed);
                    const target = await db.query.feeds.findFirst({ where: eq(feeds.id, feedId) });
                    if (!target || !canReadFeed({ ownerId: target.uid, viewerId: uid, admin, draft: target.draft, kind: target.kind })) {
                        set.status = 404;
                        return 'Feed not found';
                    }
                    const comment_list = await db.query.comments.findMany({
                        where: eq(comments.feedId, feedId),
                        columns: { feedId: false, userId: false },
                        with: {
                            user: {
                                columns: { id: true, username: true, avatar: true, permission: true }
                            }
                        },
                        orderBy: [desc(comments.createdAt)]
                    });
                    return comment_list;
                })
                .post('/:feed', async ({ uid, admin, set, params: { feed }, body: { content } }) => {
                    if (!uid) {
                        set.status = 401;
                        return 'Unauthorized';
                    }
                    if (!content) {
                        set.status = 400;
                        return 'Content is required';
                    }
                    const feedId = parseInt(feed);
                    const userId = uid;
                    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
                    if (!user) {
                        set.status = 400;
                        return 'User not found';
                    }
                    const exist = await db.query.feeds.findFirst({ where: eq(feeds.id, feedId) });
                    if (!exist || !canReadFeed({ ownerId: exist.uid, viewerId: uid, admin, draft: exist.draft, kind: exist.kind })) {
                        set.status = 404;
                        return 'Feed not found';
                    }

                    await db.insert(comments).values({
                        feedId,
                        userId,
                        content
                    });

                    const webhookUrl = await ServerConfig().get(Config.webhookUrl) || env.WEBHOOK_URL;
                    // notify
                    await notify(webhookUrl, `${env.FRONTEND_URL}/feed/${feedId}\n${user.username} 评论了: ${exist.title}\n${content}`);
                    return 'OK';
                }, {
                    body: t.Object({
                        content: t.String({ minLength: 1, maxLength: 2000 })
                    })
                })
        )
        .group('/comment', (group) =>
            group
                .delete('/:id', async ({ uid, admin, set, params: { id } }) => {
                    if (uid === undefined) {
                        set.status = 401;
                        return 'Unauthorized';
                    }
                    const id_num = parseInt(id);
                    const comment = await db.query.comments.findFirst({ where: eq(comments.id, id_num) });
                    if (!comment) {
                        set.status = 404;
                        return 'Not found';
                    }
                    if (!admin && comment.userId !== uid) {
                        set.status = 403;
                        return 'Permission denied';
                    }
                    await db.delete(comments).where(eq(comments.id, id_num));
                    return 'OK';
                })
        );
}
