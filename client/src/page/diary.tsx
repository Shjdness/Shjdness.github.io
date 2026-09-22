import { useEffect, useState } from 'react';
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
  return <><Helmet><title>日记 - {process.env.NAME}</title></Helmet><Waiting for={feeds !== null}><main className="diary-page ani-show"><header><p>PRIVATE JOURNAL</p><h1>日记</h1><span>只收录标记为「日记」的文字，按日期由近到远排列。</span></header><div>{(feeds || []).map(({ id, title, ...feed }) => <FeedCard key={id} id={id} title={title || '未命名日记'} {...feed} />)}{feeds?.length === 0 && <p className="life-coming-soon">暂时还没有日记。</p>}</div></main></Waiting></>;
}
