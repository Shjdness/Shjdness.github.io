import { eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import type { DB } from "../_worker";
import { info, users } from "../db/schema";
import { setup } from "../setup";
import { getDB, getEnv } from "../utils/di";
import { roleForUser } from "../utils/roles";
import { frontendOrigin } from "../utils/frontend-origin";

const GUEST_OPENID = "guest:beiruoxi";
const GUEST_NAME = "悲若兮";
const GUEST_AVATAR = "/guest-avatar.jpg";
const MAX_GUEST_ATTEMPTS = 5;
const GUEST_LOCK_MS = 15 * 60 * 1000;

async function digest(value: string) {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function secureEqual(left: string, right: string) {
    const [leftHash, rightHash] = await Promise.all([digest(left), digest(right)]);
    let difference = 0;
    for (let index = 0; index < leftHash.length; index++) {
        difference |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
    }
    return difference === 0;
}

export function UserService() {
    const db: DB = getDB();
    const env = getEnv();
    const ownerGithubId = env.OWNER_GITHUB_ID;
    const redirectOrigin = frontendOrigin(env.FRONTEND_URL);
    return new Elysia({ aot: false })
        .use(setup())
        .group('/user', (group) =>
            group
                .get("/github", ({ oauth2 }) =>
                    oauth2.redirect("GitHub", { scopes: ["read:user"] }))
                .get("/github/callback", async ({ jwt, oauth2, set }) => {

                    const gh_token = await oauth2.authorize("GitHub");
                    // request https://api.github.com/user for user info
                    const response = await fetch("https://api.github.com/user", {
                        headers: {
                            Authorization: `Bearer ${gh_token.accessToken}`,
                            Accept: "application/json",
                            "User-Agent": "elysia"
                        },
                    });
                    if (!response.ok) throw new Error("GitHub profile lookup failed");
                    const user: any = await response.json();
                    if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error("Invalid GitHub profile ID");
                    const profile: {
                        openid: string;
                        username: string;
                        avatar: string;
                        permission: number | null;
                    } = {
                        openid: String(user.id),
                        username: user.name || user.login,
                        avatar: user.avatar_url,
                        permission: 0
                    };
                    // GitHub's numeric ID is stable, unlike a display name. Updating
                    // this record on sign-in also repairs an owner whose legacy row
                    // was previously created with reader permissions.
                    const isOwner = Boolean(ownerGithubId) && profile.openid === ownerGithubId;
                    let issuedToken = "";
                    // Earlier deployments passed GitHub's numeric ID into a TEXT
                    // column. D1 stored those values as e.g. "121328491.0".
                    // Prefer that original account when both spellings exist so
                    // its feeds and Life records remain attached to the login.
                    const legacyOpenid = `${profile.openid}.0`;
                    const [legacyUser, canonicalUser] = await Promise.all([
                        db.query.users.findFirst({ where: eq(users.openid, legacyOpenid) }),
                        db.query.users.findFirst({ where: eq(users.openid, profile.openid) }),
                    ]);
                    const existingUser = legacyUser || canonicalUser;
                    if (existingUser) {
                        profile.permission = isOwner ? 1 : existingUser.permission;
                        // Do not create a second canonical openid while an
                        // already split account is being repaired.
                        const keepLegacyOpenid = legacyUser && canonicalUser && legacyUser.id !== canonicalUser.id;
                        await db.update(users).set({ ...profile, openid: keepLegacyOpenid ? legacyOpenid : profile.openid }).where(eq(users.id, existingUser.id));
                        issuedToken = await jwt.sign({ id: existingUser.id });
                    } else {
                        if (isOwner) profile.permission = 1;
                        const result = await db.insert(users).values(profile).returning({ insertedId: users.id });
                        if (!result?.length) throw new Error('Failed to register');
                        issuedToken = await jwt.sign({ id: result[0].insertedId });
                    }
                    const redirect_url = `${redirectOrigin}/callback#token=${encodeURIComponent(issuedToken)}`;
                    set.headers = {
                        'Cache-Control': 'no-store',
                        'Referrer-Policy': 'no-referrer',
                    }
                    set.redirect = redirect_url
                }, {
                    query: t.Object({
                        state: t.String(),
                        code: t.String(),
                        // GitHub includes its authorization-server issuer in
                        // GitHub may include its authorization-server issuer in
                        // the callback; accept the standards-based parameter.
                        iss: t.Optional(t.String()),
                    })
                })
                .post('/guest', async ({ jwt, set, headers, body: { code } }) => {
                    const configuredCode = env.GUEST_ACCESS_CODE;
                    if (!configuredCode) {
                        set.status = 503;
                        return 'Guest access is not configured';
                    }

                    const ip = headers['cf-connecting-ip'] || headers['x-real-ip'] || 'unknown';
                    const rateKey = `guest_login:${await digest(ip)}`;
                    const attemptRecord = await db.query.info.findFirst({ where: eq(info.key, rateKey) });
                    const attempt = attemptRecord ? JSON.parse(attemptRecord.value) as { failures: number; lastAttempt: number } : { failures: 0, lastAttempt: 0 };
                    const now = Date.now();

                    if (attempt.failures >= MAX_GUEST_ATTEMPTS && now - attempt.lastAttempt < GUEST_LOCK_MS) {
                        set.status = 429;
                        return 'Too many attempts. Try again later';
                    }

                    if (!await secureEqual(code, configuredCode)) {
                        const value = JSON.stringify({
                            failures: now - attempt.lastAttempt >= GUEST_LOCK_MS ? 1 : attempt.failures + 1,
                            lastAttempt: now,
                        });
                        await db.insert(info).values({ key: rateKey, value }).onConflictDoUpdate({
                            target: info.key,
                            set: { value },
                        });
                        set.status = 401;
                        return 'Invalid access code';
                    }

                    await db.delete(info).where(eq(info.key, rateKey));
                    let guest = await db.query.users.findFirst({ where: eq(users.openid, GUEST_OPENID) });
                    if (!guest) {
                        const inserted = await db.insert(users).values({
                            openid: GUEST_OPENID,
                            username: GUEST_NAME,
                            avatar: GUEST_AVATAR,
                            permission: 2,
                        }).returning({ insertedId: users.id });
                        guest = await db.query.users.findFirst({ where: eq(users.id, inserted[0].insertedId) });
                    } else if (guest.permission !== 2 || guest.username !== GUEST_NAME || guest.avatar !== GUEST_AVATAR || guest.accessExpiresAt !== null) {
                        await db.update(users).set({
                            username: GUEST_NAME,
                            avatar: GUEST_AVATAR,
                            permission: 2,
                            accessExpiresAt: null,
                            updatedAt: new Date(),
                        }).where(eq(users.id, guest.id));
                    }

                    if (!guest) {
                        set.status = 500;
                        return 'Failed to prepare guest account';
                    }

                    return {
                        token: await jwt.sign({ id: guest.id }),
                        expiresIn: 60 * 60 * 24 * 7,
                    };
                }, {
                    body: t.Object({
                        code: t.String({ minLength: 1, maxLength: 128 }),
                    })
                })
                .get('/profile', async ({ set, uid }) => {
                    if (!uid) {
                        set.status = 403
                        return 'Permission denied'
                    }
                    const uid_num = uid
                    const user = await db.query.users.findFirst({ where: eq(users.id, uid_num) })
                    if (!user) {
                        set.status = 404
                        return 'User not found'
                    }
                    return {
                        id: user.id,
                        username: user.username,
                        avatar: user.avatar,
                        permission: user.permission === 1,
                        canWrite: roleForUser(user) === 'owner' || roleForUser(user) === 'trusted',
                        role: roleForUser(user),
                        createdAt: user.createdAt,
                        updatedAt: user.updatedAt,
                    }
                })
        )
}
