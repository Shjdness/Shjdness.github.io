import { useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'wouter';
import { accountIdFromToken, accountStorageKey, flushSyncQueue, getLegacySyncQueueCount, getSyncQueue, onLocalChange } from '../../data/local-first';
import { getCookie } from 'typescript-cookie';
import { CLOUD_REFRESH_EVENT, lifeApi, type LifeSection } from './model';
import { sendQueuedMutation } from './sync';

export function LifeDenied() {
  return <main className="life-page"><section className="life-panel life-denied"><p className="life-kicker">PRIVATE LIFE</p><h1>这里是私人生活空间</h1><p>登录本身不等于私人访问权限。此区域仅向 Owner 与受信任账户开放。</p><Link className="life-link" href="/">返回公开首页</Link></section></main>;
}

export function LifeLayout({ section: _section, title, intro, children }: { section: LifeSection; title: string; intro: string; children: React.ReactNode }) {
  return <main className="life-page"><Helmet><title>{title} - {process.env.NAME}</title></Helmet><section className="life-panel life-section">
    <div className="life-title-row"><div><p className="life-kicker">PRIVATE LIFE</p><h1>{title}</h1></div><LifeSyncStatus /></div><p className="life-intro">{intro}</p>{children}
  </section></main>;
}

export function LifeSyncStatus() {
  const accountId = accountIdFromToken(getCookie('token'));
  const syncStampKey = accountId ? accountStorageKey('shjdshy-last-sync', accountId) : 'shjdshy-last-sync:unauthed';
  const [pending, setPending] = useState(0);
  const [legacyPending, setLegacyPending] = useState(0);
  const [status, setStatus] = useState<'synced' | 'pending' | 'syncing' | 'failed' | 'offline'>(navigator.onLine ? 'syncing' : 'offline');
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
    if (!navigator.onLine) setStatus('offline');
    else if (queue.some(item => item.status === 'failed') || cloudError.current) setStatus('failed');
    else if (inFlight.current) setStatus('syncing');
    else setStatus(queue.length || !verified.current ? 'pending' : 'synced');
  };
  const sync = async () => {
    if (inFlight.current) return;
    if (!navigator.onLine) { setStatus('offline'); await refresh(); return; }
    inFlight.current = true;
    setStatus('syncing');
    cloudError.current = '';
    verified.current = false;
    try {
      const result = await flushSyncQueue(sendQueuedMutation);
      if (result.failed) { await refresh(); setStatus('failed'); return; }
      const todos = await lifeApi<unknown>('/life/todos');
      if (!Array.isArray(todos)) throw new Error('云端未返回待办列表');
      verified.current = true;
      window.dispatchEvent(new CustomEvent(CLOUD_REFRESH_EVENT));
      const stamp = new Date().toISOString();
      localStorage.setItem(syncStampKey, stamp);
      setLastSync(stamp);
      setSyncError('');
      setStatus('synced');
    } catch (error) {
      cloudError.current = error instanceof Error ? error.message : '无法连接云端';
      setSyncError(cloudError.current);
      setStatus('failed');
    } finally {
      inFlight.current = false;
      void refresh();
    }
  };
  useEffect(() => {
    void sync();
    const handleOnline = () => { void sync(); };
    const handleOffline = () => { setStatus('offline'); void refresh(); };
    window.addEventListener('online', handleOnline); window.addEventListener('offline', handleOffline);
    const unsubscribe = onLocalChange(() => { void refresh(); });
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); unsubscribe(); };
  }, []);
  const labels = { synced: `已同步${lastSync ? ` · ${new Date(lastSync).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}`, pending: `${pending} 项待同步`, syncing: '正在同步…', failed: '同步失败 · 点击重试', offline: `${pending} 项离线保存` };
  const icons = { synced: 'ri-cloud-line', pending: 'ri-time-line', syncing: 'ri-loader-4-line', failed: 'ri-error-warning-line', offline: 'ri-cloud-off-line' };
  return <button className={`life-sync-status ${status}`} onClick={() => void sync()} disabled={status === 'syncing'} title={legacyPending ? `旧版未标记账号的离线操作有 ${legacyPending} 条，已保留且不会自动提交。请核对所属账号后处理。` : syncError || '推送本地更改并拉取云端最新数据'}><i className={`${icons[status]} ${status === 'syncing' ? 'spin' : ''}`} /><span>{labels[status]}{legacyPending ? ` · ${legacyPending} 条旧离线记录待核对` : ''}</span></button>;
}

