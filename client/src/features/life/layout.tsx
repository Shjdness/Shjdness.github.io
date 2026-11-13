import { useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'wouter';
import { accountIdFromToken, accountStorageKey, currentWritePause, flushSyncQueue, getLegacySyncQueueCount, getSyncQueue, onLocalChange } from '../../data/local-first';
import { getCookie } from 'typescript-cookie';
import { CLOUD_REFRESH_EVENT, invalidateLifeTodos, lifeApi, mayAccessLife, type LifeSection } from './model';
import { sendQueuedMutation } from './sync';
import { SyncConflicts } from './sync-conflicts';

export function LifeDenied() {
  return <main className="life-page"><section className="life-panel life-denied"><p className="life-kicker">PRIVATE LIFE</p><h1>这里是私人生活空间</h1><p>登录本身不等于私人访问权限。此区域仅向 Owner 与受信任账户开放。</p><Link className="life-link" href="/">返回公开首页</Link></section></main>;
}

export function LifeLayout({ section: _section, title, children }: { section: LifeSection; title: string; children: React.ReactNode }) {
  return <main className="life-page"><Helmet><title>{title} - {process.env.NAME}</title></Helmet><section className="life-panel life-section">
    <div className="life-title-row"><div><p className="life-kicker">PRIVATE LIFE</p><h1>{title}</h1></div>{_section!=='check-in'&&<LifeSyncStatus />}</div><SyncConflicts />{children}
  </section></main>;
}

export function LifeSyncStatus() {
  const accountId = accountIdFromToken(getCookie('token'));
  const syncStampKey = accountId ? accountStorageKey('shjdshy-last-sync', accountId) : 'shjdshy-last-sync:unauthed';
  const [pending, setPending] = useState(0);
  const [legacyPending, setLegacyPending] = useState(0);
  const [status, setStatus] = useState<'synced' | 'pending' | 'syncing' | 'failed' | 'offline' | 'paused'>(navigator.onLine ? (localStorage.getItem(syncStampKey) ? 'synced' : 'pending') : 'offline');
  const [lastSync, setLastSync] = useState(() => localStorage.getItem(syncStampKey) || '');
  const [syncError, setSyncError] = useState('');
  const inFlight = useRef(false);
  const cloudError = useRef('');
  const verified = useRef(false);
  const refresh = async () => {
    const [queue, oldCount] = await Promise.all([getSyncQueue(), getLegacySyncQueueCount()]);
    setLegacyPending(oldCount);
    setPending(queue.length);
    const failed = queue.find(item => item.lastError);
    const message = failed ? `${failed.entity}/${failed.action}: ${failed.lastError}` : cloudError.current;
    setSyncError(message);
    if (currentWritePause()>Date.now()) setStatus('paused');
    else if (!navigator.onLine) setStatus('offline');
    else if (queue.some(item => item.status === 'failed'||item.status==='conflict') || cloudError.current) setStatus('failed');
    else if (inFlight.current) setStatus('syncing');
    else setStatus(queue.length || !verified.current ? 'pending' : 'synced');
  };
  const sync = async (refreshCloud = false) => {
    const token = getCookie('token');
    const current = () => getCookie('token') === token;
    if (inFlight.current || !accountId || accountIdFromToken(token) !== accountId) return;
    if(currentWritePause()>Date.now()) {setStatus('paused');await refresh();return;}
    if (!navigator.onLine) { setStatus('offline'); await refresh(); return; }
    inFlight.current = true;
    cloudError.current = '';
    verified.current = false;
    try {
      let remaining = (await getSyncQueue(accountId)).length;
      if (remaining && current()) setStatus('syncing');
      let writesApplied = false;
      const refreshAfterWrites = () => {
        invalidateLifeTodos();
        window.dispatchEvent(new CustomEvent(CLOUD_REFRESH_EVENT));
      };
      // A second edit can arrive while the first batch is in flight.
      while (remaining && current()) {
        const result = await flushSyncQueue(sendQueuedMutation);
        if (!current()) return;
        writesApplied ||= result.synced > 0;
        if (result.failed) {
          if (writesApplied) refreshAfterWrites();
          await refresh(); setStatus('failed'); return;
        }
        remaining = (await getSyncQueue(accountId)).length;
      }
      if (!current()) return;
      const profile = await lifeApi<{id: number; role?: string}>('/user/profile');
      if (!current()) return;
      if (profile?.id !== accountId || !mayAccessLife(profile.role)) throw new Error('无法核验私人空间的云端访问权限');
      verified.current = true;
      if (writesApplied || refreshCloud) refreshAfterWrites();
      const stamp = new Date().toISOString();
      localStorage.setItem(syncStampKey, stamp);
      setLastSync(stamp);
      setSyncError('');
      setStatus('synced');
    } catch (error) {
      if (!current()) return;
      cloudError.current = error instanceof Error ? error.message : '无法连接云端';
      setSyncError(cloudError.current);
      setStatus('failed');
    } finally {
      inFlight.current = false;
      if (current()) void refresh();
      // A local write can land after the drain but during the cloud read.
      if (verified.current) void getSyncQueue(accountId).then(queue => {
        if (queue.length && current()) void sync();
      }).catch(() => {});
    }
  };
  useEffect(() => {
    void sync();
    const handleOnline = () => { void sync(true); };
    const handleOffline = () => { setStatus('offline'); void refresh(); };
    window.addEventListener('online', handleOnline); window.addEventListener('offline', handleOffline);
    const unsubscribe = onLocalChange(() => { void refresh(); if (!inFlight.current) void sync(); });
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); unsubscribe(); };
  }, []);
  useEffect(()=>{
    const until=currentWritePause();
    if(until>Date.now()) {const timer=window.setTimeout(()=>void sync(true),until-Date.now()+1000);return()=>window.clearTimeout(timer);}
  },[status]);
  const labels = { paused:`写入暂停 · ${new Date(currentWritePause()).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})} 后重试`, synced: `已同步${lastSync ? ` · ${new Date(lastSync).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}`, pending: pending ? `${pending} 项待同步` : '正在核验云端…', syncing: '正在同步…', failed: '同步失败 · 点击重试', offline: `${pending} 项离线保存` };
  const icons = { paused:'ri-time-line', synced: 'ri-cloud-line', pending: 'ri-time-line', syncing: 'ri-loader-4-line', failed: 'ri-error-warning-line', offline: 'ri-cloud-off-line' };
  return <button className={`life-sync-status ${status}`} onClick={() => void sync(true)} disabled={status === 'syncing'||status==='paused'} title={legacyPending ? `旧版未标记账号的离线操作有 ${legacyPending} 条，已保留且不会自动提交。请核对所属账号后处理。` : syncError || '推送本地更改并拉取云端最新数据'}><i className={`${icons[status]} ${status === 'syncing' ? 'spin' : ''}`} /><span>{labels[status]}{legacyPending ? ` · ${legacyPending} 条旧离线记录待核对` : ''}</span></button>;
}

