const endpoint = (
  process.env.RSS_SYNC_ENDPOINT ||
  "https://rin-server.1322589722.workers.dev"
).replace(/\/$/, "");
const token = process.env.RSS_SYNC_TOKEN;

if (!token) throw new Error("RSS_SYNC_TOKEN is required");

const auth = { Authorization: `Bearer ${token}` };
const request = async (url, options = {}, timeoutMs = 45_000) => {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`${response.status} ${await response.text()}`);
  return response;
};

const fetchFeed = async (source) => {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(source.feedUrl, {
      headers: { Accept: "application/atom+xml", "User-Agent": "Mozilla/5.0", ...(source.etag ? {'If-None-Match':source.etag} : {}), ...(source.lastModified ? {'If-Modified-Since':source.lastModified} : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 304) return {feed:'',notModified:true};
    if (response.ok) return {feed:await response.text(),etag:response.headers.get('etag') || '',lastModified:response.headers.get('last-modified') || ''};
    lastStatus = response.status;
    await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  throw new Error(`YouTube returned ${lastStatus || "a network error"}`);
};

const sourceResponse = await request(`${endpoint}/rss/sync/sources`, {
  headers: auth,
});
const { sources = [] } = await sourceResponse.json();
let cursor = 0;
let succeeded = 0;
let failed = 0;

const syncOne = async (source) => {
  try {
    const feed = await fetchFeed(source);
    const response = await request(
      `${endpoint}/rss/sync/ingest`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptionId: source.id, ...feed }),
      },
      60_000,
    );
    const result = await response.json();
    console.log(`OK source=${source.id}: added=${result.added || 0}, updated=${result.updated || 0}, unchanged=${result.unchanged || 0}, rowsWritten=${result.rowsWritten || 0}`);
    succeeded += 1;
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 400) : "Unknown error";
    console.error(`FAIL ${source.title || source.id}: ${message}`);
    failed += 1;
    try {
      await request(`${endpoint}/rss/sync/error`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ subscriptionId: source.id, error: message }),
      });
    } catch {
      // Keep the primary error visible in the workflow log.
    }
  }
};

const worker = async () => {
  while (cursor < sources.length) await syncOne(sources[cursor++]);
};

await Promise.all(Array.from({ length: Math.min(3, sources.length) }, worker));
console.log(
  `YouTube sync complete: ${succeeded} succeeded, ${failed} failed, ${sources.length} total`,
);
if (sources.length > 0 && succeeded === 0) process.exitCode = 1;
