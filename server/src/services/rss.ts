import { and, count, desc, eq, like, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import Elysia, { t } from 'elysia';
import { XMLParser } from 'fast-xml-parser';
import { rssItems, rssSourceGroups, rssSubscriptions } from '../db/schema';
import { setup } from '../setup';
import { getDB, getEnv } from '../utils/di';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });
const asArray = <T>(value: T | T[] | undefined | null): T[] => value == null ? [] : Array.isArray(value) ? value : [value];
const text = (value: any): string => typeof value === 'string' || typeof value === 'number' ? String(value) : value && typeof value === 'object' ? text(value['#text'] ?? value.__cdata ?? value['@_href'] ?? value['@_url'] ?? value.href ?? value.url ?? '') : '';
const clean = (value: unknown, length = 1800) => text(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
const dateOf = (value: unknown) => { const parsed = new Date(text(value)); return Number.isNaN(parsed.getTime()) ? new Date() : parsed; };

function validatedFeedUrl(value: string) {
  let url: URL; try { url = new URL(value.trim()); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === '0.0.0.0' || host === '::1' || host === 'metadata.google.internal'
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) || /^(fc|fd|fe80):/i.test(host);
  const literalAddress = /^\d+(?:\.\d+){0,3}$/.test(host) || host.includes(':');
  return url.protocol === 'https:' && !url.username && !url.password && !privateHost && !literalAddress ? url : null;
}

function rssHubBase() {
  return (getEnv().RSSHUB_BASE_URL?.trim() || 'https://rsshub.app').replace(/\/$/, '');
}

function normalizedSource(value: string) {
  let normalized = value.trim();
  if (normalized.startsWith('/')) normalized = `${rssHubBase()}${normalized}`;
  else if (normalized.startsWith('feed://')) normalized = `https://${normalized.slice(7)}`;
  else if (normalized.startsWith('http://')) normalized = `https://${normalized.slice(7)}`;
  else if (!/^https?:\/\//i.test(normalized) && /^[\w.-]+\//.test(normalized)) normalized = `https://${normalized}`;
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname === 'rsshub.app' && rssHubBase() !== 'https://rsshub.app') normalized = `${rssHubBase()}${parsed.pathname}${parsed.search}`;
  } catch { /* Validation reports malformed URLs below. */ }
  return normalized;
}

async function safeFetch(value: string, accept: string, conditional?: { etag: string; lastModified: string }, redirects = 0): Promise<{ unchanged: boolean; response: Response; body: string; finalUrl: string }> {
  const url = validatedFeedUrl(value); if (!url) throw new Error('仅支持公开 HTTPS 地址'); if (redirects > 5) throw new Error('重定向次数过多');
  const headers = new Headers({ Accept: accept, 'User-Agent': 'Shjdness-RSS/2.0 (+https://shjdness.github.io/life/rss)' }); if (conditional?.etag) headers.set('If-None-Match', conditional.etag); if (conditional?.lastModified) headers.set('If-Modified-Since', conditional.lastModified);
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15_000);
  const response = await fetch(url.toString(), { headers, redirect: 'manual', signal: controller.signal }).finally(() => clearTimeout(timeout));
  if (response.status >= 300 && response.status < 400) { const location = response.headers.get('location'); if (!location) throw new Error('重定向无有效地址'); return safeFetch(new URL(location, url).toString(), accept, conditional, redirects + 1); }
  if (response.status === 304) return { unchanged: true, response, body: '', finalUrl: url.toString() };
  if (!response.ok) {
    if (response.status === 403 && url.hostname.includes('rsshub')) throw new Error('RSSHub 拒绝服务器访问（403），请改用自建 RSSHub 实例');
    throw new Error(`来源返回 ${response.status}`);
  }
  if (Number(response.headers.get('content-length') || 0) > 4_000_000) throw new Error('来源内容超过 4MB'); const body = await response.text(); if (body.length > 4_000_000) throw new Error('来源内容超过 4MB');
  return { unchanged: false, response, body, finalUrl: url.toString() };
}

