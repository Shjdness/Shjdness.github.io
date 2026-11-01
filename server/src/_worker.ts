import type {ScheduledController,ExecutionContext} from '@cloudflare/workers-types';
import {runReportSchedule} from './utils/report-jobs';
import {reportMailCallback,REPORT_MAIL_WEBHOOK_PATH} from './utils/report-mail-callback';
import {runConfiguredReportMail} from './utils/report-mail-schedule';
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

export default {
  async scheduled(_event:ScheduledController,env:Env,_context:ExecutionContext):Promise<void>{
    let failed=false;
    try{await runReportSchedule(env.DB);}catch{failed=true;}
    try{const mail=await runConfiguredReportMail(env);if(mail.failures)failed=true;}catch{failed=true;}
    if(failed)throw Error('Life report schedule unavailable');
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    if(new URL(request.url).pathname===REPORT_MAIL_WEBHOOK_PATH)return reportMailCallback(request,env);
    const db = drizzle(env.DB, { schema: schema });
    return runRequestContext(env,db,async()=>{
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
  },
};
