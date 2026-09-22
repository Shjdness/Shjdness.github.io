# Shjdness Site Architecture

This repository keeps the original Rin article engine and deploy pipeline, but
organises the product around three stable spaces:

```text
Home                     /
├── Blog                 /blog
│   ├── Articles         /blog
│   ├── Timeline         /blog/timeline
│   ├── Tags             /blog/tags
│   ├── Gallery          /blog/gallery
│   ├── Search           /blog/search/:keyword
│   ├── Writing          /blog/writing/:id?
│   └── Article          /blog/feed/:id or /blog/:alias
└── Life                 /life
    ├── Overview         /life
    ├── Habits           /life/habits
    ├── Calendar         /life/calendar and /life/year
    ├── Pomodoro         /life/pomodoro
    └── RSS              /life/rss
```

Legacy public URLs remain as redirects so existing browser bookmarks and old
article links keep working. New links must use the canonical routes above.

## Trust boundaries

- Home and published Blog content are public.
- Life is restricted to `owner` and `trusted` roles in both the client and the
  Worker.
- Habit, Pomodoro and RSS records always carry `owner_id`; every read and write
  filters by the authenticated user ID.
- A trusted account can therefore operate its own Life data but cannot mutate
  the owner's private records.

## Life data flow

The Worker exposes aggregate reads for screens that combine several modules:

```text
GET /life/overview  -> weekly habits + today's focus + recent RSS
GET /life/calendar  -> habit logs + Pomodoro sessions + RSS activity
GET /life/year      -> annual activity heatmap data
```

Module-specific mutations stay in `/habit`, `/pomodoro` and `/rss`. RSS read
and starred timestamps are the bridge between RSS and Calendar. Do not add a
second Calendar-owned copy of those events.

## Database migrations

SQL migrations live in `server/sql` and use monotonically increasing numeric
prefixes. A schema change must include both its Drizzle definition and a new
migration file. Never edit an already-deployed migration.

## Deployment order

When a change includes a new D1 migration, deploy the Worker first so the
database and API are ready, then publish the Pages frontend. Pure frontend
changes can use the Pages workflow alone.

## Next architectural layer

Offline behaviour should be added behind one shared client data layer rather
than separately inside every page: IndexedDB cache, pending mutation queue,
retry on reconnect, and last-sync status. This keeps the current cloud API as
the source of truth while avoiding future component-specific sync logic.
