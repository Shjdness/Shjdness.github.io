import type {D1Database} from '@cloudflare/workers-types';
import type {CheckinVault} from './checkin-vault';
/** Read-only on GET; first admitted save binds the purpose-specific key. This
 * stores only a proof, never the raw/derived encryption key or user content. */
export async function checkinKeyGuard(db:D1Database,vault:CheckinVault,initialize=false){
  if(initialize){const result=await db.prepare('INSERT INTO life_checkin_key_guard(id,fingerprint) VALUES(1,?) ON CONFLICT(id) DO NOTHING').bind(vault.keyFingerprint).all();if(!result.success)throw Error('Check-in key guard unavailable');}
  const result=await db.prepare('SELECT fingerprint FROM life_checkin_key_guard WHERE id=1').all<{fingerprint:string}>();if(!result.success)throw Error('Check-in key guard unavailable');if(result.results[0]&&result.results[0].fingerprint!==vault.keyFingerprint)throw Error('Check-in encryption key mismatch');
}
