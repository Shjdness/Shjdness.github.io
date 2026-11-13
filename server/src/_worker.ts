import type {ScheduledController,ExecutionContext} from '@cloudflare/workers-types';
import {runReportSchedule} from './utils/report-jobs';
import {optionalCheckinVault} from './utils/checkin-key-guard';
import {reportMailCallback,REPORT_MAIL_WEBHOOK_PATH,REPORT_MAIL_BREVO_WEBHOOK_PATH} from './utils/report-mail-callback';
import {runConfiguredReportMail} from './utils/report-mail-schedule';
import {runConfiguredReportAI} from './utils/report-ai-schedule';
import { drizzle, DrizzleD1Database } from "drizzle-orm/d1";
import { Elysia } from "elysia";
import "reflect-metadata";
import type { Env } from "./db/db";
import * as schema from "./db/schema";
import { app } from "./server";
import { ServerConfig } from "./utils/cache";
import {quotaResponse} from './utils/write-budget';
import {frontendOrigin} from './utils/frontend-origin';
import { runRequestContext } from "./utils/di";
import {limitRequestBody} from './utils/request-body';
export type DB = DrizzleD1Database<typeof import("./db/schema")>;

function protectResponseCache(request: Request, url: URL, response: Response): Response {
  // Match whole path segments so public routes with similar names keep their policy.
  const path = url.pathname.replace(/\/+$/, '');
  const privateRoute = /^\/(?:life|habit|pomodoro|rss|user|storage)(?:\/|$)/.test(path)
    || /^\/(?:config\/(?:server|cache)|tag\/options|feed\/(?:diary|memo|drafts))(?:\/|$)/.test(path)
    || (path === '/feed' && url.searchParams.getAll('type').includes('draft'))
    || (path === '/tag' && url.searchParams.getAll('kind').some(kind => kind === 'diary' || kind === 'memo'))
    || (path.startsWith('/feed/') && [401, 403, 404].includes(response.status));
  if (!privateRoute && !request.headers.has('authorization')) return response;

  const cache = response.headers.get('Cache-Control')?.split(',').map(value => value.trim().toLowerCase());
  if (cache?.includes('private') && cache.includes('no-store')) return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async scheduled(_event:ScheduledController,env:Env,_context:ExecutionContext):Promise<void>{
    let failed=false;
    try{await runReportSchedule(env.DB,new Date(),{checkins:await optionalCheckinVault(env)??undefined,waitForRss:true});}catch{failed=true;}
    try{const ai=await runConfiguredReportAI(env);if(ai.failures)failed=true;}catch{failed=true;}
    try{const mail=await runConfiguredReportMail(env);if(mail.failures)failed=true;}catch{failed=true;}
    if(failed)throw Error('Life report schedule unavailable');
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if([REPORT_MAIL_WEBHOOK_PATH,REPORT_MAIL_BREVO_WEBHOOK_PATH].includes(url.pathname))return reportMailCallback(request,env);
    const db = drizzle(env.DB, { schema: schema });
    const response = await runRequestContext(env,db,async()=>{
    try { await ServerConfig().all(); }
    catch(error) {
      const response=quotaResponse(error) || new Response('Private configuration initialization failed; retry later', {status:503,headers:{'Cache-Control':'no-store','Retry-After':'60'}});
      // Initialization precedes Elysia: preserve the same strict CORS boundary
      // so the frontend can recognize quota pauses instead of retrying blindly.
      if(request.headers.get('Origin')===frontendOrigin(env.FRONTEND_URL)) {
        response.headers.set('Access-Control-Allow-Origin',frontendOrigin(env.FRONTEND_URL));
        response.headers.set('Vary','Origin');
      }
      response.headers.set('X-Content-Type-Options','nosniff');
      return response;
    }
    return await new Elysia({ aot: false }).use(app()).handle(limitRequestBody(request,6*1024*1024));
    });
    return protectResponseCache(request, url, response);
  },
};
