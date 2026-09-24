import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'wouter';
import { client, endpoint } from '../main';
import { ProfileContext } from '../state/profile';
import { headersWithAuth } from '../utils/auth';
import { TodayAdviceCard } from './guide';
import { enqueueMutation, flushSyncQueue, getCached, getSyncQueue, onLocalChange, setCached, withTimeout } from '../data/local-first';

type LifeSection = 'life' | 'habits' | 'calendar' | 'year' | 'pomodoro' | 'rss';
type Habit = { id: number; name: string; description: string; color: string; active: number; clientKey?: string | null };
type Log = { habitId: number; date: string; completed: number };
type DailyNote = { id?: number; date: string; content: string; updatedAt: Date | string };
type DailyBasic = { id: number; date: string; content: string; completed: number; sortOrder: number; clientKey?: string | null };
type PomodoroSession = { id: number; startedAt: Date; endedAt: Date; focusMinutes: number; roundIndex: number; completed: number; taskName?: string; completedEarly?: number };
type RssSubscription = { id: number; feedUrl: string; sourceUrl: string; title: string; alias: string; description: string; category: string; provider: string; platform: string; contentType: string; siteUrl: string; favicon: string; lastFetchedAt: Date | null; lastError: string };
type RssGroup = { id: number; name: string; sortOrder: number };
type RssItem = { id: number; subscriptionId: number; externalId?: string; title: string; url: string; summary: string; author: string; publishedAt: Date; read: number; starred: number; readAt?: Date | null; starredAt?: Date | null; mediaType: 'text' | 'video' | 'image' | 'audio' | 'external'; mediaUrl: string; embedUrl: string; thumbnailUrl: string; duration: number; contentHtml: string };
type RssData = { subscriptions: RssSubscription[]; groups?: RssGroup[]; items: RssItem[]; counts: { all: number; unread: number; starred: number }; page?: { limit: number; offset: number; total: number; hasMore: boolean } };
type RssContentType = 'all' | 'text' | 'video' | 'image';
type RssActivity = { id: number; title: string; url: string; readAt: Date | null; starredAt: Date | null };
type CalendarData = { habits: Habit[]; logs: Log[]; sessions: PomodoroSession[]; rss: RssActivity[]; notes: DailyNote[]; basics: DailyBasic[] };
type LifeOverviewData = {
  summary: { habits: number; completed: number; focusMinutes: number; rounds: number; unread: number };
  habits: Array<{ id: number; name: string; days: string[] }>;
  recentRss: Array<{ id: number; title: string; url: string; publishedAt: Date; read: number }>;
  basics: DailyBasic[];
};

const mayAccessLife = (role?: string) => role === 'owner' || role === 'trusted';
const isoDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const monthNow = () => isoDay().slice(0, 7);
const addDays = (date: Date, count: number) => { const next = new Date(date); next.setDate(next.getDate() + count); return next; };
const mondayOf = (date = new Date()) => { const next = new Date(date); const day = next.getDay() || 7; next.setDate(next.getDate() - day + 1); next.setHours(0, 0, 0, 0); return next; };
const CLOUD_REFRESH_EVENT = 'shjdshy-cloud-refresh';
const READ_TIMEOUT = 6000;
const WRITE_TIMEOUT = 20000;

