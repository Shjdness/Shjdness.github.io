import {GetObjectCommand,DeleteObjectCommand,S3Client} from '@aws-sdk/client-s3';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {$} from 'bun';

/** Migrate through signed object access before publishing; never print values. */
export async function migratePrivateConfig(database:string) {
  const check=async()=>{
    const output=await $`bunx wrangler d1 execute ${database} --remote --command ${"SELECT COUNT(*) AS count FROM info WHERE key='private:server.config:v1'"} --json`.quiet().text();
    return JSON.parse(output)[0]?.results?.[0]?.count===1;
  };
  const env=process.env;
  const s3=new S3Client({region:env.S3_REGION||'auto',endpoint:env.S3_ENDPOINT,forcePathStyle:env.S3_FORCE_PATH_STYLE==='true',credentials:{accessKeyId:env.S3_ACCESS_KEY_ID!,secretAccessKey:env.S3_SECRET_ACCESS_KEY!}});
  const objectKey=(env.S3_CACHE_FOLDER||'cache/').replace(/\/$/,'')+'/server.config.json';
  if(!await check()) {
    let data:unknown={};
    try {const legacy=await s3.send(new GetObjectCommand({Bucket:env.S3_BUCKET,Key:objectKey}));data=JSON.parse(await legacy.Body!.transformToString());}
    catch(error:any) {
      if(error.name!=='NoSuchKey'&&error.$metadata?.httpStatusCode!==404) {
        const kind=/^[A-Za-z0-9_]+$/.test(error.name)?error.name:'UnknownError';
        throw Error(`Cannot read legacy configuration securely (${kind}, HTTP ${Number(error.$metadata?.httpStatusCode)||0})`);
      }
    }
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
  await s3.send(new DeleteObjectCommand({Bucket:env.S3_BUCKET,Key:objectKey}));
  console.log('Private configuration durably stored; public legacy object removed.');
}
