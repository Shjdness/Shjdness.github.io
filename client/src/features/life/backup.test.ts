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
  it('continues to validate legacy v1 backups without the new tag-options table',async()=>{
    const backup=await fixture();delete (backup.data as any).writingTagOptions;delete (backup.counts as any).writingTagOptions;
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(backup.data)));
    backup.sha256=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
    expect((await validateBackup(backup,12)).version).toBe(1);
    await expect(validateBackup({...backup,version:2},12)).rejects.toThrow('清单不完整');
  });
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
    expect(encrypted).toMatchObject({version:2,iterations:600_000});
    expect(JSON.stringify(encrypted)).not.toContain('日记');
    expect((await decryptBackup(encrypted, 'a-long-test-passphrase', 12)).counts.lifeTodos).toBe(1);
    await expect(decryptBackup(encrypted, 'wrong-passphrase', 12)).rejects.toThrow('口令错误');
  });
  it('reads original v1 encrypted files and rejects unsupported work factors or modified v2 metadata',async()=>{
    const backup=await fixture(),salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
    const material=await crypto.subtle.importKey('raw',new TextEncoder().encode('legacy-fixture-passphrase'),'PBKDF2',false,['deriveKey']);
    const key=await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:310_000},material,{name:'AES-GCM',length:256},false,['encrypt']);
    const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(backup)));
    const base64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes));
    const legacy={format:'shjdshy-encrypted-backup',version:1,kdf:'PBKDF2-SHA256',iterations:310_000,cipher:'AES-256-GCM',salt:base64(salt),iv:base64(iv),ciphertext:base64(new Uint8Array(ciphertext))};
    expect((await decryptBackup(legacy,'legacy-fixture-passphrase',12)).counts.feeds).toBe(1);
    const modern=await encryptBackup(backup,'modern-fixture-passphrase');
    for(const changed of [{...modern,iterations:1_000_000_000},{...modern,version:1}])await expect(decryptBackup(changed,'modern-fixture-passphrase',12)).rejects.toThrow('不受支持');
    await expect(decryptBackup({...modern,ciphertext:legacy.ciphertext},'modern-fixture-passphrase',12)).rejects.toThrow('口令错误');
  });
});
