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
type RssSubscription = { id: number; feedUrl: string; title: string; siteUrl: string; favicon: string; lastFetchedAt: Date | null; lastError: string };
type RssItem = { id: number; subscriptionId: number; title: string; url: string; summary: string; author: string; publishedAt: Date; read: number; starred: number; readAt?: Date | null; starredAt?: Date | null };
type RssData = { subscriptions: RssSubscription[]; items: RssItem[]; counts: { all: number; unread: number; starred: number } };
type RssFilter = 'all' | 'today' | 'unread' | 'starred';
type RssContentType = 'all' | 'article' | 'video' | 'image';
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
const rssContentType = (item: RssItem, subscriptions: RssSubscription[]): Exclude<RssContentType, 'all'> => {
  const source = subscriptions.find(value => value.id === item.subscriptionId);
  const haystack = `${item.url} ${source?.feedUrl || ''} ${source?.siteUrl || ''}`.toLowerCase();
  if (/youtube\.com|youtu\.be|vimeo\.com|bilibili\.com/.test(haystack)) return 'video';
  if (/\.(png|jpe?g|gif|webp|avif)(?:\?|$)/.test(item.url)) return 'image';
  return 'article';
};

async function lifeApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await withTimeout(fetch(`${endpoint}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...headersWithAuth(), ...(init?.headers || {}) } }), 3000);
  if (!response.ok) throw new Error((await response.text()) || `Request failed: ${response.status}`);
  const body = await response.text();
  return (body && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(body) : body || null) as T;
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
    const { data, error } = await withTimeout<any>(client.habit.index.post({ name: payload.name, description: payload.description, color: payload.color, clientKey: payload.clientKey }, { headers: headersWithAuth() }) as Promise<any>);
    if (error || !data?.insertedId) return false;
    const mapping = (await getCached<Record<string, number>>('life:habit-id-map'))?.value || {};
    mapping[String(payload.localId)] = data.insertedId;
    await setCached('life:habit-id-map', mapping);
    return true;
  }
  if (item.entity === 'habit' && (item.action === 'update' || item.action === 'archive')) {
    const payload = item.payload as { id: number; patch: { name?: string; description?: string; color?: string; active?: boolean } };
    const id = await resolveHabitId(payload.id);
    const { error } = await withTimeout<any>(client.habit({ id }).post(payload.patch, { headers: headersWithAuth() }) as Promise<any>);
    return !error;
  }
  if (item.entity === 'habit' && item.action === 'toggle') {
    const payload = item.payload as { id: number; date: string; completed: boolean };
    const id = await resolveHabitId(payload.id);
    const { error } = await withTimeout<any>(client.habit({ id }).toggle.post({ date: payload.date, completed: payload.completed }, { headers: headersWithAuth() }) as Promise<any>);
    return !error;
  }
  if (item.entity === 'note' && item.action === 'save') {
    const payload = item.payload as { date: string; content: string; updatedAt: string };
    const { error } = await withTimeout<any>(client.life.notes({ date: payload.date }).post({ content: payload.content, updatedAt: payload.updatedAt }, { headers: headersWithAuth() }) as Promise<any>);
    return !error;
  }
  if (item.entity === 'basic') {
    const payload = item.payload as { localId?: number; id?: number; date?: string; content?: string; completed?: boolean; sortOrder?: number; clientKey?: string };
    if (item.action === 'create') {
      const result = await lifeApi<{ insertedId: number }>('/life/basics', { method: 'POST', body: JSON.stringify(payload) });
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
    const payload = item.payload as { startedAt: string };
    const month = payload.startedAt.slice(0, 7);
    const existing = await withTimeout<any>(client.pomodoro.sessions.get({ query: { month }, headers: headersWithAuth() }) as Promise<any>);
    if (Array.isArray(existing.data) && existing.data.some((session: PomodoroSession) => new Date(session.startedAt).toISOString() === new Date(payload.startedAt).toISOString())) return true;
    const { error } = await withTimeout<any>(client.pomodoro.sessions.post(item.payload as never, { headers: headersWithAuth() }) as Promise<any>);
    return !error;
  }
  if (item.entity === 'rss' && item.action === 'update') {
    const payload = item.payload as { id: number; patch: { read?: boolean; starred?: boolean } };
    const { error } = await withTimeout<any>(client.rss.items({ id: payload.id }).post(payload.patch, { headers: headersWithAuth() }) as Promise<any>);
    return !error;
  }
  return true;
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

function LifeSyncStatus() {
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<'synced' | 'pending' | 'syncing' | 'failed' | 'offline'>(navigator.onLine ? 'synced' : 'offline');
  const [lastSync, setLastSync] = useState(() => localStorage.getItem('shjdshy-last-sync') || '');
  const refresh = async () => { const queue = await getSyncQueue(); setPending(queue.length); if (!navigator.onLine) setStatus('offline'); else if (queue.some(item => item.status === 'failed')) setStatus('failed'); else setStatus(queue.length ? 'pending' : 'synced'); };
  const sync = async () => {
    if (!navigator.onLine) { setStatus('offline'); await refresh(); return; }
    setStatus('syncing');
    const result = await flushSyncQueue(sendQueuedMutation);
    await refresh();
    if (result.failed) { setStatus('failed'); return; }
    const stamp = new Date().toISOString();
    localStorage.setItem('shjdshy-last-sync', stamp); setLastSync(stamp); setStatus('synced');
    window.dispatchEvent(new CustomEvent(CLOUD_REFRESH_EVENT));
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
  return <button className={`life-sync-status ${status}`} onClick={() => void sync()} disabled={status === 'syncing'} title="推送本地更改并拉取云端最新数据"><i className={`${icons[status]} ${status === 'syncing' ? 'spin' : ''}`} /><span>{labels[status]}</span></button>;
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
      }) as Promise<any>, 3000).then(({ data }) => { if (data && typeof data !== 'string') { const next = data as LifeOverviewData; setOverview(next); void setCached(key, next); } }).catch(() => undefined);
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
  const [items, setItems] = useState<DailyBasic[]>(initial || []); const [draft, setDraft] = useState('');
  const persist = async (next: DailyBasic[]) => { setItems(next); await setCached(cacheKey, next); await patchCalendarCache(date, value => ({ ...value, basics: next })); };
  const load = async () => {
    const cached = await getCached<DailyBasic[]>(cacheKey); if (cached) setItems(cached.value);
    try { const cloud = await lifeApi<DailyBasic[]>(`/life/basics?from=${date}&to=${date}`); if (Array.isArray(cloud)) await persist(cloud); } catch {}
  };
  useEffect(() => { if (initial) void setCached(cacheKey, initial); void load(); const handler = () => void load(); window.addEventListener(CLOUD_REFRESH_EVENT, handler); return () => window.removeEventListener(CLOUD_REFRESH_EVENT, handler); }, []);
  const create = async () => {
    const content = draft.trim(); if (!content) return;
    const localId = -Date.now(); const clientKey = crypto.randomUUID(); const local: DailyBasic = { id: localId, date, content, completed: 0, sortOrder: items.length, clientKey };
    const next = [...items, local]; setDraft(''); await persist(next);
    const payload = { localId, date, content, sortOrder: local.sortOrder, clientKey };
    try { const data = await lifeApi<{ insertedId: number }>('/life/basics', { method: 'POST', body: JSON.stringify(payload) }); await persist(next.map(item => item.id === localId ? { ...item, id: data.insertedId } : item)); }
    catch { await enqueueMutation('basic', 'create', payload); }
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
  return <section className="today-basics"><header><div><small>TODAY</small><h2>今日最基础的三件事</h2></div><span>{completed} / {items.length}</span></header><div>{items.map(item => <article key={item.id} className={item.completed ? 'done' : ''}><button aria-label={item.completed ? '取消完成' : '标记完成'} onClick={() => void update(item, { completed: !item.completed })}><i className={item.completed ? 'ri-check-line' : ''} /></button><input value={item.content} maxLength={240} onChange={event => setItems(current => current.map(value => value.id === item.id ? { ...value, content: event.target.value } : value))} onBlur={event => { const content = event.target.value.trim(); if (content) void update(item, { content }); }} /><button className="remove" aria-label="删除" onClick={() => void remove(item)}><i className="ri-close-line" /></button></article>)}</div><footer><input value={draft} maxLength={240} placeholder="今天至少想完成什么？" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void create(); }} /><button disabled={!draft.trim()} onClick={() => void create()}><i className="ri-add-line" /> 添加</button></footer></section>;
}

function HabitView() {
  const [weekStart, setWeekStart] = useState(mondayOf()); const [habits, setHabits] = useState<Habit[]>([]); const [logs, setLogs] = useState<Log[]>([]); const [notes, setNotes] = useState<DailyNote[]>([]); const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [selectedDate, setSelectedDate] = useState(isoDay()); const [noteDraft, setNoteDraft] = useState(''); const [editing, setEditing] = useState<Habit | null>(null);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const cacheKey = `life:habits:${isoDay(days[0])}:${isoDay(days[6])}`;
  const load = async () => { const cached = await getCached<{ habits: Habit[]; logs: Log[]; notes: DailyNote[] }>(cacheKey); if (cached) { setHabits(cached.value.habits); setLogs(cached.value.logs); setNotes(cached.value.notes || []); } try { const [habitResult, noteResult] = await Promise.all([withTimeout<any>(client.habit.range.get({ query: { from: isoDay(days[0]), to: isoDay(days[6]) }, headers: headersWithAuth() }) as Promise<any>, 3000), withTimeout<any>(client.life.notes.get({ query: { from: isoDay(days[0]), to: isoDay(days[6]) }, headers: headersWithAuth() }) as Promise<any>, 3000)]); if (habitResult.data && typeof habitResult.data !== 'string') { const next = { habits: habitResult.data.habits as Habit[], logs: habitResult.data.logs as Log[], notes: Array.isArray(noteResult.data) ? noteResult.data as DailyNote[] : [] }; setHabits(next.habits); setLogs(next.logs); setNotes(next.notes); await setCached(cacheKey, next); } } catch {} };
  useEffect(() => { void load(); const handler = () => void load(); window.addEventListener(CLOUD_REFRESH_EVENT, handler); return () => window.removeEventListener(CLOUD_REFRESH_EVENT, handler); }, [weekStart.getTime()]);
  useEffect(() => { setNoteDraft(notes.find(note => note.date === selectedDate)?.content || ''); }, [selectedDate, notes]);
  const persist = (nextHabits = habits, nextLogs = logs, nextNotes = notes) => setCached(cacheKey, { habits: nextHabits, logs: nextLogs, notes: nextNotes });
  const create = async () => { if (!name.trim() || busy) return; setBusy(true); const localId = -Date.now(); const clientKey = crypto.randomUUID(); const local: Habit = { id: localId, name: name.trim(), description: '', color: '#e11d62', active: 1, clientKey }; const nextHabits = [local, ...habits]; setHabits(nextHabits); void persist(nextHabits); setName(''); const payload = { localId, name: local.name, clientKey }; try { const { data, error } = await withTimeout<any>(client.habit.index.post({ name: local.name, clientKey }, { headers: headersWithAuth() }) as Promise<any>, 3000); if (error || !data?.insertedId) throw new Error('sync failed'); const mapped = nextHabits.map(item => item.id === localId ? { ...item, id: data.insertedId } : item); setHabits(mapped); await persist(mapped); } catch { await enqueueMutation('habit', 'create', payload); } finally { setBusy(false); } };
  const updateHabit = async (habit: Habit, patch: { name?: string; description?: string; active?: boolean }) => { const nextHabits = habits.map(item => item.id === habit.id ? { ...item, ...patch, active: patch.active === undefined ? item.active : patch.active ? 1 : 0 } : item); setHabits(nextHabits); void persist(nextHabits); try { const id = await resolveHabitId(habit.id); const { error } = await withTimeout<any>(client.habit({ id }).post(patch, { headers: headersWithAuth() }) as Promise<any>, 3000); if (error) throw new Error('sync failed'); } catch { await enqueueMutation('habit', patch.active === false ? 'archive' : 'update', { id: habit.id, patch }); } };
  const toggle = async (habitId: number, date: string) => { setSelectedDate(date); const completed = logs.some(log => log.habitId === habitId && log.date === date && log.completed); const nextLogs = completed ? logs.map(log => log.habitId === habitId && log.date === date ? { ...log, completed: 0 } : log) : [...logs.filter(log => !(log.habitId === habitId && log.date === date)), { habitId, date, completed: 1 }]; setLogs(nextLogs); void persist(habits, nextLogs); void patchCalendarCache(date, value => ({ ...value, habits, logs: nextLogs })); const payload = { id: habitId, date, completed: !completed }; try { const id = await resolveHabitId(habitId); const { error } = await withTimeout<any>(client.habit({ id }).toggle.post({ date, completed: !completed }, { headers: headersWithAuth() }) as Promise<any>, 3000); if (error) throw new Error('sync failed'); } catch { await enqueueMutation('habit', 'toggle', payload); } };
  const saveNote = async () => { const updatedAt = new Date().toISOString(); const note: DailyNote = { date: selectedDate, content: noteDraft.trim(), updatedAt }; const nextNotes = [...notes.filter(item => item.date !== selectedDate), note]; setNotes(nextNotes); await persist(habits, logs, nextNotes); await patchCalendarCache(selectedDate, value => ({ ...value, notes: [...(value.notes || []).filter(item => item.date !== selectedDate), note] })); try { const { error } = await withTimeout<any>(client.life.notes({ date: selectedDate }).post({ content: note.content, updatedAt }, { headers: headersWithAuth() }) as Promise<any>, 3000); if (error) throw new Error('sync failed'); } catch { await enqueueMutation('note', 'save', note); } };
  const activeHabits = habits.filter(habit => habit.active);
  return <LifeLayout section="habits" title="习惯" intro="以一周为单位留下轻巧的确认，不把生活变成 KPI。"><div className="habit-week-tools"><button onClick={() => setWeekStart(addDays(weekStart, -7))}><i className="ri-arrow-left-line" /> 上一周</button><strong>{isoDay(days[0])} — {isoDay(days[6])}</strong><button onClick={() => setWeekStart(mondayOf())}>本周</button><button onClick={() => setWeekStart(addDays(weekStart, 7))}>下一周 <i className="ri-arrow-right-line" /></button></div><div className="habit-week" role="grid"><div className="habit-week-head"><span>习惯</span>{days.map(day => { const date = isoDay(day); return <button key={date} className={selectedDate === date ? 'selected' : ''} onClick={() => setSelectedDate(date)}><b>{['日','一','二','三','四','五','六'][day.getDay()]}</b><small>{day.getDate()}</small></button>; })}</div>{activeHabits.map(habit => <div className="habit-week-row" key={habit.id}><span><strong>{habit.name}</strong><small>{habit.description}</small><button className="habit-edit-button" onClick={() => setEditing(habit)} title="编辑习惯"><i className="ri-edit-line" /></button></span>{days.map(day => { const date = isoDay(day); const done = logs.some(log => log.habitId === habit.id && log.date === date && log.completed); return <button key={date} className={done ? 'done' : ''} aria-label={`${habit.name} ${date} ${done ? '已完成' : '未完成'}`} onClick={() => toggle(habit.id, date)}><i className={done ? 'ri-check-line' : ''} /></button>; })}</div>)}</div><div className="life-add"><input value={name} placeholder="添加一个想长期坚持的习惯" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void create(); }} /><button onClick={create} disabled={busy}>添加</button></div><section className="daily-note"><div><small>DAILY NOTE</small><strong>{selectedDate}</strong></div><textarea value={noteDraft} maxLength={2000} placeholder="今天做了什么 / 有什么想记下来……" onChange={event => setNoteDraft(event.target.value)} /><button onClick={saveNote}>保存当天记录</button></section>{editing && <HabitEditor habit={editing} onClose={() => setEditing(null)} onSave={patch => { void updateHabit(editing, patch); setEditing(null); }} />}</LifeLayout>;
}

function HabitEditor({ habit, onClose, onSave }: { habit: Habit; onClose: () => void; onSave: (patch: { name: string; description: string; active?: boolean }) => void }) {
  const [name, setName] = useState(habit.name); const [description, setDescription] = useState(habit.description);
  return <div className="guide-modal" role="dialog" aria-modal="true"><section><p>编辑习惯</p><h2>{habit.name}</h2><label>名称<input value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label><label>说明<input value={description} maxLength={240} onChange={event => setDescription(event.target.value)} /></label><div className="habit-editor-actions"><button className="habit-archive" onClick={() => { if (window.confirm('停用后将不再显示于每周面板，但历史记录会保留。继续吗？')) onSave({ name, description, active: false }); }}>停用</button><span /><button onClick={onClose}>取消</button><button disabled={!name.trim()} onClick={() => onSave({ name: name.trim(), description: description.trim() })}>保存</button></div></section></div>;
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
      const calendarKey = `life:calendar:${session.startedAt.slice(0, 7)}`;
      const cached = await getCached<CalendarData>(calendarKey);
      if (cached) await setCached(calendarKey, { ...cached.value, sessions: [...cached.value.sessions, { ...session, id: -Date.now(), startedAt: new Date(session.startedAt), endedAt, completed: 1, completedEarly: completedEarly ? 1 : 0 } as PomodoroSession] });
      try { const { error } = await withTimeout<any>(client.pomodoro.sessions.post(session, { headers: headersWithAuth() }) as Promise<any>, 3000); if (error) throw new Error('sync failed'); } catch { await enqueueMutation('pomodoro', 'create', session); } finally { finishing.current = false; }
      return;
    }
    if (timer.mode === 'break') setTimer({ mode: 'focus', round: Math.min(rounds, timer.round + 1), remaining: focusMinutes * 60, targetAt: null, startedAt: null, taskName: timer.taskName });
    finishing.current = false;
  };
  useEffect(() => { if (timer.remaining === 0 && timer.targetAt) void finishStage(); }, [timer.remaining, timer.targetAt]);
  const start = () => setTimer(current => ({ ...current, targetAt: Date.now() + current.remaining * 1000, startedAt: current.mode === 'focus' ? current.startedAt || new Date().toISOString() : null })); const pause = () => setTimer(current => ({ ...current, targetAt: null })); const stop = () => setTimer(current => ({ mode: 'focus', round: 1, remaining: focusMinutes * 60, targetAt: null, startedAt: null, taskName: current.taskName }));
  const commitSetting = (kind: 'focus' | 'break' | 'rounds') => { const limits = kind === 'focus' ? [1, 180] : kind === 'break' ? [1, 60] : [1, 20]; const key: 'focusMinutes' | 'breakMinutes' | 'rounds' = kind === 'focus' ? 'focusMinutes' : kind === 'break' ? 'breakMinutes' : 'rounds'; const value = boundedNumber(drafts[kind], preferences[key], limits[0], limits[1]); setDrafts(current => ({ ...current, [kind]: String(value) })); setPreferences(current => ({ ...current, [key]: value })); if (!timer.startedAt && ((kind === 'focus' && timer.mode === 'focus') || (kind === 'break' && timer.mode === 'break'))) setTimer(current => ({ ...current, remaining: value * 60 })); };
  const clock = `${String(Math.floor(timer.remaining / 60)).padStart(2, '0')}:${String(timer.remaining % 60).padStart(2, '0')}`;
  return <LifeLayout section="pomodoro" title="番茄钟" intro="休息只出现在两轮专注之间；最后一轮结束后，本组计时自然完成。"><label className="pomodoro-task">当前任务<input value={timer.taskName} placeholder="例如：阅读 PPD 论文" disabled={timer.mode === 'break'} onChange={e => setTimer(current => ({ ...current, taskName: e.target.value }))} /></label><div className={`pomodoro ${timer.mode}`}><p>{timer.mode === 'focus' ? 'FOCUS' : 'BREAK'}</p><strong>{clock}</strong><span>{timer.mode === 'focus' ? `第 ${timer.round} / ${rounds} 轮` : `第 ${timer.round} 轮完成 · 接下来第 ${timer.round + 1} 轮`}</span><div>{running ? <button onClick={pause}>暂停</button> : <button onClick={start}>{timer.remaining === (timer.mode === 'focus' ? focusMinutes : breakMinutes) * 60 ? '开始' : '继续'}</button>}{timer.mode === 'focus' && timer.startedAt && <button onClick={() => void finishStage(true)}>提前完成</button>}{timer.mode === 'break' && <button onClick={() => void finishStage(true)}>跳过休息</button>}<button className="secondary" onClick={stop}>停止</button></div></div><div className="pomodoro-settings"><label>专注时长<input inputMode="numeric" value={drafts.focus} disabled={Boolean(timer.startedAt) || timer.mode === 'break'} onChange={e => setDrafts(current => ({ ...current, focus: e.target.value }))} onBlur={() => commitSetting('focus')} /></label><label>休息时长<input inputMode="numeric" value={drafts.break} disabled={Boolean(timer.startedAt) || timer.mode === 'break'} onChange={e => setDrafts(current => ({ ...current, break: e.target.value }))} onBlur={() => commitSetting('break')} /></label><label>轮数<input inputMode="numeric" value={drafts.rounds} disabled={Boolean(timer.startedAt) || timer.mode === 'break'} onChange={e => setDrafts(current => ({ ...current, rounds: e.target.value }))} onBlur={() => commitSetting('rounds')} /></label></div></LifeLayout>;
}

function CalendarView({ year }: { year: boolean }) {
  const [month, setMonth] = useState(() => new URLSearchParams(window.location.search).get('month') || monthNow()); const [habits, setHabits] = useState<Habit[]>([]); const [logs, setLogs] = useState<Log[]>([]); const [sessions, setSessions] = useState<PomodoroSession[]>([]); const [rssActivity, setRssActivity] = useState<RssActivity[]>([]); const [notes, setNotes] = useState<DailyNote[]>([]); const [basics, setBasics] = useState<DailyBasic[]>([]); const [focused, setFocused] = useState<number | null>(null); const [selected, setSelected] = useState(() => `${new URLSearchParams(window.location.search).get('month') || monthNow()}-01`);
  useEffect(() => { const key = `life:calendar:${month}`; const apply = (value: CalendarData) => { setHabits(value.habits); setLogs(value.logs); setSessions(value.sessions); setRssActivity(value.rss); setNotes(value.notes || []); setBasics(value.basics || []); }; const load = () => { void getCached<CalendarData>(key).then(cached => { if (cached) apply(cached.value); }); const [yearNumber, monthNumber] = month.split('-').map(Number); const start = new Date(yearNumber, monthNumber - 1, 1); const end = new Date(yearNumber, monthNumber, 1); void withTimeout<any>(client.life.calendar.get({ query: { month, start: start.toISOString(), end: end.toISOString() }, headers: headersWithAuth() }) as Promise<any>, 3000).then(({ data }) => { if (data && typeof data !== 'string') { const next = { habits: data.habits as Habit[], logs: data.logs as Log[], sessions: data.sessions as PomodoroSession[], rss: data.rss as RssActivity[], notes: (data.notes || []) as DailyNote[], basics: (data.basics || []) as DailyBasic[] }; apply(next); void setCached(key, next); } }).catch(() => undefined); }; load(); const handler = () => load(); window.addEventListener(CLOUD_REFRESH_EVENT, handler); return () => window.removeEventListener(CLOUD_REFRESH_EVENT, handler); }, [month]);
  if (year) return <YearView />;
  const first = new Date(`${month}-01T00:00:00`); const dayCount = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(); const blanks = (first.getDay() + 6) % 7; const days = Array.from({ length: dayCount }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`); const done = (date: string) => logs.filter(log => log.date === date && log.completed && (!focused || log.habitId === focused)).length; const focusFor = (date: string) => sessions.filter(session => isoDay(new Date(session.startedAt)) === date && session.completed); const rssFor = (date: string) => rssActivity.filter(item => (item.readAt && isoDay(new Date(item.readAt)) === date) || (item.starredAt && isoDay(new Date(item.starredAt)) === date)); const chosenSessions = focusFor(selected); const chosenLogs = logs.filter(log => log.date === selected && log.completed); const chosenRss = rssFor(selected);
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
      void withTimeout<any>(client.life.year.get({ query: { year: String(year), start: start.toISOString(), end: end.toISOString() }, headers: headersWithAuth() }) as Promise<any>, 3000).then(({ data }) => {
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

function RssView() {
  const [data, setData] = useState<RssData | null>(null); const [filter, setFilter] = useState<RssFilter>('all'); const [contentType, setContentType] = useState<RssContentType>('all'); const [sourceId, setSourceId] = useState<number | null>(null); const [selectedItem, setSelectedItem] = useState<RssItem | null>(null); const [panel, setPanel] = useState<'add' | 'source' | 'reader'>('add'); const [feedUrl, setFeedUrl] = useState(''); const [label, setLabel] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const load = async (next = filter) => { const key = `life:rss:${next}`; const cached = await getCached<RssData>(key); if (cached) setData(cached.value); try { const remoteFilter = next === 'today' ? 'all' : next; const { data } = await withTimeout<any>(client.rss.index.get({ query: { filter: remoteFilter }, headers: headersWithAuth() }) as Promise<any>, 3000); if (data && typeof data !== 'string') { const value = trimRssData(data as RssData); setData(value); await setCached(key, value); } } catch {} }; useEffect(() => { void load(filter); const handler = () => void load(filter); window.addEventListener(CLOUD_REFRESH_EVENT, handler); return () => window.removeEventListener(CLOUD_REFRESH_EVENT, handler); }, [filter]);
  const subscribe = async () => { if (!feedUrl.trim() || busy) return; setBusy(true); setMessage('正在读取订阅源…'); const { error } = await client.rss.subscriptions.post({ feedUrl: feedUrl.trim(), title: label.trim() || undefined }, { headers: headersWithAuth() }); setBusy(false); if (error) { setMessage(typeof error.value === 'string' ? error.value : '订阅失败，请检查地址。'); return; } setFeedUrl(''); setLabel(''); setMessage('订阅已添加并完成首次更新。'); await load(); };
  const refreshAll = async () => { if (busy) return; setBusy(true); const { data, error } = await client.rss.refresh.post(undefined, { headers: headersWithAuth() }); const result = data as { refreshed?: number; added?: number } | null; setBusy(false); setMessage(error ? '更新失败，请稍后再试。' : `已更新 ${result?.refreshed || 0} 个订阅，发现 ${result?.added || 0} 篇新内容。`); await load(); };
  const updateItem = async (item: RssItem, patch: { read?: boolean; starred?: boolean }) => { const now = new Date(); const update = (value: RssItem) => ({ ...value, ...(patch.read === undefined ? {} : { read: patch.read ? 1 : 0, readAt: patch.read ? now : null }), ...(patch.starred === undefined ? {} : { starred: patch.starred ? 1 : 0, starredAt: patch.starred ? now : null }) }); const updated = update(item); setSelectedItem(current => current?.id === item.id ? update(current) : current); setData(current => { if (!current) return current; const next = trimRssData({ ...current, items: current.items.map(value => value.id === item.id ? update(value) : value) }); void setCached(`life:rss:${filter}`, next); return next; }); void patchCalendarCache(isoDay(now), value => ({ ...value, rss: [...value.rss.filter(entry => entry.id !== item.id), { id: item.id, title: item.title, url: item.url, readAt: updated.readAt || null, starredAt: updated.starredAt || null }] })); try { const { error } = await withTimeout<any>(client.rss.items({ id: item.id }).post(patch, { headers: headersWithAuth() }) as Promise<any>, 3000); if (error) throw new Error('sync failed'); } catch { await enqueueMutation('rss', 'update', { id: item.id, patch }); } };
  const openReader = async (item: RssItem) => { setSelectedItem(item); setPanel('reader'); if (!item.read) await updateItem(item, { read: true }); };
  const remove = async (subscription: RssSubscription) => { if (!window.confirm(`取消订阅「${subscription.title || subscription.feedUrl}」？`)) return; await client.rss.subscriptions({ id: subscription.id }).delete(undefined, { headers: headersWithAuth() }); if (sourceId === subscription.id) { setSourceId(null); setPanel('add'); } await load(); };
  const subscriptions = data?.subscriptions || []; const items = data?.items || []; const counts = data?.counts || { all: 0, unread: 0, starred: 0 };
  const today = isoDay(); const visibleItems = items.filter(item => (!sourceId || item.subscriptionId === sourceId) && (filter !== 'today' || isoDay(new Date(item.publishedAt)) === today) && (contentType === 'all' || rssContentType(item, subscriptions) === contentType));
  const selectedSource = subscriptions.find(source => source.id === sourceId) || null;
  return <LifeLayout section="rss" title="RSS" intro="频道、内容流和阅读器保持在同一空间。">
    <div className="rss-command"><button onClick={() => { setPanel('add'); setSelectedItem(null); }}><i className="ri-add-line" /> 新增订阅</button><button onClick={refreshAll} disabled={busy || !subscriptions.length}><i className="ri-refresh-line" /> 更新全部</button></div>
    {message && <p className="rss-message">{message}</p>}
    <div className="rss-workspace">
      <aside className="rss-library"><div className="rss-side-heading"><span>LIBRARY</span><b>{counts.unread}</b></div>{([['all','全部',counts.all,'ri-inbox-line'],['today','今日',items.filter(item => isoDay(new Date(item.publishedAt)) === today).length,'ri-calendar-line'],['unread','未读',counts.unread,'ri-mail-unread-line'],['starred','收藏',counts.starred,'ri-star-line']] as Array<[RssFilter,string,number,string]>).map(([key,name,count,icon]) => <button key={key} className={filter === key && !sourceId ? 'active' : ''} onClick={() => { setFilter(key); setSourceId(null); }}><i className={icon} /><span>{name}</span><b>{count}</b></button>)}<div className="rss-side-heading"><span>CONTENT</span></div>{([['all','全部类型','ri-layout-grid-line'],['article','文章','ri-article-line'],['video','视频','ri-video-line'],['image','图片','ri-image-line']] as Array<[RssContentType,string,string]>).map(([key,name,icon]) => <button key={key} className={contentType === key ? 'active' : ''} onClick={() => setContentType(key)}><i className={icon} /><span>{name}</span></button>)}<div className="rss-side-heading"><span>SOURCES</span><b>{subscriptions.length}</b></div>{subscriptions.map(source => <button key={source.id} className={sourceId === source.id ? 'active' : ''} onClick={() => { setFilter('all'); setSourceId(source.id); setPanel('source'); setSelectedItem(null); }}><img src={source.favicon || '/favicon.png'} alt="" /><span>{source.title || new URL(source.feedUrl).hostname}</span></button>)}</aside>
      <section className="rss-stream"><header><strong>{selectedSource?.title || ({ all: '全部内容', today: '今日更新', unread: '未读内容', starred: '收藏内容' }[filter])}</strong><span>{visibleItems.length} 篇</span></header>{visibleItems.map(item => <article className={`rss-item ${item.read ? 'is-read' : ''} ${selectedItem?.id === item.id ? 'is-selected' : ''}`} key={item.id}><button className="rss-item-main" onClick={() => openReader(item)}><span className="rss-item-meta">{subscriptions.find(source => source.id === item.subscriptionId)?.title || item.author || '订阅文章'} · {new Date(item.publishedAt).toLocaleDateString()} · {{ article: '文章', video: '视频', image: '图片' }[rssContentType(item, subscriptions)]}</span><strong>{item.title}</strong>{item.summary && <p>{item.summary}</p>}</button><div className="rss-item-actions"><button title={item.read ? '标为未读' : '标为已读'} onClick={() => updateItem(item, { read: !item.read })}><i className={item.read ? 'ri-mail-unread-line' : 'ri-mail-open-line'} /></button><button title={item.starred ? '取消收藏' : '收藏'} className={item.starred ? 'starred' : ''} onClick={() => updateItem(item, { starred: !item.starred })}><i className={item.starred ? 'ri-star-fill' : 'ri-star-line'} /></button></div></article>)}{visibleItems.length === 0 && <p className="rss-empty">这里暂时没有内容。</p>}</section>
      <aside className="rss-context">{panel === 'reader' && selectedItem ? <><p className="rss-context-kicker">READER</p><h2>{selectedItem.title}</h2><span>{new Date(selectedItem.publishedAt).toLocaleString()}</span><p className="rss-reader-copy">{selectedItem.summary || '该订阅只提供标题和原始链接。'}</p><div className="rss-context-actions"><button onClick={() => updateItem(selectedItem, { starred: !selectedItem.starred })}><i className={selectedItem.starred ? 'ri-star-fill' : 'ri-star-line'} /> {selectedItem.starred ? '已收藏' : '收藏'}</button><a href={selectedItem.url} target="_blank" rel="noreferrer">打开原文 <i className="ri-external-link-line" /></a></div></> : panel === 'source' && selectedSource ? <><p className="rss-context-kicker">FEED INFO</p><img className="rss-context-icon" src={selectedSource.favicon || '/favicon.png'} alt="" /><h2>{selectedSource.title || selectedSource.feedUrl}</h2><p>{selectedSource.lastError || (selectedSource.lastFetchedAt ? `上次更新：${new Date(selectedSource.lastFetchedAt).toLocaleString()}` : '等待首次更新')}</p><a className="rss-feed-url" href={selectedSource.siteUrl || selectedSource.feedUrl} target="_blank" rel="noreferrer">访问来源 <i className="ri-external-link-line" /></a><button className="rss-remove" onClick={() => remove(selectedSource)}>取消订阅</button></> : <><p className="rss-context-kicker">ADD FEED</p><h2>新增订阅</h2><p>添加公开的 HTTPS RSS、Atom 或 JSON Feed。</p><label>名称<input value={label} placeholder="例如：IEEE Spectrum" onChange={e => setLabel(e.target.value)} /></label><label>RSS 地址<input value={feedUrl} placeholder="https://example.com/feed.xml" onChange={e => setFeedUrl(e.target.value)} /></label><button className="rss-save" onClick={subscribe} disabled={busy || !feedUrl.trim()}>{busy ? '正在读取…' : '保存订阅'}</button></>}</aside>
    </div>
  </LifeLayout>;
}

function trimRssData(value: RssData): RssData {
  const starred = value.items.filter(item => item.starred);
  const starredIds = new Set(starred.map(item => item.id));
  const recent = value.items.filter(item => !starredIds.has(item.id)).slice(0, 200);
  return { ...value, items: [...starred, ...recent].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()) };
}
