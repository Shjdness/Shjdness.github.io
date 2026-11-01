import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';

export interface Env {
    DB: D1Database;
    RIN_GITHUB_CLIENT_ID: string;
    RIN_GITHUB_CLIENT_SECRET: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    JWT_SECRET: string;
    /** Immutable GitHub numeric ID of the site owner. */
    OWNER_GITHUB_ID: string;
    FRONTEND_URL: string;
    S3_REGION: string,
    S3_ENDPOINT: string,
    S3_ACCESS_KEY_ID: string,
    S3_SECRET_ACCESS_KEY: string,
    S3_ACCESS_HOST: string,
    S3_BUCKET: string,
    S3_FOLDER: string,
    S3_CACHE_FOLDER: string,
    WEBHOOK_URL: string,
    S3_FORCE_PATH_STYLE: string,
    GUEST_ACCESS_CODE: string,
    /** Shared secret for the lightweight GitHub YouTube feed reconciler. */
    RSS_SYNC_TOKEN: string,
    /** Server-only. Never include this value in client configuration or logs. */
    DEEPSEEK_API_KEY?: string,
    /** Emergency external-side-effect kill switch. Signed outcomes still apply. */
    REPORT_OUTBOUND_PAUSED?: string,
    /** Optional server-only mail configuration. Missing/invalid values fail closed. */
    REPORT_MAIL_ENABLED?: string,
    REPORT_MAIL_VAULT_KEY?: string,
    REPORT_MAIL_PROVIDER?: string,
    REPORT_MAIL_PROVIDER_ID?: string,
    REPORT_MAIL_API_KEY?: string,
    REPORT_MAIL_FROM?: string,
    REPORT_MAIL_WEBHOOK_SECRET?: string,
}

export function db(env: Env) {
    return drizzle(env.DB);
}
export default db;
