import { eq } from 'drizzle-orm';
import Elysia, { t } from 'elysia';
import type { DB } from '../_worker';
import { appearancePreferences } from '../db/schema';
import { setup } from '../setup';
import { ClientConfig } from '../utils/cache';
import { getDB } from '../utils/di';

export type AppearanceSettings = {
    backgroundBlur: number;
    backgroundBrightness: number;
    backgroundSaturation: number;
    glassOpacity: number;
    glassBlur: number;
};

export const defaultAppearance: AppearanceSettings = {
    backgroundBlur: 2,
    backgroundBrightness: 1,
    backgroundSaturation: 1,
    glassOpacity: 0.5,
    glassBlur: 18,
};

const appearanceBody = t.Object({
    backgroundBlur: t.Number({ minimum: 0, maximum: 16 }),
    backgroundBrightness: t.Number({ minimum: 0.55, maximum: 1.45 }),
    backgroundSaturation: t.Number({ minimum: 0.5, maximum: 1.8 }),
    glassOpacity: t.Number({ minimum: 0.12, maximum: 0.9 }),
    glassBlur: t.Number({ minimum: 0, maximum: 36 }),
});

function clamp(value: unknown, minimum: number, maximum: number, fallback: number) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(minimum, value));
}

/** Safely read older cache values as well as new settings submitted by the UI. */
export function normalizeAppearance(value: unknown): AppearanceSettings {
    const source = value && typeof value === 'object' ? value as Partial<AppearanceSettings> : {};
    return {
        backgroundBlur: clamp(source.backgroundBlur, 0, 16, defaultAppearance.backgroundBlur),
        backgroundBrightness: clamp(source.backgroundBrightness, 0.55, 1.45, defaultAppearance.backgroundBrightness),
        backgroundSaturation: clamp(source.backgroundSaturation, 0.5, 1.8, defaultAppearance.backgroundSaturation),
        glassOpacity: clamp(source.glassOpacity, 0.12, 0.9, defaultAppearance.glassOpacity),
        glassBlur: clamp(source.glassBlur, 0, 36, defaultAppearance.glassBlur),
    };
}

function parseStoredAppearance(value: string) {
    try {
        return normalizeAppearance(JSON.parse(value));
    } catch {
        return null;
    }
}

function userId(uid: string | number | undefined) {
    return typeof uid === 'number' ? uid : Number.parseInt(uid || '', 10);
}

export function AppearanceService() {
    const db: DB = getDB();
    return new Elysia({ aot: false })
        .use(setup())
        .group('/appearance', group => group
            .get('/default', async () => {
                const configured = await ClientConfig().get('appearance.default');
                return { settings: normalizeAppearance(configured) };
            })
            .put('/default', async ({ admin, body, set }) => {
                if (!admin) {
                    set.status = 403;
                    return 'Permission denied';
                }
                const settings = normalizeAppearance(body);
                const config = ClientConfig();
                await config.set('appearance.default', settings, false);
                await config.save();
                return { settings };
            }, { body: appearanceBody })
            .get('/', async ({ uid, set }) => {
                const id = userId(uid);
                if (!id) {
                    set.status = 403;
                    return 'Permission denied';
                }
                const preference = await db.query.appearancePreferences.findFirst({
                    where: eq(appearancePreferences.userId, id),
                });
                return { settings: preference ? parseStoredAppearance(preference.settings) : null };
            })
            .put('/', async ({ uid, body, set }) => {
                const id = userId(uid);
                if (!id) {
                    set.status = 403;
                    return 'Permission denied';
                }
                const settings = normalizeAppearance(body);
                const serialized = JSON.stringify(settings);
                await db.insert(appearancePreferences).values({
                    userId: id,
                    settings: serialized,
                    updatedAt: new Date(),
                }).onConflictDoUpdate({
                    target: appearancePreferences.userId,
                    set: { settings: serialized, updatedAt: new Date() },
                });
                return { settings };
            }, { body: appearanceBody })
            .delete('/', async ({ uid, set }) => {
                const id = userId(uid);
                if (!id) {
                    set.status = 403;
                    return 'Permission denied';
                }
                await db.delete(appearancePreferences).where(eq(appearancePreferences.userId, id));
                return 'OK';
            })
        );
}
