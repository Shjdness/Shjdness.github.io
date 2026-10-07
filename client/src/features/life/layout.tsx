import { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'wouter';
import { flushSyncQueue, getSyncQueue, onLocalChange } from '../../data/local-first';
import { CLOUD_REFRESH_EVENT, type LifeSection } from './model';
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
  const [pending, setPending] = useState(0);
  const [status, setStatus] = useState<'synced' | 'pending' | 'syncing' | 'failed' | 'offline'>(navigator.onLine ? 'synced' : 'offline');
  const [lastSync, setLastSync] = useState(() => localStorage.getItem('shjdshy-last-sync') || '');
  const [syncError, setSyncError] = useState('');
  const refresh = async () => { const queue = await getSyncQueue(); const failed = queue.find(item => item.lastError); setPending(queue.length); setSyncError(failed ? `${failed.entity}/${failed.action}: ${failed.lastError}` : ''); if (!navigator.onLine) setStatus('offline'); else if (queue.some(item => item.status === 'failed')) setStatus('failed'); else setStatus(queue.length ? 'pending' : 'synced'); };
  const sync = async () => {
    if (!navigator.onLine) { setStatus('offline'); await refresh(); return; }
    setStatus('syncing');
    const result = await flushSyncQueue(sendQueuedMutation);
    await refresh();
    window.dispatchEvent(new CustomEvent(CLOUD_REFRESH_EVENT));
    if (result.failed) { setStatus('failed'); return; }
    const stamp = new Date().toISOString();
    localStorage.setItem('shjdshy-last-sync', stamp); setLastSync(stamp); setStatus('synced');
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
  return <button className={`life-sync-status ${status}`} onClick={() => void sync()} disabled={status === 'syncing'} title={syncError || '推送本地更改并拉取云端最新数据'}><i className={`${icons[status]} ${status === 'syncing' ? 'spin' : ''}`} /><span>{labels[status]}</span></button>;
}

