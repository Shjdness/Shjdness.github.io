export type Backup = {
  format: string;
  version: number;
  ownerId: number;
  exportedAt: string;
  counts: Record<string, number>;
  sha256: string;
  data: Record<string, unknown[]>;
};

export type EncryptedBackup = {
  format: 'shjdshy-encrypted-backup';
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: 310_000;
  cipher: 'AES-256-GCM';
  salt: string;
  iv: string;
  ciphertext: string;
};

export const BACKUP_TABLES = [
  'feeds', 'comments', 'hashtags', 'feedHashtags', 'habits', 'habitLogs',
  'lifeDailyNotes', 'dailyBasics', 'lifeTodos', 'pomodoroSessions',
  'rssSubscriptions', 'rssSourceGroups', 'rssItems', 'appearancePreferences',
] as const;

const toBase64 = (value: Uint8Array) => {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += 0x8000) chunks.push(String.fromCharCode(...value.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(''));
};
const fromBase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));

async function backupKey(passphrase: string, salt: Uint8Array, usage: KeyUsage) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 310_000 }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

export async function encryptBackup(backup: Backup, passphrase: string): Promise<EncryptedBackup> {
  if (passphrase.length < 12) throw new Error('备份口令至少需要 12 个字符');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await backupKey(passphrase, salt, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(backup)));
  return { format: 'shjdshy-encrypted-backup', version: 1, kdf: 'PBKDF2-SHA256', iterations: 310_000, cipher: 'AES-256-GCM', salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptBackup(value: unknown, passphrase: string, expectedOwnerId: number): Promise<Backup> {
  if (!value || typeof value !== 'object') throw new Error('备份文件无效');
  const wrapper = value as EncryptedBackup;
  if (wrapper.format !== 'shjdshy-encrypted-backup' || wrapper.version !== 1 || wrapper.kdf !== 'PBKDF2-SHA256' || wrapper.iterations !== 310_000 || wrapper.cipher !== 'AES-256-GCM') throw new Error('加密备份格式不受支持');
  if (typeof wrapper.salt !== 'string' || typeof wrapper.iv !== 'string' || typeof wrapper.ciphertext !== 'string') throw new Error('备份加密参数无效');
  let salt: Uint8Array; let iv: Uint8Array;
  try { salt = fromBase64(wrapper.salt); iv = fromBase64(wrapper.iv); }
  catch { throw new Error('备份加密参数无效'); }
  if (salt.length !== 16 || iv.length !== 12) throw new Error('备份加密参数无效');
  try {
    const key = await backupKey(passphrase, salt, 'decrypt');
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, fromBase64(wrapper.ciphertext));
    return validateBackup(JSON.parse(new TextDecoder().decode(plaintext)), expectedOwnerId);
  } catch (error) {
    if (error instanceof Error && error.message.includes('账号不符')) throw error;
    throw new Error('口令错误或备份文件已损坏');
  }
}

export async function validateBackup(value: unknown, expectedOwnerId: number): Promise<Backup> {
  if (!value || typeof value !== 'object') throw new Error('备份内容无效');
  const backup = value as Backup;
  if (backup.format !== 'shjdshy-personal-data' || backup.version !== 1) throw new Error('备份格式不受支持');
  if (backup.ownerId !== expectedOwnerId) throw new Error('备份所属账号不符');
  if (!Number.isSafeInteger(backup.ownerId) || backup.ownerId <= 0 || !Number.isFinite(Date.parse(backup.exportedAt))) throw new Error('备份元数据无效');
  if (!backup.data || typeof backup.data !== 'object' || !backup.counts || typeof backup.counts !== 'object') throw new Error('备份数据不完整');
  if (BACKUP_TABLES.some(name => !(name in backup.data) || !(name in backup.counts)) || Object.keys(backup.data).length !== Object.keys(backup.counts).length) throw new Error('备份清单不完整');
  for (const [name, count] of Object.entries(backup.counts)) {
    if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(backup.data[name]) || backup.data[name].length !== count) throw new Error(`备份清单不符：${name}`);
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(backup.data)));
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== backup.sha256) throw new Error('备份校验失败');
  return backup;
}
