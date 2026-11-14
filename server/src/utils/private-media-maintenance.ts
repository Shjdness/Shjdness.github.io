import type { Env } from '../db/db';

export const privateMediaWritesPaused = (env: Pick<Env, 'PRIVATE_MEDIA_WRITES_PAUSED'>) =>
    env.PRIVATE_MEDIA_WRITES_PAUSED !== 'false';

export const privateMediaPaused = {
    code: 'PRIVATE_MEDIA_WRITES_PAUSED',
    message: '私密图片写入暂时暂停，请保留本地草稿并稍后重试',
} as const;
