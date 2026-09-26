# Private RSSHub deployment

This stack runs RSSHub and a bounded Redis cache. RSSHub only listens on
`127.0.0.1:1200`; publish it through HTTPS with Caddy, Nginx or a Cloudflare
Tunnel. Do not expose port 1200 directly.

## Deploy

1. Copy this directory to the server.
2. Copy `.env.example` to `.env` and set a long random `RSSHUB_ACCESS_KEY`.
3. Add platform credentials only when the corresponding route needs them.
4. Start with `docker compose up -d` and check `docker compose ps`.
5. Put an HTTPS hostname in front of `http://127.0.0.1:1200`.
6. Set the Worker secret `RSSHUB_ACCESS_KEY` to the same value and set
   `RSSHUB_BASE_URL` to the HTTPS origin, without a trailing slash.

The browser never receives the access key. Only the Cloudflare Worker calls
RSSHub, and it appends the key server-side.

## Verify before switching production

Test the health endpoint and the routes used by this site:

```text
/healthz?key=...
/bilibili/user/video/53456?key=...
/pixiv/user/882569?key=...
/twitter/user/<username>?key=...
```

The last three routes may need the optional credentials in `.env`. A 401/403
from the upstream platform is not fixed by retrying; add or refresh that
platform's credential and restart RSSHub.

Once verified, pin `RSSHUB_IMAGE` to the tested image digest. Keep Redis as a
cache only: articles and media metadata are persisted in Cloudflare D1, while
images and videos remain at their original hosts. This keeps disk and traffic
use small.

## Updating

Update deliberately: back up `.env`, pull the chosen image, start the stack,
then verify all four test routes before changing the pinned digest. The compose
file caps logs and Redis memory to prevent quiet disk or memory growth.

