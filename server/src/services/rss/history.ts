import { and, eq } from 'drizzle-orm';
import Elysia, { t } from 'elysia';
import type { DB } from '../../_worker';
import { rssSubscriptions } from '../../db/schema';
import { setup } from '../../setup';
import { getEnv } from '../../utils/di';
import { ingestVideos } from './ingestion';
import { rssStorage } from './storage';

export function historyRoutes(db: DB, authorized: (value?: string) => boolean) {
  const sourceById = (id: number) => db.query.rssSubscriptions.findFirst({ where: and(eq(rssSubscriptions.id,id),eq(rssSubscriptions.active,1),eq(rssSubscriptions.platform,'youtube')) });
  return new Elysia({aot:false}).use(setup())
    .get('/capabilities', () => ({ version: 3, history: true, search: true }))
    .get('/sync/history-sources', async ({headers,set}) => {
      if (!authorized(headers.authorization)) { set.status=401; return 'Unauthorized'; }
      const result = await getEnv().DB.prepare(`SELECT s.id,s.title,s.alias,s.external_id AS channelId,s.site_url AS siteUrl,s.history_policy AS policy,s.history_status AS status,s.history_reason AS reason,s.history_error AS error,
        SUM(CASE WHEN i.published_precision='exact' AND i.published_at>=? THEN 1 ELSE 0 END) AS recent90,
        MAX(CASE WHEN i.published_precision='exact' THEN i.published_at END) AS newest
        FROM rss_subscriptions s LEFT JOIN rss_items i ON i.subscription_id=s.id AND i.owner_id=s.owner_id
        WHERE s.active=1 AND s.platform='youtube' GROUP BY s.id ORDER BY s.id`).bind(Math.floor(Date.now()/1000)-90*86400).all();
      return { sources: result.results };
    })
    .get('/sync/report', async ({headers,set}) => {
      if (!authorized(headers.authorization)) { set.status=401; return 'Unauthorized'; }
      const storage = await rssStorage(getEnv().DB);
      const duplicates = await getEnv().DB.prepare('SELECT COUNT(*) AS groups FROM (SELECT owner_id,external_id FROM rss_items GROUP BY owner_id,external_id HAVING COUNT(*)>1)').first();
      const flags = await getEnv().DB.prepare('SELECT SUM(read) AS read,SUM(starred) AS starred FROM rss_items').first();
      return { ...storage, duplicates, flags };
    })
    .post('/sync/history-batch', async ({headers,set,body}) => {
      if (!authorized(headers.authorization)) { set.status=401; return 'Unauthorized'; }
      const source = await sourceById(body.subscriptionId);
      if (!source) { set.status=404; return 'Source not found'; }
      return ingestVideos(getEnv().DB,source,body.videos.map(video=>({ ...video, url:'',summary:video.summary || '',author:source.title,embedUrl:'',thumbnailUrl:'',publishedAt:new Date(video.publishedAt*1000) })), 'history');
    }, { body:t.Object({ subscriptionId:t.Integer({minimum:1}), videos:t.Array(t.Object({ externalId:t.String({pattern:'^[A-Za-z0-9_-]{11}$'}), title:t.String({maxLength:500}),summary:t.Optional(t.String({maxLength:4000})),publishedAt:t.Number({minimum:0,maximum:4102444800}),publishedPrecision:t.Union([t.Literal('exact'),t.Literal('estimated'),t.Literal('unknown')]) }),{maxItems:30}) }) })
    .post('/sync/history-state', async ({headers,set,body}) => {
      if (!authorized(headers.authorization)) { set.status=401; return 'Unauthorized'; }
      const source=await sourceById(body.subscriptionId);
      if (!source) { set.status=404; return 'Source not found'; }
      await db.update(rssSubscriptions).set({historyPolicy:body.policy,historyStatus:body.status,historyReason:body.reason,historyError:body.error || '',historyCheckedAt:new Date()}).where(eq(rssSubscriptions.id,source.id));
      return {ok:true};
    }, {body:t.Object({subscriptionId:t.Integer({minimum:1}),policy:t.Union([t.Literal('full'),t.Literal('two-years')]),status:t.Union([t.Literal('running'),t.Literal('complete'),t.Literal('partial'),t.Literal('failed')]),reason:t.String({maxLength:500}),error:t.Optional(t.String({maxLength:400}))})});
}
