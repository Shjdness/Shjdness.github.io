import 'reflect-metadata';
import {expect,it} from 'vitest';
import {drizzle} from 'drizzle-orm/d1';
import {SignJWT} from 'jose';
import * as schema from '../db/schema';
import {runRequestContext} from './di';
import {LifeReportsService} from '../services/life-reports';
import {mailFixture} from './report-mail-fixture';
it('isolates selected AI settings, requires new consent and permits withdrawal without keys or outbound access',async()=>{
 const f=await mailFixture();try{
  const db=drizzle(f.raw,{schema}),env={DB:f.raw,JWT_SECRET:'selected-ai-fixture-auth-key-32chars',DEEPSEEK_API_KEY:'mock-only',LIFE_CHECKIN_KEY:btoa(String.fromCharCode(...Array.from({length:32},(_,i)=>i+53))),RIN_GITHUB_CLIENT_ID:'fixture',RIN_GITHUB_CLIENT_SECRET:'fixture'} as any;
  const service=runRequestContext(env,db,()=>LifeReportsService());
  const request=async(owner:number|null,body?:unknown)=>{
   const headers:Record<string,string>={};if(owner)headers.Authorization='Bearer '+await new SignJWT({id:owner}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(new TextEncoder().encode(env.JWT_SECRET));if(body!==undefined)headers['Content-Type']='application/json';
   return runRequestContext(env,db,()=>service.handle(new Request('https://fixture.invalid/life/reports/selected-ai',{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)})));
  };
  for(const owner of [null,3]){const response=await request(owner);expect(response.status).toBe(403);expect(response.headers.get('cache-control')).toContain('no-store');}
  const initial=await request(1);expect(await initial.json()).toMatchObject({scope:'selected',scopeVersion:2,enabled:false,revision:0,configured:true,monthlyBudgetFen:1000});expect(initial.headers.get('cache-control')).toContain('no-store');
  expect((await request(1,{enabled:true,baseRevision:0})).status).toBe(409);
  expect((await request(1,{enabled:true,baseRevision:0,allowNumericAnalysis:true})).status).toBe(422);
  expect(await (await request(1,{enabled:true,baseRevision:0,allowSelectedAnalysis:true})).json()).toMatchObject({saved:true,enabled:true,revision:1});
  expect(await (await request(2)).json()).toMatchObject({enabled:false,revision:0});
  expect(f.sqlite.prepare('SELECT count(*) n FROM life_report_ai_reservations').get().n).toBe(0);expect(f.sqlite.prepare('SELECT ai_enabled FROM life_report_preferences').get().ai_enabled).toBe(0);
  delete env.LIFE_CHECKIN_KEY;delete env.DEEPSEEK_API_KEY;env.REPORT_OUTBOUND_PAUSED='true';
  expect((await request(1,{enabled:true,baseRevision:1,allowSelectedAnalysis:true})).status).toBe(503);
  expect(await (await request(1,{enabled:false,baseRevision:1})).json()).toMatchObject({saved:true,enabled:false,revision:2});
  expect((await request(1,{enabled:false,baseRevision:0})).status).toBe(409);
 }finally{f.sqlite.close();}
});
