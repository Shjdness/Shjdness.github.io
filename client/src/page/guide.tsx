import { useContext, useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link, useSearch } from 'wouter';
import { getCached, getSavedAdviceIds, setAdviceSaved, setCached, withTimeout } from '../data/local-first';
import { client } from '../main';
import { headersWithAuth } from '../utils/auth';
import { ProfileContext } from '../state/profile';

export type Advice = { id: string; title: string; summary: string; category: string; evidence: string; cost: string; benefit: string; source: string; detail: string; chapter: string; featured: boolean; sourceUrl: string };
type GuideData = { generatedAt: string; repository: string; count: number; entries: Advice[] };
const GUIDE_CACHE_KEY = 'static:life-guide';

async function loadGuide(onCached?: (data: GuideData) => void) {
  const cached = await getCached<GuideData>(GUIDE_CACHE_KEY);
  if (cached) onCached?.(cached.value);
  try {
    const response = await withTimeout(fetch('/life-guide.json'), 3000);
    if (!response.ok) throw new Error('Guide unavailable');
    const data = await response.json() as GuideData;
    await setCached(GUIDE_CACHE_KEY, data);
    return data;
  } catch {
    return cached?.value || null;
  }
}

function dayIndex(length: number) {
  const day = new Date().toISOString().slice(0, 10);
  let hash = 0;
  for (const character of day) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % Math.max(1, length);
}

export function TodayAdviceCard() {
  const [data, setData] = useState<GuideData | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  useEffect(() => { void loadGuide(setData).then(result => result && setData(result)); void getSavedAdviceIds().then(setSaved); }, []);
  const advice = useMemo(() => { const pool = data?.entries.filter(item => item.featured) || []; return pool[dayIndex(pool.length)]; }, [data]);
  if (!advice) return null;
  const isSaved = saved.includes(advice.id);
  const toggle = async () => { await setAdviceSaved(advice.id, !isSaved); setSaved(await getSavedAdviceIds()); };
  return <section className="today-advice"><div className="today-advice-heading"><span>TODAY'S ADVICE</span><Link href="/life/guide?saved=1">已收藏 {saved.length}</Link></div><h2>{advice.title}</h2><p>{advice.summary}</p><small>{advice.category} · Evidence {advice.evidence}</small><div><Link href={`/life/guide?item=${advice.id}`}>了解更多 <i className="ri-arrow-right-line" /></Link><button onClick={toggle}><i className={isSaved ? 'ri-bookmark-fill' : 'ri-bookmark-line'} /> {isSaved ? '已收藏' : '收藏'}</button></div></section>;
}

