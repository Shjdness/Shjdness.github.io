import { useContext, useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'wouter';
import { client } from '../main';
import { ProfileContext } from '../state/profile';
import { headersWithAuth } from '../utils/auth';

type LifeSection = 'life' | 'habits' | 'calendar' | 'year' | 'pomodoro' | 'rss';
type Habit = { id: number; name: string; description: string; color: string; active: number };
type Log = { habitId: number; date: string; completed: number };
type PomodoroSession = { id: number; startedAt: Date; endedAt: Date; focusMinutes: number; roundIndex: number; completed: number };
type RssSubscription = { id: number; feedUrl: string; title: string; siteUrl: string; favicon: string; lastFetchedAt: Date | null; lastError: string };
type RssItem = { id: number; subscriptionId: number; title: string; url: string; summary: string; author: string; publishedAt: Date; read: number; starred: number };
type RssData = { subscriptions: RssSubscription[]; items: RssItem[]; counts: { all: number; unread: number; starred: number } };
type RssFilter = 'all' | 'unread' | 'starred';

const lifeNav = [
  { id: 'life', title: '总览', href: '/life' },
  { id: 'habits', title: '习惯', href: '/life/habits' },
  { id: 'calendar', title: '日历', href: '/life/calendar' },
  { id: 'pomodoro', title: '番茄钟', href: '/life/pomodoro' },
  { id: 'rss', title: 'RSS', href: '/life/rss' },
] as const;

const mayAccessLife = (role?: string) => role === 'owner' || role === 'trusted';
const isoDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const monthNow = () => isoDay().slice(0, 7);
const addDays = (date: Date, count: number) => { const next = new Date(date); next.setDate(next.getDate() + count); return next; };
const mondayOf = (date = new Date()) => { const next = new Date(date); const day = next.getDay() || 7; next.setDate(next.getDate() - day + 1); next.setHours(0, 0, 0, 0); return next; };

export function PrivateLifePage({ section }: { section: LifeSection }) {
  const profile = useContext(ProfileContext);
  const [verified, setVerified] = useState(false);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    if (!mayAccessLife(profile?.role)) { setVerified(false); return; }
    client.life.overview.get({ headers: headersWithAuth() }).then(({ data, error }) => {
      setDenied(Boolean(error) || !data || typeof data === 'string');
      setVerified(Boolean(data) && typeof data !== 'string');
    });
  }, [profile?.id, profile?.role]);
  if (!mayAccessLife(profile?.role) || denied) return <LifeDenied />;
  if (!verified) return <main className="life-page"><section className="life-panel"><p className="life-kicker">PRIVATE LIFE</p><p>正在确认访问权限…</p></section></main>;
  if (section === 'life') return <LifeOverview />;
  if (section === 'habits') return <HabitView />;
  if (section === 'calendar' || section === 'year') return <CalendarView year={section === 'year'} />;
  if (section === 'pomodoro') return <PomodoroView />;
  return <RssView />;
}

function LifeDenied() {
  return <main className="life-page"><section className="life-panel life-denied"><p className="life-kicker">PRIVATE LIFE</p><h1>这里是私人生活空间</h1><p>登录本身不等于私人访问权限。此区域仅向 Owner 与受信任账户开放。</p><Link className="life-link" href="/">返回公开首页</Link></section></main>;
}

function LifeLayout({ section, title, intro, children }: { section: LifeSection; title: string; intro: string; children: React.ReactNode }) {
  return <main className="life-page"><Helmet><title>{title} - {process.env.NAME}</title></Helmet><section className="life-panel life-section">
    <nav className="life-nav" aria-label="Life 导航">{lifeNav.map(item => <Link key={item.id} className={section === item.id ? 'active' : ''} href={item.href}>{item.title}</Link>)}</nav>
    <p className="life-kicker">PRIVATE LIFE</p><h1>{title}</h1><p className="life-intro">{intro}</p>{children}
  </section></main>;
}

