import { useContext, useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'wouter';
import { ProfileContext } from '../state/profile';
import { client } from '../main';
import { headersWithAuth } from '../utils/auth';

type LifeSection = 'life' | 'habits' | 'calendar' | 'year' | 'rss';

const pages: Array<{ id: Exclude<LifeSection, 'life'>; title: string; description: string; href: string; icon: string }> = [
  { id: 'habits', title: '习惯', description: '记录希望长期留在生活里的事。', href: '/habits', icon: 'ri-seedling-line' },
  { id: 'calendar', title: '日历', description: '把每日记录与习惯放在同一条生活轨迹中。', href: '/calendar', icon: 'ri-calendar-2-line' },
  { id: 'year', title: '年历', description: '以安静的方式看见这一年的生活痕迹。', href: '/year', icon: 'ri-calendar-check-line' },
  { id: 'rss', title: 'RSS', description: '私人的信息与阅读入口。', href: '/rss', icon: 'ri-rss-line' },
];

function mayAccessLife(role: string | undefined) {
  return role === 'owner' || role === 'trusted';
}

export function PrivateLifePage({ section }: { section: LifeSection }) {
  const profile = useContext(ProfileContext);
  const [verified, setVerified] = useState(false);
  const [denied, setDenied] = useState(false);
  const sectionInfo = pages.find(page => page.id === section);

  useEffect(() => {
    if (!mayAccessLife(profile?.role)) {
      setVerified(false);
      return;
    }
    client.life.overview.get({ headers: headersWithAuth() }).then(({ data, error }) => {
      setDenied(Boolean(error) || !data || typeof data === 'string');
      setVerified(Boolean(data) && typeof data !== 'string');
    });
  }, [profile?.id, profile?.role]);

  if (!mayAccessLife(profile?.role) || denied) {
    return (
      <main className="life-page">
        <section className="life-panel life-denied">
          <p className="life-kicker">PRIVATE LIFE</p>
          <h1>这里是私人生活空间</h1>
          <p>登录本身不等于私人访问权限。此区域仅向 Owner 与受信任账户开放。</p>
          <Link className="life-link" href="/">返回公开首页</Link>
        </section>
      </main>
    );
  }

  if (!verified) {
    return <main className="life-page"><section className="life-panel"><p className="life-kicker">PRIVATE LIFE</p><p>正在确认访问权限…</p></section></main>;
  }

  if (sectionInfo) {
    if (section === 'habits') return <HabitView />;
    if (section === 'calendar' || section === 'year') return <CalendarView year={section === 'year'} />;
    return (
      <main className="life-page">
        <Helmet><title>{sectionInfo.title} - {process.env.NAME}</title></Helmet>
        <section className="life-panel life-section">
          <Link className="life-back" href="/life"><i className="ri-arrow-left-line" /> 返回 Life</Link>
          <p className="life-kicker">PRIVATE LIFE</p>
          <h1>{sectionInfo.title}</h1>
          <p>{sectionInfo.description}</p>
          <div className="life-coming-soon">RSS 的订阅源、抓取与去重将在下一阶段接入；此入口已完成私有权限保护。</div>
        </section>
      </main>
    );
  }

  return (
    <main className="life-page">
      <Helmet><title>Life - {process.env.NAME}</title></Helmet>
      <section className="life-panel">
        <p className="life-kicker">PRIVATE LIFE</p>
        <h1>Life</h1>
        <p className="life-intro">这是只属于生活的安静空间。每个入口都经过服务端权限验证，后续数据也会按账号归属保存。</p>
        <div className="life-grid">
          {pages.map(page => <Link className="life-card" href={page.href} key={page.id}>
            <i className={page.icon} />
            <span><strong>{page.title}</strong><small>{page.description}</small></span>
            <i className="ri-arrow-right-up-line" />
          </Link>)}
        </div>
      </section>
    </main>
  );
}

type Habit = { id: number; name: string; description: string; color: string; active: number };
type Log = { habitId: number; date: string; completed: number };
const today = () => new Date().toISOString().slice(0, 10);
const monthNow = () => today().slice(0, 7);

function HabitView() {
  const [habits, setHabits] = useState<Habit[]>([]); const [name, setName] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => client.habit.index.get({ headers: headersWithAuth() }).then(({ data }) => { if (data && typeof data !== 'string') setHabits(data as Habit[]); });
  useEffect(() => { void load(); }, []);
  const create = async () => { if (!name.trim() || busy) return; setBusy(true); await client.habit.index.post({ name: name.trim() }, { headers: headersWithAuth() }); setName(''); setBusy(false); load(); };
  const toggle = async (habit: Habit) => { await client.habit({ id: habit.id }).toggle.post({ date: today(), completed: true }, { headers: headersWithAuth() }); load(); };
  return <LifeLayout title="习惯" intro="每天留下一次轻巧的确认，不把生活变成 KPI。">
    <div className="life-add"><input value={name} placeholder="添加一个想长期坚持的习惯" onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') create(); }} /><button onClick={create}>添加</button></div>
    <div className="habit-list">{habits.map(h => <button className="habit-row" key={h.id} onClick={() => toggle(h)}><i className="ri-checkbox-circle-line" style={{ color: h.color }} /><span><strong>{h.name}</strong><small>{h.description || '点击完成今日打卡'}</small></span><em>今日打卡</em></button>)}{habits.length === 0 && <p className="life-coming-soon">先添加第一条习惯吧。</p>}</div>
  </LifeLayout>;
}

function CalendarView({ year }: { year: boolean }) {
  const [month, setMonth] = useState(monthNow()); const [habits, setHabits] = useState<Habit[]>([]); const [logs, setLogs] = useState<Log[]>([]); const [focused, setFocused] = useState<number | null>(null);
  useEffect(() => { client.habit.calendar.get({ query: { month }, headers: headersWithAuth() }).then(({ data }) => { if (data && typeof data !== 'string') { setHabits(data.habits as Habit[]); setLogs(data.logs as Log[]); } }); }, [month]);
  const days = Array.from({ length: new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate() }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  const done = (date: string) => logs.filter(log => log.date === date && log.completed && (!focused || log.habitId === focused)).length;
  return <LifeLayout title={year ? '年历' : '月历'} intro={year ? '年历会沿用每月的习惯记录，逐步汇聚成这一年的生活痕迹。' : '点击某天即可查看完成记录；选择单条习惯时，绿色代表完成，红色代表未完成。'}>
    {!year && <><div className="calendar-tools"><input type="month" value={month} onChange={e => setMonth(e.target.value)} /><select value={focused || ''} onChange={e => setFocused(e.target.value ? Number(e.target.value) : null)}><option value="">全部习惯</option>{habits.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}</select></div><div className="calendar-grid">{days.map(date => <div key={date} className={`calendar-day ${done(date) ? 'done' : focused && date <= today() ? 'missed' : ''}`}><b>{date.slice(-2)}</b><span>{done(date) ? `${done(date)} 项` : ''}</span></div>)}</div></>}
    {year && <p className="life-coming-soon">年视图已与同一打卡数据关联；下一步将增加全年热力格与月份跳转。</p>}
  </LifeLayout>;
}

function LifeLayout({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) { return <main className="life-page"><section className="life-panel life-section"><Link className="life-back" href="/life"><i className="ri-arrow-left-line" /> 返回 Life</Link><p className="life-kicker">PRIVATE LIFE</p><h1>{title}</h1><p>{intro}</p>{children}</section></main>; }