const feedAccept = 'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json;q=0.9';
type MediaType = 'text' | 'video' | 'image' | 'audio' | 'external';
type ParsedItem = { externalId: string; title: string; url: string; summary: string; author: string; publishedAt: Date; mediaType: MediaType; mediaUrl: string; embedUrl: string; thumbnailUrl: string; duration: number; contentHtml: string };
const youtubeId = (url: string, fallback = '') => { try { const parsed = new URL(url); return parsed.searchParams.get('v') || (parsed.hostname === 'youtu.be' ? parsed.pathname.slice(1) : parsed.pathname.match(/\/shorts\/([^/?]+)/)?.[1]) || fallback; } catch { return fallback; } };
const firstImage = (value: unknown) => text(value).match(/<img\b[^>]*src=["']([^"']+)["']/i)?.[1] || '';

function mediaFor(entry: Record<string, any>, url: string) {
  const enclosure = asArray(entry.enclosure)[0] || {}; const media = asArray(entry['media:content'])[0] || {}; const thumb = asArray(entry['media:thumbnail'])[0] || {};
  let mediaUrl = text(media['@_url'] || enclosure['@_url'] || enclosure.url); const mime = text(media['@_type'] || enclosure['@_type'] || enclosure.type).toLowerCase(); const videoId = clean(entry['yt:videoId'], 100) || youtubeId(url);
  if (videoId || mime.startsWith('video/')) return { mediaType: 'video' as const, mediaUrl, embedUrl: videoId ? `https://www.youtube-nocookie.com/embed/${videoId}` : '', thumbnailUrl: text(thumb['@_url']) || (videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : mediaUrl), duration: Number(media['@_duration'] || 0) || 0 };
  const bilibiliId = url.match(/bilibili\.com\/video\/(BV[\w]+)/i)?.[1];
  if (bilibiliId) return { mediaType: 'video' as const, mediaUrl: '', embedUrl: `https://player.bilibili.com/player.html?bvid=${bilibiliId}`, thumbnailUrl: text(thumb['@_url']) || firstImage(entry['content:encoded'] || entry.description || entry.content), duration: 0 };
  if (!mediaUrl) mediaUrl = firstImage(entry['content:encoded'] || entry.description || entry.content || entry.summary);
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif)(?:\?|$)/i.test(mediaUrl)) return { mediaType: 'image' as const, mediaUrl, embedUrl: '', thumbnailUrl: text(thumb['@_url']) || mediaUrl, duration: 0 };
  if (mime.startsWith('audio/')) return { mediaType: 'audio' as const, mediaUrl, embedUrl: '', thumbnailUrl: text(thumb['@_url']), duration: Number(media['@_duration'] || 0) || 0 };
  return { mediaType: 'text' as const, mediaUrl: '', embedUrl: '', thumbnailUrl: text(thumb['@_url']), duration: 0 };
}

