import 'reflect-metadata';
import {expect,it} from 'vitest';
import {drizzle} from 'drizzle-orm/d1';
import {SignJWT} from 'jose';
import * as schema from '../db/schema';
import {runRequestContext} from './di';
import {LifeReportsService} from '../services/life-reports';
import {mailFixture,now,seconds} from './report-mail-fixture';
import {setBriefConsent,readBriefConsent} from './report-brief-consent';
it('requires independent explicit consent, preserves epoch on retries and conflicts on stale tabs',async()=>{
 const f=await mailFixture();try{
  expect(await readBriefConsent(f.raw,1)).toMatchObject({enabled:false,revision:0});
  expect(await setBriefConsent({db:f.raw,owner:1,enabled:true,baseRevision:0,now})).toMatchObject({saved:false,reason:'consent-required'});
  const options={db:f.raw,owner:1,enabled:true,baseRevision:0,allowNamedMail:true,now};
  const results=await Promise.all(Array.from({length:5},()=>setBriefConsent(options)));expect(results.filter(r=>r.saved)).toHaveLength(1);
  expect(await readBriefConsent(f.raw,1)).toMatchObject({enabled:true,revision:1,enabledAt:seconds});
  expect(await setBriefConsent({...options,baseRevision:1,now:new Date(now.getTime()+10000)})).toMatchObject({saved:true,reason:'unchanged',enabledAt:seconds});
  expect(await setBriefConsent({...options,enabled:false})).toMatchObject({saved:false,reason:'conflict'});
  expect(await setBriefConsent({...options,enabled:false,baseRevision:1})).toMatchObject({saved:true,enabled:false,revision:2,enabledAt:null});
  expect(await setBriefConsent({...options,baseRevision:2,now:new Date(now.getTime()+10000)})).toMatchObject({saved:true,revision:3,enabledAt:seconds+10});
  expect(f.sqlite.prepare('SELECT ai_enabled,email_enabled FROM life_report_preferences WHERE owner_id=1').get()).toMatchObject({ai_enabled:0,email_enabled:0});
  expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_mail_deliveries').get().n).toBe(0);
  await expect(setBriefConsent({...options,owner:3})).rejects.toThrow('Owner access');
 }finally{f.sqlite.close();}
});
it('exposes only owner state and allows withdrawal with no key or paused outbound',async()=>{
 const f=await mailFixture();try{
  await setBriefConsent({db:f.raw,owner:1,enabled:true,baseRevision:0,allowNamedMail:true,now});
  const db=drizzle(f.raw,{schema}),env={DB:f.raw,JWT_SECRET:'synthetic-brief-consent-32chars',REPORT_OUTBOUND_PAUSED:'true',RIN_GITHUB_CLIENT_ID:'fixture',RIN_GITHUB_CLIENT_SECRET:'fixture'} as any;
  const service=runRequestContext(env,db,()=>LifeReportsService());
  const send=async(owner:number|null,body?:unknown)=>{
   const headers:Record<string,string>={};if(owner)headers.Authorization='Bearer '+await new SignJWT({id:owner}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));
   if(body!==undefined)headers['Content-Type']='application/json';
   return runRequestContext(env,db,()=>service.handle(new Request('https://fixture.invalid/life/reports/brief-mail',{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)})));
  };
  for(const owner of [null,3]){const response=await send(owner);expect(response.status).toBe(403);expect(response.headers.get('cache-control')).toContain('no-store');}
  expect(await (await send(2)).json()).toMatchObject({ownerId:2,enabled:false});
  expect(await (await send(1)).json()).toMatchObject({ownerId:1,enabled:true,configured:false,paused:true});
  expect((await send(1,{enabled:true,baseRevision:1,allowNamedMail:true})).status).toBe(503);
  expect(await (await send(1,{enabled:false,baseRevision:1})).json()).toMatchObject({ownerId:1,enabled:false,saved:true,revision:2});
  expect((await send(1,{enabled:false,baseRevision:2,scopeVersion:1})).status).toBe(422);
 }finally{f.sqlite.close();}
});
