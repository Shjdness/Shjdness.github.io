import { useContext, useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet';
import { FeedCard } from '../components/feed_card';
import { Waiting } from '../components/loading';
import { client } from '../main';
import { ProfileContext } from '../state/profile';
import { headersWithAuth } from '../utils/auth';
import { siteName } from '../utils/constants';

type Hashtag = { id: number; name: string; feeds: number };
type TaggedFeed = { id: number; title: string | null; summary: string; content: string; createdAt: Date; updatedAt: Date; hashtags: Array<{ id: number; name: string }>; user: { id: number; username: string; avatar: string | null } };

export function HashtagsPage() {
  const profile = useContext(ProfileContext);
  const [hashtags, setHashtags] = useState<Hashtag[]>();
  const [selected, setSelected] = useState<string[]>([]);
  const [feeds, setFeeds] = useState<TaggedFeed[]>([]);
  const [loadingFeeds, setLoadingFeeds] = useState(false);
  const ref = useRef(false);
  const loadTags = () => client.tag.index.get().then(({ data }) => { if (data && typeof data !== 'string') setHashtags(data as Hashtag[]); });

  useEffect(() => { if (ref.current) return; void loadTags(); ref.current = true; }, []);
  useEffect(() => {
    if (!selected.length) { setFeeds([]); return; }
    setLoadingFeeds(true);
    Promise.all(selected.map(name => client.tag({ name }).get({ headers: headersWithAuth() }))).then(results => {
      const lists = results.map(result => result.data && typeof result.data !== 'string' ? (result.data.feeds || []) as TaggedFeed[] : []);
      const common = lists[0]?.filter(feed => lists.every(list => list.some(candidate => candidate.id === feed.id))) || [];
      setFeeds(common.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
      setLoadingFeeds(false);
    });
  }, [selected.join('|')]);

  const toggle = (name: string) => setSelected(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name]);
  const remove = async (tag: Hashtag) => {
    if (!window.confirm(`标签「${tag.name}」关联 ${tag.feeds} 篇文章。删除只会移除标签关联，不会删除文章。继续吗？`)) return;
    await client.tag({ name: tag.name }).delete(undefined, { headers: headersWithAuth() });
    setSelected(current => current.filter(name => name !== tag.name));
    await loadTags();
  };

  return <><Helmet><title>标签 - {process.env.NAME}</title><meta property="og:site_name" content={siteName} /></Helmet><Waiting for={hashtags}><main className="tags-page ani-show"><header><p>BLOG INDEX</p><h1>标签</h1><span>可同时选择多个标签；结果需包含全部所选标签。</span></header><div className="tag-filter-list">{hashtags?.filter(tag => tag.feeds > 0).map(tag => <div key={tag.id} className={selected.includes(tag.name) ? 'active' : ''}><button onClick={() => toggle(tag.name)}>#{tag.name}<small>{tag.feeds}</small></button>{profile?.role === 'owner' && <button className="tag-delete" title={`删除 ${tag.name}`} onClick={() => remove(tag)}><i className="ri-delete-bin-line" /></button>}</div>)}</div>{selected.length > 0 && <section className="tag-results"><div><strong>{selected.map(name => `#${name}`).join(' + ')}</strong><span>{loadingFeeds ? '正在筛选…' : `${feeds.length} 篇文章`}</span></div>{!loadingFeeds && feeds.map(({ id, title, ...feed }) => <FeedCard key={id} id={id.toString()} title={title || '未命名'} {...feed} />)}{!loadingFeeds && feeds.length === 0 && <p className="life-coming-soon">没有同时包含这些标签的文章。</p>}</section>}</main></Waiting></>;
}
