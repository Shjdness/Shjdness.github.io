import { useCallback, useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'wouter';
import { accountIdFromToken, accountStorageKey, flushSyncQueue, getLegacySyncQueueCount, getSyncQueue, hasPendingSync, onLocalChange } from '../../data/local-first';
import { getCookie } from 'typescript-cookie';
import { CLOUD_REFRESH_EVENT, lifeApi, type LifeSection } from './model';
import { sendQueuedMutation } from './sync';

export function LifeDenied() {
  return <main className="life-page"><section className="life-panel life-denied"><p className="life-kicker">PRIVATE LIFE</p><h1>这里是私人生活空间</h1><p>登录本身不等于私人访问权限。此区域仅向 Owner 与受信任账户开放。</p><Link className="life-link" href="/">返回公开首页</Link></section></main>;
}

export function LifeLayout({ title, intro, children }: { section: LifeSection; title: string; intro: string; children: React.ReactNode }) {
  return <main className="life-page"><Helmet><title>{title} - {process.env.NAME}</title></Helmet><section className="life-panel life-section">
    <div className="life-title-row"><div><p className="life-kicker">PRIVATE LIFE</p><h1>{title}</h1></div><LifeSyncStatus /></div><p className="life-intro">{intro}</p>{children}
  </section></main>;
}

const verifiedAccounts = new Set<number>();
const activeSyncs = new Map<number, Promise<string>>();

function verifyCloudSync(accountId: number, syncStampKey: string, upload: boolean) {
  const existing = activeSyncs.get(accountId);
  if (existing) return existing;
  const task = (async () => {
    if (upload) {
      const result = await flushSyncQueue(sendQueuedMutation);
      if (result.failed) throw new Error('部分本地操作未能上传');
    }
    const todos = await lifeApi<unknown>('/life/todos');
    if (!Array.isArray(todos)) throw new Error('云端未返回待办列表');
    const stamp = new Date().toISOString();
    localStorage.setItem(syncStampKey, stamp);
    verifiedAccounts.add(accountId);
    window.dispatchEvent(new CustomEvent(CLOUD_REFRESH_EVENT));
    return stamp;
  })().finally(() => { activeSyncs.delete(accountId); });
  activeSyncs.set(accountId, task);
  return task;
}

export function LifeSyncStatus() {
  const accountId = accountIdFromToken(getCookie('token'));
  const syncStampKey = accountId ? accountStorageKey('shjdshy-last-sync', accountId) : 'shjdshy-last-sync:unauthed';
  const [pending, setPending] = useState(0);
  const [legacyPending, setLegacyPending] = useState(0);
  const [status, setStatus] = useState<'synced' | 'pending' | 'syncing' | 'failed' | 'offline'>(navigator.onLine ? (localStorage.getItem(syncStampKey) ? 'synced' : 'pending') : 'offline');
  const [lastSync, setLastSync] = useState(() => localStorage.getItem(syncStampKey) || '');
  const [syncError, setSyncError] = useState('');
  const inFlight = useRef(false);
  const cloudError = useRef('');
  const verified = useRef(Boolean(lastSync) || (accountId !== null && verifiedAccounts.has(accountId)));
  const refresh = useCallback(async () => {
    const [queue, oldCount] = await Promise.all([getSyncQueue(), getLegacySyncQueueCount()]);
    setLegacyPending(oldCount);
    setPending(queue.length);
    const failed = queue.find(item => item.lastError);
    const message = failed ? `${failed.entity}/${failed.action}: ${failed.lastError}` : cloudError.current;
    setSyncError(message);
    if (!navigator.onLine) setStatus('offline');
    else if (queue.some(item => item.status === 'failed') || cloudError.current) setStatus('failed');
    else if (inFlight.current && queue.length) setStatus('syncing');
    else setStatus(queue.length || !verified.current ? 'pending' : 'synced');
  }, []);
  const sync = useCallback(async (force = false) => {
    if (inFlight.current) return;
    if (!navigator.onLine || accountId === null) { await refresh(); return; }
    const queue = await getSyncQueue();
    const upload = queue.length > 0 && (force || hasPendingSync(queue));
    if ((queue.length && !upload) || (!force && !upload && verifiedAccounts.has(accountId))) {
      await refresh();
      return;
    }
    inFlight.current = true;
    if (upload) setStatus('syncing');
    cloudError.current = '';
    try {
      const stamp = await verifyCloudSync(accountId, syncStampKey, upload);
      verified.current = true;
      setLastSync(stamp);
      setSyncError('');
    } catch (error) {
      cloudError.current = error instanceof Error ? error.message : '无法连接云端';
      setSyncError(cloudError.current);
    } finally {
      inFlight.current = false;
      void refresh();
    }
  }, [accountId, refresh, syncStampKey]);
  useEffect(() => {
    void sync();
    const handleOnline = () => { void sync(true); };
    const handleOffline = () => { setStatus('offline'); void refresh(); };
    window.addEventListener('online', handleOnline); window.addEventListener('offline', handleOffline);
    const unsubscribe = onLocalChange(kind => { if (kind === 'queue') { void refresh(); if (!inFlight.current) void sync(); } });
    return () => { window.removeEventListener('online', handleOnline); window.removeEventListener('offline', handleOffline); unsubscribe(); };
  }, [refresh, sync]);
  const labels = { synced: `已同步${lastSync ? ` · ${new Date(lastSync).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : ''}`, pending: `${pending} 项待同步`, syncing: '正在同步…', failed: '同步失败 · 点击重试', offline: `${pending} 项离线保存` };
  const icons = { synced: 'ri-cloud-line', pending: 'ri-time-line', syncing: 'ri-loader-4-line', failed: 'ri-error-warning-line', offline: 'ri-cloud-off-line' };
  return <button className={`life-sync-status ${status}`} onClick={() => void sync(true)} disabled={status === 'syncing'} title={legacyPending ? `旧版未标记账号的离线操作有 ${legacyPending} 条，已保留且不会自动提交。请核对所属账号后处理。` : syncError || '推送本地更改并拉取云端最新数据'}><i className={`${icons[status]} ${status === 'syncing' ? 'spin' : ''}`} /><span>{labels[status]}{legacyPending ? ` · ${legacyPending} 条旧离线记录待核对` : ''}</span></button>;
}