async function lifeApi<T>(path: string, init?: RequestInit, timeoutOverride?: number): Promise<T> {
  const timeout = timeoutOverride ?? ((init?.method || 'GET').toUpperCase() === 'GET' ? READ_TIMEOUT : WRITE_TIMEOUT);
  const response = await withTimeout(fetch(`${endpoint}${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...headersWithAuth(), ...(init?.headers || {}) } }), timeout);
  if (!response.ok) throw new Error((await response.text()) || `Request failed: ${response.status}`);
  const body = await response.text();
  const trimmed = body.trim();
  if (trimmed && response.headers.get('content-type')?.includes('application/json')) {
    try { return JSON.parse(trimmed) as T; } catch { return trimmed as T; }
  }
  return (trimmed || null) as T;
}

export function PrivateLifePage({ section }: { section: LifeSection }) {
  const profile = useContext(ProfileContext);
  if (!mayAccessLife(profile?.role)) return <LifeDenied />;
  if (section === 'life') return <LifeOverview />;
  if (section === 'habits') return <HabitView />;
  if (section === 'calendar' || section === 'year') return <CalendarView year={section === 'year'} />;
  if (section === 'pomodoro') return <PomodoroView />;
  return <RssView />;
}

function LifeDenied() {
  return <main className="life-page"><section className="life-panel life-denied"><p className="life-kicker">PRIVATE LIFE</p><h1>这里是私人生活空间</h1><p>登录本身不等于私人访问权限。此区域仅向 Owner 与受信任账户开放。</p><Link className="life-link" href="/">返回公开首页</Link></section></main>;
}

function LifeLayout({ section: _section, title, intro, children }: { section: LifeSection; title: string; intro: string; children: React.ReactNode }) {
  return <main className="life-page"><Helmet><title>{title} - {process.env.NAME}</title></Helmet><section className="life-panel life-section">
    <div className="life-title-row"><div><p className="life-kicker">PRIVATE LIFE</p><h1>{title}</h1></div><LifeSyncStatus /></div><p className="life-intro">{intro}</p>{children}
  </section></main>;
}

async function sendQueuedMutation(item: { entity: string; action: string; payload: unknown }) {
  if (item.entity === 'habit' && item.action === 'create') {
    const payload = item.payload as { localId: number; name: string; description?: string; color?: string; clientKey: string };
    const data = await lifeApi<{ insertedId: number }>('/habit', { method: 'POST', body: JSON.stringify({ name: payload.name, description: payload.description, color: payload.color, clientKey: payload.clientKey }) });
    if (!data?.insertedId) return false;
    const mapping = (await getCached<Record<string, number>>('life:habit-id-map'))?.value || {};
    mapping[String(payload.localId)] = data.insertedId;
    await setCached('life:habit-id-map', mapping);
    return true;
  }
  if (item.entity === 'habit' && (item.action === 'update' || item.action === 'archive')) {
    const payload = item.payload as { id: number; patch: { name?: string; description?: string; color?: string; active?: boolean } };
    const id = await resolveHabitId(payload.id);
    await lifeApi(`/habit/${id}`, { method: 'POST', body: JSON.stringify(payload.patch) });
    return true;
  }
  if (item.entity === 'habit' && item.action === 'delete') {
    const payload = item.payload as { id: number };
    const id = await resolveHabitId(payload.id);
    await lifeApi(`/habit/${id}`, { method: 'DELETE' });
    return true;
  }
  if (item.entity === 'habit' && item.action === 'toggle') {
    const payload = item.payload as { id: number; date: string; completed: boolean };
    const id = await resolveHabitId(payload.id);
    await lifeApi(`/habit/${id}/toggle`, { method: 'POST', body: JSON.stringify({ date: payload.date, completed: payload.completed }) });
    return true;
  }
  if (item.entity === 'note' && item.action === 'save') {
    const payload = item.payload as { date: string; content: string; updatedAt: string };
    await lifeApi(`/life/notes/${payload.date}`, { method: 'POST', body: JSON.stringify({ content: payload.content, updatedAt: payload.updatedAt }) });
    return true;
  }
  if (item.entity === 'note' && item.action === 'delete') {
    const payload = item.payload as { date: string };
    await lifeApi(`/life/notes/${payload.date}`, { method: 'DELETE' });
    return true;
  }
  if (item.entity === 'basic') {
    const payload = item.payload as { localId?: number; id?: number; date?: string; content?: string; completed?: boolean; sortOrder?: number; clientKey?: string };
    if (item.action === 'create') {
      const result = await lifeApi<{ insertedId: number }>('/life/basics', { method: 'POST', body: JSON.stringify({ date: payload.date, content: payload.content, sortOrder: payload.sortOrder, clientKey: payload.clientKey }) });
      if (!result.insertedId || payload.localId === undefined) return false;
      const mapping = (await getCached<Record<string, number>>('life:basic-id-map'))?.value || {};
      mapping[String(payload.localId)] = result.insertedId;
      await setCached('life:basic-id-map', mapping);
      return true;
    }
    const id = await resolveBasicId(payload.id || 0);
    if (item.action === 'delete') await lifeApi(`/life/basics/${id}`, { method: 'DELETE' });
    else await lifeApi(`/life/basics/${id}`, { method: 'POST', body: JSON.stringify({ content: payload.content, completed: payload.completed, sortOrder: payload.sortOrder }) });
    return true;
  }
  if (item.entity === 'pomodoro' && item.action === 'create') {
    const payload = item.payload as { startedAt: string; focusMinutes?: number };
    if ((payload.focusMinutes || 0) < 5) return true;
    const month = payload.startedAt.slice(0, 7);
    const existing = await lifeApi<PomodoroSession[]>(`/pomodoro/sessions?month=${encodeURIComponent(month)}`);
    if (Array.isArray(existing) && existing.some(session => new Date(session.startedAt).toISOString() === new Date(payload.startedAt).toISOString())) return true;
    await lifeApi('/pomodoro/sessions', { method: 'POST', body: JSON.stringify(item.payload) });
    return true;
  }
  if (item.entity === 'rss' && item.action === 'update') {
    const payload = item.payload as { id: number; patch: { read?: boolean; starred?: boolean } };
    await lifeApi(`/rss/items/${payload.id}`, { method: 'POST', body: JSON.stringify(payload.patch) });
    return true;
  }
  if (item.entity === 'rss' && item.action === 'mark-all-read') {
    await lifeApi('/rss/items/mark-all-read', { method: 'POST' });
    return true;
  }
  throw new Error(`Unsupported queued mutation: ${item.entity}/${item.action}`);
}

async function resolveHabitId(id: number) {
  if (id >= 0) return id;
  const mapping = (await getCached<Record<string, number>>('life:habit-id-map'))?.value || {};
  if (!mapping[String(id)]) throw new Error('Habit is waiting to be created');
  return mapping[String(id)];
}

async function resolveBasicId(id: number) {
  if (id >= 0) return id;
  const mapping = (await getCached<Record<string, number>>('life:basic-id-map'))?.value || {};
  if (!mapping[String(id)]) throw new Error('Today item is waiting to be created');
  return mapping[String(id)];
}

async function rememberLocalId(cacheKey: string, localId: number, cloudId: number) {
  const mapping = (await getCached<Record<string, number>>(cacheKey))?.value || {};
  mapping[String(localId)] = cloudId;
  await setCached(cacheKey, mapping);
}

function normalizeBasics(values: DailyBasic[]) {
  const unique = new Map<string, DailyBasic>();
  for (const value of values) {
    const key = `${value.date}:${value.content.trim().replace(/\s+/g, ' ').toLowerCase()}`;
    const current = unique.get(key);
    if (!current || (current.id < 0 && value.id >= 0)) unique.set(key, value);
  }
  return [...unique.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

async function mergePendingBasics(date: string, cloud: DailyBasic[], cached: DailyBasic[] = []) {
  const queue = (await getSyncQueue()).filter(item => item.entity === 'basic');
  if (!queue.length) return cloud;
  const mapping = (await getCached<Record<string, number>>('life:basic-id-map'))?.value || {};
  let result = [...cloud];
  for (const item of queue) {
    const payload = item.payload as { localId?: number; id?: number; date?: string; content?: string; completed?: boolean; sortOrder?: number; clientKey?: string };
    if (item.action === 'create' && payload.date === date && payload.localId !== undefined) {
      const mappedId = mapping[String(payload.localId)];
      const alreadyCloud = result.some(value => value.clientKey === payload.clientKey || value.id === mappedId);
      if (!alreadyCloud) {
        const local = cached.find(value => value.id === payload.localId || value.clientKey === payload.clientKey);
        result.push(local || { id: payload.localId, date, content: payload.content || '', completed: 0, sortOrder: payload.sortOrder || 0, clientKey: payload.clientKey });
      }
      continue;
    }
    if (payload.id === undefined) continue;
    const mappedId = payload.id < 0 ? mapping[String(payload.id)] : payload.id;
    const targetId = mappedId || payload.id;
    if (item.action === 'delete') result = result.filter(value => value.id !== targetId && value.id !== payload.id);
    if (item.action === 'update') {
      const local = cached.find(value => value.id === payload.id || value.id === targetId);
      if (!result.some(value => value.id === targetId) && local?.date === date) result.push(local);
      result = result.map(value => value.id === targetId || value.id === payload.id ? { ...value, ...(payload.content === undefined ? {} : { content: payload.content }), ...(payload.completed === undefined ? {} : { completed: payload.completed ? 1 : 0 }), ...(payload.sortOrder === undefined ? {} : { sortOrder: payload.sortOrder }) } : value);
    }
  }
  return normalizeBasics(result.filter(value => value.date === date));
}

async function mergePendingHabitData(
  cloud: { habits: Habit[]; logs: Log[]; notes: DailyNote[] },
  cached: { habits: Habit[]; logs: Log[]; notes: DailyNote[] } | null,
) {
  const queue = await getSyncQueue();
  if (!queue.length) return cloud;
  const mapping = (await getCached<Record<string, number>>('life:habit-id-map'))?.value || {};
  let habits = [...cloud.habits]; let logs = [...cloud.logs]; let notes = [...cloud.notes];
  for (const queued of queue) {
    if (queued.entity === 'habit' && queued.action === 'create') {
      const payload = queued.payload as { localId: number; name: string; description?: string; color?: string; clientKey: string };
      const cloudId = mapping[String(payload.localId)];
      if (!habits.some(value => value.id === cloudId || value.clientKey === payload.clientKey)) {
        habits.unshift(cached?.habits.find(value => value.id === payload.localId || value.clientKey === payload.clientKey) || { id: payload.localId, name: payload.name, description: payload.description || '', color: payload.color || '#e11d62', active: 1, clientKey: payload.clientKey });
      }
    }
    if (queued.entity === 'habit' && (queued.action === 'update' || queued.action === 'archive')) {
      const payload = queued.payload as { id: number; patch: { name?: string; description?: string; color?: string; active?: boolean } };
      const id = payload.id < 0 ? mapping[String(payload.id)] || payload.id : payload.id;
      if (!habits.some(value => value.id === id)) { const local = cached?.habits.find(value => value.id === payload.id); if (local) habits.push(local); }
      habits = habits.map(value => value.id === id || value.id === payload.id ? { ...value, ...payload.patch, active: payload.patch.active === undefined ? value.active : payload.patch.active ? 1 : 0 } : value);
    }
    if (queued.entity === 'habit' && queued.action === 'delete') {
      const payload = queued.payload as { id: number };
      const id = payload.id < 0 ? mapping[String(payload.id)] || payload.id : payload.id;
      habits = habits.filter(value => value.id !== id && value.id !== payload.id);
      logs = logs.filter(value => value.habitId !== id && value.habitId !== payload.id);
    }
    if (queued.entity === 'habit' && queued.action === 'toggle') {
      const payload = queued.payload as { id: number; date: string; completed: boolean };
      const id = payload.id < 0 ? mapping[String(payload.id)] || payload.id : payload.id;
      logs = [...logs.filter(value => !(value.habitId === id && value.date === payload.date)), { habitId: id, date: payload.date, completed: payload.completed ? 1 : 0 }];
    }
    if (queued.entity === 'note' && queued.action === 'save') {
      const note = queued.payload as DailyNote;
      notes = [...notes.filter(value => value.date !== note.date), note];
    }
    if (queued.entity === 'note' && queued.action === 'delete') {
      const payload = queued.payload as { date: string };
      notes = notes.filter(value => value.date !== payload.date);
    }
  }
  return { habits, logs, notes };
}

function LifeSyncStatus() {
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<'synced' | 'pending' | 'syncing' | 'failed' | 'offline'>(navigator.onLine ? 'synced' : 'offline');
  const [lastSync, setLastSync] = useState(() => localStorage.getItem('shjdshy-last-sync') || '');
  const [syncError, setSyncError] = useState('');
  const refresh = async () => { const queue = await getSyncQueue(); const failed = queue.find(item => item.lastError); setPending(queue.length); setSyncError(failed ? `${failed.entity}/${failed.action}: ${failed.lastError}` : ''); if (!navigator.onLine) setStatus('offline'); else if (queue.some(item => item.status === 'failed')) setStatus('failed'); else setStatus(queue.length ? 'pending' : 'synced'); };
  const sync = async () => {
    if (!navigator.onLine) { setStatus('offline'); await refresh(); return; }
    setStatus('syncing');
    const result = await flushSyncQueue(sendQueuedMutation);
    await refresh();
    window.dispatchEvent(new CustomEvent(CLOUD_REFRESH_EVENT));
    if (result.failed) { setStatus('failed'); return; }
    const stamp = new Date().toISOString();
    localStorage.setItem('shjdshy-last-sync', stamp); setLastSync(stamp); setStatus('synced');
  };
  useEffect(() => {
    void sync();
    const handleOnline = () => { void sync(); };
    const handleOffline = () => { setStatus('offline'); void refresh(); };
    window.addEventListener('online', handleOnline); window.addEventListener('offline', handleOffline);
    const unsubscribe = onLocalChange(() => { void refresh(); });
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); unsubscribe(); };
  }, []);
  const labels = { synced: `已同步${lastSync ? ` · ${new Date(lastSync).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}`, pending: `${pending} 项待同步`, syncing: '正在同步…', failed: '同步失败 · 点击重试', offline: `${pending} 项离线保存` };
  const icons = { synced: 'ri-cloud-line', pending: 'ri-time-line', syncing: 'ri-loader-4-line', failed: 'ri-error-warning-line', offline: 'ri-cloud-off-line' };
  return <button className={`life-sync-status ${status}`} onClick={() => void sync()} disabled={status === 'syncing'} title={syncError || '推送本地更改并拉取云端最新数据'}><i className={`${icons[status]} ${status === 'syncing' ? 'spin' : ''}`} /><span>{labels[status]}</span></button>;
}

function LifeOverview() {
  const [overview, setOverview] = useState<LifeOverviewData | null>(null);
  useEffect(() => {
    const start = mondayOf(); const end = addDays(start, 6);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = addDays(dayStart, 1);
    const key = `life:overview:${isoDay(dayStart)}:${isoDay(start)}`;
    const load = () => {
      void getCached<LifeOverviewData>(key).then(cached => cached && setOverview(cached.value));
      void withTimeout<any>(client.life.overview.get({
        query: { dayStart: dayStart.toISOString(), dayEnd: dayEnd.toISOString(), weekStart: isoDay(start), weekEnd: isoDay(end), day: isoDay(dayStart) },
        headers: headersWithAuth(),
      }) as Promise<any>, READ_TIMEOUT).then(({ data }) => { if (data && typeof data !== 'string') { const next = data as LifeOverviewData; setOverview(next); void setCached(key, next); } }).catch(() => undefined);
    };
    load(); const handler = () => load(); window.addEventListener(CLOUD_REFRESH_EVENT, handler); return () => window.removeEventListener(CLOUD_REFRESH_EVENT, handler);
  }, []);
  const summary = overview?.summary || { habits: 0, completed: 0, focusMinutes: 0, rounds: 0, unread: 0 };
  return <LifeLayout section="life" title="Life" intro="习惯、专注、阅读与时间，在这里汇成同一条生活轨迹。">
    <TodayBasics initial={overview?.basics} />
    <div className="life-summary-grid"><Link href="/life/pomodoro"><small>TODAY FOCUS</small><strong>{summary.focusMinutes} min</strong><span>{summary.rounds} 轮专注</span></Link><Link href="/life/habits"><small>THIS WEEK</small><strong>{summary.completed}</strong><span>{summary.habits} 项习惯</span></Link><Link href="/life/calendar"><small>CALENDAR</small><strong>{new Date().getDate()}</strong><span>{new Date().toLocaleDateString('zh-CN', { month: 'long', weekday: 'long' })}</span></Link><Link href="/life/rss"><small>RSS</small><strong>{summary.unread}</strong><span>篇未读</span></Link></div>
    {overview && <div className="life-overview-detail"><section><h2>本周习惯</h2>{overview.habits.map(habit => <p key={habit.id}><strong>{habit.name}</strong><span>{Array.from({ length: 7 }, (_, index) => { const date = isoDay(addDays(mondayOf(), index)); return <i key={date} className={habit.days.includes(date) ? 'done' : ''} title={date} />; })}</span></p>)}</section><section><h2>最近订阅</h2>{overview.recentRss.length ? overview.recentRss.map(item => <Link href="/life/rss" key={item.id}>{item.title}</Link>) : <p>还没有订阅内容</p>}</section></div>}
    <TodayAdviceCard />
  </LifeLayout>;
}

function TodayBasics({ initial }: { initial?: DailyBasic[] }) {
  const date = isoDay(); const cacheKey = `life:basics:${date}`;
  const [items, setItems] = useState<DailyBasic[]>(normalizeBasics(initial || [])); const [draft, setDraft] = useState(''); const [creating, setCreating] = useState(false);
  const persist = async (next: DailyBasic[]) => { const normalized = normalizeBasics(next); setItems(normalized); await setCached(cacheKey, normalized); await patchCalendarCache(date, value => ({ ...value, basics: normalized })); };
  const load = async () => {
    const cached = await getCached<DailyBasic[]>(cacheKey); if (cached) setItems(cached.value);
    try { const cloud = await lifeApi<DailyBasic[]>(`/life/basics?from=${date}&to=${date}`); if (Array.isArray(cloud)) await persist(await mergePendingBasics(date, cloud, cached?.value || items)); } catch {}
  };
  useEffect(() => { void load(); const handler = () => void load(); window.addEventListener(CLOUD_REFRESH_EVENT, handler); return () => window.removeEventListener(CLOUD_REFRESH_EVENT, handler); }, []);
  const create = async () => {
    const content = draft.trim(); if (!content || creating || items.length >= 3 || items.some(item => item.content.trim().toLowerCase() === content.toLowerCase())) return;
    setCreating(true);
    const localId = -Date.now(); const clientKey = crypto.randomUUID(); const local: DailyBasic = { id: localId, date, content, completed: 0, sortOrder: items.length, clientKey };
    const next = [...items, local]; setDraft(''); await persist(next);
    const payload = { localId, date, content, sortOrder: local.sortOrder, clientKey };
    try { const data = await lifeApi<{ insertedId: number }>('/life/basics', { method: 'POST', body: JSON.stringify({ date, content, sortOrder: local.sortOrder, clientKey }) }); await rememberLocalId('life:basic-id-map', localId, data.insertedId); await persist(next.map(item => item.id === localId ? { ...item, id: data.insertedId } : item)); }
    catch { await enqueueMutation('basic', 'create', payload); }
    finally { setCreating(false); }
  };
  const update = async (item: DailyBasic, patch: { content?: string; completed?: boolean }) => {
    const next = items.map(value => value.id === item.id ? { ...value, ...patch, completed: patch.completed === undefined ? value.completed : patch.completed ? 1 : 0 } : value); await persist(next);
    const payload = { id: item.id, ...patch };
    try { const id = await resolveBasicId(item.id); await lifeApi(`/life/basics/${id}`, { method: 'POST', body: JSON.stringify(patch) }); }
    catch { await enqueueMutation('basic', 'update', payload); }
  };
  const remove = async (item: DailyBasic) => {
    if (!window.confirm(`删除「${item.content}」？`)) return;
    await persist(items.filter(value => value.id !== item.id));
    try { const id = await resolveBasicId(item.id); await lifeApi(`/life/basics/${id}`, { method: 'DELETE' }); }
    catch { await enqueueMutation('basic', 'delete', { id: item.id }); }
  };
  const completed = items.filter(item => item.completed).length;
  return <section className="today-basics"><header><div><small>TODAY</small><h2>今日最基础的三件事</h2></div><span>{completed} / {items.length}</span></header><div>{items.map(item => <article key={item.id} className={item.completed ? 'done' : ''}><button aria-label={item.completed ? '取消完成' : '标记完成'} onClick={() => void update(item, { completed: !item.completed })}><i className={item.completed ? 'ri-check-line' : ''} /></button><input value={item.content} maxLength={240} onChange={event => setItems(current => current.map(value => value.id === item.id ? { ...value, content: event.target.value } : value))} onBlur={event => { const content = event.target.value.trim(); if (content) void update(item, { content }); }} /><button className="remove" aria-label="删除" onClick={() => void remove(item)}><i className="ri-close-line" /></button></article>)}</div><footer><input value={draft} maxLength={240} disabled={items.length >= 3} placeholder={items.length >= 3 ? '今天的三件事已经写好' : '今天至少想完成什么？'} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void create(); }} /><button disabled={!draft.trim() || creating || items.length >= 3} onClick={() => void create()}><i className="ri-add-line" /> 添加</button></footer></section>;
}

