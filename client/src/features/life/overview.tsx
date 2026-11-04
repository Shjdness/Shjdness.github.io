import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { client } from '../../main';
import { getCached, setCached, withTimeout } from '../../data/local-first';
import { headersWithAuth } from '../../utils/auth';
import { addDays, CLOUD_REFRESH_EVENT, isoDay, mondayOf, READ_TIMEOUT, type LifeOverviewData } from './model';
import { LifeLayout } from './layout';
import { TodoBoard } from "./todos";
import { LifeBackupButton } from './backup';
import { LifeReportsEntry } from './reports';
import {DailyBasicsPlanner} from './daily-planner';

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
    <LifeReportsEntry />
    <DailyBasicsPlanner />
    <div className="life-summary-grid"><Link className="mobile-secondary" href="/life/pomodoro"><small>TODAY FOCUS</small><strong>{summary.focusMinutes} min</strong><span>{summary.rounds} 轮专注</span></Link><Link href="/life/habits"><small>THIS WEEK</small><strong>{summary.completed}</strong><span>{summary.habits} 项习惯</span></Link><Link href="/life/calendar"><small>CALENDAR</small><strong>{new Date().getDate()}</strong><span>{new Date().toLocaleDateString('zh-CN', { month: 'long', weekday: 'long' })}</span></Link><Link href="/life/rss"><small>RSS</small><strong>{summary.unread}</strong><span>篇未读</span></Link></div>
    <LifeBackupButton />
    {overview && <div className="life-overview-detail"><section><h2>本周习惯</h2>{overview.habits.map(habit => <p key={habit.id}><strong>{habit.name}</strong><span>{Array.from({ length: 7 }, (_, index) => { const date = isoDay(addDays(mondayOf(), index)); return <i key={date} className={habit.days.includes(date) ? 'done' : ''} title={date} />; })}</span></p>)}</section><section><h2>最近订阅</h2>{overview.recentRss.length ? overview.recentRss.map(item => <Link href="/life/rss" key={item.id}>{item.title}</Link>) : <p>还没有订阅内容</p>}</section></div>}
    </div></div>
  </LifeLayout>;
}