function LifeOverview() {
  const [summary, setSummary] = useState({ habits: 0, completed: 0, focus: 0, rounds: 0, unread: 0 });
  useEffect(() => {
    const start = mondayOf(); const end = addDays(start, 6); const month = monthNow();
    Promise.all([
      client.habit.range.get({ query: { from: isoDay(start), to: isoDay(end) }, headers: headersWithAuth() }),
      client.pomodoro.sessions.get({ query: { month }, headers: headersWithAuth() }),
      client.rss.index.get({ query: { filter: 'all' }, headers: headersWithAuth() }),
    ]).then(([habitResult, pomodoroResult, rssResult]) => {
      const habitData = habitResult.data && typeof habitResult.data !== 'string' ? habitResult.data : { habits: [], logs: [] };
      const sessions = pomodoroResult.data && typeof pomodoroResult.data !== 'string' ? pomodoroResult.data : [];
      const rss = rssResult.data && typeof rssResult.data !== 'string' ? rssResult.data : null;
      setSummary({ habits: habitData.habits.length, completed: habitData.logs.filter(log => log.completed).length, focus: sessions.reduce((sum, item) => sum + (item.completed ? item.focusMinutes : 0), 0), rounds: sessions.filter(item => item.completed).length, unread: rss?.counts.unread || 0 });
    });
  }, []);
  return <LifeLayout section="life" title="Life" intro="习惯、专注、阅读与时间，在这里汇成同一条生活轨迹。">
    <div className="life-summary-grid"><Link href="/life/pomodoro"><small>FOCUS</small><strong>{summary.focus} min</strong><span>{summary.rounds} 轮专注</span></Link><Link href="/life/habits"><small>THIS WEEK</small><strong>{summary.completed}</strong><span>{summary.habits} 项习惯</span></Link><Link href="/life/calendar"><small>CALENDAR</small><strong>{new Date().getDate()}</strong><span>{new Date().toLocaleDateString('zh-CN', { month: 'long', weekday: 'long' })}</span></Link><Link href="/life/rss"><small>RSS</small><strong>{summary.unread}</strong><span>篇未读</span></Link></div>
  </LifeLayout>;
}

function HabitView() {
  const [weekStart, setWeekStart] = useState(mondayOf()); const [habits, setHabits] = useState<Habit[]>([]); const [logs, setLogs] = useState<Log[]>([]); const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const load = async () => { const { data } = await client.habit.range.get({ query: { from: isoDay(days[0]), to: isoDay(days[6]) }, headers: headersWithAuth() }); if (data && typeof data !== 'string') { setHabits(data.habits as Habit[]); setLogs(data.logs as Log[]); } };
  useEffect(() => { void load(); }, [weekStart.getTime()]);
  const create = async () => { if (!name.trim() || busy) return; setBusy(true); await client.habit.index.post({ name: name.trim() }, { headers: headersWithAuth() }); setName(''); setBusy(false); await load(); };
  const toggle = async (habitId: number, date: string) => { const completed = logs.some(log => log.habitId === habitId && log.date === date && log.completed); setLogs(current => completed ? current.map(log => log.habitId === habitId && log.date === date ? { ...log, completed: 0 } : log) : [...current.filter(log => !(log.habitId === habitId && log.date === date)), { habitId, date, completed: 1 }]); await client.habit({ id: habitId }).toggle.post({ date, completed: !completed }, { headers: headersWithAuth() }); };
  return <LifeLayout section="habits" title="习惯" intro="以一周为单位留下轻巧的确认，不把生活变成 KPI。"><div className="habit-week-tools"><button onClick={() => setWeekStart(addDays(weekStart, -7))}><i className="ri-arrow-left-line" /> 上一周</button><strong>{isoDay(days[0])} — {isoDay(days[6])}</strong><button onClick={() => setWeekStart(addDays(weekStart, 7))}>下一周 <i className="ri-arrow-right-line" /></button></div><div className="habit-week" role="grid"><div className="habit-week-head"><span>习惯</span>{days.map(day => <span key={isoDay(day)}><b>{['日','一','二','三','四','五','六'][day.getDay()]}</b><small>{day.getDate()}</small></span>)}</div>{habits.map(habit => <div className="habit-week-row" key={habit.id}><span><strong>{habit.name}</strong><small>{habit.description}</small></span>{days.map(day => { const date = isoDay(day); const done = logs.some(log => log.habitId === habit.id && log.date === date && log.completed); return <button key={date} className={done ? 'done' : ''} aria-label={`${habit.name} ${date} ${done ? '已完成' : '未完成'}`} onClick={() => toggle(habit.id, date)}><i className={done ? 'ri-check-line' : ''} /></button>; })}</div>)}</div><div className="life-add"><input value={name} placeholder="添加一个想长期坚持的习惯" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void create(); }} /><button onClick={create}>添加</button></div></LifeLayout>;
}

