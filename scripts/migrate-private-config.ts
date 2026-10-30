import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {$} from 'bun';

/** Use the existing Cloudflare deploy identity, never print object contents. */
export async function migratePrivateConfig(database:string) {
  const check=async()=>{
    const output=await $`bunx wrangler d1 execute ${database} --remote --command ${"SELECT COUNT(*) AS count FROM info WHERE key='private:server.config:v1'"} --json`.quiet().text();
    return JSON.parse(output)[0]?.results?.[0]?.count===1;
  };
  const env=process.env;
  const objectKey=(env.S3_CACHE_FOLDER||'cache/').replace(/\/$/,'')+'/server.config.json';
  const url=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID!)}/r2/buckets/${encodeURIComponent(env.S3_BUCKET!)}/objects/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  const objectRequest=(method:string)=>fetch(url,{method,headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`},signal:AbortSignal.timeout(30000)});
  if(!await check()) {
    let data:unknown={};
    const legacy=await objectRequest('GET');
    if(legacy.ok)data=await legacy.json();
    else if(legacy.status!==404)throw Error(`Private configuration read failed (HTTP ${legacy.status})`);
    if(!data||Array.isArray(data)||typeof data!=='object')throw Error('Invalid legacy configuration');
    const value=JSON.stringify(data).replace(/'/g,"''");
    const file='.wrangler/private-config-migration.sql';
    await mkdir('.wrangler',{recursive:true});
    try {
      await writeFile(file,`INSERT OR IGNORE INTO info(key,value) VALUES('private:server.config:v1','${value}');`,{mode:0o600});
      await $`bunx wrangler d1 execute ${database} --remote --file ${file}`.quiet();
    } catch {throw Error('Private configuration migration failed; configuration values are not logged');}
    finally {await unlink(file).catch(()=>{});}
    if(!await check())throw Error('Private configuration verification failed');
  }
  const removed=await objectRequest('DELETE');
  if(!removed.ok&&removed.status!==404)throw Error(`Legacy configuration cleanup failed (HTTP ${removed.status})`);
  console.log('Private configuration durably stored; public legacy object removed.');
}
