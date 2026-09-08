# Deploying to a VPS with Coolify

## The one thing that will bite you

This build stores everything in SQLite at `/data/bot.db`. Two consequences:

1. **Mount a volume at `/data`.** Without it the database lives in the container
   filesystem and is destroyed on every redeploy — every trade, setting and
   wallet gone, silently.
2. **Run exactly one replica.** SQLite is single-writer. Two containers pointed
   at the same file will corrupt it. Do not scale this service.

---

## 1. Create the application

In Coolify: **New Resource → Application → Public Repository** (or your private
fork with a deploy key).

- **Build Pack:** `Dockerfile`
- **Branch:** `mine`
- **Port:** `10000`

## 2. Add the persistent volume

**Storages → Add** — this is the step people skip.

| Field | Value |
|---|---|
| Name | `bot-data` |
| Destination Path | `/data` |

## 3. Set the domain

Coolify assigns a domain (or point your own at it). Whatever it ends up being,
it must also go into `PUBLIC_URL` below — Telegram delivers updates by webhook,
so a wrong value means the bot starts cleanly and then receives nothing at all.

Coolify terminates TLS for you, so the app itself only ever listens on plain
HTTP on port 10000.

## 4. Environment variables

Paste from [.env.example](.env.example). Minimum to boot:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
PUBLIC_URL=https://your-coolify-domain
DATABASE_URL=file:/data/bot.db
PORT=10000
```

`DATABASE_URL` **must** be the `/data` path, not the local `./data` default.

For live trading add `WALLET_PRIVATE_KEY`, `WALLET_ENCRYPTION_KEY`, and a real
RPC (`QUICKNODE_RPC_URL` or `HELIUS_API_KEY`). Demo mode needs none of these.

Leave `REDIS_URL` blank — it is only a cache now, and the bot logs that it is
running on SQLite alone.

## 5. Deploy

Migrations apply automatically on start (`prisma migrate deploy`, which only
applies committed migrations and never resets data).

A healthy first boot logs roughly:

```
SQLite ready — file:/data/bot.db (journal_mode=wal)
Redis not configured — using SQLite alone
Bot Live via Webhook on port 10000
Risk loop 1000ms | monitor loop 30000ms | mode DEMO
```

## 6. Verify before trusting it with money

In Telegram:

```
/test           bot responds
/mode           should say DEMO on a fresh install
/demo           simulated balance
/chart          renders (empty until trades close)
```

Then **leave it in demo for a few days.** Simulated fills carry realistic
slippage and fees, so the demo curve is a fair preview of live behaviour. Only
`/mode live` once you like what `/chart` shows.

---

## Backups

The volume is the only thing that matters — code is already mirrored to your
private backup repo.

```bash
# on the VPS
docker ps --filter "name=<service>" --format "{{.ID}}"
docker exec <container> sh -c "sqlite3 /data/bot.db '.backup /data/backup.db'"
docker cp <container>:/data/backup.db ./bot-$(date +%F).db
```

WAL mode means copying `bot.db` alone while running can miss recent commits —
use `.backup` as above, or copy `bot.db`, `bot.db-wal` and `bot.db-shm` together.

## Upgrading from the old Postgres build

There is no automatic migration. The old deploy wrote to Supabase/Postgres; this
one starts from an empty SQLite file. If you want the history carried across,
export the old `alert_history` and `bot_settings` tables to CSV and import them —
ask and I will write the importer.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Bot starts, never responds | `PUBLIC_URL` wrong, or domain not routing to port 10000 |
| `FATAL: no public URL set` | `PUBLIC_URL` unset — intentional, it refuses to guess |
| Data gone after redeploy | No volume mounted at `/data`, or `DATABASE_URL` not pointing there |
| Cards/charts are blank boxes | `assets/fonts/CardFont.ttf` missing from the image |
| `SQLITE_BUSY` in logs | More than one replica running — scale back to 1 |
| Nothing buys in live mode | No wallet loaded; check `/settings` |