type TimerState = { mode: 'focus' | 'break'; round: number; remaining: number; targetAt: number | null; startedAt: string | null };
const TIMER_KEY = 'rin-life-pomodoro';
function PomodoroView() {
  const [focusMinutes, setFocusMinutes] = useState(25); const [breakMinutes, setBreakMinutes] = useState(5); const [rounds, setRounds] = useState(4);
  const [timer, setTimer] = useState<TimerState>(() => { try { const saved = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null') as TimerState | null; if (saved) return { ...saved, remaining: saved.targetAt ? Math.max(0, Math.ceil((saved.targetAt - Date.now()) / 1000)) : saved.remaining }; } catch {} return { mode: 'focus', round: 1, remaining: 25 * 60, targetAt: null, startedAt: null }; });
  const running = timer.targetAt !== null;
  useEffect(() => { localStorage.setItem(TIMER_KEY, JSON.stringify(timer)); }, [timer]);
  useEffect(() => { if (!timer.targetAt) return; const interval = window.setInterval(() => setTimer(current => current.targetAt ? { ...current, remaining: Math.max(0, Math.ceil((current.targetAt - Date.now()) / 1000)) } : current), 500); return () => clearInterval(interval); }, [timer.targetAt]);
  const finishStage = async () => { if (timer.mode === 'focus' && timer.startedAt) await client.pomodoro.sessions.post({ startedAt: timer.startedAt, endedAt: new Date().toISOString(), focusMinutes, breakMinutes, roundIndex: timer.round, completed: true }, { headers: headersWithAuth() }); if (timer.mode === 'focus' && timer.round < rounds) setTimer({ mode: 'break', round: timer.round, remaining: breakMinutes * 60, targetAt: null, startedAt: null }); else if (timer.mode === 'break') setTimer({ mode: 'focus', round: timer.round + 1, remaining: focusMinutes * 60, targetAt: null, startedAt: null }); else setTimer({ mode: 'focus', round: 1, remaining: focusMinutes * 60, targetAt: null, startedAt: null }); };
  useEffect(() => { if (timer.remaining === 0 && timer.targetAt) void finishStage(); }, [timer.remaining, timer.targetAt]);
  const start = () => setTimer(current => ({ ...current, targetAt: Date.now() + current.remaining * 1000, startedAt: current.mode === 'focus' ? current.startedAt || new Date().toISOString() : null })); const pause = () => setTimer(current => ({ ...current, targetAt: null })); const stop = () => setTimer({ mode: 'focus', round: 1, remaining: focusMinutes * 60, targetAt: null, startedAt: null });
  const applySetting = (kind: 'focus' | 'break', value: number) => { if (running) return; if (kind === 'focus') { setFocusMinutes(value); if (timer.mode === 'focus') setTimer(current => ({ ...current, remaining: value * 60 })); } else { setBreakMinutes(value); if (timer.mode === 'break') setTimer(current => ({ ...current, remaining: value * 60 })); } };
  const clock = `${String(Math.floor(timer.remaining / 60)).padStart(2, '0')}:${String(timer.remaining % 60).padStart(2, '0')}`;
  return <LifeLayout section="pomodoro" title="番茄钟" intro="计时在浏览器本地运行；完成的专注轮次会保存到日历。"><div className="pomodoro"><p>{timer.mode === 'focus' ? 'FOCUS' : 'BREAK'}</p><strong>{clock}</strong><span>{timer.round} / {rounds}</span><div>{running ? <button onClick={pause}>暂停</button> : <button onClick={start}>{timer.remaining === (timer.mode === 'focus' ? focusMinutes : breakMinutes) * 60 ? '开始' : '继续'}</button>}<button className="secondary" onClick={stop}>停止</button></div></div><div className="pomodoro-settings"><label>专注时长<input type="number" min="1" max="180" value={focusMinutes} disabled={running} onChange={e => applySetting('focus', Number(e.target.value))} /></label><label>休息时长<input type="number" min="1" max="60" value={breakMinutes} disabled={running} onChange={e => applySetting('break', Number(e.target.value))} /></label><label>轮数<input type="number" min="1" max="20" value={rounds} disabled={running} onChange={e => setRounds(Number(e.target.value))} /></label></div></LifeLayout>;
}

function CalendarView({ year }: { year: boolean }) {
  const [month, setMonth] = useState(monthNow()); const [habits, setHabits] = useState<Habit[]>([]); const [logs, setLogs] = useState<Log[]>([]); const [sessions, setSessions] = useState<PomodoroSession[]>([]); const [focused, setFocused] = useState<number | null>(null); const [selected, setSelected] = useState(isoDay());
  useEffect(() => { Promise.all([client.habit.calendar.get({ query: { month }, headers: headersWithAuth() }), client.pomodoro.sessions.get({ query: { month }, headers: headersWithAuth() })]).then(([habitResult, pomoResult]) => { if (habitResult.data && typeof habitResult.data !== 'string') { setHabits(habitResult.data.habits as Habit[]); setLogs(habitResult.data.logs as Log[]); } if (pomoResult.data && typeof pomoResult.data !== 'string') setSessions(pomoResult.data as PomodoroSession[]); }); }, [month]);
  if (year) return <YearView />;
  const first = new Date(`${month}-01T00:00:00`); const dayCount = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate(); const blanks = (first.getDay() + 6) % 7; const days = Array.from({ length: dayCount }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`); const done = (date: string) => logs.filter(log => log.date === date && log.completed && (!focused || log.habitId === focused)).length; const focusFor = (date: string) => sessions.filter(session => isoDay(new Date(session.startedAt)) === date && session.completed); const chosenSessions = focusFor(selected); const chosenLogs = logs.filter(log => log.date === selected && log.completed);
  return <LifeLayout section="calendar" title="日历" intro="按日期查看习惯与专注记录，回答今天做了什么、留下了什么。"><div className="calendar-tools"><input type="month" value={month} onChange={e => { setMonth(e.target.value); setSelected(`${e.target.value}-01`); }} /><select value={focused || ''} onChange={e => setFocused(e.target.value ? Number(e.target.value) : null)}><option value="">全部习惯</option>{habits.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select><Link href="/life/year">全年视图</Link></div><div className="calendar-weekdays">{['一','二','三','四','五','六','日'].map(day => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{Array.from({ length: blanks }, (_, i) => <span key={`blank-${i}`} />)}{days.map(date => <button key={date} onClick={() => setSelected(date)} className={`calendar-day ${done(date) ? 'done' : focused && date <= isoDay() ? 'missed' : ''} ${selected === date ? 'selected' : ''}`}><b>{Number(date.slice(-2))}</b><span>{done(date) ? `${done(date)} 项习惯` : ''}</span><em>{focusFor(date).length ? `${focusFor(date).length} 🍅` : ''}</em></button>)}</div><section className="calendar-detail"><h2>{new Date(`${selected}T00:00:00`).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</h2><div><article><strong>习惯</strong>{chosenLogs.length ? chosenLogs.map(log => <p key={log.habitId}>✓ {habits.find(h => h.id === log.habitId)?.name}</p>) : <p>没有完成记录</p>}</article><article><strong>专注</strong><p>{chosenSessions.length} 轮 · {chosenSessions.reduce((sum, item) => sum + item.focusMinutes, 0)} 分钟</p>{chosenSessions.map(item => <p key={item.id}>{new Date(item.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} — {new Date(item.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</p>)}</article></div></section></LifeLayout>;
}

function YearView() {
  const [year, setYear] = useState(new Date().getFullYear()); const [activity, setActivity] = useState<Record<string, number>>({});
  useEffect(() => { Promise.all(Array.from({ length: 12 }, (_, index) => { const month = `${year}-${String(index + 1).padStart(2, '0')}`; return Promise.all([client.habit.calendar.get({ query: { month }, headers: headersWithAuth() }), client.pomodoro.sessions.get({ query: { month }, headers: headersWithAuth() })]); })).then(results => { const next: Record<string, number> = {}; results.forEach(([habitResult, pomoResult]) => { if (habitResult.data && typeof habitResult.data !== 'string') habitResult.data.logs.forEach(log => { if (log.completed) next[log.date] = (next[log.date] || 0) + 1; }); if (pomoResult.data && typeof pomoResult.data !== 'string') pomoResult.data.forEach(item => { const date = isoDay(new Date(item.startedAt)); if (item.completed) next[date] = (next[date] || 0) + 1; }); }); setActivity(next); }); }, [year]);
  const start = new Date(year, 0, 1); const cells = Array.from({ length: 371 }, (_, index) => { const date = addDays(start, index - ((start.getDay() + 6) % 7)); return date.getFullYear() === year ? isoDay(date) : ''; });
  return <LifeLayout section="calendar" title="年历" intro="全年生活轨迹；颜色越深，代表当天留下的习惯与专注记录越多。"><div className="year-tools"><button onClick={() => setYear(year - 1)}>←</button><strong>{year}</strong><button onClick={() => setYear(year + 1)}>→</button></div><div className="life-year-grid">{cells.map((date, index) => <span key={`${date}-${index}`} className={!date ? 'empty' : `level-${Math.min(4, activity[date] || 0)}`} title={date ? `${date} · ${activity[date] || 0} 条记录` : ''} />)}</div></LifeLayout>;
}

function RssView() {
  const [data, setData] = useState<RssData | null>(null); const [filter, setFilter] = useState<RssFilter>('all'); const [feedUrl, setFeedUrl] = useState(''); const [label, setLabel] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const load = async (next = filter) => { const { data } = await client.rss.index.get({ query: { filter: next }, headers: headersWithAuth() }); if (data && typeof data !== 'string') setData(data as RssData); }; useEffect(() => { void load(filter); }, [filter]);
  const subscribe = async () => { if (!feedUrl.trim() || busy) return; setBusy(true); setMessage('正在读取订阅源…'); const { error } = await client.rss.subscriptions.post({ feedUrl: feedUrl.trim(), title: label.trim() || undefined }, { headers: headersWithAuth() }); setBusy(false); if (error) { setMessage(typeof error.value === 'string' ? error.value : '订阅失败，请检查地址。'); return; } setFeedUrl(''); setLabel(''); setMessage('订阅已添加并完成首次更新。'); await load(); };
  const refreshAll = async () => { if (busy) return; setBusy(true); const { data, error } = await client.rss.refresh.post(undefined, { headers: headersWithAuth() }); const result = data as { refreshed?: number; added?: number } | null; setBusy(false); setMessage(error ? '更新失败，请稍后再试。' : `已更新 ${result?.refreshed || 0} 个订阅，发现 ${result?.added || 0} 篇新内容。`); await load(); };
  const updateItem = async (item: RssItem, patch: { read?: boolean; starred?: boolean }, open = false) => { await client.rss.items({ id: item.id }).post(patch, { headers: headersWithAuth() }); if (open) window.open(item.url, '_blank', 'noopener,noreferrer'); await load(); }; const remove = async (subscription: RssSubscription) => { if (!window.confirm(`取消订阅「${subscription.title || subscription.feedUrl}」？`)) return; await client.rss.subscriptions({ id: subscription.id }).delete(undefined, { headers: headersWithAuth() }); await load(); };
  const subscriptions = data?.subscriptions || []; const items = data?.items || []; const counts = data?.counts || { all: 0, unread: 0, starred: 0 };
  return <LifeLayout section="rss" title="RSS" intro="私人的信息入口；订阅、更新与阅读状态按账号独立保存。"><div className="rss-subscribe"><div><input value={feedUrl} placeholder="公开 HTTPS RSS / Atom / JSON Feed 地址" onChange={e => setFeedUrl(e.target.value)} /><input value={label} placeholder="备注名称（可选）" onChange={e => setLabel(e.target.value)} /></div><button onClick={subscribe} disabled={busy || !feedUrl.trim()}>订阅</button></div><div className="rss-toolbar"><div className="rss-filters">{([['all','全部',counts.all],['unread','未读',counts.unread],['starred','收藏',counts.starred]] as Array<[RssFilter,string,number]>).map(([key,name,count]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{name}<b>{count}</b></button>)}</div><button className="rss-refresh" onClick={refreshAll} disabled={busy || !subscriptions.length}>更新订阅</button></div>{message && <p className="rss-message">{message}</p>}<div className="rss-layout"><aside className="rss-sources"><strong>订阅源 · {subscriptions.length}</strong>{subscriptions.map(source => <div className="rss-source" key={source.id}><div><img src={source.favicon || '/favicon.png'} alt="" /><span><a href={source.siteUrl || source.feedUrl} target="_blank" rel="noreferrer">{source.title || source.feedUrl}</a><small>{source.lastError || (source.lastFetchedAt ? new Date(source.lastFetchedAt).toLocaleString() : '等待更新')}</small></span></div><button onClick={() => remove(source)}>×</button></div>)}</aside><section className="rss-items">{items.map(item => <article className={`rss-item ${item.read ? 'is-read' : ''}`} key={item.id}><button className="rss-item-main" onClick={() => updateItem(item, { read: true }, true)}><span className="rss-item-meta">{item.author || '订阅文章'} · {new Date(item.publishedAt).toLocaleDateString()}</span><strong>{item.title}</strong>{item.summary && <p>{item.summary}</p>}</button><div className="rss-item-actions"><button onClick={() => updateItem(item, { read: !item.read })}><i className={item.read ? 'ri-mail-unread-line' : 'ri-mail-open-line'} /></button><button className={item.starred ? 'starred' : ''} onClick={() => updateItem(item, { starred: !item.starred })}><i className={item.starred ? 'ri-star-fill' : 'ri-star-line'} /></button></div></article>)}</section></div></LifeLayout>;
}
