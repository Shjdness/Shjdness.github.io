import Elysia, { t } from "elysia";
import { oauth2 } from "elysia-oauth2";
import type { DB } from "./_worker";
import type { Env } from "./db/db";
import { getDB, getEnv } from "./utils/di";
import jwt from "./utils/jwt";
import { authenticate } from "./utils/authentication";


export function setup() {
    const db: DB = getDB();
    const env: Env = getEnv();
    let gh_client_id = env.GITHUB_CLIENT_ID || env.RIN_GITHUB_CLIENT_ID;
    let gh_client_secret = env.GITHUB_CLIENT_SECRET || env.RIN_GITHUB_CLIENT_SECRET;
    let jwt_secret = env.JWT_SECRET;

    if (!gh_client_id || !gh_client_secret) {
        throw new Error('Please set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET');
    }
    if (!jwt_secret) {
        throw new Error('Please set JWT_SECRET');
    }
    const oauth = oauth2({
        GitHub: [
            gh_client_id,
            gh_client_secret
        ],
    })
    return new Elysia({ aot: false, name: 'setup' })
        .use(oauth)
        .use(
            jwt({
                aot: false,
                name: 'jwt',
                secret: jwt_secret,
                exp: '7d',
                schema: t.Object({
                    id: t.Integer(),
                })
            })
        )
        .derive({ as: 'global' }, ({request}) => authenticate(request,db,env))
}