function HabitView() {
  const [weekStart, setWeekStart] = useState(mondayOf()); const [habits, setHabits] = useState<Habit[]>([]); const [logs, setLogs] = useState<Log[]>([]); const [notes, setNotes] = useState<DailyNote[]>([]); const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [selectedDate, setSelectedDate] = useState(isoDay()); const [noteDraft, setNoteDraft] = useState(''); const [editing, setEditing] = useState<Habit | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const cacheKey = `life:habits:${isoDay(days[0])}:${isoDay(days[6])}`;
  const load = async () => { const cached = await getCached<{ habits: Habit[]; logs: Log[]; notes: DailyNote[] }>(cacheKey); if (cached) { setHabits(cached.value.habits); setLogs(cached.value.logs); setNotes(cached.value.notes || []); } try { const [habitResult, noteResult] = await Promise.all([withTimeout<any>(client.habit.range.get({ query: { from: isoDay(days[0]), to: isoDay(days[6]) }, headers: headersWithAuth() }) as Promise<any>, READ_TIMEOUT), withTimeout<any>(client.life.notes.get({ query: { from: isoDay(days[0]), to: isoDay(days[6]) }, headers: headersWithAuth() }) as Promise<any>, READ_TIMEOUT)]); if (habitResult.data && typeof habitResult.data !== 'string') { const cloud = { habits: habitResult.data.habits as Habit[], logs: habitResult.data.logs as Log[], notes: Array.isArray(noteResult.data) ? noteResult.data as DailyNote[] : [] }; const next = await mergePendingHabitData(cloud, cached?.value || null); setHabits(next.habits); setLogs(next.logs); setNotes(next.notes); await setCached(cacheKey, next); } } catch {} };
  useEffect(() => { void load(); const handler = () => void load(); window.addEventListener(CLOUD_REFRESH_EVENT, handler); return () => window.removeEventListener(CLOUD_REFRESH_EVENT, handler); }, [weekStart.getTime()]);
  useEffect(() => { setNoteDraft(notes.find(note => note.date === selectedDate)?.content || ''); }, [selectedDate, notes]);
  const persist = (nextHabits = habits, nextLogs = logs, nextNotes = notes) => setCached(cacheKey, { habits: nextHabits, logs: nextLogs, notes: nextNotes });
  const create = async () => { if (!name.trim() || busy) return; setBusy(true); const localId = -Date.now(); const clientKey = crypto.randomUUID(); const local: Habit = { id: localId, name: name.trim(), description: '', color: '#e11d62', active: 1, clientKey }; const nextHabits = [local, ...habits]; setHabits(nextHabits); void persist(nextHabits); setName(''); const payload = { localId, name: local.name, clientKey }; try { const data = await lifeApi<{ insertedId: number }>('/habit', { method: 'POST', body: JSON.stringify({ name: local.name, clientKey }) }); if (!data?.insertedId) throw new Error('sync failed'); await rememberLocalId('life:habit-id-map', localId, data.insertedId); const mapped = nextHabits.map(item => item.id === localId ? { ...item, id: data.insertedId } : item); setHabits(mapped); await persist(mapped); } catch { await enqueueMutation('habit', 'create', payload); } finally { setBusy(false); } };
  const updateHabit = async (habit: Habit, patch: { name?: string; description?: string; active?: boolean }) => { const nextHabits = habits.map(item => item.id === habit.id ? { ...item, ...patch, active: patch.active === undefined ? item.active : patch.active ? 1 : 0 } : item); setHabits(nextHabits); void persist(nextHabits); try { const id = await resolveHabitId(habit.id); await lifeApi(`/habit/${id}`, { method: 'POST', body: JSON.stringify(patch) }); } catch { await enqueueMutation('habit', patch.active === false ? 'archive' : 'update', { id: habit.id, patch }); } };
  const removeHabit = async (habit: Habit) => { if (!window.confirm(`永久删除「${habit.name}」及其过往打卡记录？`)) return; const nextHabits = habits.filter(item => item.id !== habit.id); const nextLogs = logs.filter(log => log.habitId !== habit.id); setHabits(nextHabits); setLogs(nextLogs); setEditing(null); await persist(nextHabits, nextLogs); try { const id = await resolveHabitId(habit.id); await lifeApi(`/habit/${id}`, { method: 'DELETE' }); } catch { await enqueueMutation('habit', 'delete', { id: habit.id }); } };
  const toggle = async (habitId: number, date: string) => { setSelectedDate(date); const completed = logs.some(log => log.habitId === habitId && log.date === date && log.completed); const nextLogs = completed ? logs.map(log => log.habitId === habitId && log.date === date ? { ...log, completed: 0 } : log) : [...logs.filter(log => !(log.habitId === habitId && log.date === date)), { habitId, date, completed: 1 }]; setLogs(nextLogs); void persist(habits, nextLogs); void patchCalendarCache(date, value => ({ ...value, habits, logs: nextLogs })); const payload = { id: habitId, date, completed: !completed }; try { const id = await resolveHabitId(habitId); await lifeApi(`/habit/${id}/toggle`, { method: 'POST', body: JSON.stringify({ date, completed: !completed }) }); } catch { await enqueueMutation('habit', 'toggle', payload); } };
  const saveNote = async () => { const updatedAt = new Date().toISOString(); const note: DailyNote = { date: selectedDate, content: noteDraft.trim(), updatedAt }; const nextNotes = [...notes.filter(item => item.date !== selectedDate), note]; setNotes(nextNotes); await persist(habits, logs, nextNotes); await patchCalendarCache(selectedDate, value => ({ ...value, notes: [...(value.notes || []).filter(item => item.date !== selectedDate), note] })); try { await lifeApi(`/life/notes/${selectedDate}`, { method: 'POST', body: JSON.stringify({ content: note.content, updatedAt }) }); } catch { await enqueueMutation('note', 'save', note); } };
  const removeNote = async () => { if (!noteDraft.trim() || !window.confirm(`清除 ${selectedDate} 的当天记录？`)) return; const nextNotes = notes.filter(item => item.date !== selectedDate); setNotes(nextNotes); setNoteDraft(''); await persist(habits, logs, nextNotes); await patchCalendarCache(selectedDate, value => ({ ...value, notes: (value.notes || []).filter(item => item.date !== selectedDate) })); try { await lifeApi(`/life/notes/${selectedDate}`, { method: 'DELETE' }); } catch { await enqueueMutation('note', 'delete', { date: selectedDate }); } };
  const activeHabits = habits.filter(habit => habit.active);
  return <LifeLayout section="habits" title="习惯" intro="以一周为单位留下轻巧的确认，不把生活变成 KPI。"><div className="habit-week-tools"><button onClick={() => setWeekStart(addDays(weekStart, -7))}><i className="ri-arrow-left-line" /> 上一周</button><strong>{isoDay(days[0])} — {isoDay(days[6])}</strong><button onClick={() => setWeekStart(mondayOf())}>本周</button><button onClick={() => setWeekStart(addDays(weekStart, 7))}>下一周 <i className="ri-arrow-right-line" /></button></div><div className="habit-week" role="grid"><div className="habit-week-head"><span>习惯</span>{days.map(day => { const date = isoDay(day); return <button key={date} className={selectedDate === date ? 'selected' : ''} onClick={() => setSelectedDate(date)}><b>{['日','一','二','三','四','五','六'][day.getDay()]}</b><small>{day.getDate()}</small></button>; })}</div>{activeHabits.map(habit => <div className="habit-week-row" key={habit.id}><span><strong>{habit.name}</strong><small>{habit.description}</small><button className="habit-edit-button" onClick={() => setEditing(habit)} title="编辑习惯"><i className="ri-edit-line" /></button></span>{days.map(day => { const date = isoDay(day); const done = logs.some(log => log.habitId === habit.id && log.date === date && log.completed); return <button key={date} className={done ? 'done' : ''} aria-label={`${habit.name} ${date} ${done ? '已完成' : '未完成'}`} onClick={() => toggle(habit.id, date)}><i className={done ? 'ri-check-line' : ''} /></button>; })}</div>)}</div><div className="life-add"><input value={name} placeholder="添加一个想长期坚持的习惯" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void create(); }} /><button onClick={create} disabled={busy}>添加</button></div><section className="daily-note"><div><small>DAILY NOTE</small><strong>{selectedDate}</strong></div><textarea value={noteDraft} maxLength={2000} placeholder="今天做了什么 / 有什么想记下来……" onChange={event => setNoteDraft(event.target.value)} /><div className="daily-note-actions"><button className="secondary" disabled={!noteDraft.trim()} onClick={() => void removeNote()}>清除</button><button onClick={saveNote}>保存当天记录</button></div></section>{editing && <HabitEditor habit={editing} onClose={() => setEditing(null)} onDelete={() => void removeHabit(editing)} onSave={patch => { void updateHabit(editing, patch); setEditing(null); }} />}</LifeLayout>;
}

