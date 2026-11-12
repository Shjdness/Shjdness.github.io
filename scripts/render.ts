import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import puppeteer from 'puppeteer';
import path from "node:path"

const env = process.env;
const baseUrl = env.SEO_BASE_URL || env.FRONTEND_URL || '';
const region = env.S3_REGION;
const endpoint = env.S3_ENDPOINT;
const accessKeyId = env.S3_ACCESS_KEY_ID;
const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
const accessHost = env.S3_ACCESS_HOST || endpoint;
const bucket = env.S3_BUCKET;
const folder = env.S3_CACHE_FOLDER || 'cache/';
const privateRoutes = new Set(['/blog/diary', '/blog/memos', '/blog/drafts', '/blog/writing']);
const forcePathStyle = env.S3_FORCE_PATH_STYLE === "true";
if (!baseUrl) {
    throw new Error('SEO_BASE_URL is not defined');
}
if (!region) {
    throw new Error('S3_REGION is not defined');
}
if (!endpoint) {
    throw new Error('S3_ENDPOINT is not defined');
}
if (!accessKeyId) {
    throw new Error('S3_ACCESS_KEY_ID is not defined');
}
if (!secretAccessKey) {
    throw new Error('S3_SECRET_ACCESS_KEY is not defined');
}
if (!bucket) {
    throw new Error('S3_BUCKET is not defined');
}
const origin = new URL(baseUrl).origin;
if (!origin.startsWith('https://')) throw new Error('SEO_BASE_URL must use HTTPS');

function publicPage(value: string): string | null {
    try {
        const url = new URL(value, origin);
        if (url.origin !== origin || url.username || url.password) return null;
        const route = decodeURIComponent(url.pathname).replace(/\/$/, '') || '/';
        const blogPage = /^\/blog(?:\/feed\/\d+|\/[a-zA-Z0-9_-]+)?$/.test(route);
        if (route !== '/' && (!blogPage || privateRoutes.has(route))) return null;
        url.hash = '';
        const page = url.searchParams.get('page');
        const isPagination = route === '/blog/articles' && page && /^\d{1,3}$/.test(page);
        url.search = isPagination ? `?page=${page}` : '';
        return url.href;
    } catch {
        return null;
    }
}

const s3 = new S3Client({
    region: region,
    endpoint: endpoint,
    forcePathStyle: forcePathStyle,
    credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey
    }
});

async function saveFile(filename: string, data: string) {
    // Save data to file
    console.log(`Saving ${filename}`);
    const url = new URL(filename)
    let fileName = path.join(folder, url.pathname + url.search.replace('?', '&'))
    if (fileName.endsWith('/')) {
        fileName += 'index.html';
    }
    try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: fileName, Body: data, ContentType: 'text/html' }))
        console.info(`Saved ${accessHost}/${fileName}.`)
    } catch (e: any) {
        console.error(e.message)
    }
}

const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const browserEnv = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'XDG_CACHE_HOME'].flatMap(key => env[key] ? [[key, env[key]]] : []),
);
const start = publicPage(baseUrl);
if (!start) throw new Error('SEO_BASE_URL must point to a public site route');
const browser = await puppeteer.launch({
    env: browserEnv,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

async function fetchPage(url: string) {
    console.log(`Fetching ${url}`);
    const page = await browser.newPage();
    try {
        await page.setUserAgent(ua);
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.isNavigationRequest() &&
                (request.frame() !== page.mainFrame() || publicPage(request.url()) !== request.url())) {
                void request.abort().catch(() => {});
            } else {
                void request.continue().catch(() => {});
            }
        });
        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 20_000 });
        if (!response?.ok() || !response.headers()['content-type']?.includes('text/html') ||
            publicPage(page.url()) !== page.url()) return [];
        await saveFile(url, await page.content());
        return await page.evaluate(() => Array.from(document.querySelectorAll('a'), anchor => anchor.href));
    } finally {
        await page.close();
    }
}

const pending = [start], seen = new Set(pending);
try {
    for (let index = 0; index < pending.length; index++) {
        const url = pending[index];
        try {
            for (const link of await fetchPage(url)) {
                const next = publicPage(link);
                if (!next || seen.has(next) || pending.length >= 250) continue;
                seen.add(next);
                pending.push(next);
            }
        } catch {
            if (index === 0) throw new Error('SEO entry page failed to render');
            console.warn(`Could not render ${url}`);
        }
    }
} finally {
    await browser.close();
}
