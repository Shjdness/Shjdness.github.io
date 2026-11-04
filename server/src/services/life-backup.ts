import { eq, inArray } from 'drizzle-orm';
import Elysia, {t} from 'elysia';
import {
  appearancePreferences, comments, dailyBasics, feedHashtags, feeds, habitLogs, habits,
  hashtags, lifeDailyNotes, lifeTodos, pomodoroSessions, rssItems, rssSourceGroups,
  rssSubscriptions, writingTagOptions, lifeReports, lifeReportPreferences, lifeReportAnalyses,lifeCheckins,lifeCheckinRevisions,lifeReportCheckinSnapshots,lifeReportCheckinAnalyses,lifeReportBriefs,
} from '../db/schema';
import { setup } from '../setup';
import { getDB,getEnv } from '../utils/di';
import {validBackupManifest} from '../utils/backup-manifest';
import {checkinVault} from '../utils/checkin-vault';
import {exportCheckinRows} from '../utils/checkin-backup';
import {exportCheckinAnalysisArchives} from '../utils/checkin-analysis-backup';
import {exportReportCheckinArchives} from '../utils/report-checkin-backup';
import {exportReportBriefArchives} from '../utils/report-brief-backup';

export const BACKUP_FORMAT = 'shjdshy-personal-data';
export const BACKUP_VERSION = 2;

export async function buildBackupEnvelope(ownerId: number, data: Record<string, unknown[]>, version:2|3|4|5=BACKUP_VERSION) {
  if(!validBackupManifest(data,version))throw Error('Personal backup manifest invalid');
  const counts = Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length]));
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { format: BACKUP_FORMAT, version, ownerId, exportedAt: new Date().toISOString(), counts, sha256, data };
}

/** A read-only, owner-scoped export. Secrets, visit IPs and account tokens are excluded. */
export function LifeBackupService() {
  const db = getDB(),env=getEnv();
  return new Elysia({ aot: false }).use(setup()).get('/life/backup', async ({ uid, lifeAccess, admin, set, query }) => {
    set.headers['Cache-Control'] = 'private, no-store, max-age=0';
    set.headers['Pragma'] = 'no-cache';
    set.headers['Vary'] = 'Origin, Authorization';
    if (!uid || !lifeAccess) { set.status = 403; return 'Private Life access is required'; }
    if(query.version==='5'&&!admin){set.status=403;return 'Owner access is required';}

    const ownFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.uid, uid));
    const ownTagIds = db.select({ id: feedHashtags.hashtagId }).from(feedHashtags).where(inArray(feedHashtags.feedId, ownFeedIds));
    // D1 executes a batch as one transaction: every table belongs to the same snapshot.
    // Keep subqueries in that transaction too; do not fetch IDs in an earlier request.
    const [ownFeeds, ownComments, ownHabits, logs, notes, basics, todos, sessions,
      subscriptions, groups, items, appearance, ownFeedTags, ownTags, tagOptions, reports, preferences, analyses,checkins,revisions,extensions,checkinAnalyses,briefs] = await db.batch([
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
      ...(['3','4','5'].includes(query.version??'')?[
        db.query.lifeReports.findMany({where:eq(lifeReports.ownerId,uid)}),
        db.query.lifeReportPreferences.findMany({where:eq(lifeReportPreferences.ownerId,uid)}),
      ]:[]),
      ...(['4','5'].includes(query.version??'')?[db.query.lifeReportAnalyses.findMany({where:eq(lifeReportAnalyses.ownerId,uid)})]:[]),
      ...(query.version==='5'?[db.query.lifeCheckins.findMany({where:eq(lifeCheckins.ownerId,uid)}),db.query.lifeCheckinRevisions.findMany({where:eq(lifeCheckinRevisions.ownerId,uid)}),db.query.lifeReportCheckinSnapshots.findMany({where:eq(lifeReportCheckinSnapshots.ownerId,uid)}),db.query.lifeReportCheckinAnalyses.findMany({where:eq(lifeReportCheckinAnalyses.ownerId,uid)}),db.query.lifeReportBriefs.findMany({where:eq(lifeReportBriefs.ownerId,uid)})]:[]),
    ]);
    const safeSubscriptions = subscriptions.map(({ websubKey: _key, websubCallback: _callback, ...row }) => row);
    let checkinData={lifeCheckins:[] as unknown[],lifeCheckinRevisions:[] as unknown[],lifeReportCheckinArchives:[] as unknown[],lifeReportCheckinAnalysisArchives:[] as unknown[],lifeReportBriefArchives:[] as unknown[]};
    if(query.version==='5'&&(checkins.length||revisions.length||extensions.length||checkinAnalyses.length||briefs.length)){
      try{const vault=await checkinVault(env.LIFE_CHECKIN_KEY??'',[env.JWT_SECRET,env.REPORT_MAIL_VAULT_KEY??'',env.DEEPSEEK_API_KEY??'',env.REPORT_QQ_SMTP_AUTH_CODE??'']);checkinData={lifeCheckins:await exportCheckinRows(checkins,vault,uid),lifeCheckinRevisions:await exportCheckinRows(revisions,vault,uid),lifeReportCheckinArchives:await exportReportCheckinArchives(extensions,reports,vault,uid),lifeReportCheckinAnalysisArchives:await exportCheckinAnalysisArchives(checkinAnalyses,reports,extensions,vault,uid),lifeReportBriefArchives:await exportReportBriefArchives(briefs,reports,extensions,vault,uid)};}
      catch{set.status=503;return 'Check-in backup decryption unavailable; no partial backup exported';}
    }
    const data = {
      feeds: ownFeeds, comments: ownComments, hashtags: ownTags, feedHashtags: ownFeedTags,
      habits: ownHabits, habitLogs: logs, lifeDailyNotes: notes, dailyBasics: basics,
      lifeTodos: todos, pomodoroSessions: sessions, rssSubscriptions: safeSubscriptions,
      rssSourceGroups: groups, rssItems: items, appearancePreferences: appearance,
      writingTagOptions:tagOptions,
      ...(['3','4','5'].includes(query.version??'')?{lifeReports:reports,lifeReportPreferences:preferences}:{}),
      ...(['4','5'].includes(query.version??'')?{lifeReportAnalyses:analyses}:{}),
      ...(query.version==='5'?{...checkinData,lifeCheckinDraftCopies:[]}:{}),
    };
    return buildBackupEnvelope(uid, data,query.version==='5'?5:query.version==='4'?4:query.version==='3'?3:2);
  },{query:t.Object({version:t.Optional(t.Union([t.Literal('2'),t.Literal('3'),t.Literal('4'),t.Literal('5')]))})});
}