function HabitEditor({ habit, onClose, onSave, onDelete }: { habit: Habit; onClose: () => void; onSave: (patch: { name: string; description: string; active?: boolean }) => void; onDelete: () => void }) {
  const [name, setName] = useState(habit.name); const [description, setDescription] = useState(habit.description);
  return <div className="guide-modal" role="dialog" aria-modal="true"><section><p>编辑习惯</p><h2>{habit.name}</h2><label>名称<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label><label>说明<input value={description} maxLength={240} onChange={event => setDescription(event.target.value)} /></label><div className="habit-editor-actions"><button className="habit-delete" onClick={onDelete}>删除</button><button className="habit-archive" onClick={() => { if (window.confirm('停用后将不再显示于每周面板，但历史记录会保留。继续吗？')) onSave({ name, description, active: false }); }}>停用</button><span /><button onClick={onClose}>取消</button><button disabled={!name.trim()} onClick={() => onSave({ name: name.trim(), description: description.trim() })}>保存</button></div></section></div>;
}

async function patchCalendarCache(date: string, update: (value: CalendarData) => CalendarData) {
  const key = `life:calendar:${date.slice(0, 7)}`; const cached = await getCached<CalendarData>(key);
  if (cached) await setCached(key, update(cached.value));
}

type TimerState = { mode: 'focus' | 'break'; round: number; remaining: number; targetAt: number | null; startedAt: string | null; taskName: string };
type PomodoroPreferences = { focusMinutes: number; breakMinutes: number; rounds: number; autoStartFocus: boolean };
const TIMER_KEY = 'rin-life-pomodoro';
const POMODORO_PREFS_KEY = 'rin-life-pomodoro-preferences';
const defaultPomodoroPreferences: PomodoroPreferences = { focusMinutes: 25, breakMinutes: 5, rounds: 4, autoStartFocus: false };
const boundedNumber = (value: string, fallback: number, min: number, max: number) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= min ? Math.min(max, Math.round(parsed)) : fallback; };
function PomodoroView() {
  const [preferences, setPreferences] = useState<PomodoroPreferences>(() => { try { return { ...defaultPomodoroPreferences, ...JSON.parse(localStorage.getItem(POMODORO_PREFS_KEY) || '{}') }; } catch { return defaultPomodoroPreferences; } });
  const [drafts, setDrafts] = useState(() => ({ focus: String(preferences.focusMinutes), break: String(preferences.breakMinutes), rounds: String(preferences.rounds) }));
  const [timer, setTimer] = useState<TimerState>(() => { try { const saved = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null') as TimerState | null; if (saved) return { ...saved, taskName: saved.taskName || '', remaining: saved.targetAt ? Math.max(0, Math.ceil((saved.targetAt - Date.now()) / 1000)) : saved.remaining }; } catch {} return { mode: 'focus', round: 1, remaining: preferences.focusMinutes * 60, targetAt: null, startedAt: null, taskName: '' }; });
  const finishing = useRef(false);
  const { focusMinutes, breakMinutes, rounds } = preferences;
  const running = timer.targetAt !== null;
  useEffect(() => { localStorage.setItem(TIMER_KEY, JSON.stringify(timer)); }, [timer]);
  useEffect(() => { localStorage.setItem(POMODORO_PREFS_KEY, JSON.stringify(preferences)); }, [preferences]);
  useEffect(() => { if (!timer.targetAt) return; const interval = window.setInterval(() => setTimer(current => current.targetAt ? { ...current, remaining: Math.max(0, Math.ceil((current.targetAt - Date.now()) / 1000)) } : current), 500); return () => clearInterval(interval); }, [timer.targetAt]);
  const finishStage = async (completedEarly = false) => {
    if (finishing.current) return; finishing.current = true;
    const endedAt = new Date();
    if (timer.mode === 'focus' && timer.startedAt) {
      const actualMinutes = Math.max(1, Math.ceil((endedAt.getTime() - new Date(timer.startedAt).getTime()) / 60000));
      const session = { startedAt: timer.startedAt, endedAt: endedAt.toISOString(), focusMinutes: completedEarly ? actualMinutes : focusMinutes, breakMinutes, roundIndex: timer.round, completed: true, taskName: timer.taskName.trim(), completedEarly };
      const hasNextRound = timer.round < rounds;
      setTimer(hasNextRound
        ? { mode: 'break', round: timer.round, remaining: breakMinutes * 60, targetAt: Date.now() + breakMinutes * 60 * 1000, startedAt: null, taskName: timer.taskName }
        : { mode: 'focus', round: 1, remaining: focusMinutes * 60, targetAt: null, startedAt: null, taskName: timer.taskName });
      if (session.focusMinutes < 5) { finishing.current = false; return; }
      const calendarKey = `life:calendar:${session.startedAt.slice(0, 7)}`;
      const cached = await getCached<CalendarData>(calendarKey);
      if (cached) await setCached(calendarKey, { ...cached.value, sessions: [...cached.value.sessions, { ...session, id: -Date.now(), startedAt: new Date(session.startedAt), endedAt, completed: 1, completedEarly: completedEarly ? 1 : 0 } as PomodoroSession] });
      try { await lifeApi('/pomodoro/sessions', { method: 'POST', body: JSON.stringify(session) }); } catch { await enqueueMutation('pomodoro', 'create', session); } finally { finishing.current = false; }
      return;
    }
    if (timer.mode === 'break') setTimer({ mode: 'focus', round: Math.min(rounds, timer.round + 1), remaining: focusMinutes * 60, targetAt: null, startedAt: null, taskName: timer.taskName });
    finishing.current = false;
  };
  useEffect(() => { if (timer.remaining === 0 && timer.targetAt) void finishStage(); }, [timer.remaining, timer.targetAt]);
  const start = () => setTimer(current => ({ ...current, targetAt: Date.now() + current.remaining * 1000, startedAt: current.mode === 'focus' ? current.startedAt || new Date().toISOString() : null })); const pause = () => setTimer(current => ({ ...current, targetAt: null })); const stop = () => setTimer(current => ({ mode: 'focus', round: 1, remaining: focusMinutes * 60, targetAt: null, startedAt: null, taskName: current.taskName }));
  const commitSetting = (kind: 'focus' | 'break' | 'rounds') => { const limits = kind === 'focus' ? [1, 180] : kind === 'break' ? [1, 60] : [1, 20]; const key: 'focusMinutes' | 'breakMinutes' | 'rounds' = kind === 'focus' ? 'focusMinutes' : kind === 'break' ? 'breakMinutes' : 'rounds'; const value = boundedNumber(drafts[kind], preferences[key], limits[0], limits[1]); setDrafts(current => ({ ...current, [kind]: String(value) })); setPreferences(current => ({ ...current, [key]: value })); if (!timer.startedAt && ((kind === 'focus' && timer.mode === 'focus') || (kind === 'break' && timer.mode === 'break'))) setTimer(current => ({ ...current, remaining: value * 60 })); };
  const clock = `${String(Math.floor(timer.remaining / 60)).padStart(2, '0')}:${String(timer.remaining % 60).padStart(2, '0')}`;
  return <LifeLayout section="pomodoro" title="番茄钟" intro="休息只出现在两轮专注之间；最后一轮结束后，本组计时自然完成。"><label className="pomodoro-task">当前任务<input value={timer.taskName} placeholder="" disabled={timer.mode === 'break'} onChange={e => setTimer(current => ({ ...current, taskName: e.target.value }))} /></label><div className={`pomodoro ${timer.mode}`}><p>{timer.mode === 'focus' ? 'FOCUS' : 'BREAK'}</p><strong>{clock}</strong><span>{timer.mode === 'focus' ? `第 ${timer.round} / ${rounds} 轮` : `第 ${timer.round} 轮完成 · 接下来第 ${timer.round + 1} 轮`}</span><div>{running ? <button onClick={pause}>暂停</button> : <button onClick={start}>{timer.remaining === (timer.mode === 'focus' ? focusMinutes : breakMinutes) * 60 ? '开始' : '继续'}</button>}{timer.mode === 'focus' && timer.startedAt && <button onClick={() => void finishStage(true)}>提前完成</button>}{timer.mode === 'break' && <button onClick={() => void finishStage(true)}>跳过休息</button>}<button className="secondary" onClick={stop}>停止</button></div></div><div className="pomodoro-settings"><label>专注时长<input inputMode="numeric" value={drafts.focus} disabled={Boolean(timer.startedAt) || timer.mode === 'break'} onChange={e => setDrafts(current => ({ ...current, focus: e.target.value }))} onBlur={() => commitSetting('focus')} /></label><label>休息时长<input inputMode="numeric" value={drafts.break} disabled={Boolean(timer.startedAt) || timer.mode === 'break'} onChange={e => setDrafts(current => ({ ...current, break: e.target.value }))} onBlur={() => commitSetting('break')} /></label><label>轮数<input inputMode="numeric" value={drafts.rounds} disabled={Boolean(timer.startedAt) || timer.mode === 'break'} onChange={e => setDrafts(current => ({ ...current, rounds: e.target.value }))} onBlur={() => commitSetting('rounds')} /></label></div></LifeLayout>;
}

function CalendarView({ year }: { year: boolean }) {
  const [month, setMonth] = useState(() => new URLSearchParams(window.location.search).get('month') || monthNow()); const [habits, setHabits] = useState<Habit[]>([]); const [logs, setLogs] = useState<Log[]>([]); const [sessions, setSessions] = useState<PomodoroSession[]>([]); const [rssActivity, setRssActivity] = useState<RssActivity[]>([]); const [notes, setNotes] = useState<DailyNote[]>([]); const [basics, setBasics] = useState<DailyBasic[]>([]); const [focused, setFocused] = useState<number | null>(null); const [selected, setSelected] = useState(() => `${new URLSearchParams(window.location.search).get('month') || monthNow()}-01`);
  useEffect(() => { const key = `life:calendar:${month}`; const apply = (value: CalendarData) => { setHabits(value.habits); setLogs(value.logs); setSessions(value.sessions); setRssActivity(value.rss); setNotes(value.notes || []); setBasics(value.basics || []); }; const load = async () => { const cached = await getCached<CalendarData>(key); if (cached) apply(cached.value); const [yearNumber, monthNumber] = month.split('-').map(Number); const start = new Date(yearNumber, monthNumber - 1, 1); const end = new Date(yearNumber, monthNumber, 1); try { const { data } = await withTimeout<any>(client.life.calendar.get({ query: { month, start: start.toISOString(), end: end.toISOString() }, headers: headersWithAuth() }) as Promise<any>, READ_TIMEOUT); if (data && typeof data !== 'string') { const merged = await mergePendingHabitData({ habits: data.habits as Habit[], logs: data.logs as Log[], notes: (data.notes || []) as DailyNote[] }, cached ? { habits: cached.value.habits, logs: cached.value.logs, notes: cached.value.notes || [] } : null); const basics: DailyBasic[] = []; for (const day of Array.from({ length: new Date(yearNumber, monthNumber, 0).getDate() }, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`)) basics.push(...await mergePendingBasics(day, (data.basics || []) as DailyBasic[], cached?.value.basics || [])); const sessions = [...data.sessions as PomodoroSession[]]; for (const queued of (await getSyncQueue()).filter(item => item.entity === 'pomodoro' && item.action === 'create')) { const payload = queued.payload as { startedAt: string; endedAt: string; focusMinutes: number; roundIndex: number; completed: boolean; taskName?: string; completedEarly?: boolean }; if (payload.startedAt.startsWith(month) && !sessions.some(value => new Date(value.startedAt).toISOString() === new Date(payload.startedAt).toISOString())) sessions.push({ ...payload, id: -(queued.id || Date.now()), startedAt: new Date(payload.startedAt), endedAt: new Date(payload.endedAt), completed: payload.completed ? 1 : 0, completedEarly: payload.completedEarly ? 1 : 0 }); } const next = { habits: merged.habits, logs: merged.logs, sessions, rss: data.rss as RssActivity[], notes: merged.notes, basics }; apply(next); await setCached(key, next); } } catch {} }; void load(); const handler = () => { void load(); }; window.addEventListener(CLOUD_REFRESH_EVENT, handler); return () => window.removeEventListener(CLOUD_REFRESH_EVENT, handler); }, [month]);
  if (year) return <YearView />;
  const activeHabits = habits.filter(habit => habit.active);
  const activeHabitIds = new Set(activeHabits.map(habit => habit.id));
  const first = new Date(`${month}-01T00:00:00`); const dayCount = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(); const blanks = (first.getDay() + 6) % 7; const days = Array.from({ length: dayCount }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`); const done = (date: string) => logs.filter(log => log.date === date && log.completed && activeHabitIds.has(log.habitId) && (!focused || log.habitId === focused)).length; const focusFor = (date: string) => sessions.filter(session => isoDay(new Date(session.startedAt)) === date && session.completed); const rssFor = (date: string) => rssActivity.filter(item => (item.readAt && isoDay(new Date(item.readAt)) === date) || (item.starredAt && isoDay(new Date(item.starredAt)) === date)); const chosenSessions = focusFor(selected); const chosenLogs = logs.filter(log => log.date === selected && log.completed && activeHabitIds.has(log.habitId)); const chosenRss = rssFor(selected);
  const chosenNote = notes.find(note => note.date === selected); const chosenBasics = basics.filter(item => item.date === selected);
  return <LifeLayout section="calendar" title="日历" intro="当天的基础事项、便签、习惯、专注和阅读在同一条时间线上汇合。"><div className="calendar-tools"><input type="month" value={month} onChange={e => { setMonth(e.target.value); setSelected(`${e.target.value}-01`); }} /><select value={focused || ''} onChange={e => setFocused(e.target.value ? Number(e.target.value) : null)}><option value="">全部习惯</option>{habits.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select><Link href="/life/year">全年视图</Link></div><div className="calendar-weekdays">{['一','二','三','四','五','六','日'].map(day => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{Array.from({ length: blanks }, (_, i) => <span key={`blank-${i}`} />)}{days.map(date => <button key={date} onClick={() => setSelected(date)} className={`calendar-day ${done(date) ? 'done' : focused && date <= isoDay() ? 'missed' : ''} ${selected === date ? 'selected' : ''}`}><b>{Number(date.slice(-2))}</b><span>{done(date) ? `${done(date)} 项习惯` : ''}{notes.some(note => note.date === date && note.content) ? ' · 便签' : ''}{basics.some(item => item.date === date) ? ' · Today' : ''}</span><em>{focusFor(date).length ? `${focusFor(date).length} 🍅` : ''}{rssFor(date).length ? ` · ${rssFor(date).length} 阅读` : ''}</em></button>)}</div><section className="calendar-detail"><h2>{new Date(`${selected}T00:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</h2>{chosenNote?.content && <p className="calendar-note">{chosenNote.content}</p>}<div><article><strong>Today</strong>{chosenBasics.length ? chosenBasics.map(item => <p key={item.id}>{item.completed ? '✓' : '○'} {item.content}</p>) : <p>没有基础事项</p>}</article><article><strong>习惯</strong>{chosenLogs.length ? chosenLogs.map(log => <p key={log.habitId}>✓ {habits.find(h => h.id === log.habitId)?.name}</p>) : <p>没有完成记录</p>}</article><article><strong>专注</strong><p>{chosenSessions.length} 轮 · {chosenSessions.reduce((sum, item) => sum + item.focusMinutes, 0)} 分钟</p>{chosenSessions.map(item => <p key={item.id}>{new Date(item.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} — {new Date(item.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</p>)}</article><article><strong>阅读</strong>{chosenRss.length ? chosenRss.map(item => <p key={item.id}>{item.starredAt && isoDay(new Date(item.starredAt)) === selected ? '★' : '✓'} <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a></p>) : <p>没有阅读记录</p>}</article></div></section></LifeLayout>;
}

type YearSnapshot = { activity: Record<string, number>; habits: Array<{ id: number; name: string }>; logs: Log[]; sessions: PomodoroSession[]; rss: RssActivity[]; basics: DailyBasic[] };
function YearView() {
  const [year, setYear] = useState(new Date().getFullYear()); const [snapshot, setSnapshot] = useState<YearSnapshot>({ activity: {}, habits: [], logs: [], sessions: [], rss: [], basics: [] });
  useEffect(() => {
    const key = `life:year:v2:${year}`;
    const load = () => {
      void getCached<YearSnapshot>(key).then(cached => cached && setSnapshot(cached.value));
      const start = new Date(year, 0, 1); const end = new Date(year + 1, 0, 1);
      void withTimeout<any>(client.life.year.get({ query: { year: String(year), start: start.toISOString(), end: end.toISOString() }, headers: headersWithAuth() }) as Promise<any>, READ_TIMEOUT).then(({ data }) => {
        if (!data || typeof data === 'string') return;
        const activity: Record<string, number> = {}; const logs = data.logs as Log[]; const sessions = data.sessions as PomodoroSession[]; const rss = data.rss as RssActivity[]; const basics = (data.basics || []) as DailyBasic[];
        logs.forEach(log => { if (log.completed) activity[log.date] = (activity[log.date] || 0) + 1; });
        sessions.forEach(session => { if (session.completed) { const date = isoDay(new Date(session.startedAt)); activity[date] = (activity[date] || 0) + 1; } });
        rss.forEach(item => { [item.readAt, item.starredAt].forEach(value => { if (value) { const date = isoDay(new Date(value)); activity[date] = (activity[date] || 0) + 1; } }); });
        basics.forEach(item => { if (item.completed) activity[item.date] = (activity[item.date] || 0) + 1; });
        const next = { activity, habits: data.habits || [], logs, sessions, rss, basics }; setSnapshot(next); void setCached(key, next);
      }).catch(() => undefined);
    };
    load(); const handler = () => load(); window.addEventListener(CLOUD_REFRESH_EVENT, handler); return () => window.removeEventListener(CLOUD_REFRESH_EVENT, handler);
  }, [year]);
  const start = new Date(year, 0, 1); const cells = Array.from({ length: 371 }, (_, index) => { const date = addDays(start, index - ((start.getDay() + 6) % 7)); return date.getFullYear() === year ? isoDay(date) : ''; });
  const completedLogs = snapshot.logs.filter(log => log.completed); const completedSessions = snapshot.sessions.filter(session => session.completed); const completedBasics = snapshot.basics.filter(item => item.completed);
  const habitCounts = new Map<number, number>(); completedLogs.forEach(log => habitCounts.set(log.habitId, (habitCounts.get(log.habitId) || 0) + 1)); const stable = [...habitCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const monthly = Array.from({ length: 12 }, (_, month) => { const prefix = `${year}-${String(month + 1).padStart(2, '0')}`; return Object.entries(snapshot.activity).filter(([date]) => date.startsWith(prefix)).reduce((sum, [, count]) => sum + count, 0); }); const maxMonth = Math.max(1, ...monthly);
  return <LifeLayout section="calendar" title="年度回顾" intro="Calendar 看见这个月，Year 留下这一整年的生活痕迹。"><div className="year-tools"><button onClick={() => setYear(year - 1)}>← {year - 1}</button><strong>{year}</strong><button onClick={() => setYear(year + 1)}>{year + 1} →</button></div><section className="year-overview"><article><small>HABIT</small><strong>{completedLogs.length}</strong><span>{stable ? `最稳定：${snapshot.habits.find(item => item.id === stable[0])?.name || '习惯'} · ${stable[1]} 次` : '尚无完成记录'}</span></article><article><small>FOCUS</small><strong>{completedSessions.reduce((sum, item) => sum + item.focusMinutes, 0)} min</strong><span>{completedSessions.length} 轮专注</span></article><article><small>RSS</small><strong>{snapshot.rss.filter(item => item.readAt).length}</strong><span>{snapshot.rss.filter(item => item.starredAt).length} 次收藏</span></article><article><small>TODAY</small><strong>{new Set(completedBasics.map(item => item.date)).size}</strong><span>{completedBasics.length} 件基础事项</span></article></section><section className="year-heatmap"><header><strong>Life Heatmap</strong><span>{Object.keys(snapshot.activity).length} 个有记录的日子</span></header><div className="life-year-grid">{cells.map((date, index) => <span key={`${date}-${index}`} className={!date ? 'empty' : `level-${Math.min(4, snapshot.activity[date] || 0)}`} title={date ? `${date} · ${snapshot.activity[date] || 0} 条记录` : ''} />)}</div></section><section className="monthly-strip"><header><strong>月份</strong><span>点击进入当月日历</span></header>{monthly.map((value, index) => <Link key={index} href={`/life/calendar?month=${year}-${String(index + 1).padStart(2, '0')}`}><b>{String(index + 1).padStart(2, '0')}</b><i><span style={{ width: `${Math.max(4, value / maxMonth * 100)}%` }} /></i><em>{value}</em></Link>)}</section></LifeLayout>;
}

type RssPreviewItem = Pick<RssItem, 'title' | 'url' | 'summary' | 'publishedAt' | 'mediaType' | 'thumbnailUrl'> & { externalId: string };
type ResolvedFeed = { sourceUrl: string; feedUrl: string; provider: string; platform: string; externalId: string; title: string; description: string; siteUrl: string; icon: string; category: string; contentType: string; preview: RssPreviewItem[] };
async function mergePendingRss(value: RssData) {
  const patches = (await getSyncQueue()).filter(item => item.entity === 'rss' && item.action === 'update');
  if (!patches.length) return value;
  return { ...value, items: value.items.map(item => { let next = item; for (const queued of patches) { const payload = queued.payload as { id: number; patch: { read?: boolean; starred?: boolean } }; if (payload.id === item.id) next = { ...next, ...(payload.patch.read === undefined ? {} : { read: payload.patch.read ? 1 : 0 }), ...(payload.patch.starred === undefined ? {} : { starred: payload.patch.starred ? 1 : 0 }) }; } return next; }) };
}

function readableRssError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  try { const value = JSON.parse(error.message) as { summary?: string; message?: string }; return value.summary || value.message || fallback; } catch { return error.message || fallback; }
}

function RssView() {
  const [data, setData] = useState<RssData | null>(null);
  const [filter, setFilter] = useState<'unread' | 'starred'>('unread');
  const [contentType, setContentType] = useState<RssContentType>('all');
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [selectedItem, setSelectedItem] = useState<RssItem | null>(null);
  const [search, setSearch] = useState('');
  const [sourceSearch, setSourceSearch] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [showGroups, setShowGroups] = useState(false);
  const [editingSource, setEditingSource] = useState<RssSubscription | null>(null);
  const [lightbox, setLightbox] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [candidates, setCandidates] = useState<ResolvedFeed[]>([]);
  const [candidate, setCandidate] = useState<ResolvedFeed | null>(null);
  const [alias, setAlias] = useState('');
  const [category, setCategory] = useState('其他');
  const [newGroup, setNewGroup] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const cacheKey = `life:rss:v3:${sourceId || filter}:${contentType}:${search.trim()}`;

  const load = async (append = false) => {
    if (!append) { const cached = await getCached<RssData>(cacheKey); if (cached) setData(cached.value); }
    const nextOffset = append ? offset : 0;
    try {
      const query = new URLSearchParams({ filter: sourceId ? 'all' : filter, contentType, limit: '200', offset: String(nextOffset) });
      if (sourceId) query.set('sourceId', String(sourceId));
      if (search.trim()) query.set('search', search.trim());
      const remote = await mergePendingRss(await lifeApi<RssData>(`/rss?${query}`));
      const next = append && data ? { ...remote, items: [...data.items, ...remote.items] } : remote;
      setData(next); setOffset(nextOffset + remote.items.length); await setCached(cacheKey, next);
    } catch { /* Local cache stays usable while the cloud is unavailable. */ }
  };
  useEffect(() => { setOffset(0); setSelectedItem(null); void load(); }, [filter, contentType, sourceId, search]);
  useEffect(() => { if (!lightbox) return; const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setLightbox(''); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [lightbox]);

  const updateItem = async (item: RssItem, patch: { read?: boolean; starred?: boolean }) => {
    const now = new Date(); const apply = (value: RssItem) => ({ ...value, ...(patch.read === undefined ? {} : { read: patch.read ? 1 : 0, readAt: patch.read ? now : null }), ...(patch.starred === undefined ? {} : { starred: patch.starred ? 1 : 0, starredAt: patch.starred ? now : null }) });
    setSelectedItem(current => current?.id === item.id ? apply(current) : current);
    setData(current => current ? { ...current, items: current.items.map(value => value.id === item.id ? apply(value) : value) } : current);
    try { await lifeApi(`/rss/items/${item.id}`, { method: 'POST', body: JSON.stringify(patch) }); } catch { await enqueueMutation('rss', 'update', { id: item.id, patch }); }
  };
  const openItem = async (item: RssItem) => { setSelectedItem(item); if (!item.read) await updateItem(item, { read: true }); };
  const markAllRead = async () => { if (!data?.counts.unread || !window.confirm(`将 ${data.counts.unread} 条未读全部标记为已读？`)) return; const now = new Date(); setData(current => current ? { ...current, items: current.items.map(item => ({ ...item, read: 1, readAt: item.readAt || now })), counts: { ...current.counts, unread: 0 } } : current); setBusy(true); try { await lifeApi('/rss/items/mark-all-read', { method: 'POST' }); setMessage('未读内容已全部清除。'); await load(); } catch { await enqueueMutation('rss', 'mark-all-read', {}); setMessage('已在本地清除未读，联网后自动同步。'); } finally { setBusy(false); } };
  const refreshAll = async () => { if (busy) return; setBusy(true); try { const result = await lifeApi<{ refreshed: number; total: number; added: number; failed: number; failures?: Array<{ title: string; error: string }> }>('/rss/refresh', { method: 'POST' }, 60_000); const detail = result.failures?.slice(0, 2).map(item => `${item.title}：${item.error}`).join('；'); setMessage(`已更新 ${result.refreshed}/${result.total ?? result.refreshed} 个来源，新增 ${result.added} 条${result.failed ? `，${result.failed} 个失败${detail ? `（${detail}）` : ''}` : ''}。`); await load(); } catch (error) { setMessage(readableRssError(error, '更新失败，已缓存内容仍可阅读。')); } finally { setBusy(false); } };
  const detect = async () => { if (!sourceUrl.trim() || busy) return; setBusy(true); setMessage(''); setCandidates([]); setCandidate(null); try { const result = await lifeApi<{ candidates: ResolvedFeed[] }>('/rss/resolve', { method: 'POST', body: JSON.stringify({ sourceUrl: sourceUrl.trim() }) }); const first = result.candidates[0] || null; setCandidates(result.candidates); setCandidate(first); setAlias(first?.title || ''); setCategory(first?.category || '其他'); } catch (error) { setMessage(readableRssError(error, '未发现可订阅源')); } finally { setBusy(false); } };
  const subscribe = async () => { if (!candidate || busy) return; setBusy(true); try { const payload = { feedUrl: candidate.feedUrl, sourceUrl: candidate.sourceUrl, title: candidate.title, alias: alias.trim(), description: candidate.description, category: category.trim() || '其他', provider: candidate.provider, platform: candidate.platform, externalId: candidate.externalId, contentType: candidate.contentType, icon: candidate.icon }; const result = await lifeApi<{ warning?: string }>('/rss/subscriptions', { method: 'POST', body: JSON.stringify(payload) }); setMessage(result.warning ? `订阅已保存；首次更新失败：${result.warning}` : '订阅成功，内容已加入资料库。'); setShowAdd(false); setSourceUrl(''); setCandidate(null); setCandidates([]); await load(); } catch (error) { setMessage(readableRssError(error, '订阅失败')); } finally { setBusy(false); } };
  const createGroup = async () => { const name = newGroup.trim(); if (!name) return; await lifeApi('/rss/groups', { method: 'POST', body: JSON.stringify({ name }) }); setNewGroup(''); await load(); };
  const renameGroup = async (group: RssGroup) => { const name = window.prompt('新的分组名称', group.name)?.trim(); if (!name || name === group.name) return; await lifeApi(`/rss/groups/${group.id}`, { method: 'POST', body: JSON.stringify({ name }) }); await load(); };
  const deleteGroup = async (group: RssGroup) => { if (!window.confirm(`删除分组「${group.name}」？其中来源会移动到“其他”。`)) return; await lifeApi(`/rss/groups/${group.id}`, { method: 'DELETE' }); await load(); };
  const removeSource = async (source: RssSubscription) => { if (!window.confirm(`取消订阅「${source.alias || source.title}」？`)) return; await lifeApi(`/rss/subscriptions/${source.id}`, { method: 'DELETE' }); setEditingSource(null); setSourceId(null); await load(); };
  const refreshSource = async (source: RssSubscription) => { setBusy(true); try { const result = await lifeApi<{ added: number }>(`/rss/subscriptions/${source.id}/refresh`, { method: 'POST' }, 30_000); setMessage(`「${source.alias || source.title}」新增 ${result.added || 0} 条。`); await load(); } catch (error) { setMessage(readableRssError(error, `「${source.alias || source.title}」更新失败`)); } finally { setBusy(false); } };

  const subscriptions = data?.subscriptions || []; const items = data?.items || []; const counts = data?.counts || { all: 0, unread: 0, starred: 0 };
  const persistedGroups = data?.groups || []; const groupNames = [...new Set([...persistedGroups.map(group => group.name), ...subscriptions.map(source => source.category || '其他')])];
  const displayName = (source: RssSubscription) => source.alias || source.title || new URL(source.feedUrl).hostname;
  const sourceOf = (item: RssItem) => subscriptions.find(source => source.id === item.subscriptionId);
  const itemImage = (item: RssItem) => item.thumbnailUrl || item.mediaUrl;
  const renderCard = (item: RssItem) => {
    const source = sourceOf(item); const kind = item.mediaType === 'video' ? 'video' : item.mediaType === 'image' ? 'image' : 'text';
    return <article key={item.id} className={`rss-card rss-card-${kind} ${item.read ? 'is-read' : ''}`} onClick={() => void openItem(item)}>{itemImage(item) ? <div className="rss-card-media"><img src={itemImage(item)} alt="" loading="lazy" />{kind === 'video' && <i className="ri-play-large-fill" />}</div> : <div className="rss-card-placeholder"><i className={kind === 'video' ? 'ri-video-line' : 'ri-article-line'} /></div>}<div className="rss-card-copy"><strong>{item.title}</strong>{kind === 'text' && item.summary && <p>{item.summary}</p>}<span>{source ? displayName(source) : item.author || '订阅内容'} · {new Date(item.publishedAt).toLocaleDateString()}</span></div><button className={item.starred ? 'starred' : ''} title="收藏" onClick={event => { event.stopPropagation(); void updateItem(item, { starred: !item.starred }); }}><i className={item.starred ? 'ri-star-fill' : 'ri-star-line'} /></button></article>;
  };

  return <main className="rss-standalone"><Helmet><title>RSS | Shjdshy</title></Helmet><section className="rss-standalone-shell">
    <div className="rss-command"><Link href="/life" className="rss-back"><i className="ri-arrow-left-line" /> Life</Link><button onClick={() => setShowAdd(true)}><i className="ri-add-line" /> 新增订阅</button><label><i className="ri-search-line" /><input value={search} placeholder="搜索标题、摘要或作者" onChange={event => setSearch(event.target.value)} /></label><button onClick={refreshAll} disabled={busy || !subscriptions.length}><i className="ri-refresh-line" /> 更新</button></div>
    {message && <p className="rss-message">{message}</p>}
    <div className={`rss-workspace rss-workspace-wide ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
      <aside className="rss-library"><button className="rss-sidebar-toggle" onClick={() => setSidebarCollapsed(value => !value)} title={sidebarCollapsed ? '展开来源栏' : '收起来源栏'}><i className={sidebarCollapsed ? 'ri-side-bar-fill' : 'ri-contract-left-line'} /></button><div className="rss-library-content"><div className="rss-side-heading"><span>LIBRARY</span><button onClick={() => setShowGroups(true)} title="管理分组"><i className="ri-folder-settings-line" /></button></div><button className={!sourceId && filter === 'unread' ? 'active' : ''} onClick={() => { setSourceId(null); setFilter('unread'); }}><i className="ri-mail-unread-line" /><span>未读</span><b>{counts.unread}</b></button><button className={!sourceId && filter === 'starred' ? 'active' : ''} onClick={() => { setSourceId(null); setFilter('starred'); }}><i className="ri-star-line" /><span>收藏</span><b>{counts.starred}</b></button>{!sourceId && filter === 'unread' && counts.unread > 0 && <button className="rss-clear-unread" onClick={() => void markAllRead()}><i className="ri-check-double-line" /><span>一键清除未读</span></button>}<div className="rss-side-heading"><span>VIEW</span></div>{([['all','全部类型','ri-layout-grid-line'],['text','文章','ri-article-line'],['video','视频','ri-video-line'],['image','图片','ri-image-line']] as Array<[RssContentType,string,string]>).map(([key,name,icon]) => <button key={key} className={contentType === key ? 'active' : ''} onClick={() => setContentType(key)}><i className={icon} /><span>{name}</span></button>)}<label className="rss-source-search"><i className="ri-search-line" /><input value={sourceSearch} placeholder="搜索来源" onChange={event => setSourceSearch(event.target.value)} /></label>{groupNames.map(group => { const sources = subscriptions.filter(source => (source.category || '其他') === group && displayName(source).toLowerCase().includes(sourceSearch.toLowerCase())); if (!sources.length) return null; const folded = collapsed.has(group); return <section className="rss-source-group" key={group}><button onClick={() => setCollapsed(current => { const next = new Set(current); next.has(group) ? next.delete(group) : next.add(group); return next; })}><i className={folded ? 'ri-arrow-right-s-line' : 'ri-arrow-down-s-line'} /><strong>{group}</strong><b>{sources.length}</b></button>{!folded && sources.map(source => <div className="rss-source-row" key={source.id}><button className={sourceId === source.id ? 'active' : ''} onClick={() => { setSourceId(source.id); setContentType(source.contentType === 'video' || source.contentType === 'image' ? source.contentType as RssContentType : 'all'); }}><img src={source.favicon || '/favicon.png'} alt="" loading="lazy" /><span>{displayName(source)}</span></button><button title="来源设置" onClick={() => setEditingSource(source)}><i className="ri-more-2-fill" /></button></div>)}</section>; })}</div></aside>
      <section className={`rss-main ${selectedItem ? `is-reader is-${selectedItem.mediaType}` : 'is-library'}`}>{selectedItem ? <article className="rss-reader"><header><button onClick={() => setSelectedItem(null)}><i className="ri-arrow-left-line" /> 返回</button><div><button className={selectedItem.starred ? 'starred' : ''} onClick={() => void updateItem(selectedItem, { starred: !selectedItem.starred })}><i className={selectedItem.starred ? 'ri-star-fill' : 'ri-star-line'} /> 收藏</button><a href={selectedItem.url} target="_blank" rel="noreferrer">原始链接 <i className="ri-external-link-line" /></a></div></header>{selectedItem.mediaType === 'video' && selectedItem.embedUrl ? <iframe className="rss-reader-video" src={selectedItem.embedUrl} title={selectedItem.title} allow="accelerometer; autoplay; encrypted-media; picture-in-picture" allowFullScreen /> : selectedItem.mediaType === 'video' && itemImage(selectedItem) ? <a href={selectedItem.url} target="_blank" rel="noreferrer" className="rss-reader-video-fallback"><img src={itemImage(selectedItem)} alt="" /><span>该来源未提供可嵌入播放器，点击前往原站播放</span></a> : null}{selectedItem.mediaType === 'image' && itemImage(selectedItem) && <><button className="rss-reader-image" onClick={() => setLightbox(itemImage(selectedItem))}><img src={itemImage(selectedItem)} alt={selectedItem.title} /></button><a className="rss-download" href={selectedItem.mediaUrl || selectedItem.thumbnailUrl} download target="_blank" rel="noreferrer"><i className="ri-download-line" /> 下载原图</a></>}<div className="rss-reader-body"><span>{sourceOf(selectedItem) ? displayName(sourceOf(selectedItem)!) : selectedItem.author} · {new Date(selectedItem.publishedAt).toLocaleString()}</span><h2>{selectedItem.title}</h2>{(selectedItem.contentHtml || selectedItem.summary) && <p>{selectedItem.contentHtml || selectedItem.summary}</p>}</div></article> : <><div className={`rss-card-grid rss-card-grid-${contentType}`}>{items.map(renderCard)}</div>{!items.length && <p className="rss-empty">这里暂时没有内容。</p>}{data?.page?.hasMore && <button className="rss-load-more" onClick={() => void load(true)}>加载更早内容</button>}</>}</section>
    </div>
    {showAdd && <div className="rss-modal-backdrop" onMouseDown={() => setShowAdd(false)}><section className="rss-modal" onMouseDown={event => event.stopPropagation()}><header><div><small>ADD SUBSCRIPTION</small><h2>新增订阅</h2></div><button onClick={() => setShowAdd(false)}><i className="ri-close-line" /></button></header><p>支持 RSS / Atom / JSON Feed、RSSHub、YouTube、Bilibili 与 X 用户链接。</p>{message && !candidate && <p className="rss-modal-message">{message}</p>}<label>来源地址<input autoFocus value={sourceUrl} placeholder="粘贴 Feed 或频道主页" onChange={event => setSourceUrl(event.target.value)} /></label><button className="rss-save" onClick={() => void detect()} disabled={busy || !sourceUrl.trim()}>{busy ? '正在检测…' : '检测来源'}</button>{candidates.length > 1 && <label>发现的订阅<select value={candidate?.feedUrl || ''} onChange={event => { const next = candidates.find(value => value.feedUrl === event.target.value) || null; setCandidate(next); setAlias(next?.title || ''); setCategory(next?.category || '其他'); }}>{candidates.map(value => <option value={value.feedUrl} key={value.feedUrl}>{value.title}</option>)}</select></label>}{candidate && <div className="rss-detected"><small>{candidate.platform.toUpperCase()} · {candidate.contentType.toUpperCase()}</small><h3>{candidate.title}</h3><label>显示名称<input value={alias} onChange={event => setAlias(event.target.value)} /></label><label>分组<input list="rss-group-options" value={category} onChange={event => setCategory(event.target.value)} /><datalist id="rss-group-options">{groupNames.map(name => <option key={name} value={name} />)}</datalist></label><div className="rss-preview-list">{candidate.preview.map(item => <span key={item.externalId}>{item.title}</span>)}</div><button className="rss-save" onClick={() => void subscribe()} disabled={busy}>确认订阅</button></div>}</section></div>}
    {showGroups && <div className="rss-modal-backdrop" onMouseDown={() => setShowGroups(false)}><section className="rss-modal rss-group-manager" onMouseDown={event => event.stopPropagation()}><header><div><small>SOURCE GROUPS</small><h2>管理分组</h2></div><button onClick={() => setShowGroups(false)}><i className="ri-close-line" /></button></header><div className="rss-group-create"><input value={newGroup} placeholder="新分组名称" onChange={event => setNewGroup(event.target.value)} /><button onClick={() => void createGroup()}>创建</button></div>{persistedGroups.map(group => <div className="rss-group-manage-row" key={group.id}><strong>{group.name}</strong><span>{subscriptions.filter(source => source.category === group.name).length} 个来源</span><button onClick={() => void renameGroup(group)}><i className="ri-edit-line" /></button><button onClick={() => void deleteGroup(group)}><i className="ri-delete-bin-line" /></button></div>)}</section></div>}
    {editingSource && <div className="rss-modal-backdrop" onMouseDown={() => setEditingSource(null)}><section className="rss-modal" onMouseDown={event => event.stopPropagation()}><header><div><small>SOURCE SETTINGS</small><h2>{displayName(editingSource)}</h2></div><button onClick={() => setEditingSource(null)}><i className="ri-close-line" /></button></header><SourcePanel source={editingSource} busy={busy} onRefresh={() => void refreshSource(editingSource)} onRemove={() => void removeSource(editingSource)} onSaved={() => { setEditingSource(null); void load(); }} /></section></div>}
    {lightbox && <div className="rss-lightbox" onClick={() => setLightbox('')}><img src={lightbox} alt="" /><span>ESC 关闭</span></div>}
  </section></main>;
}

function SourcePanel({ source, busy, onRefresh, onRemove, onSaved }: { source: RssSubscription; busy: boolean; onRefresh: () => void; onRemove: () => void; onSaved: () => void }) {
  const [alias, setAlias] = useState(source.alias || source.title); const [description, setDescription] = useState(source.description || ''); const [category, setCategory] = useState(source.category || '其他'); const [saving, setSaving] = useState(false);
  useEffect(() => { setAlias(source.alias || source.title); setDescription(source.description || ''); setCategory(source.category || '其他'); }, [source.id]);
  const save = async () => { setSaving(true); try { await lifeApi(`/rss/subscriptions/${source.id}`, { method: 'POST', body: JSON.stringify({ alias, description, category }) }); onSaved(); } finally { setSaving(false); } };
  return <><p className="rss-context-kicker">SOURCE INFO</p><img className="rss-context-icon" src={source.favicon || '/favicon.png'} alt="" /><h2>{source.alias || source.title}</h2><span>{source.platform} · {source.provider}</span><label>显示名称<input value={alias} onChange={event => setAlias(event.target.value)} /></label><label>分类<input value={category} onChange={event => setCategory(event.target.value)} /></label><label>备注<textarea value={description} onChange={event => setDescription(event.target.value)} /></label><button className="rss-save" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存来源信息'}</button><button onClick={onRefresh} disabled={busy}><i className="ri-refresh-line" /> 更新这个来源</button><p>{source.lastError || (source.lastFetchedAt ? `上次更新：${new Date(source.lastFetchedAt).toLocaleString()}` : '等待首次更新')}</p><a className="rss-feed-url" href={source.sourceUrl || source.siteUrl || source.feedUrl} target="_blank" rel="noreferrer">访问来源 <i className="ri-external-link-line" /></a><button className="rss-remove" onClick={onRemove}>取消订阅</button></>;
}
