import { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet';
import { FeedCard } from '../components/feed_card';
import { Waiting } from '../components/loading';
import { client } from '../main';
import { headersWithAuth } from '../utils/auth';

export function MemoPage() {
  const [feeds, setFeeds] = useState<any[] | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  useEffect(() => {
    client.feed.memo.get({ headers: headersWithAuth() }).then(({ data }) => {
      setFeeds(data && typeof data !== 'string' ? data : []);
    });
  }, []);

  const tagNames = useMemo(() => [...new Set((feeds || []).flatMap(feed => feed.hashtags?.map((tag: any) => tag.name) || []))].sort() as string[], [feeds]);
  const visible = useMemo(() => (feeds || []).filter(feed => selectedTags.length === 0 || selectedTags.every(name => feed.hashtags?.some((tag: any) => tag.name === name))), [feeds, selectedTags]);

  return <>
    <Helmet><title>备忘录 - {process.env.NAME}</title></Helmet>
    <Waiting for={feeds !== null}>
      <main className="memo-page ani-show">
        <header>
          <p>PRIVATE NOTES</p>
          <h1>备忘录</h1>
          <span>默认私密，不会出现在公开文章、时间轴或搜索结果中。</span>
        </header>
        {tagNames.length > 0 && <div className="inline-tag-filter">
          {tagNames.map(name => <button key={name} className={selectedTags.includes(name) ? 'active' : ''} onClick={() => setSelectedTags(value => value.includes(name) ? value.filter(item => item !== name) : [...value, name])}>#{name}</button>)}
          {selectedTags.length > 0 && <button onClick={() => setSelectedTags([])}>清除筛选</button>}
        </div>}
        <section className="memo-list">
          {visible.map(({ id, ...feed }) => <FeedCard key={id} id={String(id)} {...feed} />)}
          {visible.length === 0 && <p className="memo-empty">还没有备忘录。可在写作页选择“备忘录”后发布。</p>}
        </section>
      </main>
    </Waiting>
  </>;
}
