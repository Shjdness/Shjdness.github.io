import { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet';
import { FeedCard } from '../components/feed_card';
import { Waiting } from '../components/loading';
import { diaryTimestamp, getDiaryPosts } from '../data/blog';
import { client } from '../main';
import { headersWithAuth } from '../utils/auth';

export function DiaryPage() {
  const [feeds, setFeeds] = useState<any[] | null>(null);
  useEffect(() => {
    client.tag({ name: '日记' }).get({ headers: headersWithAuth() }).then(({ data }: any) => {
      const entries = data && typeof data !== 'string' ? getDiaryPosts(data.feeds || []) : [];
      setFeeds(entries.sort((a, b) => diaryTimestamp(b) - diaryTimestamp(a)));
    });
  }, []);
  const groups = useMemo(() => {
    const result = new Map<number, Map<number, Map<number, any[]>>>();
    for (const feed of feeds || []) {
      const date = new Date(diaryTimestamp(feed));
      const year = date.getFullYear(); const month = date.getMonth() + 1; const week = isoWeek(date);
      if (!result.has(year)) result.set(year, new Map());
      if (!result.get(year)!.has(month)) result.get(year)!.set(month, new Map());
      if (!result.get(year)!.get(month)!.has(week)) result.get(year)!.get(month)!.set(week, []);
      result.get(year)!.get(month)!.get(week)!.push(feed);
    }
    return result;
  }, [feeds]);
  const current = new Date();
  return <><Helmet><title>日记 - {process.env.NAME}</title></Helmet><Waiting for={feeds !== null}><main className="diary-page ani-show"><header><p>PRIVATE JOURNAL</p><h1>日记</h1><span>只收录标记为「日记」的文字，按日期由近到远排列。</span></header><button className="diary-index-toggle" onClick={() => document.querySelector('.diary-index')?.classList.toggle('open')}>时间检查表 <i className="ri-calendar-line" /></button><div className="diary-layout"><aside className="diary-index"><strong>时间检查表</strong>{[...groups.entries()].map(([year, months]) => <details key={year} open={year === current.getFullYear()}><summary>{year}</summary>{[...months.entries()].map(([month, weeks]) => <details key={month} open={year === current.getFullYear() && month === current.getMonth() + 1}><summary>{String(month).padStart(2, '0')} 月</summary>{[...weeks.entries()].map(([week, entries]) => <a key={week} href={`#diary-${entries[0].id}`}>Week {week}<small>{entries.length}</small></a>)}</details>)}</details>)}</aside><section className="diary-list">{(feeds || []).map(({ id, title, ...feed }) => <div id={`diary-${id}`} key={id}><FeedCard id={id} title={title || '未命名日记'} {...feed} /></div>)}{feeds?.length === 0 && <p className="life-coming-soon">暂时还没有日记。</p>}</section></div></main></Waiting></>;
}

function isoWeek(date: Date) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7; target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}
