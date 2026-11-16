import { pathToFileURL } from 'node:url';

export function privateMediaBucketApi(env, request = fetch) {
    const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token,
        PRIVATE_MEDIA_R2_BUCKET: bucket, S3_BUCKET: publicBucket } = env;
    if (!/^[0-9a-f]{32}$/i.test(account ?? '') || !token) {
        throw new Error('Cloudflare deployment credentials are unavailable.');
    }
    const bucketName = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
    if (!bucketName.test(bucket ?? '') || !bucketName.test(publicBucket ?? '') || bucket === publicBucket) {
        throw new Error('Private media needs a valid R2 bucket distinct from the existing public bucket.');
    }
    const base = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets`;

    async function call(step, path, options = {}) {
        let response;
        let body;
        try {
            response = await request(base + path, {
                ...options,
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                    'cf-r2-jurisdiction': 'default',
                },
                redirect: 'error',
                signal: AbortSignal.timeout(12_000),
            });
            body = await response.json();
        } catch {
            throw new Error(`Cloudflare R2 ${step} returned no usable response.`);
        }
        if (response.ok && body?.success === true) return body;
        const codes = Array.isArray(body?.errors) ? body.errors.map(error => error?.code) : [];
        const code = codes.length === 1 && Number.isSafeInteger(codes[0]) ? codes[0] : undefined;
        throw Object.assign(new Error(`Cloudflare R2 ${step} failed (HTTP ${response.status}${code ? `, code ${code}` : ''}).`), {
            status: response.status,
            code,
            confirmedMissing: response.status === 404 && body?.success === false && code === 10006,
        });
    }

    return { bucket, path: `/${bucket}`, call };
}

export async function checkPrivateMediaBucket({ bucket, path, call }) {
    const { result } = await call('bucket lookup', path);
    if (result?.name !== bucket || result.storage_class !== 'Standard') {
        throw new Error('Private media bucket is not the expected Standard R2 bucket.');
    }
    const [managed, custom] = await Promise.all([
        call('managed domain lookup', `${path}/domains/managed`),
        call('custom domain lookup', `${path}/domains/custom`),
    ]);
    if (managed.result?.enabled !== false || !Array.isArray(custom.result?.domains) || custom.result.domains.length !== 0) {
        throw new Error('Private media requires r2.dev disabled and no custom domains.');
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        await checkPrivateMediaBucket(privateMediaBucketApi(process.env));
        console.log('Dedicated Standard R2 bucket verified with no public endpoints.');
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
