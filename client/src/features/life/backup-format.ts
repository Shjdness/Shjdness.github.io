import {validateStoredAnalysis,type StoredReportAnalysis} from '../../../../server/src/utils/report-analysis-format';
import {reportSnapshot,type LifeReportPreview} from '../../../../server/src/utils/life-report';

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
  kdf: 'PBKDF2-SHA256';
  cipher: 'AES-256-GCM';
  salt: string;
  iv: string;
  ciphertext: string;
} & ({version:1;iterations:310_000}|{version:2;iterations:600_000});

const V2_AAD=new TextEncoder().encode('shjdshy-encrypted-backup:v2:PBKDF2-SHA256:600000:AES-256-GCM');

export const BACKUP_TABLES = [
  'feeds', 'comments', 'hashtags', 'feedHashtags', 'habits', 'habitLogs',
  'lifeDailyNotes', 'dailyBasics', 'lifeTodos', 'pomodoroSessions',
  'rssSubscriptions', 'rssSourceGroups', 'rssItems', 'appearancePreferences', 'writingTagOptions',
] as const;
// Keep the legacy table list unchanged: older v1/v2 files remain readable.
export const REPORT_BACKUP_TABLES=['lifeReports','lifeReportPreferences'] as const;

const toBase64 = (value: Uint8Array) => {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += 0x8000) chunks.push(String.fromCharCode(...value.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(''));
};
const fromBase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));

async function backupKey(passphrase: string, salt: Uint8Array, usage: KeyUsage, iterations:310_000|600_000) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt:new Uint8Array(salt), iterations }, material, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

export async function encryptBackup(backup: Backup, passphrase: string): Promise<EncryptedBackup> {
  if (passphrase.length < 12) throw new Error('备份口令至少需要 12 个字符');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await backupKey(passphrase, salt, 'encrypt',600_000);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData:V2_AAD }, key, new TextEncoder().encode(JSON.stringify(backup)));
  return { format: 'shjdshy-encrypted-backup', version: 2, kdf: 'PBKDF2-SHA256', iterations: 600_000, cipher: 'AES-256-GCM', salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptBackup(value: unknown, passphrase: string, expectedOwnerId: number): Promise<Backup> {
  if (!value || typeof value !== 'object') throw new Error('备份文件无效');
  const wrapper = value as EncryptedBackup;
  const supported=(wrapper.version===1 && wrapper.iterations===310_000)||(wrapper.version===2 && wrapper.iterations===600_000);
  if (wrapper.format !== 'shjdshy-encrypted-backup' || !supported || wrapper.kdf !== 'PBKDF2-SHA256' || wrapper.cipher !== 'AES-256-GCM') throw new Error('加密备份格式不受支持');
  if (typeof wrapper.salt !== 'string' || typeof wrapper.iv !== 'string' || typeof wrapper.ciphertext !== 'string') throw new Error('备份加密参数无效');
  let salt: Uint8Array; let iv: Uint8Array;
  try { salt = fromBase64(wrapper.salt); iv = fromBase64(wrapper.iv); }
  catch { throw new Error('备份加密参数无效'); }
  if (salt.length !== 16 || iv.length !== 12) throw new Error('备份加密参数无效');
  try {
    const key = await backupKey(passphrase, salt, 'decrypt',wrapper.iterations);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv:new Uint8Array(iv),...(wrapper.version===2?{additionalData:V2_AAD}:{}) }, key, fromBase64(wrapper.ciphertext));
    return validateBackup(JSON.parse(new TextDecoder().decode(plaintext)), expectedOwnerId);
  } catch (error) {
    if (error instanceof Error && error.message.includes('账号不符')) throw error;
    throw new Error('口令错误或备份文件已损坏');
  }
}

