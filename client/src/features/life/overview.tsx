import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { getCookie } from 'typescript-cookie';
import { accountIdFromToken, getCached, setCached } from '../../data/local-first';
import { addDays, CLOUD_REFRESH_EVENT, isoDay, lifeApi, mondayOf, shanghaiDay, type DailyBasic, type LifeOverviewData } from './model';
import { LifeLayout } from './layout';
import { TodoBoard } from "./todos";
import { LifeBackupButton } from './backup';
import { LifeReportsEntry } from './reports';
import { mergePendingBasics } from './sync';

export function LifeOverview() {
  const [overview, setOverview] = useState<LifeOverviewData | null>(null);
  useEffect(() => {
    const start = mondayOf(); const end = addDays(start, 6);
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = addDays(dayStart, 1);
    const day = shanghaiDay();
    const key = `life:overview:${day}:${isoDay(start)}`;
    let active = true, version = 0;
    const load = async () => {
      const token = getCookie('token'), ownerId = accountIdFromToken(token);
      const request = ++version;
      const current = () => active && version === request && getCookie('token') === token;
      if (!ownerId) return;
      try {
        const cached = await getCached<LifeOverviewData>(key, ownerId);
        if (!current()) return;
        const localPlan = (await getCached<DailyBasic[]>(`life:basics:${day}`, ownerId))?.value ?? [];
        if (!current()) return;
        if (cached) {
          const basics = await mergePendingBasics(day, cached.value.basics ?? [], localPlan);
          if (current()) setOverview({ ...cached.value, basics });
        }
        if (!current()) return;
        const query = new URLSearchParams({ dayStart: dayStart.toISOString(), dayEnd: dayEnd.toISOString(), weekStart: isoDay(start), weekEnd: isoDay(end), day });
        const data = await lifeApi<LifeOverviewData>(`/life/overview?${query}`);
        if (!current() || !data?.summary) return;
        const basics = await mergePendingBasics(day, data.basics ?? [], localPlan);
        if (!current()) return;
        const next = { ...data, basics };
        setOverview(next);
        await setCached(key, next, ownerId);
      } catch { /* Keep the cached overview when the cloud is unavailable. */ }
    };
    void load();
    window.addEventListener(CLOUD_REFRESH_EVENT, load);
    return () => { active = false; window.removeEventListener(CLOUD_REFRESH_EVENT, load); };
  }, []);
  const summary = overview?.summary || { habits: 0, completed: 0, focusMinutes: 0, rounds: 0, unread: 0 };
  return <LifeLayout section="life" title="Life">
    <div className="life-home-layout"><section className="life-home-todos"><header><h2>待办</h2><Link href="/life/todos">打开待办</Link></header><TodoBoard /></section><div className="life-home-side">
    <LifeReportsEntry />
    <section className="today-basics"><header><h2>今日三件事</h2><Link href="/life/todos">安排</Link></header>
      {overview?.basics?.length ? <ul>{overview.basics.map(item => <li key={item.id}>{item.completed ? '✓' : '○'} {item.content}</li>)}</ul> : <p>{overview ? '今日暂无安排' : '正在读取安排…'}</p>}
    </section>
    <div className="life-summary-grid"><Link className="mobile-secondary" href="/life/pomodoro"><small>TODAY FOCUS</small><strong>{summary.focusMinutes} min</strong><span>{summary.rounds} 轮专注</span></Link><Link href="/life/habits"><small>THIS WEEK</small><strong>{summary.completed}</strong><span>{summary.habits} 项习惯</span></Link><Link href="/life/calendar"><small>CALENDAR</small><strong>{new Date().getDate()}</strong><span>{new Date().toLocaleDateString('zh-CN', { month: 'long', weekday: 'long' })}</span></Link><Link href="/life/rss"><small>RSS</small><strong>{summary.unread}</strong><span>篇未读</span></Link></div>
    <LifeBackupButton />
    {overview && <div className="life-overview-detail"><section><h2>本周习惯</h2>{overview.habits.map(habit => <p key={habit.id}><strong>{habit.name}</strong><span>{Array.from({ length: 7 }, (_, index) => { const date = isoDay(addDays(mondayOf(), index)); return <i key={date} className={habit.days.includes(date) ? 'done' : ''} title={date} />; })}</span></p>)}</section><section><h2>最近订阅</h2>{overview.recentRss.length ? overview.recentRss.map(item => <Link href="/life/rss" key={item.id}>{item.title}</Link>) : <p>还没有订阅内容</p>}</section></div>}
    </div></div>
  </LifeLayout>;
}
