import { relations, sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

const created_at = integer("created_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull();
const updated_at = integer("updated_at", { mode: 'timestamp' }).default(sql`(unixepoch())`).notNull();

const checkinFields=()=>({ownerId:integer('owner_id').notNull().references(()=>users.id,{onDelete:'cascade'}),recordDate:text('record_date').notNull(),revision:integer('revision').notNull(),clientKey:text('client_key').notNull(),sealedJson:text('sealed_json').notNull(),contentHmac:text('content_hmac').notNull(),updatedAt:integer('updated_at').notNull()});
export const lifeCheckins=sqliteTable('life_checkins',checkinFields(),t=>({pk:primaryKey({columns:[t.ownerId,t.recordDate]})}));
export const lifeCheckinRevisions=sqliteTable('life_checkin_revisions',checkinFields(),t=>({pk:primaryKey({columns:[t.ownerId,t.recordDate,t.revision]})}));
export const lifeReportCheckinSnapshots=sqliteTable('life_report_checkin_snapshots',{
 reportId:integer('report_id').primaryKey().references(()=>lifeReports.id,{onDelete:'cascade'}),ownerId:integer('owner_id').notNull().references(()=>users.id,{onDelete:'cascade'}),reportSha256:text('report_sha256').notNull(),version:integer('version').notNull(),outboundEligible:integer('outbound_eligible').notNull().default(0),sealedJson:text('sealed_json').notNull(),contentHmac:text('content_hmac').notNull(),createdAt:integer('created_at').notNull(),
});
export const lifeReportCheckinAnalyses=sqliteTable('life_report_checkin_analyses',{
 requestKey:text('request_key').primaryKey(),ownerId:integer('owner_id').notNull().references(()=>users.id,{onDelete:'cascade'}),reportId:integer('report_id').notNull().references(()=>lifeReports.id,{onDelete:'cascade'}),reportSha256:text('report_sha256').notNull(),snapshotHmac:text('snapshot_hmac').notNull(),scopeVersion:integer('scope_version').notNull(),claimToken:text('claim_token').notNull(),state:text('state').notNull(),reason:text('reason'),sealedJson:text('sealed_json'),resultHmac:text('result_hmac'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull(),
},t=>({ownerReport:uniqueIndex('life_report_checkin_analysis_owner').on(t.ownerId,t.reportId)}));

export const feeds = sqliteTable("feeds", {
    id: integer("id").primaryKey(),
    alias: text("alias"),
    title: text("title"),
    summary: text("summary").default("").notNull(),
    content: text("content").notNull(),
    listed: integer("listed").default(1).notNull(),
    draft: integer("draft").default(1).notNull(),
    kind: text("kind").default("article").notNull(),
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
 * Retired appearance preferences remain available in historical backups. This is
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
    revision: integer('revision').notNull().default(0),
    id: integer("id").primaryKey(),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    date: text("date").notNull(),
    content: text("content").default("").notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, table => ({ ownerDate: uniqueIndex("life_daily_notes_owner_date").on(table.ownerId, table.date) }));

/** Optional private reports; no provider credentials or diary bodies belong here. */
export const lifeReportPreferences = sqliteTable('life_report_preferences', {
    ownerId: integer('owner_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    dailyTime: text('daily_time').notNull().default('08:00'),
    weeklyTime: text('weekly_time').notNull().default('08:00'),
    weeklyDay: integer('weekly_day').notNull().default(1),
    dailyEnabled: integer('daily_enabled').notNull().default(0),
    weeklyEnabled: integer('weekly_enabled').notNull().default(0),
    emailEnabled: integer('email_enabled').notNull().default(0),
    aiEnabled: integer('ai_enabled').notNull().default(0),
    aiScope: text('ai_scope').notNull().default('statistics'),
    revision: integer('revision').notNull().default(0),
    updatedAt: updated_at,
});

export const lifeReports = sqliteTable('life_reports', {
    id: integer('id').primaryKey(),
    ownerId: integer('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    periodStart: integer('period_start', {mode:'timestamp'}).notNull(),
    periodEnd: integer('period_end', {mode:'timestamp'}).notNull(),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    templateVersion: integer('template_version').notNull().default(1),
    snapshotJson: text('snapshot_json').notNull(),
    snapshotSha256: text('snapshot_sha256').notNull(),
    createdAt: created_at,
}, table=>({ownerPeriod:uniqueIndex('life_reports_owner_period_version').on(table.ownerId,table.kind,table.periodStart,table.periodEnd,table.templateVersion)}));

/** Durable call/results only; global spend receipts stay outside personal backups. */
export const lifeReportAnalyses = sqliteTable('life_report_analyses', {
    requestKey: text('request_key').primaryKey(),
    ownerId: integer('owner_id').notNull().references(() => users.id, {onDelete:'cascade'}),
    reportId: integer('report_id').notNull().references(() => lifeReports.id, {onDelete:'cascade'}),
    snapshotSha256: text('snapshot_sha256').notNull(),
    model: text('model').notNull(),
    promptVersion: integer('prompt_version').notNull().default(1),
    state: text('state').notNull(),
    reason: text('reason'),
    analysisJson: text('analysis_json'),
    analysisSha256: text('analysis_sha256'),
    createdAt: created_at,
    updatedAt: updated_at,
}, table=>({reportModel:uniqueIndex('life_report_analyses_report_model').on(table.ownerId,table.reportId,table.model,table.promptVersion)}));

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

export const lifeTodos = sqliteTable("life_todos", {
    id: integer("id").primaryKey(),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    content: text("content").notNull(),
    type: text("type").default("task").notNull(),
    completed: integer("completed").default(0).notNull(),
    clientKey: text("client_key"),
    deadlineAt: integer("deadline_at", { mode: 'timestamp' }),
    completedAt: integer("completed_at", { mode: 'timestamp' }),
    sortOrder: integer("sort_order").default(0).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, table => ({ ownerClientKey: uniqueIndex("life_todos_owner_client_key").on(table.ownerId, table.clientKey) }));

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
    todoId: integer("todo_id").references(() => lifeTodos.id, { onDelete: 'set null' }),
    clientKey: text("client_key"),
    completedEarly: integer("completed_early").default(0).notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, table => ({ ownerClientKey: uniqueIndex("pomodoro_sessions_owner_client_key").on(table.ownerId, table.clientKey) }));

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
    active: integer("active").default(1).notNull(),
    etag: text("etag").default("").notNull(),
    lastModified: text("last_modified").default("").notNull(),
    lastFetchedAt: integer("last_fetched_at", { mode: 'timestamp' }),
    lastError: text("last_error").default("").notNull(),
    websubKey: text("websub_key").default("").notNull(),
    websubCallback: text("websub_callback").default("").notNull(),
    websubLeaseExpiresAt: integer("websub_lease_expires_at", { mode: 'timestamp' }),
    historyPolicy: text("history_policy").default('').notNull(),
    historyReason: text("history_reason").default('').notNull(),
    historyStatus: text("history_status").default('pending').notNull(),
    historyCheckedAt: integer("history_checked_at", { mode: 'timestamp' }),
    historyError: text("history_error").default('').notNull(),
    createdAt: created_at,
    updatedAt: updated_at,
}, table => ({ ownerExternal: uniqueIndex("rss_subscriptions_owner_external").on(table.ownerId, table.externalId).where(sql`${table.externalId} <> ''`) }));

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
    embedUrl: text("embed_url").default("").notNull(),
    thumbnailUrl: text("thumbnail_url").default("").notNull(),
    publishedPrecision: text("published_precision").default('exact').notNull(),
    publishedAt: integer("published_at", { mode: 'timestamp' }).notNull(),
    read: integer("read").default(0).notNull(),
    starred: integer("starred").default(0).notNull(),
    readAt: integer("read_at", { mode: 'timestamp' }),
    starredAt: integer("starred_at", { mode: 'timestamp' }),
    createdAt: created_at,
    updatedAt: updated_at,
}, table => ({
    subscriptionExternal: uniqueIndex("rss_items_subscription_external").on(table.subscriptionId, table.externalId),
    ownerExternal: uniqueIndex("rss_items_owner_external").on(table.ownerId, table.externalId),
}));

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

export const writingTagOptions = sqliteTable("writing_tag_options", {
    id: integer("id").primaryKey(),
    ownerId: integer("owner_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
    scope: text("scope").notNull(),
    name: text("name").notNull(),
    createdAt: created_at,
}, table => ({ ownerScopeName: uniqueIndex("writing_tag_options_owner_scope_name").on(table.ownerId, table.scope, table.name) }));

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
