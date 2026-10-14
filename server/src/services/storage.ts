import { PutObjectCommand } from "@aws-sdk/client-s3";
import Elysia, { t } from "elysia";
import path from "node:path";
import type { Env } from "../db/db";
import { setup } from "../setup";
import { getEnv } from "../utils/di";
import { createS3Client } from "../utils/s3";
import { imageFormat } from "../utils/image-format";

function buf2hex(buffer: ArrayBuffer) {
    return [...new Uint8Array(buffer)]
        .map(x => x.toString(16).padStart(2, '0'))
        .join('');
}

export function StorageService() {
    const env: Env = getEnv();
    const endpoint = env.S3_ENDPOINT;
    const bucket = env.S3_BUCKET;
    const folder = env.S3_FOLDER || '';
    const accessHost = env.S3_ACCESS_HOST || endpoint;
    const accessKeyId = env.S3_ACCESS_KEY_ID;
    const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
    const s3 = createS3Client();
    return new Elysia({ aot: false })
        .use(setup())
        .group('/storage', (group) =>
            group
                .post('/', async ({ uid, writer, set, body: { file } }) => {

                    if (!endpoint) {
                        set.status = 500;
                        return 'S3_ENDPOINT is not defined'
                    }
                    if (!accessKeyId) {
                        set.status = 500;
                        return 'S3_ACCESS_KEY_ID is not defined'
                    }
                    if (!secretAccessKey) {
                        set.status = 500;
                        return 'S3_SECRET_ACCESS_KEY is not defined'
                    }
                    if (!bucket) {
                        set.status = 500;
                        return 'S3_BUCKET is not defined'
                    }
                    if (!uid || !writer) {
                        set.status = 401;
                        return 'Unauthorized';
                    }
                    if (file.size > 5 * 1024 * 1024) {
                        set.status = 413;
                        return 'Image size must not exceed 5 MB';
                    }
                    const bytes = await file.arrayBuffer();
                    const format = imageFormat(new Uint8Array(bytes));
                    if (!format) {
                        set.status = 400;
                        return 'Unsupported image format';
                    }
                    const hashArray = await crypto.subtle.digest(
                        { name: 'SHA-256' },
                        bytes
                    );
                    const hash = buf2hex(hashArray)
                    const hashkey = path.join(folder, hash + "." + format.extension);
                    try {
                        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: hashkey, Body: new Uint8Array(bytes), ContentType: format.contentType }))
                        return `${accessHost}/${hashkey}`
                    } catch (e: any) {
                        set.status = 502;
                        console.error(e.message)
                        return 'Image storage is unavailable'
                    }
                }, {
                    body: t.Object({
                        key: t.String(),
                        file: t.File()
                    })
                })
        );
}