export async function validateBackup(value: unknown, expectedOwnerId: number): Promise<Backup> {
  if (!value || typeof value !== 'object') throw new Error('备份内容无效');
  const backup = value as Backup;
  if (backup.format !== 'shjdshy-personal-data' || ![1,2,3,4].includes(backup.version)) throw new Error('备份格式不受支持');
  if (backup.ownerId !== expectedOwnerId) throw new Error('备份所属账号不符');
  if (!Number.isSafeInteger(backup.ownerId) || backup.ownerId <= 0 || !Number.isFinite(Date.parse(backup.exportedAt))) throw new Error('备份元数据无效');
  if (!backup.data || typeof backup.data !== 'object' || !backup.counts || typeof backup.counts !== 'object') throw new Error('备份数据不完整');
  const required=backup.version===1?BACKUP_TABLES.filter(name=>name!=='writingTagOptions'):backup.version===4?[...BACKUP_TABLES,...REPORT_BACKUP_TABLES,'lifeReportAnalyses']:backup.version===3?[...BACKUP_TABLES,...REPORT_BACKUP_TABLES]:BACKUP_TABLES;
  if (required.some(name => !(name in backup.data) || !(name in backup.counts)) || Object.keys(backup.data).length !== Object.keys(backup.counts).length) throw new Error('备份清单不完整');
  for (const [name, count] of Object.entries(backup.counts)) {
    if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(backup.data[name]) || backup.data[name].length !== count) throw new Error(`备份清单不符：${name}`);
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(backup.data)));
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== backup.sha256) throw new Error('备份校验失败');
  if(backup.version>=3){
    for(const entry of backup.data.lifeReports){
      const row=entry as Record<string,unknown>;
      if(!row||row.ownerId!==expectedOwnerId||!Number.isSafeInteger(row.id)||Number(row.id)<=0||row.templateVersion!==1||typeof row.snapshotJson!=='string'||row.snapshotJson.length>16384||typeof row.snapshotSha256!=='string')throw Error('报表备份记录无效');
      const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(row.snapshotJson));
      const digest=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('');
      if(digest!==row.snapshotSha256)throw Error('报表快照校验失败');
      const report=reportSnapshot(expectedOwnerId,JSON.parse(row.snapshotJson) as LifeReportPreview);
      const time=(value:unknown)=>value instanceof Date?value.getTime():typeof value==='string'?Date.parse(value):NaN;
      if(row.kind!==report.period.kind||row.timezone!==report.period.timezone||time(row.periodStart)!==Date.parse(report.period.start)||time(row.periodEnd)!==Date.parse(report.period.end))throw Error('报表周期不匹配');
    }
    for(const entry of backup.data.lifeReportPreferences){
      const row=entry as Record<string,unknown>;
      const clock=(value:unknown)=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
      if(!row||row.ownerId!==expectedOwnerId||row.timezone!=='Asia/Shanghai'||!clock(row.dailyTime)||!clock(row.weeklyTime)||!Number.isInteger(row.weeklyDay)||Number(row.weeklyDay)<1||Number(row.weeklyDay)>7||row.aiScope!=='statistics'||['dailyEnabled','weeklyEnabled','emailEnabled','aiEnabled'].some(key=>row[key]!==0&&row[key]!==1))throw Error('报表设置备份无效');
    }
  }
  if(backup.version===4){
    const reports=new Map(backup.data.lifeReports.map(entry=>{const row=entry as Record<string,unknown>;return [row.id,row];}));
    if(reports.size!==backup.data.lifeReports.length||backup.data.lifeReportPreferences.length>1)throw Error('分析备份存在重复所属记录');
    const keys=new Set<string>();
    for(const entry of backup.data.lifeReportAnalyses){
      const row=entry as StoredReportAnalysis;
      const parent=reports.get(row?.reportId);
      if(!parent||row.ownerId!==expectedOwnerId||keys.has(row.requestKey))throw Error('分析备份所属报告无效');
      keys.add(row.requestKey);
      const time=(value:unknown)=>value instanceof Date?value.getTime()/1000:typeof value==='string'?Date.parse(value)/1000:NaN;
      await validateStoredAnalysis({...row,createdAt:time(row.createdAt),updatedAt:time(row.updatedAt)},{id:row.reportId,ownerId:expectedOwnerId,sha256:parent.snapshotSha256 as string});
    }
  }
  return backup;
}