function parseFeed(body: string, fallbackUrl: string) {
  if (body.trim().startsWith('{')) {
    const json = JSON.parse(body) as Record<string, any>; const items = asArray(json.items as Record<string, any>[]).map(item => { const url = clean(item.url || item.external_url || fallbackUrl, 2000); const attachment = asArray(item.attachments)[0] || {}; const mime = text(attachment.mime_type).toLowerCase(); const mediaUrl = clean(attachment.url, 2000); const mediaType: MediaType = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'text'; return { externalId: clean(item.id || url, 1000), title: clean(item.title || '未命名条目', 500), url, summary: clean(item.summary || item.content_text || item.content_html), author: clean((asArray(item.authors)[0] || {}).name || item.author || '', 200), publishedAt: dateOf(item.date_published || item.date_modified), mediaType, mediaUrl, embedUrl: '', thumbnailUrl: clean(item.image || item.banner_image || (mediaType === 'image' ? mediaUrl : ''), 2000), duration: Number(attachment.duration_in_seconds || 0) || 0, contentHtml: clean(item.content_text || item.content_html || item.summary, 20_000) }; }).filter(item => item.externalId && item.url);
    return { title: clean(json.title || new URL(fallbackUrl).hostname, 160), description: clean(json.description, 500), siteUrl: clean(json.home_page_url || fallbackUrl, 2000), icon: clean(json.icon || json.favicon, 2000), items };
  }
  const document = parser.parse(body) as Record<string, any>; const channel = document.rss?.channel || document.channel; const atom = document.feed; const source = channel || atom; if (!source) throw new Error('无法识别 RSS、Atom 或 JSON Feed 格式');
  const entries = channel ? asArray(source.item) : asArray(source.entry); const siteLink = channel ? text(source.link) : text(asArray(source.link).find((link: any) => link?.['@_rel'] !== 'self') || source.link);
  const items = entries.map((entry: Record<string, any>) => { const rawLink = channel ? entry.link : asArray(entry.link).find((link: any) => !link?.['@_rel'] || link?.['@_rel'] === 'alternate') || entry.link; const author = entry.author && typeof entry.author === 'object' ? text(entry.author.name) : text(entry.author || entry['dc:creator']); const url = text(rawLink) || fallbackUrl; const content = entry['content:encoded'] || entry.content || entry.description || entry.summary; return { externalId: clean(entry.guid || entry.id || url, 1000), title: clean(entry.title || '未命名条目', 500), url: clean(url, 2000), summary: clean(content), author: clean(author, 200), publishedAt: dateOf(entry.pubDate || entry.published || entry.updated), ...mediaFor(entry, url), contentHtml: clean(content, 20_000) }; }).filter((item: ParsedItem) => item.externalId && item.url && !/youtube\.com\/shorts\//i.test(item.url) && !/(^|\s)#shorts?(\s|$)/i.test(`${item.title} ${item.summary}`));
  return { title: clean(source.title || new URL(fallbackUrl).hostname, 160), description: clean(source.description || source.subtitle, 500), siteUrl: siteLink || fallbackUrl, icon: clean(source.icon || source.logo, 2000), items };
}

const platformFor = (value: string) => { const url = new URL(value); const host = url.hostname.toLowerCase(); const path = url.pathname.toLowerCase(); if (host.includes('youtube.com') || host === 'youtu.be') return 'youtube'; if (host.includes('bilibili.com') || path.includes('/bilibili/')) return 'bilibili'; if (host === 'x.com' || host.includes('twitter.com') || path.includes('/twitter/') || path.includes('/x/')) return 'x'; if (host.includes('rsshub')) return 'rsshub'; return 'other'; };
async function resolveSource(value: string) {
  const source = validatedFeedUrl(normalizedSource(value)); if (!source) throw new Error('请输入公开订阅地址'); const platform = platformFor(source.toString());
  if (platform === 'bilibili' && source.hostname.includes('bilibili.com') && !source.hostname.includes('rsshub')) { const uid = source.hostname === 'space.bilibili.com' ? source.pathname.split('/').filter(Boolean)[0] : ''; if (!uid || !/^\d+$/.test(uid)) throw new Error('请粘贴 Bilibili 用户空间地址或 RSSHub 订阅地址'); const feedUrl = `${rssHubBase()}/bilibili/user/video/${uid}`; const feed = await safeFetch(feedUrl, feedAccept); return [candidate(parseFeed(feed.body, feedUrl), source.toString(), feedUrl, 'rsshub', 'bilibili', uid)]; }
  if (platform === 'x' && !source.hostname.includes('rsshub')) { const username = source.pathname.split('/').filter(Boolean)[0]; if (!username || ['home','explore','search','i'].includes(username.toLowerCase())) throw new Error('请粘贴 X 用户主页或 RSSHub 订阅地址'); const feedUrl = `${rssHubBase()}/twitter/user/${username}`; const feed = await safeFetch(feedUrl, feedAccept); return [candidate(parseFeed(feed.body, feedUrl), source.toString(), feedUrl, 'rsshub', 'x', username)]; }
  if (platform === 'youtube' && !source.pathname.includes('/feeds/videos.xml')) {
    const pathId = source.pathname.match(/\/channel\/(UC[\w-]+)/)?.[1];
    let channelId = pathId || '';
    if (!channelId) {
      const attempts = [source.toString(), new URL(`${source.pathname.replace(/\/$/, '')}/videos`, source.origin).toString()];
      for (const pageUrl of [...new Set(attempts)]) {
        try {
          const page = await safeFetch(pageUrl, 'text/html,application/xhtml+xml');
          channelId = page.body.match(/"channelId":"(UC[\w-]+)"/)?.[1]
            || page.body.match(/"browseId":"(UC[\w-]+)"/)?.[1]
            || page.body.match(/itemprop=["'](?:identifier|channelId)["'][^>]*content=["'](UC[\w-]+)["']/i)?.[1]
            || page.body.match(/youtube\.com\/channel\/(UC[\w-]+)/)?.[1]
            || '';
          if (channelId) break;
        } catch { /* Try the channel videos page next. */ }
      }
    }
    if (!channelId) throw new Error('未识别 YouTube 频道，请粘贴 /channel/UC… 地址或官方 Feed');
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`; const feed = await safeFetch(feedUrl, feedAccept); const parsed = parseFeed(feed.body, feedUrl); return [candidate(parsed, source.toString(), feedUrl, 'native', 'youtube', channelId)];
  }
  const fetched = await safeFetch(source.toString(), `${feedAccept}, text/html;q=0.8`);
  try { const parsed = parseFeed(fetched.body, fetched.finalUrl); return [candidate(parsed, parsed.siteUrl || source.toString(), fetched.finalUrl, 'native', platform, '')]; } catch {}
  const hrefs = [...fetched.body.matchAll(/<link\b[^>]*>/gi)].map(match => match[0]).filter(tag => /rel=["'][^"']*alternate/i.test(tag) && /type=["'](?:application\/(?:rss\+xml|atom\+xml|feed\+json)|application\/json)/i.test(tag)).map(tag => tag.match(/href=["']([^"']+)["']/i)?.[1]).filter(Boolean) as string[]; const results = [] as any[];
  for (const href of [...new Set(hrefs)].slice(0, 5)) { const feedUrl = new URL(href, fetched.finalUrl).toString(); if (!validatedFeedUrl(feedUrl)) continue; try { const feed = await safeFetch(feedUrl, feedAccept); results.push(candidate(parseFeed(feed.body, feedUrl), fetched.finalUrl, feedUrl, 'autodiscovery', platform, '')); } catch {} }
  if (!results.length) throw new Error('未发现可订阅源；也可以直接粘贴 Feed 地址'); return results;
}
function candidate(parsed: ReturnType<typeof parseFeed>, sourceUrl: string, feedUrl: string, provider: string, platform: string, externalId: string) { const contentType = parsed.items.some(item => item.mediaType === 'video') ? 'video' : parsed.items.some(item => item.mediaType === 'image') ? 'image' : 'text'; const category = platform === 'youtube' || platform === 'bilibili' ? '视频' : platform === 'x' ? '社交媒体' : '其他'; return { sourceUrl, feedUrl, provider, platform, externalId, title: parsed.title, description: parsed.description, siteUrl: parsed.siteUrl, icon: parsed.icon, category, contentType, preview: parsed.items.slice(0, 3) }; }

export async function refreshSubscription(db: ReturnType<typeof getDB>, ownerId: number, subscription: typeof rssSubscriptions.$inferSelect) {
  const now = new Date(); try { const effectiveFeedUrl = normalizedSource(subscription.feedUrl); const fetched = await safeFetch(effectiveFeedUrl, feedAccept, subscription); if (fetched.unchanged) { await db.update(rssSubscriptions).set({ feedUrl: effectiveFeedUrl, lastFetchedAt: now, lastError: '', updatedAt: now }).where(and(eq(rssSubscriptions.id, subscription.id), eq(rssSubscriptions.ownerId, ownerId))); return { added: 0, unchanged: true }; }
    const parsed = parseFeed(fetched.body, subscription.feedUrl); let added = 0; for (const item of parsed.items.slice(0, 250)) { const result = await db.insert(rssItems).values({ subscriptionId: subscription.id, ownerId, ...item }).onConflictDoNothing({ target: [rssItems.subscriptionId, rssItems.externalId] }).returning({ id: rssItems.id }); added += result.length; }
    const origin = new URL(effectiveFeedUrl).origin; await db.update(rssSubscriptions).set({ feedUrl: effectiveFeedUrl, title: parsed.title || subscription.title, siteUrl: parsed.siteUrl || effectiveFeedUrl, favicon: parsed.icon || subscription.favicon || `${origin}/favicon.ico`, etag: fetched.response.headers.get('etag') || '', lastModified: fetched.response.headers.get('last-modified') || '', lastFetchedAt: now, lastError: '', contentType: parsed.items.some(item => item.mediaType === 'video') ? 'video' : parsed.items.some(item => item.mediaType === 'image') ? 'image' : subscription.contentType, updatedAt: now }).where(and(eq(rssSubscriptions.id, subscription.id), eq(rssSubscriptions.ownerId, ownerId))); return { added, unchanged: false };
  } catch (error) { const message = error instanceof Error ? error.message.slice(0, 240) : '更新失败'; await db.update(rssSubscriptions).set({ lastFetchedAt: now, lastError: message, updatedAt: now }).where(and(eq(rssSubscriptions.id, subscription.id), eq(rssSubscriptions.ownerId, ownerId))); throw new Error(message); }
}

export async function refreshSubscriptions(db: ReturnType<typeof getDB>, subscriptions: Array<typeof rssSubscriptions.$inferSelect>) {
  const results: PromiseSettledResult<{ added: number; unchanged: boolean }>[] = new Array(subscriptions.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < subscriptions.length) {
      const index = cursor++;
      try { results[index] = { status: 'fulfilled', value: await refreshSubscription(db, subscriptions[index].ownerId, subscriptions[index]) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, subscriptions.length) }, worker));
  const failures = results.flatMap((result, index) => result?.status === 'rejected' ? [{ id: subscriptions[index].id, title: subscriptions[index].alias || subscriptions[index].title, error: result.reason instanceof Error ? result.reason.message : '更新失败' }] : []);
  return { refreshed: subscriptions.length - failures.length, total: subscriptions.length, added: results.reduce((sum, result) => sum + (result?.status === 'fulfilled' ? result.value.added : 0), 0), failed: failures.length, failures };
}

export function RssService() {
  const db = getDB(); const requireLife = ({ uid, lifeAccess, set }: { uid?: number; lifeAccess?: boolean; set: { status?: number | string } }) => { if (!uid || !lifeAccess) { set.status = 403; return false; } return true; };
  return new Elysia({ aot: false }).use(setup()).group('/rss', group => group
    .get('/', async ({ uid, lifeAccess, set, query }) => { if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required'; const limit = Math.min(200, Math.max(10, Number(query.limit || 90))); const offset = Math.max(0, Number(query.offset || 0)); const conditions: SQL[] = [eq(rssItems.ownerId, uid!)]; if (query.filter === 'unread') conditions.push(eq(rssItems.read, 0)); if (query.filter === 'starred') conditions.push(eq(rssItems.starred, 1)); if (query.sourceId) conditions.push(eq(rssItems.subscriptionId, Number(query.sourceId))); if (query.contentType && query.contentType !== 'all') conditions.push(eq(rssItems.mediaType, query.contentType)); if (query.search?.trim()) { const term = `%${query.search.trim()}%`; conditions.push(or(like(rssItems.title, term), like(rssItems.summary, term), like(rssItems.author, term))!); } const where = and(...conditions);
      const [subscriptions, groups, items, filteredCount, allCount, unreadCount, starredCount] = await Promise.all([db.query.rssSubscriptions.findMany({ where: eq(rssSubscriptions.ownerId, uid!), orderBy: [desc(rssSubscriptions.updatedAt)] }), db.select().from(rssSourceGroups).where(eq(rssSourceGroups.ownerId, uid!)).orderBy(rssSourceGroups.sortOrder, rssSourceGroups.id), db.select().from(rssItems).where(where).orderBy(desc(rssItems.publishedAt), desc(rssItems.id)).limit(limit).offset(offset), db.select({ value: count() }).from(rssItems).where(where), db.select({ value: count() }).from(rssItems).where(eq(rssItems.ownerId, uid!)), db.select({ value: count() }).from(rssItems).where(and(eq(rssItems.ownerId, uid!), eq(rssItems.read, 0))), db.select({ value: count() }).from(rssItems).where(and(eq(rssItems.ownerId, uid!), eq(rssItems.starred, 1)))]); const total = filteredCount[0]?.value || 0; return { subscriptions, groups, items, counts: { all: allCount[0]?.value || 0, unread: unreadCount[0]?.value || 0, starred: starredCount[0]?.value || 0 }, page: { limit, offset, total, hasMore: offset + items.length < total } };
    }, { query: t.Object({ filter: t.Optional(t.Union([t.Literal('all'), t.Literal('unread'), t.Literal('starred')])), contentType: t.Optional(t.String()), sourceId: t.Optional(t.String()), search: t.Optional(t.String({ maxLength: 120 })), limit: t.Optional(t.String()), offset: t.Optional(t.String()) }) })
    .post('/resolve', async ({ uid, lifeAccess, set, body }) => { if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required'; try { return { candidates: await resolveSource(body.sourceUrl) }; } catch (error) { set.status = 422; return error instanceof Error ? error.message : '无法识别该来源'; } }, { body: t.Object({ sourceUrl: t.String({ maxLength: 2000 }) }) })
    .post('/subscriptions', async ({ uid, lifeAccess, set, body }) => { if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required'; const feedUrl = validatedFeedUrl(body.feedUrl)?.toString(); if (!feedUrl) { set.status = 400; return '请输入公开 HTTPS 订阅地址'; } const existing = await db.query.rssSubscriptions.findFirst({ where: and(eq(rssSubscriptions.ownerId, uid!), eq(rssSubscriptions.feedUrl, feedUrl)) }); if (existing) { set.status = 409; return '该订阅已存在'; } const category = body.category?.trim() || '其他'; await db.insert(rssSourceGroups).values({ ownerId: uid!, name: category }).onConflictDoNothing({ target: [rssSourceGroups.ownerId, rssSourceGroups.name] }); const inserted = await db.insert(rssSubscriptions).values({ ownerId: uid!, feedUrl, sourceUrl: body.sourceUrl || feedUrl, title: body.title?.trim() || '', alias: body.alias?.trim() || '', description: body.description?.trim() || '', category, provider: body.provider || 'manual', platform: body.platform || 'other', externalId: body.externalId || '', contentType: body.contentType || 'text', favicon: body.icon || '' }).returning({ id: rssSubscriptions.id }); const subscription = await db.query.rssSubscriptions.findFirst({ where: and(eq(rssSubscriptions.id, inserted[0].id), eq(rssSubscriptions.ownerId, uid!)) }); if (!subscription) { set.status = 500; return '无法创建订阅'; } try { return { subscriptionId: subscription.id, ...await refreshSubscription(db, uid!, subscription) }; } catch (error) { return { subscriptionId: subscription.id, added: 0, warning: error instanceof Error ? error.message : '首次更新失败，可稍后重试' }; }
    }, { body: t.Object({ feedUrl: t.String({ maxLength: 2000 }), sourceUrl: t.Optional(t.String({ maxLength: 2000 })), title: t.Optional(t.String({ maxLength: 160 })), alias: t.Optional(t.String({ maxLength: 160 })), description: t.Optional(t.String({ maxLength: 500 })), category: t.Optional(t.String({ maxLength: 80 })), provider: t.Optional(t.String()), platform: t.Optional(t.String()), externalId: t.Optional(t.String()), contentType: t.Optional(t.String()), icon: t.Optional(t.String({ maxLength: 2000 })) }) })
    .post('/subscriptions/:id', async ({ uid, lifeAccess, set, params, body }) => { if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required'; const id = Number(params.id); const existing = await db.query.rssSubscriptions.findFirst({ where: and(eq(rssSubscriptions.id, id), eq(rssSubscriptions.ownerId, uid!)) }); if (!existing) { set.status = 404; return '订阅不存在'; } const category = body.category?.trim(); if (category) await db.insert(rssSourceGroups).values({ ownerId: uid!, name: category }).onConflictDoNothing({ target: [rssSourceGroups.ownerId, rssSourceGroups.name] }); await db.update(rssSubscriptions).set({ alias: body.alias?.trim(), description: body.description?.trim(), category, updatedAt: new Date() }).where(and(eq(rssSubscriptions.id, id), eq(rssSubscriptions.ownerId, uid!))); return 'OK'; }, { body: t.Object({ alias: t.Optional(t.String({ maxLength: 160 })), description: t.Optional(t.String({ maxLength: 500 })), category: t.Optional(t.String({ maxLength: 80 })) }) })
    .post('/groups', async ({ uid, lifeAccess, set, body }) => { if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required'; const name = body.name.trim(); const existing = await db.query.rssSourceGroups.findFirst({ where: and(eq(rssSourceGroups.ownerId, uid!), eq(rssSourceGroups.name, name)) }); if (existing) return existing; const inserted = await db.insert(rssSourceGroups).values({ ownerId: uid!, name }).returning(); return inserted[0]; }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 80 }) }) })
    .post('/groups/:id', async ({ uid, lifeAccess, set, params, body }) => { if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required'; const id = Number(params.id); const groupItem = await db.query.rssSourceGroups.findFirst({ where: and(eq(rssSourceGroups.id, id), eq(rssSourceGroups.ownerId, uid!)) }); if (!groupItem) { set.status = 404; return '分组不存在'; } const name = body.name.trim(); await db.update(rssSourceGroups).set({ name, updatedAt: new Date() }).where(and(eq(rssSourceGroups.id, id), eq(rssSourceGroups.ownerId, uid!))); await db.update(rssSubscriptions).set({ category: name, updatedAt: new Date() }).where(and(eq(rssSubscriptions.ownerId, uid!), eq(rssSubscriptions.category, groupItem.name))); return 'OK'; }, { body: t.Object({ name: t.String({ minLength: 1, maxLength: 80 }) }) })
    .delete('/groups/:id', async ({ uid, lifeAccess, set, params }) => { if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required'; const id = Number(params.id); const groupItem = await db.query.rssSourceGroups.findFirst({ where: and(eq(rssSourceGroups.id, id), eq(rssSourceGroups.ownerId, uid!)) }); if (!groupItem) { set.status = 404; return '分组不存在'; } await db.update(rssSubscriptions).set({ category: '其他', updatedAt: new Date() }).where(and(eq(rssSubscriptions.ownerId, uid!), eq(rssSubscriptions.category, groupItem.name))); await db.delete(rssSourceGroups).where(and(eq(rssSourceGroups.id, id), eq(rssSourceGroups.ownerId, uid!))); return 'OK'; })
    .post('/refresh', async ({ uid, lifeAccess, set }) => {
      if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required';
      const subscriptions = await db.query.rssSubscriptions.findMany({ where: and(eq(rssSubscriptions.ownerId, uid!), eq(rssSubscriptions.active, 1)) });
      return refreshSubscriptions(db, subscriptions);
    })
    .post('/subscriptions/:id/refresh', async ({ uid, lifeAccess, set, params }) => { if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required'; const subscription = await db.query.rssSubscriptions.findFirst({ where: and(eq(rssSubscriptions.id, Number(params.id)), eq(rssSubscriptions.ownerId, uid!)) }); if (!subscription) { set.status = 404; return '订阅不存在'; } try { return await refreshSubscription(db, uid!, subscription); } catch (error) { set.status = 422; return error instanceof Error ? error.message : '更新失败'; } })
    .post('/items/mark-all-read', async ({ uid, lifeAccess, set }) => { if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required'; const now = new Date(); await db.update(rssItems).set({ read: 1, readAt: now, updatedAt: now }).where(and(eq(rssItems.ownerId, uid!), eq(rssItems.read, 0))); return 'OK'; })
    .post('/items/:id', async ({ uid, lifeAccess, set, params, body }) => { if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required'; const item = await db.query.rssItems.findFirst({ where: and(eq(rssItems.id, Number(params.id)), eq(rssItems.ownerId, uid!)) }); if (!item) { set.status = 404; return '条目不存在'; } const now = new Date(); await db.update(rssItems).set({ ...(body.read === undefined ? {} : { read: body.read ? 1 : 0, readAt: body.read ? (item.readAt || now) : null }), ...(body.starred === undefined ? {} : { starred: body.starred ? 1 : 0, starredAt: body.starred ? (item.starredAt || now) : null }), updatedAt: now }).where(and(eq(rssItems.id, item.id), eq(rssItems.ownerId, uid!))); return 'OK'; }, { body: t.Object({ read: t.Optional(t.Boolean()), starred: t.Optional(t.Boolean()) }) })
    .delete('/subscriptions/:id', async ({ uid, lifeAccess, set, params }) => { if (!requireLife({ uid, lifeAccess, set })) return 'Private Life access is required'; const result = await db.delete(rssSubscriptions).where(and(eq(rssSubscriptions.id, Number(params.id)), eq(rssSubscriptions.ownerId, uid!))).returning({ id: rssSubscriptions.id }); if (!result.length) { set.status = 404; return '订阅不存在'; } return 'OK'; })
  );
}
