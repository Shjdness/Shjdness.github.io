const endpoint = (process.env.RSS_SYNC_ENDPOINT || 'https://rin-server.1322589722.workers.dev').replace(/\/$/, '')
const token = process.env.RSS_SYNC_TOKEN
const rsshub = (process.env.RSSHUB_LOCAL_URL || 'http://127.0.0.1:1200').replace(/\/$/, '')

if (!token) throw new Error('RSS_SYNC_TOKEN is required')

const auth = { Authorization: `Bearer ${token}` }
const request = async (url, options = {}, timeoutMs = 45_000) => {
  const signal = AbortSignal.timeout(timeoutMs)
  const response = await fetch(url, { ...options, signal })
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`)
  return response
}

const sourceResponse = await request(`${endpoint}/rss/bridge/sources`, { headers: auth })
const { sources = [] } = await sourceResponse.json()
let cursor = 0
let succeeded = 0
let failed = 0
let skipped = 0

const configured = {
  bilibili: process.env.RSS_BILIBILI_CONFIGURED === 'true',
  x: process.env.RSS_X_CONFIGURED === 'true',
}

const missingConfiguration = (source) => {
  if (source.route.startsWith('/bilibili/') && !configured.bilibili) return '缺少 GitHub Secret：BILIBILI_COOKIE，GitHub 托管出口会被 Bilibili 412 拒绝'
  if (/^\/(?:twitter|x)\//.test(source.route) && !configured.x) return '缺少 GitHub Secret：TWITTER_AUTH_TOKEN，X 官方路由暂不抓取'
  return ''
}

const reportSourceError = async (source, message) => {
  try {
    await request(`${endpoint}/rss/bridge/error`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionId: source.id, error: message }),
    })
  } catch {
    // Keep the primary result visible in the workflow log.
  }
}

const syncOne = async (source) => {
  const unavailable = missingConfiguration(source)
  if (unavailable) {
    console.log(`SKIP ${source.title || source.id}: ${unavailable}`)
    skipped += 1
    await reportSourceError(source, unavailable)
    return
  }
  try {
    const feedResponse = await request(`${rsshub}${source.route}`, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json' } }, 90_000)
    const feed = await feedResponse.text()
    const result = await request(`${endpoint}/rss/bridge/ingest`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriptionId: source.id, feed }) }, 90_000)
    const summary = await result.json()
    console.log(`OK ${source.title || source.id}: +${summary.added}, ${summary.total} fetched`)
    succeeded += 1
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 400) : 'Unknown sync error'
    console.error(`FAIL ${source.title || source.id}: ${message}`)
    failed += 1
    await reportSourceError(source, message)
  }
}

const worker = async () => {
  while (cursor < sources.length) {
    const index = cursor++
    await syncOne(sources[index])
  }
}

await Promise.all(Array.from({ length: Math.min(3, sources.length) }, worker))
console.log(`RSSHub sync complete: ${succeeded} succeeded, ${skipped} skipped, ${failed} failed, ${sources.length} total`)
if (failed > 0 && succeeded === 0) process.exitCode = 1
