# Reliability hardening — 2026-10-30

## Scope and compatibility

Keep the current Blog/Life UI, hosting, account identities and API routes. No content cleanup, database replacement, IndexedDB reset or dependency major upgrade is included. Migration 0026 only adds a budget table, visit index and note revision column. Existing note, todo, RSS identity, reading and starred records remain in place. The deployment records a D1 Time Travel bookmark and compares original note fields in memory before and after migration; contents are never printed.

## Implemented controls

- **Private configuration:** copy `server.config.json` through signed S3 access into private D1 `info`, verify the private record, then remove the public legacy object before publishing. Subsequent reads and saves use D1. Migration errors stop publication. Secret updates use stdin rather than shell arguments.
- **RSS budget:** atomically reserve `24 × changed items + 16` units per batch in a durable UTC-day counter, shared by history, feeds and push. History stops at 25,000 reserved units; daily/push stop at 40,000, leaving feed headroom. Failed reservations remain reserved. This conservative envelope covers item/index/monitoring overhead; it is not an account-wide D1 usage meter or an availability guarantee for unrelated jobs. D1 free daily limits reset at 00:00 UTC (08:00 Beijing).
- **Scheduling:** one daily refresh at 00:17 UTC; history checks after successful daily sync and skips installation/import when all histories are complete. Code deployments no longer trigger history imports. Quota pauses stop retries and source fan-out.
- **Foreground preservation:** hard D1 quota failures return structured 503/Retry-After. The account-scoped local queue stays intact and pauses until reset. An RSS-only budget pause does not pause private-data writes.
- **Conflict acknowledgement:** `saved:false` never removes a queued note. Notes use an atomic revision comparison; conflicts show both versions and require a choice. The original local item is archived before resolution. IndexedDB writes are acknowledged only after transaction commit, with cross-tab queue serialization where Web Locks is available.
- **Public request cost:** article-list cache is memory-only, 60 seconds and 128 entries, with bounded pagination/type inputs. View recording has per-isolate burst deduplication plus its own durable 8,000-unit/day budget (8 units per record). Visit failures do not prevent article reads; historical counts remain, but repeated views can now be sampled rather than counted individually. SQL aggregation replaces loading full visits, notes and unread lists where applicable.
- **Request handling:** request-scoped JWT verification requires expiry and HS256, retains existing role checks and tokens. Upload authorization occurs before multipart parsing. Best-effort per-isolate burst limiting, declared body-size bound, no-referrer/nosniff headers and authenticated-response no-store are added. These are not a distributed WAF or a streaming body-size enforcement layer.
- **Backups:** format v2 includes scoped writing-tag options, while v1 encrypted imports remain supported.

## Future module contract

1. Keep authorization per request and owner scoping in every private query; do not cache identities globally.
2. Background ingestion uses the shared durable budget before writes. New indexes or larger batches require re-measuring D1 `meta.rows_written` and adjusting the reservation coefficient.
3. Preserve existing routes and fields; add optional version/base fields and capability gates for coordinated frontend releases.
4. Offline writes require idempotent server acknowledgement; conflicts remain queued until resolved. New entities extend the existing queue instead of adding another local database.
5. Additive migrations need a restore bookmark and preservation checks. Do not roll back to old public-config persistence: use a forward repair retaining private D1 config.

## Verification and limits

Automated coverage includes atomic budget competition/UTC reset, request identity isolation and JWT restrictions, private-copy-before-delete, bounded nonpersistent public cache, concurrent same-second note writes, rejection of false acknowledgements, quota batch stop, IndexedDB abort and v1 backup compatibility. Server/client/migrator types and Worker dry-run build are checked. Production acceptance results are recorded separately after publication.

The dependency advisories found during audit are **not all resolved** by this patch. Elysia/ORM/Markdown dependency upgrades still need isolated compatibility work. Also outstanding: stronger session isolation on a dedicated same-site domain, WebSub HMAC validation, distributed WAF/rate enforcement, restrictive frontend CSP with Markdown/media compatibility, request-global DI isolation, independent offsite backups and restore drills. These are separate work items; do not describe this release as a completed penetration test or a guarantee of zero vulnerabilities.

Official resource accounting: [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [limits](https://developers.cloudflare.com/d1/platform/limits/).
