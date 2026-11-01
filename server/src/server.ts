import cors from '@elysiajs/cors';
import { serverTiming } from '@elysiajs/server-timing';
import { Elysia } from 'elysia';
import { CommentService } from './services/comments';
import { FeedService } from './services/feed';
import { SEOService } from './services/seo';
import { StorageService } from './services/storage';
import { TagService } from './services/tag';
import { UserService } from './services/user';
import { ConfigService } from './services/config';
import { LifeService } from './services/life';
import { HabitService } from './services/habit';
import { RssService } from './services/rss';
import { PomodoroService } from './services/pomodoro';
import { LifeBackupService } from './services/life-backup';
import { LifeReportsService } from './services/life-reports';
import { ReportMailService } from './services/report-mail';
import { getEnv } from './utils/di';
import { frontendOrigin } from './utils/frontend-origin';
import { quotaResponse } from './utils/write-budget';
import { allowBurst } from './utils/rate-limit';
import { authenticate } from './utils/authentication';
import {getDB} from './utils/di';
import {hasBodyLimitError} from './utils/request-body';

export const app = () => new Elysia({ aot: false })
    .onRequest(async({request,set})=>{
        set.headers['X-Content-Type-Options']='nosniff';
        set.headers['Referrer-Policy']='no-referrer';
        if(request.headers.has('authorization'))set.headers['Cache-Control']='private, no-store';
        const ip=request.headers.get('cf-connecting-ip') || 'unknown';
        if(!allowBurst(ip)) {set.status=429;set.headers['Retry-After']='60';return '请求过于频繁，请稍后重试';}
        if(Number(request.headers.get('content-length')||0)>6*1024*1024) {set.status=413;return 'Request body is too large';}
        if(request.method==='POST'&&new URL(request.url).pathname.replace(/\/$/,'')==='/storage') {
            const identity=await authenticate(request,getDB(),getEnv());
            if(!identity.writer) {set.status=401;return 'Unauthorized';}
        }
    })
    .use(cors({
        aot: false,
        origin: (request) => request.headers.get('Origin') === frontendOrigin(getEnv().FRONTEND_URL),
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowedHeaders: [
            'authorization',
            'content-type'
        ],
        maxAge: 600,
        credentials: false,
        preflight: true
    }))
    .use(serverTiming({
        enabled: true,
    }))
    .use(UserService())
    .use(FeedService())
    .use(CommentService())
    .use(TagService())
    .use(StorageService())
    .use(SEOService())
    .use(ConfigService())
    .use(LifeService())
    .use(HabitService())
    .use(RssService())
    .use(PomodoroService())
    .use(LifeBackupService())
    .use(LifeReportsService())
    .use(ReportMailService())
    .get('/reliability/capabilities',()=>({version:2,backgroundBudget:true,conflictAcknowledgement:true,privateServerConfig:true,signedWebsub:true,requestIsolation:true,streamingBodyLimit:true,transactionalBackup:true,idempotentLifeCreates:true,wrappedQuotaErrors:true,guardedSeoSnapshots:true,durableGuestGuard:true,isolatedNotifications:true,atomicPostUpdates:true,atomicPostCreates:true,idempotentPostCreates:true,atomicTagCreation:true,conditionalDraftDelete:true,lifeReportsPreview:true,lifeReportsHistory:true,reportBackupV3:true,reportAIResults:true,reportBackupV4:true,reportSchedule:true}))
    .get('/', () => `Hi`)
    .onError(({ path, params, code, error, set }) => {
        if(hasBodyLimitError(error))return new Response('Request body is too large',{status:413,headers:{'Cache-Control':'no-store'}});
        const quota=quotaResponse(error);if(quota)return quota;
        if (code === 'NOT_FOUND')
            return `${path} ${JSON.stringify(params)} not found`
        if(code==='VALIDATION'||code==='PARSE'||code==='INVALID_COOKIE_SIGNATURE')return;
        set.status=500;
        return '服务暂时不可用，请稍后重试';
    })

export type App = ReturnType<typeof app>;
