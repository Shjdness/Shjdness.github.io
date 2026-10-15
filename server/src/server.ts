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
import { AppearanceService } from './services/appearance';
import { LifeService } from './services/life';
import { HabitService } from './services/habit';
import { RssService } from './services/rss';
import { PomodoroService } from './services/pomodoro';
import { LifeBackupService } from './services/life-backup';
import { getEnv } from './utils/di';
import { frontendOrigin } from './utils/frontend-origin';

export const app = () => new Elysia({ aot: false })
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
    .use(AppearanceService())
    .use(LifeService())
    .use(HabitService())
    .use(RssService())
    .use(PomodoroService())
    .use(LifeBackupService())
    .get('/', () => `Hi`)
    .onError(({ path, params, code }) => {
        if (code === 'NOT_FOUND')
            return `${path} ${JSON.stringify(params)} not found`
    })

export type App = ReturnType<typeof app>;
