import { relations, sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const created_at = integer("created_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull();
const updated_at = integer("updated_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull();

export const feeds = sqliteTable("feeds", {
    id: integer("id").primaryKey(),
    alias: text("alias"),
    title: text("title"),
    summary: text("summary").default("").notNull(),
    content: text("content").notNull(),
    listed: integer("listed").default(1).notNull(),
    draft: integer("draft").default(1).notNull(),
    top: integer("top").default(0).notNull(),
    uid: integer("uid").references(() => users.id).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const visits = sqliteTable("visits", {
    id: integer("id").primaryKey(),
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    ip: text("ip").notNull(),
    createdAt: created_at,
});

export const info = sqliteTable("info", {
    key: text("key").notNull().unique(),
    value: text("value").notNull(),
});

export const users = sqliteTable("users", {
    id: integer("id").primaryKey(),
    username: text("username").notNull(),
    openid: text("openid").notNull(),
    avatar: text("avatar"),
    permission: integer("permission").default(0),
    // A trusted invitation can later have a bounded lifetime without changing
    // the role contract. Null means the access does not expire.
    accessExpiresAt: integer("access_expires_at", { mode: 'timestamp' }),
    createdAt: created_at,
    updatedAt: updated_at,
});

/**
 * A small, user-owned preference store for the appearance controls.  This is
 * deliberately separate from the public client configuration: a visitor's
 * view can retain the site default while each signed-in person keeps their own
 * visual preferences across devices.
 */
export const appearancePreferences = sqliteTable("appearance_preferences", {
    id: integer("id").primaryKey(),
    userId: integer("user_id").references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
    settings: text("settings").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const habits = sqliteTable("habits", {
    id: integer("id").primaryKey(),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    color: text("color").default("#e11d62").notNull(),
    active: integer("active").default(1).notNull(),
    clientKey: text("client_key"),
    createdAt: created_at,
    updatedAt: updated_at,
}, table => ({ ownerClientKey: uniqueIndex("habits_owner_client_key").on(table.ownerId, table.clientKey) }));

export const habitLogs = sqliteTable("habit_logs", {
    id: integer("id").primaryKey(),
    habitId: integer("habit_id").references(() => habits.id, { onDelete: 'cascade' }).notNull(),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    date: text("date").notNull(),
    completed: integer("completed").default(1).notNull(),
    note: text("note").default("").notNull(),
    source: text("source").default("manual").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const lifeDailyNotes = sqliteTable("life_daily_notes", {
    id: integer("id").primaryKey(),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    date: text("date").notNull(),
    content: text("content").default("").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, table => ({ ownerDate: uniqueIndex("life_daily_notes_owner_date").on(table.ownerId, table.date) }));

export const dailyBasics = sqliteTable("daily_basics", {
    id: integer("id").primaryKey(),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    date: text("date").notNull(),
    content: text("content").notNull(),
    completed: integer("completed").default(0).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    clientKey: text("client_key"),
    createdAt: created_at,
    updatedAt: updated_at,
}, table => ({
    ownerClientKey: uniqueIndex("daily_basics_owner_client_key").on(table.ownerId, table.clientKey),
    ownerDateContent: uniqueIndex("daily_basics_owner_date_content").on(table.ownerId, table.date, table.content),
}));

export const pomodoroSessions = sqliteTable("pomodoro_sessions", {
    id: integer("id").primaryKey(),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    startedAt: integer("started_at", { mode: 'timestamp' }).notNull(),
    endedAt: integer("ended_at", { mode: 'timestamp' }).notNull(),
    focusMinutes: integer("focus_minutes").notNull(),
    breakMinutes: integer("break_minutes").default(5).notNull(),
    roundIndex: integer("round_index").default(1).notNull(),
    completed: integer("completed").default(1).notNull(),
    taskName: text("task_name").default("").notNull(),
    completedEarly: integer("completed_early").default(0).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

/** Private RSS reader: subscriptions and entries are always owned by one Life user. */
export const rssSubscriptions = sqliteTable("rss_subscriptions", {
    id: integer("id").primaryKey(),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    feedUrl: text("feed_url").notNull(),
    title: text("title").default("").notNull(),
    siteUrl: text("site_url").default("").notNull(),
    favicon: text("favicon").default("").notNull(),
    sourceUrl: text("source_url").default("").notNull(),
    provider: text("provider").default("manual").notNull(),
    platform: text("platform").default("other").notNull(),
    externalId: text("external_id").default("").notNull(),
    alias: text("alias").default("").notNull(),
    description: text("description").default("").notNull(),
    category: text("category").default("其他").notNull(),
    contentType: text("content_type").default("text").notNull(),
    active: integer("active").default(1).notNull(),
    etag: text("etag").default("").notNull(),
    lastModified: text("last_modified").default("").notNull(),
    lastFetchedAt: integer("last_fetched_at", { mode: 'timestamp' }),
    lastError: text("last_error").default("").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const rssSourceGroups = sqliteTable("rss_source_groups", {
    id: integer("id").primaryKey(),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, table => ({ ownerName: uniqueIndex("rss_source_groups_owner_name").on(table.ownerId, table.name) }));

export const rssItems = sqliteTable("rss_items", {
    id: integer("id").primaryKey(),
    subscriptionId: integer("subscription_id").references(() => rssSubscriptions.id, { onDelete: 'cascade' }).notNull(),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    summary: text("summary").default("").notNull(),
    author: text("author").default("").notNull(),
    mediaType: text("media_type").default("text").notNull(),
    mediaUrl: text("media_url").default("").notNull(),
    embedUrl: text("embed_url").default("").notNull(),
    thumbnailUrl: text("thumbnail_url").default("").notNull(),
    duration: integer("duration").default(0).notNull(),
    contentHtml: text("content_html").default("").notNull(),
    publishedAt: integer("published_at", { mode: 'timestamp' }).notNull(),
    read: integer("read").default(0).notNull(),
    starred: integer("starred").default(0).notNull(),
    readAt: integer("read_at", { mode: 'timestamp' }),
    starredAt: integer("starred_at", { mode: 'timestamp' }),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const comments = sqliteTable("comments", {
    id: integer("id").primaryKey(),
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    userId: integer("user_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    content: text("content").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const hashtags = sqliteTable("hashtags", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const feedHashtags = sqliteTable("feed_hashtags", {
    feedId: integer("feed_id").references(() => feeds.id, { onDelete: 'cascade' }).notNull(),
    hashtagId: integer("hashtag_id").references(() => hashtags.id, { onDelete: 'cascade' }).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
});

export const feedsRelations = relations(feeds, ({ many, one }) => ({
    hashtags: many(feedHashtags),
    user: one(users, {
        fields: [feeds.uid],
        references: [users.id],
    }),
    comments: many(comments),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
    feed: one(feeds, {
        fields: [comments.feedId],
        references: [feeds.id],
    }),
    user: one(users, {
        fields: [comments.userId],
        references: [users.id],
    }),
}));

export const hashtagsRelations = relations(hashtags, ({ many }) => ({
    feeds: many(feedHashtags),
}));

export const feedHashtagsRelations = relations(feedHashtags, ({ one }) => ({
    feed: one(feeds, {
        fields: [feedHashtags.feedId],
        references: [feeds.id],
    }),
    hashtag: one(hashtags, {
        fields: [feedHashtags.hashtagId],
        references: [hashtags.id],
    }),
}));
