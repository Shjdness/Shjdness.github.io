/** Explicit versioned personal-data boundary. Operational consent, queues,
 * delivery proofs, secrets and global spend ledgers never belong here.
 * New business modules extend a new version instead of accepting arbitrary SQL
 * table names from a file. V1 retains its historical optional tag-options table. */
export const BACKUP_TABLES=['feeds','comments','hashtags','feedHashtags','habits','habitLogs','lifeDailyNotes','dailyBasics','lifeTodos','pomodoroSessions','rssSubscriptions','rssSourceGroups','rssItems','appearancePreferences','writingTagOptions'] as const;
export const REPORT_BACKUP_TABLES=['lifeReports','lifeReportPreferences'] as const;
export function validBackupManifest(value:unknown,version:number){
  if(!value||typeof value!=='object'||Array.isArray(value)||![1,2,3,4].includes(version))return false;
  const allowed:readonly string[]=version===4?[...BACKUP_TABLES,...REPORT_BACKUP_TABLES,'lifeReportAnalyses']:version===3?[...BACKUP_TABLES,...REPORT_BACKUP_TABLES]:BACKUP_TABLES;
  const required=version===1?BACKUP_TABLES.filter(name=>name!=='writingTagOptions'):allowed;
  return required.every(name=>Object.hasOwn(value,name))&&Object.keys(value).every(name=>allowed.includes(name));
}
