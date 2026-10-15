import { describe, expect, it } from 'vitest';
import { BACKUP_TABLES, decryptBackup, encryptBackup, validateBackup } from './backup-format';

async function fixture() {
  const data = Object.fromEntries(BACKUP_TABLES.map(name => [name, [] as Array<{ id: number; content: string }>])) as Record<(typeof BACKUP_TABLES)[number], Array<{ id: number; content: string }>>;
  data.feeds.push({ id: 1, content: '日记' });
  data.lifeTodos.push({ id: 5, content: '任务' });
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { format: 'shjdshy-personal-data', version: 1, ownerId: 12, exportedAt: '2026-10-15T00:00:00.000Z', counts: Object.fromEntries(BACKUP_TABLES.map(name => [name, data[name].length])), sha256, data };
}

describe('personal backup validation', () => {
  it('accepts a matching owner and complete snapshot', async () => {
    expect((await validateBackup(await fixture(), 12)).counts.feeds).toBe(1);
  });
  it('rejects a different owner or modified content', async () => {
    const backup = await fixture();
    await expect(validateBackup(backup, 13)).rejects.toThrow('账号不符');
    backup.data.lifeTodos[0].content = '被篡改';
    await expect(validateBackup(backup, 12)).rejects.toThrow('校验失败');
  });
  it('rejects a missing table even if the digest field is present', async () => {
    const backup = await fixture();
    delete (backup.data as Record<string, unknown>).feeds;
    await expect(validateBackup(backup, 12)).rejects.toThrow('清单不完整');
  });
  it('encrypts the backup locally and detects a wrong password', async () => {
    const backup = await fixture();
    const encrypted = await encryptBackup(backup, 'a-long-test-passphrase');
    expect(JSON.stringify(encrypted)).not.toContain('日记');
    expect((await decryptBackup(encrypted, 'a-long-test-passphrase', 12)).counts.lifeTodos).toBe(1);
    await expect(decryptBackup(encrypted, 'wrong-passphrase', 12)).rejects.toThrow('口令错误');
  });
});
