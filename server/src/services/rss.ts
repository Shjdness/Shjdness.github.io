import { and, desc, eq } from 'drizzle-orm';
import Elysia, { t } from 'elysia';
import { XMLParser } from 'fast-xml-parser';
import { rssItems, rssSubscriptions } from '../db/schema';
import { setup } from '../setup';
import { getDB } from '../utils/di';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });
const asArray = <T>(value: T | T[] | undefined | null): T[] => value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return text(item['#text'] ?? item['__cdata'] ?? item['@_href'] ?? item.href ?? item.url ?? '');
  }
  return '';
};
const clean = (value: unknown, length = 1800) => text(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
const dateOf = (value: unknown) => {
  const parsed = new Date(text(value));
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

function validatedFeedUrl(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  const host = url.hostname.toLowerCase();
  const isPrivate = host === 'localhost' || host.endsWith('.local') || host === '0.0.0.0' || host === '::1'
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (url.protocol !== 'https:' || Boolean(url.username || url.password) || isPrivate) return null;
  return url;
}

async function fetchFeed(url: string, conditional: { etag: string; lastModified: string }) {
  const checked = validatedFeedUrl(url);
  if (!checked) throw new Error('仅支持公开 HTTPS 订阅地址');
  const headers = new Headers({ Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json;q=0.9' });
  if (conditional.etag) headers.set('If-None-Match', conditional.etag);
  if (conditional.lastModified) headers.set('If-Modified-Since', conditional.lastModified);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response = await fetch(checked.toString(), { headers, redirect: 'manual', signal: controller.signal }).finally(() => clearTimeout(timeout));
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error('订阅源重定向无有效地址');
    const redirected = new URL(location, checked).toString();
    return fetchFeed(redirected, conditional);
  }
  if (response.status === 304) return { unchanged: true as const, response, body: '' };
  if (!response.ok) throw new Error(`订阅源返回 ${response.status}`);
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error('订阅源过大，已拒绝读取');
  return { unchanged: false as const, response, body };
}

type ParsedItem = { externalId: string; title: string; url: string; summary: string; author: string; publishedAt: Date };
function parseFeed(body: string, fallbackUrl: string) {
  if (body.trim().startsWith('{')) {
    const json = JSON.parse(body) as Record<string, unknown>;
    const items = asArray(json.items as Record<string, unknown>[]).map(item => ({
      externalId: clean(item.id || item.url || item.external_url, 1000), title: clean(item.title || '未命名条目', 500),
      url: clean(item.url || item.external_url || fallbackUrl, 2000), summary: clean(item.content_text || item.content_html || item.summary),
      author: clean((asArray(item.authors as Record<string, unknown>[])[0] || {}).name || item.author || ''),
      publishedAt: dateOf(item.date_published || item.date_modified),
    })).filter(item => item.externalId && item.url);
    return { title: clean(json.title || new URL(fallbackUrl).hostname, 160), siteUrl: clean(json.home_page_url || fallbackUrl, 2000), items };
  }
  const document = parser.parse(body) as Record<string, any>;
  const channel = document.rss?.channel || document.channel;
  const atom = document.feed;
  const source = channel || atom;
  if (!source) throw new Error('无法识别 RSS、Atom 或 JSON Feed 格式');
  const entries = channel ? asArray(source.item) : asArray(source.entry);
  const siteLink = channel ? text(source.link) : text(asArray(source.link).find((link: any) => link?.['@_rel'] !== 'self') || source.link);
  const items = entries.map((entry: Record<string, unknown>) => {
    const rawLink = channel ? entry.link : asArray(entry.link).find((link: any) => !link?.['@_rel'] || link?.['@_rel'] === 'alternate') || entry.link;
    const author = entry.author && typeof entry.author === 'object' ? text((entry.author as Record<string, unknown>).name) : text(entry.author || entry['dc:creator']);
    const link = text(rawLink) || fallbackUrl;
    const externalId = clean(entry.guid || entry.id || link, 1000);
    return { externalId, title: clean(entry.title || '未命名条目', 500), url: clean(link, 2000), summary: clean(entry['content:encoded'] || entry.content || entry.description || entry.summary), author: clean(author, 200), publishedAt: dateOf(entry.pubDate || entry.published || entry.updated) };
  }).filter((item: ParsedItem) => item.externalId && item.url);
  return { title: clean(source.title || new URL(fallbackUrl).hostname, 160), siteUrl: siteLink || fallbackUrl, items };
}

async function refreshSubscription(db: ReturnType<typeof getDB>, ownerId: number, subscription: typeof rssSubscriptions.$inferSelect) {
  const now = new Date();
  try {
    const fetched = await fetchFeed(subscription.feedUrl, subscription);
    if (fetched.unchanged) {
      await db.update(rssSubscriptions).set({ lastFetchedAt: now, lastError: '', updatedAt: now }).where(eq(rssSubscriptions.id, subscription.id));
      return { added: 0, unchanged: true };
    }
    const parsed = parseFeed(fetched.body, subscription.feedUrl);
    let added = 0;
    for (const item of parsed.items.slice(0, 100)) {
      const inserted = await db.insert(rssItems).values({ subscriptionId: subscription.id, ownerId, ...item }).onConflictDoNothing({ target: [rssItems.subscriptionId, rssItems.externalId] }).returning({ id: rssItems.id });
      added += inserted.length;
    }
    const source = new URL(subscription.feedUrl);
    await db.update(rssSubscriptions).set({
      title: parsed.title || subscription.title, siteUrl: parsed.siteUrl || subscription.feedUrl,
      favicon: `${source.origin}/favicon.ico`, etag: fetched.response.headers.get('etag') || '',
      lastModified: fetched.response.headers.get('last-modified') || '', lastFetchedAt: now, lastError: '', updatedAt: now,
    }).where(eq(rssSubscriptions.id, subscription.id));
    return { added, unchanged: false };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 240) : '更新失败';
    await db.update(rssSubscriptions).set({ lastFetchedAt: now, lastError: message, updatedAt: now }).where(eq(rssSubscriptions.id, subscription.id));
    throw new Error(message);
  }
}

export function RssService() {
  const db = getDB();
  const requireLife = ({ uid, lifeAccess, set }: { uid?: number; lifeAccess?: boolean; set: { status?: number | string } }) => {
    if (!uid || !lifeAccess) { set.status = 403; return false; }
    return true;
  };
  return new Elysia({ aot: false }).use(setup()).group('/rss', group => group
    .get('/', async ({ uid, lifeAccess, set, query }) => {
      if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
      const subscriptions = await db.query.rssSubscriptions.findMany({ where: eq(rssSubscriptions.ownerId, uid!), orderBy: [desc(rssSubscriptions.updatedAt)] });
      const allItems = await db.query.rssItems.findMany({ where: eq(rssItems.ownerId, uid!), orderBy: [desc(rssItems.publishedAt)], limit: 120 });
      const filtered = query.filter === 'unread' ? allItems.filter(item => !item.read) : query.filter === 'starred' ? allItems.filter(item => item.starred) : allItems;
      return { subscriptions, items: filtered, counts: { all: allItems.length, unread: allItems.filter(item => !item.read).length, starred: allItems.filter(item => item.starred).length } };
    }, { query: t.Object({ filter: t.Optional(t.Union([t.Literal('all'), t.Literal('unread'), t.Literal('starred')])) }) })
    .post('/subscriptions', async ({ uid, lifeAccess, set, body }) => {
      if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
      const feedUrl = validatedFeedUrl(body.feedUrl)?.toString();
      if (!feedUrl) { set.status = 400; return '请输入公开 HTTPS 订阅地址'; }
      const existing = await db.query.rssSubscriptions.findFirst({ where: and(eq(rssSubscriptions.ownerId, uid!), eq(rssSubscriptions.feedUrl, feedUrl)) });
      if (existing) { set.status = 409; return '该订阅已存在'; }
      const inserted = await db.insert(rssSubscriptions).values({ ownerId: uid!, feedUrl, title: body.title?.trim() || '' }).returning({ id: rssSubscriptions.id });
      const subscription = await db.query.rssSubscriptions.findFirst({ where: eq(rssSubscriptions.id, inserted[0].id) });
      if (!subscription) { set.status = 500; return '无法创建订阅'; }
      try { const result = await refreshSubscription(db, uid!, subscription); return { subscriptionId: subscription.id, ...result }; }
      catch (error) { set.status = 422; return error instanceof Error ? error.message : '订阅源无法更新'; }
    }, { body: t.Object({ feedUrl: t.String({ maxLength: 2000 }), title: t.Optional(t.String({ maxLength: 160 })) }) })
    .post('/refresh', async ({ uid, lifeAccess, set }) => {
      if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
      const subscriptions = await db.query.rssSubscriptions.findMany({ where: and(eq(rssSubscriptions.ownerId, uid!), eq(rssSubscriptions.active, 1)) });
      const results = await Promise.allSettled(subscriptions.map(subscription => refreshSubscription(db, uid!, subscription)));
      return { refreshed: subscriptions.length, added: results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value.added : 0), 0), failed: results.filter(result => result.status === 'rejected').length };
    })
    .post('/subscriptions/:id/refresh', async ({ uid, lifeAccess, set, params }) => {
      if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
      const subscription = await db.query.rssSubscriptions.findFirst({ where: and(eq(rssSubscriptions.id, Number(params.id)), eq(rssSubscriptions.ownerId, uid!)) });
      if (!subscription) { set.status = 404; return '订阅不存在'; }
      try { return await refreshSubscription(db, uid!, subscription); } catch (error) { set.status = 422; return error instanceof Error ? error.message : '更新失败'; }
    })
    .post('/items/:id', async ({ uid, lifeAccess, set, params, body }) => {
      if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
      const item = await db.query.rssItems.findFirst({ where: and(eq(rssItems.id, Number(params.id)), eq(rssItems.ownerId, uid!)) });
      if (!item) { set.status = 404; return '条目不存在'; }
      await db.update(rssItems).set({ ...(body.read === undefined ? {} : { read: body.read ? 1 : 0 }), ...(body.starred === undefined ? {} : { starred: body.starred ? 1 : 0 }), updatedAt: new Date() }).where(eq(rssItems.id, item.id));
      return 'OK';
    }, { body: t.Object({ read: t.Optional(t.Boolean()), starred: t.Optional(t.Boolean()) }) })
    .delete('/subscriptions/:id', async ({ uid, lifeAccess, set, params }) => {
      if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
      const result = await db.delete(rssSubscriptions).where(and(eq(rssSubscriptions.id, Number(params.id)), eq(rssSubscriptions.ownerId, uid!))).returning({ id: rssSubscriptions.id });
      if (!result.length) { set.status = 404; return '订阅不存在'; }
      return 'OK';
    })
  );
}
