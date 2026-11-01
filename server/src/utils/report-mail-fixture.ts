import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {reportMailVault,reportVerificationToken} from './report-mail-vault';
import {saveReportRecipient} from './report-mail-contacts';
// Test-only isolated database and synthetic mailbox, never imported by the Worker.
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
export const now=new Date('2026-11-02T00:00:00Z');
export const seconds=now.getTime()/1000;
const secret=btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+1)));

export async function mailFixture(){
  const sqlite=new DatabaseSync(':memory:'),folder=new URL('../../sql/',import.meta.url);
  for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()){
    sqlite.exec(readFileSync(new URL(file,folder),'utf8'));if(file==='0002.sql')sqlite.exec('ALTER TABLE feeds ADD COLUMN top INTEGER DEFAULT 0');
  }
  sqlite.exec("INSERT INTO users(id,username,openid,permission) VALUES(1,'owner','owner',1),(2,'other','other',1),(3,'trusted','trusted',2); INSERT INTO life_report_preferences(owner_id,daily_time,daily_enabled,weekly_enabled) VALUES(1,'09:15',1,1)");
  let tail=Promise.resolve();
  const raw={prepare(sql:string){let values:unknown[]=[];return {bind(...args:unknown[]){values=args;return this;},async all(){return {success:true,results:sqlite.prepare(sql).all(...values),meta:{}};},async raw(){return sqlite.prepare(sql).all(...values).map((row:Record<string,unknown>)=>Object.values(row));}};},batch(statements:Array<{all:()=>Promise<unknown>}>){
    const next=tail.then(async()=>{sqlite.exec('BEGIN');try{const rows=[];for(const statement of statements)rows.push(await statement.all());sqlite.exec('COMMIT');return rows;}catch(error){sqlite.exec('ROLLBACK');throw error;}});tail=next.then(()=>{},()=>{});return next;
  }} as any;
  const vault=await reportMailVault(secret);
  const configure=(email='fixture@example.invalid',baseRevision=0)=>saveReportRecipient({db:raw,ownerId:1,email,baseRevision,vault,now});
  const issueFixture=async(expires=seconds+1800)=>{
    const token=await reportVerificationToken(),contact=sqlite.prepare('SELECT * FROM life_report_mail_contacts WHERE owner_id=1').get(),key=token.hash;
    // Test-only fake outbound proof. No production issuer or provider is wired yet.
    sqlite.prepare("INSERT INTO life_report_mail_deliveries(delivery_key,owner_id,kind,purpose_key,contact_revision,fingerprint,provider_identity,state,message_sha256,created_at,updated_at) VALUES(?,1,'verification',?,?,?,'mock-v1','accepted',?,?,?)").run(key,key,contact.revision,contact.fingerprint,'a'.repeat(64),seconds,seconds);
    sqlite.prepare('INSERT INTO life_report_mail_verifications(token_hash,owner_id,contact_revision,fingerprint,delivery_key,created_at,expires_at) VALUES(?,1,?,?,?,?,?)').run(token.hash,contact.revision,contact.fingerprint,key,seconds-60,expires);
    return token.token;
  };
  return {sqlite,raw,vault,configure,issueFixture};
}

