import { eq, inArray } from 'drizzle-orm';
import Elysia, {t} from 'elysia';
import {
  appearancePreferences, comments, dailyBasics, feedHashtags, feeds, habitLogs, habits,
  hashtags, lifeDailyNotes, lifeTodos, pomodoroSessions, rssItems, rssSourceGroups,
  rssSubscriptions, writingTagOptions, lifeReports, lifeReportPreferences, lifeReportAnalyses,
} from '../db/schema';
import { setup } from '../setup';
import { getDB } from '../utils/di';

export const BACKUP_FORMAT = 'shjdshy-personal-data';
export const BACKUP_VERSION = 2;

export async function buildBackupEnvelope(ownerId: number, data: Record<string, unknown[]>, version:2|3|4=BACKUP_VERSION) {
  const counts = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length]));
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { format: BACKUP_FORMAT, version, ownerId, exportedAt: new Date().toISOString(), counts, sha256, data };
}

/** A read-only, owner-scoped export. Secrets, visit IPs and account tokens are excluded. */
export function LifeBackupService() {
  const db = getDB();
  return new Elysia({ aot: false }).use(setup()).get('/life/backup', async ({ uid, lifeAccess, set, query }) => {
    if (!uid || !lifeAccess) { set.status = 403; return 'Private Life access is required'; }
    set.headers['Cache-Control'] = 'private, no-store, max-age=0';
    set.headers['Pragma'] = 'no-cache';

    const ownFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.uid, uid));
    const ownTagIds = db.select({ id: feedHashtags.hashtagId }).from(feedHashtags).where(inArray(feedHashtags.feedId, ownFeedIds));
    // D1 executes a batch as one transaction: every table belongs to the same snapshot.
    // Keep subqueries in that transaction too; do not fetch IDs in an earlier request.
    const [ownFeeds, ownComments, ownHabits, logs, notes, basics, todos, sessions,
      subscriptions, groups, items, appearance, ownFeedTags, ownTags, tagOptions, reports, preferences, analyses] = await db.batch([
      db.query.feeds.findMany({ where: eq(feeds.uid, uid) }),
      db.query.comments.findMany({ where: eq(comments.userId, uid) }),
      db.query.habits.findMany({ where: eq(habits.ownerId, uid) }),
      db.query.habitLogs.findMany({ where: eq(habitLogs.ownerId, uid) }),
      db.query.lifeDailyNotes.findMany({ where: eq(lifeDailyNotes.ownerId, uid) }),
      db.query.dailyBasics.findMany({ where: eq(dailyBasics.ownerId, uid) }),
      db.query.lifeTodos.findMany({ where: eq(lifeTodos.ownerId, uid) }),
      db.query.pomodoroSessions.findMany({ where: eq(pomodoroSessions.ownerId, uid) }),
      db.query.rssSubscriptions.findMany({ where: eq(rssSubscriptions.ownerId, uid) }),
      db.query.rssSourceGroups.findMany({ where: eq(rssSourceGroups.ownerId, uid) }),
      db.query.rssItems.findMany({ where: eq(rssItems.ownerId, uid) }),
      db.query.appearancePreferences.findMany({ where: eq(appearancePreferences.userId, uid) }),
      db.query.feedHashtags.findMany({ where: inArray(feedHashtags.feedId, ownFeedIds) }),
      db.query.hashtags.findMany({ where: inArray(hashtags.id, ownTagIds) }),
      db.query.writingTagOptions.findMany({ where: eq(writingTagOptions.ownerId, uid) }),
      ...(['3','4'].includes(query.version??'')?[
        db.query.lifeReports.findMany({where:eq(lifeReports.ownerId,uid)}),
        db.query.lifeReportPreferences.findMany({where:eq(lifeReportPreferences.ownerId,uid)}),
      ]:[]),
      ...(query.version==='4'?[db.query.lifeReportAnalyses.findMany({where:eq(lifeReportAnalyses.ownerId,uid)})]:[]),
    ]);
    const safeSubscriptions = subscriptions.map(({ websubKey: _key, websubCallback: _callback, ...row }) => row);
    const data = {
      feeds: ownFeeds, comments: ownComments, hashtags: ownTags, feedHashtags: ownFeedTags,
      habits: ownHabits, habitLogs: logs, lifeDailyNotes: notes, dailyBasics: basics,
      lifeTodos: todos, pomodoroSessions: sessions, rssSubscriptions: safeSubscriptions,
      rssSourceGroups: groups, rssItems: items, appearancePreferences: appearance,
      writingTagOptions:tagOptions,
      ...(['3','4'].includes(query.version??'')?{lifeReports:reports,lifeReportPreferences:preferences}:{}),
      ...(query.version==='4'?{lifeReportAnalyses:analyses}:{}),
    };
    return buildBackupEnvelope(uid, data,query.version==='4'?4:query.version==='3'?3:2);
  },{query:t.Object({version:t.Optional(t.Union([t.Literal('2'),t.Literal('3'),t.Literal('4')]))})});
}
