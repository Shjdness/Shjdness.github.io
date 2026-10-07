import { useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'wouter';
import { enqueueMutation, getCached, getSyncQueue, setCached } from '../../data/local-first';
import { usePomodoro } from '../../state/pomodoro';
import { lifeApi, type RssData, type RssGroup, type RssItem, type RssStorage, type RssSubscription } from './model';

type RssPreviewItem = Pick<RssItem, 'title' | 'url' | 'summary' | 'publishedAt' | 'thumbnailUrl'> & { externalId: string };
type ResolvedFeed = { sourceUrl: string; feedUrl: string; provider: string; platform: string; externalId: string; title: string; description: string; siteUrl: string; icon: string; category: string; preview: RssPreviewItem[] };
async function mergePendingRss(value: RssData) {
  const patches = (await getSyncQueue()).filter(item => item.entity === 'rss' && item.action === 'update');
  if (!patches.length) return value;
  return { ...value, items: value.items.map(item => { let next = item; for (const queued of patches) { const payload = queued.payload as { id: number; patch: { read?: boolean; starred?: boolean } }; if (payload.id === item.id) next = { ...next, ...(payload.patch.read === undefined ? {} : { read: payload.patch.read ? 1 : 0 }), ...(payload.patch.starred === undefined ? {} : { starred: payload.patch.starred ? 1 : 0 }) }; } return next; }) };
}

function readableRssError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  try { const value = JSON.parse(error.message) as { summary?: string; message?: string }; return value.summary || value.message || fallback; } catch { return error.message || fallback; }
}

const formatBytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${Math.max(0, value / 1024).toFixed(0)} KB`;

export function RssView() {
  const { timer: pomodoroTimer, running: pomodoroRunning, clock: pomodoroClock } = usePomodoro();
  const [data, setData] = useState<RssData | null>(null);
  const [filter, setFilter] = useState<'all' | 'unread' | 'starred'>('all');
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<RssItem | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [offset, setOffset] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [showGroups, setShowGroups] = useState(false);
  const [editingSource, setEditingSource] = useState<RssSubscription | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [candidate, setCandidate] = useState<ResolvedFeed | null>(null);
  const [alias, setAlias] = useState('');
  const [category, setCategory] = useState('其他');
  const [newGroup, setNewGroup] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [storage, setStorage] = useState<RssStorage | null>(null);
  const swipeStart = useRef<number | null>(null);
  const cacheKey = `life:rss:youtube:v1:${filter}:${selectedGroup || 'all'}:${sourceId || 'all'}`;

  const load = async (append = false) => {
    if (!append) { const cached = await getCached<RssData>(cacheKey); if (cached) setData(cached.value); }
    const nextOffset = append ? offset : 0;
    try {
      const query = new URLSearchParams({ filter, limit: '200', offset: String(nextOffset) });
      if (sourceId) query.set('sourceId', String(sourceId));
      if (selectedGroup) query.set('category', selectedGroup);
      const remote = await mergePendingRss(await lifeApi<RssData>(`/rss?${query}`));
      const next = append && data ? { ...remote, items: [...data.items, ...remote.items] } : remote;
      setData(next); setOffset(nextOffset + remote.items.length); await setCached(cacheKey, next);
    } catch { /* Local cache stays usable while the cloud is unavailable. */ }
  };
  useEffect(() => { setOffset(0); setSelectedItem(null); void load(); }, [filter, sourceId, selectedGroup]);
  useEffect(() => { void (async () => { try { const remote = await lifeApi<Omit<RssStorage, 'local'>>('/rss/storage'); const local = await navigator.storage?.estimate?.(); setStorage({ ...remote, local: { usedBytes: local?.usage || 0, limitBytes: local?.quota || 0 } }); } catch { /* Storage information is informative and must not block the reader. */ } })(); }, []);

  const updateItem = async (item: RssItem, patch: { read?: boolean; starred?: boolean }) => {
    const now = new Date(); const apply = (value: RssItem) => ({ ...value, ...(patch.read === undefined ? {} : { read: patch.read ? 1 : 0, readAt: patch.read ? now : null }), ...(patch.starred === undefined ? {} : { starred: patch.starred ? 1 : 0, starredAt: patch.starred ? now : null }) });
    setSelectedItem(current => current?.id === item.id ? apply(current) : current);
    setData(current => current ? { ...current, items: current.items.map(value => value.id === item.id ? apply(value) : value) } : current);
    try { await lifeApi(`/rss/items/${item.id}`, { method: 'POST', body: JSON.stringify(patch) }); } catch { await enqueueMutation('rss', 'update', { id: item.id, patch }); }
  };
  const openItem = async (item: RssItem) => { setSelectedItem(item); if (!item.read) await updateItem(item, { read: true }); };
  const markAllRead = async () => { if (!data?.counts.unread || !window.confirm(`将 ${data.counts.unread} 条未读全部标记为已读？`)) return; const now = new Date(); setData(current => current ? { ...current, items: current.items.map(item => ({ ...item, read: 1, readAt: item.readAt || now })), counts: { ...current.counts, unread: 0 } } : current); setBusy(true); try { await lifeApi('/rss/items/mark-all-read', { method: 'POST' }); setMessage('未读内容已全部清除。'); await load(); } catch { await enqueueMutation('rss', 'mark-all-read', {}); setMessage('已在本地清除未读，联网后自动同步。'); } finally { setBusy(false); } };
  const refreshAll = async () => { if (busy) return; setBusy(true); try { const result = await lifeApi<{ refreshed: number; total: number; added: number; failed: number; failures?: Array<{ title: string; error: string }> }>('/rss/refresh', { method: 'POST' }, 120_000); const detail = result.failures?.slice(0, 2).map(item => `${item.title}：${item.error}`).join('；'); setMessage(`已更新 ${result.refreshed}/${result.total ?? result.refreshed} 个 YouTube 频道，新增 ${result.added} 条${result.failed ? `，${result.failed} 个失败${detail ? `（${detail}）` : ''}` : ''}。`); await load(); } catch (error) { setMessage(readableRssError(error, '更新失败，已缓存内容仍可阅读。')); } finally { setBusy(false); } };
  const detect = async () => { if (!sourceUrl.trim() || busy) return; setBusy(true); setMessage(''); setCandidate(null); try { const result = await lifeApi<{ candidates: ResolvedFeed[] }>('/rss/resolve', { method: 'POST', body: JSON.stringify({ sourceUrl: sourceUrl.trim() }) }); const first = result.candidates[0] || null; setCandidate(first); setAlias(first?.title || ''); setCategory(first?.category || '其他'); } catch (error) { setMessage(readableRssError(error, '未发现可订阅频道')); } finally { setBusy(false); } };
  const subscribe = async () => { if (!candidate || busy) return; setBusy(true); try { const payload = { feedUrl: candidate.feedUrl, sourceUrl: candidate.sourceUrl, title: candidate.title, alias: alias.trim(), description: candidate.description, category: category.trim() || '其他', provider: candidate.provider, platform: candidate.platform, externalId: candidate.externalId, icon: candidate.icon }; await lifeApi('/rss/subscriptions', { method: 'POST', body: JSON.stringify(payload) }); setMessage('订阅成功，视频已加入资料库。'); setShowAdd(false); setSourceUrl(''); setCandidate(null); await load(); } catch (error) { setMessage(readableRssError(error, '订阅失败')); } finally { setBusy(false); } };
  const createGroup = async () => { const name = newGroup.trim(); if (!name) return; await lifeApi('/rss/groups', { method: 'POST', body: JSON.stringify({ name }) }); setNewGroup(''); await load(); };
  const renameGroup = async (group: RssGroup) => { const name = window.prompt('新的分组名称', group.name)?.trim(); if (!name || name === group.name) return; await lifeApi(`/rss/groups/${group.id}`, { method: 'POST', body: JSON.stringify({ name }) }); await load(); };
  const deleteGroup = async (group: RssGroup) => { if (!window.confirm(`删除分组「${group.name}」？其中来源会移动到“其他”。`)) return; await lifeApi(`/rss/groups/${group.id}`, { method: 'DELETE' }); await load(); };
  const moveGroup = async (group: RssGroup, direction: -1 | 1) => { const index = persistedGroups.findIndex(item => item.id === group.id); const target = index + direction; if (index < 0 || target < 0 || target >= persistedGroups.length) return; const next = [...persistedGroups]; [next[index], next[target]] = [next[target], next[index]]; await lifeApi('/rss/groups/reorder', { method: 'POST', body: JSON.stringify({ ids: next.map(item => item.id) }) }); await load(); };
  const removeSource = async (source: RssSubscription) => { if (!window.confirm(`取消订阅「${source.alias || source.title}」？`)) return; await lifeApi(`/rss/subscriptions/${source.id}`, { method: 'DELETE' }); setEditingSource(null); setSourceId(null); await load(); };
  const refreshSource = async (source: RssSubscription) => { setBusy(true); try { const result = await lifeApi<{ added: number }>(`/rss/subscriptions/${source.id}/refresh`, { method: 'POST' }, 30_000); setMessage(`「${source.alias || source.title}」新增 ${result.added || 0} 条。`); await load(); } catch (error) { setMessage(readableRssError(error, `「${source.alias || source.title}」更新失败`)); } finally { setBusy(false); } };

  const subscriptions = data?.subscriptions || []; const items = data?.items || []; const counts = data?.counts || { all: 0, unread: 0, starred: 0 };
  const persistedGroups = data?.groups || [];
  const subscriptionsForView = subscriptions;
  const groupNames = [...new Set(subscriptionsForView.map(source => source.category || '其他'))];
  const displayName = (source: RssSubscription) => source.alias || source.title || new URL(source.feedUrl).hostname;
  const sourceOf = (item: RssItem) => subscriptions.find(source => source.id === item.subscriptionId);
  const itemImage = (item: RssItem) => item.thumbnailUrl || '';
  const embedFor = (item: RssItem) => {
    const embed = item.embedUrl;
    if (!embed) return '';
    const url = new URL(embed);
    if (!url.pathname.startsWith('/embed/') || !['www.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname)) return embed;
    url.searchParams.set('playsinline', '1'); url.searchParams.set('rel', '0'); url.searchParams.set('origin', window.location.origin); url.searchParams.set('cc_load_policy', '0'); url.searchParams.set('iv_load_policy', '3'); url.searchParams.set('vq', 'hd1440'); return url.toString();
  };
  const renderCard = (item: RssItem) => {
    const source = sourceOf(item);
    return <article key={item.id} className={`rss-card rss-card-video ${itemImage(item) ? 'has-media' : 'no-media'} ${item.read ? 'is-read' : ''}`} onClick={() => void openItem(item)}>{itemImage(item) ? <div className="rss-card-media"><img src={itemImage(item)} alt="" loading="lazy" /><i className="ri-play-large-fill" /></div> : <div className="rss-card-placeholder"><i className="ri-video-line" /></div>}<div className="rss-card-copy"><span>{source ? displayName(source) : item.author || 'YouTube'} · {new Date(item.publishedAt).toLocaleDateString()}</span><strong>{item.title}</strong></div><button className={item.starred ? 'starred' : ''} title="收藏" onClick={event => { event.stopPropagation(); void updateItem(item, { starred: !item.starred }); }}><i className={item.starred ? 'ri-star-fill' : 'ri-star-line'} /></button></article>;
  };
  const closeReader = () => { setSelectedItem(null); };
  const finishSwipe = (clientX: number) => { if (swipeStart.current !== null && swipeStart.current - clientX > 72) closeReader(); swipeStart.current = null; };
  const readerBody = selectedItem ? <div className="rss-reader-body"><span>{sourceOf(selectedItem) ? displayName(sourceOf(selectedItem)!) : selectedItem.author} · {new Date(selectedItem.publishedAt).toLocaleString()}</span><h2>{selectedItem.title}</h2>{selectedItem.summary && <p>{selectedItem.summary}</p>}</div> : null;

  return <main className="rss-standalone"><Helmet><title>RSS | Shjdshy</title></Helmet><section className="rss-standalone-shell">
    {pomodoroRunning && <Link href="/life/pomodoro" className="rss-pomodoro-status" title="打开番茄钟"><i className="ri-timer-line" />{pomodoroTimer.taskName.trim() ? `${pomodoroTimer.taskName.trim()} · ${pomodoroClock}` : pomodoroClock}</Link>}
    {message && <p className="rss-message">{message}</p>}
    <div className={`rss-workspace rss-workspace-wide ${sidebarCollapsed ? 'is-sidebar-collapsed' : ''}`}>
      <aside className="rss-library">
        <nav className="rss-sidebar-tools" aria-label="RSS 工具">
          <Link href="/life" title="返回 Life"><i className="ri-arrow-left-line" /></Link>
          <button onClick={() => setShowAdd(true)} title="新增订阅"><i className="ri-add-line" /></button>
          <button onClick={refreshAll} disabled={busy || !subscriptions.length} title="更新来源"><i className={`ri-refresh-line ${busy ? 'spin' : ''}`} /></button>
          <button onClick={() => setSidebarCollapsed(value => !value)} title={sidebarCollapsed ? '展开来源栏' : '收起来源栏'}><i className={sidebarCollapsed ? 'ri-side-bar-fill' : 'ri-contract-left-line'} /></button>
        </nav>
        <div className="rss-library-content">
          <section className="rss-sidebar-card">
            <div className="rss-side-heading"><span>阅读状态</span>{filter !== 'all' && <button onClick={() => setFilter('all')} title="清除阅读状态筛选"><i className="ri-close-circle-line" /></button>}</div>
            <button className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter(current => current === 'unread' ? 'all' : 'unread')}><i className="ri-mail-unread-line" /><span>未读</span><b>{counts.unread}</b></button>
            <button className={filter === 'starred' ? 'active' : ''} onClick={() => setFilter(current => current === 'starred' ? 'all' : 'starred')}><i className="ri-star-line" /><span>收藏</span><b>{counts.starred}</b></button>
            {filter === 'unread' && counts.unread > 0 && <button className="rss-clear-unread" onClick={() => void markAllRead()}><i className="ri-check-double-line" /><span>一键清除未读</span></button>}
          </section>
          <section className="rss-sidebar-card rss-source-card">
            <div className="rss-side-heading"><span>来源</span><span className="rss-heading-actions"><button onClick={() => setShowGroups(true)} title="管理分组"><i className="ri-folder-settings-line" /></button><button onClick={() => setCollapsed(current => current.size ? new Set() : new Set(groupNames))} title={collapsed.size ? '展开所有分组' : '收起所有分组'}><i className={collapsed.size ? 'ri-expand-up-down-line' : 'ri-collapse-diagonal-line'} /></button></span></div>
            <button className={!selectedGroup && !sourceId ? 'active' : ''} onClick={() => { setSelectedGroup(null); setSourceId(null); }}><i className="ri-folders-line" /><span>全部分组</span></button>
            {groupNames.map(group => { const sources = subscriptionsForView.filter(source => (source.category || '其他') === group); if (!sources.length) return null; const folded = collapsed.has(group); return <section className="rss-source-group" key={group}><div className="rss-source-group-head"><button className={selectedGroup === group && !sourceId ? 'active' : ''} onClick={() => { setSelectedGroup(group); setSourceId(null); }}><strong>{group}</strong><b>{sources.length}</b></button><button title={folded ? '展开' : '收起'} onClick={() => setCollapsed(current => { const next = new Set(current); next.has(group) ? next.delete(group) : next.add(group); return next; })}><i className={folded ? 'ri-arrow-right-s-line' : 'ri-arrow-down-s-line'} /></button></div>{!folded && sources.map(source => <div className="rss-source-row" key={source.id}><button className={sourceId === source.id ? 'active' : ''} onClick={() => { setSourceId(source.id); setSelectedGroup(group); }}><img src={source.favicon || '/favicon.png'} alt="" loading="lazy" /><span>{displayName(source)}</span></button><button title="来源设置" onClick={() => setEditingSource(source)}><i className="ri-more-2-fill" /></button></div>)}</section>; })}
          </section>
          {storage && <section className="rss-sidebar-card rss-storage-card"><div className="rss-side-heading"><span>存储空间</span></div><label><span>D1 后端 <b>{formatBytes(storage.backend.usedBytes)} / {formatBytes(storage.backend.limitBytes)}</b></span><i><em style={{ width: `${Math.min(100, storage.backend.usedBytes / Math.max(1, storage.backend.limitBytes) * 100)}%` }} /></i></label>{storage.local?.limitBytes ? <label><span>本机缓存 <b>{formatBytes(storage.local.usedBytes)} / {formatBytes(storage.local.limitBytes)}</b></span><i><em style={{ width: `${Math.min(100, storage.local.usedBytes / storage.local.limitBytes * 100)}%` }} /></i></label> : null}<small>RSS 文字数据约 {formatBytes(storage.rssBytes)}；图片与视频不存入数据库。</small></section>}
        </div>
      </aside>
      <section className={`rss-main ${selectedItem ? 'is-reader is-video' : 'is-library'}`}>
        {selectedItem ? <article className="rss-reader" onTouchStart={event => { swipeStart.current = event.changedTouches[0]?.clientX ?? null; }} onTouchEnd={event => finishSwipe(event.changedTouches[0]?.clientX ?? 0)}>
          <header><button onClick={closeReader}><i className="ri-arrow-left-line" /> 返回</button><div><button className={selectedItem.starred ? 'starred' : ''} onClick={() => void updateItem(selectedItem, { starred: !selectedItem.starred })}><i className={selectedItem.starred ? 'ri-star-fill' : 'ri-star-line'} /> 收藏</button><a href={selectedItem.url} target="_blank" rel="noreferrer">在 YouTube 打开 <i className="ri-external-link-line" /></a></div></header>
          {embedFor(selectedItem) ? <iframe className="rss-reader-video" src={embedFor(selectedItem)} title={selectedItem.title} allow="accelerometer; autoplay; encrypted-media; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen /> : itemImage(selectedItem) ? <div className="rss-reader-video-fallback"><img src={itemImage(selectedItem)} alt="" /><span>该视频暂时无法站内播放，可使用下方 YouTube 链接。</span></div> : null}
          {readerBody}
        </article> : <><div className="rss-card-grid rss-card-grid-video">{items.map(renderCard)}</div>{!items.length && <p className="rss-empty">这里暂时没有内容。</p>}{data?.page?.hasMore && <button className="rss-load-more" onClick={() => void load(true)}>加载更早内容</button>}</>}
      </section>
    </div>
    {showAdd && <div className="rss-modal-backdrop" onMouseDown={() => setShowAdd(false)}><section className="rss-modal" onMouseDown={event => event.stopPropagation()}><header><div><small>ADD YOUTUBE</small><h2>新增 YouTube 订阅</h2></div><button onClick={() => setShowAdd(false)}><i className="ri-close-line" /></button></header><p>支持官方 Feed、/channel/UC… 频道链接及 @handle 频道主页。</p>{message && !candidate && <p className="rss-modal-message">{message}</p>}<label>频道地址<input autoFocus value={sourceUrl} placeholder="粘贴 YouTube Feed 或频道主页" onChange={event => setSourceUrl(event.target.value)} /></label><button className="rss-save" onClick={() => void detect()} disabled={busy || !sourceUrl.trim()}>{busy ? '正在检测…' : '检测频道'}</button>{candidate && <div className="rss-detected"><small>YOUTUBE · VIDEO</small><h3>{candidate.title}</h3><label>显示名称<input value={alias} onChange={event => setAlias(event.target.value)} /></label><label>分组<select value={category} onChange={event => setCategory(event.target.value)}>{groupNames.map(name => <option key={name} value={name}>{name}</option>)}{!groupNames.includes(category) && <option value={category}>{category}</option>}</select></label><div className="rss-preview-list">{candidate.preview.map(item => <span key={item.externalId}>{item.title}</span>)}</div><button className="rss-save" onClick={() => void subscribe()} disabled={busy}>确认订阅</button></div>}</section></div>}
    {showGroups && <div className="rss-modal-backdrop" onMouseDown={() => setShowGroups(false)}><section className="rss-modal rss-group-manager" onMouseDown={event => event.stopPropagation()}><header><div><small>SOURCE GROUPS</small><h2>管理分组</h2></div><button onClick={() => setShowGroups(false)}><i className="ri-close-line" /></button></header><div className="rss-group-create"><input value={newGroup} placeholder="新分组名称" onChange={event => setNewGroup(event.target.value)} /><button onClick={() => void createGroup()}>创建</button></div>{persistedGroups.map((group, index) => <div className="rss-group-manage-row" key={group.id}><strong>{group.name}</strong><span>{subscriptions.filter(source => source.category === group.name).length} 个来源</span><button disabled={index === 0} title="上移" onClick={() => void moveGroup(group, -1)}><i className="ri-arrow-up-line" /></button><button disabled={index === persistedGroups.length - 1} title="下移" onClick={() => void moveGroup(group, 1)}><i className="ri-arrow-down-line" /></button><button onClick={() => void renameGroup(group)}><i className="ri-edit-line" /></button><button onClick={() => void deleteGroup(group)}><i className="ri-delete-bin-line" /></button></div>)}</section></div>}
    {editingSource && <div className="rss-modal-backdrop" onMouseDown={() => setEditingSource(null)}><section className="rss-modal" onMouseDown={event => event.stopPropagation()}><header><div><small>SOURCE SETTINGS</small><h2>{displayName(editingSource)}</h2></div><button onClick={() => setEditingSource(null)}><i className="ri-close-line" /></button></header><SourcePanel source={editingSource} groups={groupNames} busy={busy} onRefresh={() => void refreshSource(editingSource)} onRemove={() => void removeSource(editingSource)} onSaved={() => { setEditingSource(null); void load(); }} /></section></div>}
  </section></main>;
}

function SourcePanel({ source, groups, busy, onRefresh, onRemove, onSaved }: { source: RssSubscription; groups: string[]; busy: boolean; onRefresh: () => void; onRemove: () => void; onSaved: () => void }) {
  const [alias, setAlias] = useState(source.alias || source.title); const [description, setDescription] = useState(source.description || ''); const [category, setCategory] = useState(source.category || '其他'); const [saving, setSaving] = useState(false);
  useEffect(() => { setAlias(source.alias || source.title); setDescription(source.description || ''); setCategory(source.category || '其他'); }, [source.id]);
  const save = async () => { setSaving(true); try { await lifeApi(`/rss/subscriptions/${source.id}`, { method: 'POST', body: JSON.stringify({ alias, description, category }) }); onSaved(); } finally { setSaving(false); } };
  return <><p className="rss-context-kicker">SOURCE INFO</p><img className="rss-context-icon" src={source.favicon || '/favicon.png'} alt="" /><h2>{source.alias || source.title}</h2><span>{source.platform} · {source.provider}</span><label>显示名称<input value={alias} onChange={event => setAlias(event.target.value)} /></label><label>分类<select value={category} onChange={event => setCategory(event.target.value)}>{groups.map(name => <option key={name} value={name}>{name}</option>)}{!groups.includes(category) && <option value={category}>{category}</option>}</select></label><label>备注<textarea value={description} onChange={event => setDescription(event.target.value)} /></label><button className="rss-save" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存来源信息'}</button><button onClick={onRefresh} disabled={busy}><i className="ri-refresh-line" /> 更新这个来源</button><p>{source.lastError || (source.lastFetchedAt ? `上次更新：${new Date(source.lastFetchedAt).toLocaleString()}` : '等待首次更新')}</p><a className="rss-feed-url" href={source.sourceUrl || source.siteUrl || source.feedUrl} target="_blank" rel="noreferrer">访问来源 <i className="ri-external-link-line" /></a><button className="rss-remove" onClick={onRemove}>取消订阅</button></>;
}
