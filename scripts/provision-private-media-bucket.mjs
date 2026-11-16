import { checkPrivateMediaBucket, privateMediaBucketApi } from './private-media-bucket.mjs';

try {
    const api = privateMediaBucketApi({ ...process.env, PRIVATE_MEDIA_R2_BUCKET: 'rin-private-media' });
    try {
        await checkPrivateMediaBucket(api);
    } catch (error) {
        if (!error.confirmedMissing) throw error;
        try {
            await api.call('bucket creation', '', {
                method: 'POST',
                body: JSON.stringify({ name: api.bucket, storageClass: 'Standard' }),
            });
        } catch (createError) {
            if (createError.status === 401 || createError.status === 403) throw createError;
            console.log('Bucket creation was not confirmed. Checking once without repeating the request.');
        }
        await checkPrivateMediaBucket(api);
    }
    const objects = await api.call('empty bucket check', `${api.path}/objects?per_page=1`);
    if (!Array.isArray(objects.result) || objects.result.length !== 0 || objects.result_info?.is_truncated || objects.result_info?.cursor) {
        throw new Error('The dedicated bucket was not confirmed empty.');
    }
    console.log('Empty dedicated Standard R2 bucket verified with no public endpoints.');
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
