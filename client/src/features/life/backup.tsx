import { useState } from 'react';
import { getCookie } from 'typescript-cookie';
import { accountIdFromToken, getLegacySyncQueueCount, getSyncQueue } from '../../data/local-first';
import { lifeApi, isoDay } from './model';
import { decryptBackup, encryptBackup, validateBackup } from './backup-format';

export function LifeBackupButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const download = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const ownerId = accountIdFromToken(getCookie('token'));
      if (!ownerId) throw new Error('请重新登录后下载备份');
      if (passphrase.length < 12 || passphrase !== confirmation) throw new Error('请输入至少 12 字符且两次一致的备份口令');
      const [pending, legacy] = await Promise.all([getSyncQueue(), getLegacySyncQueueCount()]);
      if (pending.length || legacy) throw new Error(`还有 ${pending.length + legacy} 条离线操作待核对；同步完成后再导出`);
      const backup = await validateBackup(await lifeApi<unknown>('/life/backup', { cache: 'no-store' }, 60_000), ownerId);
      const encrypted = await encryptBackup(backup, passphrase);
      const blob = new Blob([JSON.stringify(encrypted)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `shjdshy-personal-backup-${isoDay()}.encrypted.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage(`已加密并下载：文章/日记 ${backup.counts.feeds} 条、待办 ${backup.counts.lifeTodos} 条、番茄钟 ${backup.counts.pomodoroSessions} 条；请另行保管口令`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '备份失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };
  const verifyFile = async (file?: File) => {
    if (!file || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const ownerId = accountIdFromToken(getCookie('token'));
      if (!ownerId) throw new Error('请重新登录后验证备份');
      if (file.size > 100 * 1024 * 1024) throw new Error('备份文件超过 100 MB，请使用离线恢复工具核对');
      const backup = await decryptBackup(JSON.parse(await file.text()), passphrase, ownerId);
      setMessage(`备份有效：${new Date(backup.exportedAt).toLocaleString('zh-CN')}；文章/日记 ${backup.counts.feeds} 条、待办 ${backup.counts.lifeTodos} 条、番茄钟 ${backup.counts.pomodoroSessions} 条。此处仅验证，不会覆盖网站数据。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '备份验证失败');
    } finally {
      setBusy(false);
    }
  };
  return <details className="life-backup-row"><summary>私人数据备份与验证</summary><div className="life-backup-controls"><label>备份口令<input type="password" autoComplete="off" value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={12} /></label><label>再次输入口令<input type="password" autoComplete="off" value={confirmation} onChange={event => setConfirmation(event.target.value)} minLength={12} /></label><button type="button" onClick={() => void download()} disabled={busy}>{busy ? '正在处理…' : '下载加密备份'}</button><label className="life-backup-verify">验证已有备份<input type="file" accept=".json,application/json" disabled={busy} onChange={event => { void verifyFile(event.target.files?.[0]); event.target.value = ''; }} /></label><small>包含云端已保存的日记与 Life 数据，不含上传图片文件。请将口令与文件分开保存；忘记口令无法恢复。</small>{message && <span role="status">{message}</span>}</div></details>;
}