export function GuidePage() {
  const profile = useContext(ProfileContext);
  const params = new URLSearchParams(useSearch());
  const [data, setData] = useState<GuideData | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [evidence, setEvidence] = useState('');
  const [habitAdvice, setHabitAdvice] = useState<Advice | null>(null);
  const [habitName, setHabitName] = useState('');
  const [message, setMessage] = useState('');
  const savedOnly = params.get('saved') === '1';
  const showAll = params.get('all') === '1';
  const selectedId = params.get('item');
  useEffect(() => { void loadGuide(setData).then(result => result && setData(result)); void getSavedAdviceIds().then(setSaved); }, []);
  const categories = useMemo(() => [...new Set((data?.entries || []).map(item => item.category))], [data]);
  const results = useMemo(() => {
    const entries = data?.entries || [];
    if (selectedId) return entries.filter(item => item.id === selectedId);
    if (savedOnly && !category && !query.trim() && !evidence) return entries.filter(item => saved.includes(item.id));
    if (showAll && !query.trim() && !category && !evidence) return entries.slice(0, 80);
    if (!query.trim() && !category && !evidence) return [];
    const keyword = query.trim().toLowerCase();
    return entries.filter(item => (!keyword || `${item.title} ${item.summary} ${item.benefit} ${item.detail}`.toLowerCase().includes(keyword)) && (!category || item.category === category) && (!evidence || item.evidence === evidence)).slice(0, 80);
  }, [data, selectedId, savedOnly, showAll, saved, query, category, evidence]);
  const toggleSaved = async (id: string) => { await setAdviceSaved(id, !saved.includes(id)); setSaved(await getSavedAdviceIds()); };
  const openHabit = (advice: Advice) => { setHabitAdvice(advice); setHabitName(advice.title); setMessage(''); };
  const createHabit = async () => {
    if (!habitName.trim()) return;
    try {
      const { error } = await withTimeout<any>(client.habit.index.post({ name: habitName.trim(), description: `来自 Life Guide：${habitAdvice?.title || ''}` }, { headers: headersWithAuth() }) as Promise<any>, 3000);
      if (error) throw new Error('create failed');
      setMessage('已创建习惯。'); setHabitAdvice(null);
    } catch { setMessage('当前无法连接同步服务，请稍后再创建习惯。'); }
  };
  if (profile?.role !== 'owner' && profile?.role !== 'trusted') return <main className="guide-page"><section className="guide-empty"><h1>这里是私人生活空间</h1><p>Life Guide 只向 Owner 与受信任账户开放。</p><Link href="/">返回公开首页</Link></section></main>;
  return <main className="guide-page ani-show"><Helmet><title>Life Guide - {process.env.NAME}</title></Helmet><header><div><p>LIFE · LOW-NOISE KNOWLEDGE</p><h1>{savedOnly ? 'Saved Advice' : 'Guide'}</h1><span>需要时再查，不把建议变成新的任务清单。</span></div><Link href="/life">返回 Life</Link></header><div className="guide-workspace"><aside className="guide-sidebar"><strong>GUIDE</strong><Link className={showAll && !category ? 'active' : ''} href="/life/guide?all=1"><i className="ri-layout-grid-line" /> 全部</Link><Link className={savedOnly ? 'active' : ''} href="/life/guide?saved=1"><i className="ri-bookmark-line" /> 我的收藏 <b>{saved.length}</b></Link><span>分类</span>{categories.map(name => <button key={name} className={category === name ? 'active' : ''} onClick={() => setCategory(category === name ? '' : name)}>{name}</button>)}</aside><div className="guide-main">{!savedOnly && !selectedId && <section className="guide-tools"><label><i className="ri-search-line" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索生活问题……" /></label><select value={evidence} onChange={event => setEvidence(event.target.value)}><option value="">全部证据等级</option><option value="A">Evidence A</option><option value="B">Evidence B</option><option value="C">Evidence C</option></select></section>}<section className="guide-results">{results.map(advice => <article key={advice.id}><div className="guide-card-meta"><span>{advice.category}</span><b>Evidence {advice.evidence}</b></div><h2>{advice.title}</h2><p>{advice.summary}</p><details open={Boolean(selectedId)}><summary>成本、收益与来源</summary><dl><dt>成本</dt><dd>{advice.cost || '未单独列出'}</dd><dt>收益</dt><dd>{advice.benefit || advice.summary}</dd>{advice.source && <><dt>来源</dt><dd>{advice.source}</dd></>}{advice.detail && <><dt>备注</dt><dd>{advice.detail}</dd></>}</dl><a href={advice.sourceUrl} target="_blank" rel="noreferrer">查看原始条目 <i className="ri-external-link-line" /></a></details><div className="guide-card-actions"><button onClick={() => toggleSaved(advice.id)}><i className={saved.includes(advice.id) ? 'ri-bookmark-fill' : 'ri-bookmark-line'} /> {saved.includes(advice.id) ? '已收藏' : '收藏'}</button><button onClick={() => openHabit(advice)}>转为习惯</button></div></article>)}{results.length === 0 && <p className="guide-empty">{savedOnly ? '还没有收藏建议。' : '输入问题或选择分类后，结果才会出现。'}</p>}</section></div></div>{message && <p className="guide-message">{message}</p>}{habitAdvice && <div className="guide-modal" role="dialog" aria-modal="true"><section><p>创建 Habit</p><h2>{habitAdvice.title}</h2><label>名称<input value={habitName} onChange={event => setHabitName(event.target.value)} /></label><div><button onClick={() => setHabitAdvice(null)}>取消</button><button onClick={createHabit}>创建</button></div></section></div>}</main>;
}
