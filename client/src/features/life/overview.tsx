import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { client } from '../../main';
import { enqueueMutation, getCached, setCached, withTimeout } from '../../data/local-first';
import { headersWithAuth } from '../../utils/auth';
import { addDays, CLOUD_REFRESH_EVENT, isoDay, lifeApi, mondayOf, READ_TIMEOUT, type DailyBasic, type LifeOverviewData } from './model';
import { mergePendingBasics, normalizeBasics, rememberLocalId, resolveBasicId } from './sync';
import { LifeLayout } from './layout';
import { patchCalendarCache } from './habits';
import { TodoBoard } from "./todos";
import { LifeBackupButton } from './backup';

export function LifeOverview() {
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
    <div className="life-home-layout"><section className="life-home-todos"><header><h2>待办</h2><Link href="/life/todos">四栏工作台</Link></header><TodoBoard /></section><div className="life-home-side">
    <TodayBasics initial={overview?.basics} />
    <div className="life-summary-grid"><Link href="/life/pomodoro"><small>TODAY FOCUS</small><strong>{summary.focusMinutes} min</strong><span>{summary.rounds} 轮专注</span></Link><Link href="/life/habits"><small>THIS WEEK</small><strong>{summary.completed}</strong><span>{summary.habits} 项习惯</span></Link><Link href="/life/calendar"><small>CALENDAR</small><strong>{new Date().getDate()}</strong><span>{new Date().toLocaleDateString('zh-CN', { month: 'long', weekday: 'long' })}</span></Link><Link href="/life/rss"><small>RSS</small><strong>{summary.unread}</strong><span>篇未读</span></Link></div>
    <LifeBackupButton />
    {overview && <div className="life-overview-detail"><section><h2>本周习惯</h2>{overview.habits.map(habit => <p key={habit.id}><strong>{habit.name}</strong><span>{Array.from({ length: 7 }, (_, index) => { const date = isoDay(addDays(mondayOf(), index)); return <i key={date} className={habit.days.includes(date) ? 'done' : ''} title={date} />; })}</span></p>)}</section><section><h2>最近订阅</h2>{overview.recentRss.length ? overview.recentRss.map(item => <Link href="/life/rss" key={item.id}>{item.title}</Link>) : <p>还没有订阅内容</p>}</section></div>}
    </div></div>
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
