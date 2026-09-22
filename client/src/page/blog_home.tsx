import { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'wouter';
import { FeedCard } from '../components/feed_card';
import { Waiting } from '../components/loading';
import { getNormalPosts } from '../data/blog';
import { client } from '../main';
import { headersWithAuth } from '../utils/auth';
import { siteName } from '../utils/constants';

export function BlogHomePage() {
  const [feeds, setFeeds] = useState<any[] | null>(null);
  useEffect(() => {
    client.feed.index.get({ query: { page: 1, limit: 8, type: 'normal', contentType: 'normal' }, headers: headersWithAuth() }).then(({ data }: any) => {
      setFeeds(data && typeof data !== 'string' ? getNormalPosts(data.data) : []);
    });
  }, []);
  const pinned = (feeds || []).filter(feed => feed.top === 1);
  const recent = (feeds || []).filter(feed => feed.top !== 1).slice(0, 5);
  return <><Helmet><title>Blog - {process.env.NAME}</title><meta property="og:site_name" content={siteName} /></Helmet><Waiting for={feeds !== null}><main className="blog-home ani-show"><header><p>BLOG</p><h1>文字与时间</h1><span>普通文章在这里展开，日记则留在独立的时间线里。</span></header>{pinned.length > 0 && <section><div className="blog-section-heading"><h2>置顶文章</h2></div>{pinned.map(({ id, ...feed }) => <FeedCard key={id} id={id} {...feed} />)}</section>}<section><div className="blog-section-heading"><h2>最近文章</h2><Link href="/blog/articles">查看全部 <i className="ri-arrow-right-line" /></Link></div>{recent.map(({ id, ...feed }) => <FeedCard key={id} id={id} {...feed} />)}{recent.length === 0 && <p className="life-coming-soon">暂时没有普通文章。</p>}</section></main></Waiting></>;
}
