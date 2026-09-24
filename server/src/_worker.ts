import { drizzle, DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import 'reflect-metadata';
import Container from "typedi";
import type { Env } from "./db/db";
import * as schema from './db/schema';
import { app } from "./server";
import { CacheImpl } from "./utils/cache";
import { dbToken, envToken } from "./utils/di";
import { refreshSubscriptions } from "./services/rss";
export type DB = DrizzleD1Database<typeof import("./db/schema")>

export default {
    async fetch(
        request: Request,
        env: Env,
    ): Promise<Response> {
        const db = drizzle(env.DB, { schema: schema })
        Container.set(envToken, env)
        Container.set(dbToken, db)

        const exist = Container.has("cache")
        if (!exist) {
            Container.set("cache", new CacheImpl());
            Container.set("server.config", new CacheImpl("server.config"));
            Container.set("client.config", new CacheImpl("client.config"));
        }

        return await new Elysia({ aot: false })
            .use(app())
            .handle(request)
    },
    async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
        const database = drizzle(env.DB, { schema })
        Container.set(envToken, env)
        Container.set(dbToken, database)
        const subscriptions = await database.query.rssSubscriptions.findMany({ where: eq(schema.rssSubscriptions.active, 1) })
        await refreshSubscriptions(database, subscriptions)
    },
}
