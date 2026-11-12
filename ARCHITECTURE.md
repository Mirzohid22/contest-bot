# Contest Bot — Architecture and Build Plan

Referral-contest Telegram bot: sponsor-channel gate → personal invite link → N verified invites → access to a private prize channel. Target: 10,000+ users arriving within minutes of launch, on one Hetzner VPS (2 vCPU, 4 GB RAM, 40 GB disk).

Telegram facts in this document were checked against core.telegram.org (Bot API 10.4, November 2026). Numbers marked *undocumented* are starting guesses to be measured, not facts.

---

## 1. Decisions

| Area | Decision | Why |
|---|---|---|
| Language | **TypeScript** on Node.js (current LTS) | The owner already works in TypeScript and can read, debug, and maintain it; one language for the bot and the admin UI. The workload is I/O-bound, which Node handles well. See 1.1. |
| Database | **PostgreSQL 17** | Transactions make referral credit exactly-once; handles this load with large margin. |
| Cache / broker | **None** (no Redis, no message queue) | One process on one box. In-process limiter and queues; Postgres for the few things that must survive a restart. |
| Update transport | **Long polling** (`getUpdates`), webhook behind a config flag | At-least-once delivery for free, Telegram buffers the backlog for 24 h, no public endpoint for the bot. See 4.1. |
| Membership checks | **Push first** (`chat_member` updates into a local table), `getChatMember` only as fallback | Turns the worst API bottleneck into a local DB lookup. See 6. |
| Prize channel access | **One join-request invite link per contest**; bot approves or declines each request | Link can be shared freely and is useless to non-qualified users; no per-user link creation. See 5.4. |
| Contest reset | **Scope by `contest_id`**, never delete | "Reset" = new contest row. Old data stays intact and cannot collide. See 7. |
| Admin panel | Fastify JSON API + small React SPA served by the same process | One deployable. Login through the bot, no passwords. See 9. |
| Reuse for other clients | **One stack per client** (own bot token, own database, same image) | Zero tenancy code, full isolation, per-bot rate limits stay separate. See 10. |
| Deployment | Docker Compose: `app` and `postgres`; image built by GitHub Actions and pulled from GHCR | Reproducible on any client VPS, and nothing is compiled on the server. |

### 1.1 Why TypeScript, and what it costs

Raw language speed is not what decides whether this bot survives 10K users: the server-side work per update is a few milliseconds of DB access, and the ceiling is Telegram's rate limits (section 2). TypeScript is chosen because the owner can maintain it. Go was the alternative; it would give more headroom, not a different outcome.

What Node costs compared with Go, and how the design absorbs it:

- **One thread runs all handlers.** Node uses one core for JavaScript; Postgres gets the other. Estimated ceiling is about 1,000 updates/s, which is roughly the worst-minute peak in section 3. Beyond it Telegram holds the backlog, and since replies are capped at ~30/s anyway, users see no difference. Phase 6 measures the real number.
- **Never block the event loop.** No synchronous CPU work in the bot process: stream CSV exports, paginate admin queries, no sync crypto or large `JSON.stringify` in hot paths.
- **Exactly one process.** No `cluster`, no PM2 multi-instance, no second replica. The limiter and the poll loop are in-memory and must be single; Telegram also rejects two pollers on one token (409 Conflict).
- **Memory** is about 150–250 MB instead of ~50 MB. Fine on 4 GB; cap the heap with `--max-old-space-size=512`.

Libraries:

- **grammY** — typed Bot API client, update routing, and a `client.apiRoot` override for tests. Use it for types, `bot.api`, and `bot.handleUpdate`. Do **not** add `@grammyjs/runner`, `@grammyjs/auto-retry`, or the throttler plugin: the poll loop (4.1) and the lanes (4.2) replace them.
- **`pg` + Kysely** — parameterised SQL without an ORM, and transactions. Migrations are plain `.sql` files applied in order by a small runner in `src/db/index.ts`.
- **Fastify** — admin API and static files for the React admin.
- **zod** (config and admin input validation), **pino** (logs), **prom-client** (metrics), **vitest** (tests).

Before starting, confirm the installed grammY version exposes every method in section 5.5.

---

## 2. What actually limits this system

| Constraint | Value | Source |
|---|---|---|
| Broadcast rate | about 30 messages/second per bot | documented |
| Per chat | 1 message/second, short bursts tolerated | documented |
| Over the limit | HTTP 429 with a retry delay | documented |
| Paid broadcast (1000 msg/s, 0.1 Star each) | needs 100,000 Stars balance **and** 100,000 monthly users | documented — **not available to a new bot** |
| `getChatMember` | reliable only if the bot is an admin of that chat; rate limit *undocumented* | documented / undocumented |
| `chat_member` updates | only if bot is admin **and** `chat_member` is listed in `allowed_updates` | documented |
| `chat_join_request` updates | bot needs the `can_invite_users` admin right | documented |
| Join-request link | `creates_join_request` cannot be combined with `member_limit` | documented |
| `getUpdates` | max 100 updates per call; pending updates kept 24 h | documented |
| Deep-link payload | `A-Z a-z 0-9 _ -`, max 64 chars | documented |

Consequences:

1. **Incoming load is not the problem.** Telegram delivers updates as fast as we take them and holds the rest.
2. **Outgoing messages are the bottleneck.** Each user needs two: the channel list, then (as an edit of that message) their personal link. 10,000 users are 20,000 calls; at 30/s that is about 11 minutes of queue if everyone arrives in the same minute. No server or language changes this. The design therefore sends nothing beyond those two and prioritises what is queued.
3. **Membership verification is the second bottleneck.** 10,000 users × 5 sponsors = 50,000 `getChatMember` calls if done naively. The design avoids most of them.
4. A self-hosted Bot API server does **not** raise these limits. Do not add one.

---

## 3. Load model

Worst case: 10,000 users start within 60 seconds.

| Stream | Volume | Peak rate |
|---|---|---|
| `/start` messages | 10K | ~170/s |
| Button clicks (`callback_query`) | 20–40K | ~300/s |
| `chat_member` events (5 sponsors) | ~50K | ~500/s |
| **Total incoming** | ~100K in a few minutes | **~1,000/s peak** |
| DB statements | 2–3 per update | ~3,000/s peak, all single-row by primary key or unique index |
| Outgoing sends | ≥ 10K | capped at ~30/s by Telegram |

Postgres on 2 vCPU with NVMe handles this statement rate. Data size is negligible (100K users ≈ tens of MB).

---

## 4. Architecture

```
                  Telegram Bot API
                 ▲               │ getUpdates (batches of 100)
   rate-limited  │               ▼
  ┌──────────────┴───┐    ┌──────────────┐
  │  Sender          │    │  Poller      │
  │  priority queue  │    └──────┬───────┘
  │  + lane limiters │           │ shard by user_id
  └──────▲───────────┘    ┌──────▼───────┐      ┌────────────┐
         │                │  Handlers    │◄────►│ PostgreSQL │
         │   enqueue      │  (N workers) │      └─────▲──────┘
         ├────────────────┤  DB work only│            │
         │                └──────┬───────┘            │
  ┌──────┴───────────┐           │ verify jobs        │
  │ Outbox worker    │    ┌──────▼───────┐            │
  │ (durable sends)  │    │ Membership   │────────────┤
  └──────────────────┘    │ service      │            │
                          └──────────────┘     ┌──────┴──────┐
                                               │ Admin API + │◄── SSH tunnel or nginx
                                               │ React SPA   │
                                               └─────────────┘
```

Everything is one Node.js process. Layout:

```
src/
  main.ts           entry point, graceful shutdown on SIGTERM
  app.ts            wiring: builds every part and starts/stops them in order
  config.ts         env parsing (zod)
  tg/               Telegram gateway: lanes, token buckets, 429 handling, error classes
  ingest/           poll loop, per-user sequencing
  flow/             handlers (start, check, join request, my_chat_member) and message texts
  member/           membership service (push table + API fallback)
  contest/          contest cache, participants, referral credit transaction
  workers/          durable send queue (outbox), join-request decisions
  admin/            Fastify routes, auth, static SPA
  db/               connection, migration runner, row types
migrations/         SQL files, applied in name order
web/                React admin (Vite), built to web/dist and served by src/admin
loadtest/           fake Telegram server, load generator, local demo
test/               unit and integration tests
```

### 4.1 Ingest: long polling, at-least-once

- `getUpdates` with `limit=100`, `timeout=30`, `allowed_updates = [message, callback_query, chat_member, my_chat_member, chat_join_request]`.
- The poll loop is our own code (about 40 lines) calling `bot.api.getUpdates` and `bot.handleUpdate`. `bot.start()` handles one update at a time, which is too slow, and `@grammyjs/runner` fetches the next batch while earlier updates are still in flight, so a crash can drop them.
- Each batch is grouped by user id: one user's updates run in order, different users run concurrently (`Promise.all` over the groups; the DB pool bounds real concurrency). The loop awaits the whole batch, then requests the next one. The next request's `offset` acknowledges the batch.
- A crash before acknowledgement means Telegram redelivers. **Every handler must be idempotent** (section 5 relies on conditional updates and unique keys for this).
- **Handlers never call Telegram and never wait.** They read/write Postgres and enqueue work. This keeps a batch of 100 at an estimated 50–100 ms on one Node thread, roughly 1,000 updates/s. If the bot falls behind, Telegram holds the backlog; nothing is lost.
- `chat_member` events in a batch are written with one multi-row upsert.
- Webhook mode (`max_connections` up to 100) stays behind a config flag as the upgrade path if polling ever becomes the limit. The handler layer does not know which transport is in use.

### 4.2 Sender: one gate for every outgoing call

No code calls the Telegram API directly. Everything goes through `src/tg`, installed as a grammY API transformer (`bot.api.config.use`) so that even a stray `ctx.reply` is routed into a lane. It owns four lanes, each with its own token bucket:

| Lane | Methods | Start rate | Notes |
|---|---|---|---|
| send | `sendMessage`, `editMessageText` | 25/s, burst 30 | documented limit; plus 1/s per chat |
| callback | `answerCallbackQuery` | 100/s | *undocumented*; must be fast or the button spinner hangs |
| lookup | `getChatMember` | 20/s | *undocumented* |
| manage | `approveChatJoinRequest`, `declineChatJoinRequest`, `createChatInviteLink`, `getChat` | 10/s | *undocumented* |

Behaviour:

- **Adaptive (AIMD):** on a 429 (a `GrammyError` with `parameters.retry_after`), pause that lane for that many seconds, halve its rate, then recover slowly. On sustained success, creep upward to a configured ceiling. The real limits are found by measurement, not assumed.
- **Priorities on the send lane**, highest first: (1) replies to `/start` and edits after a button press, in arrival order; (2) "you qualified", join-request answers, admin alerts; (3) referral progress notices; (4) admin broadcasts. Start replies and edits share a level on purpose: if newcomers always went first, people one step from finishing would wait for as long as the spike lasts.
- **Shedding:** progress notices are coalesced per referrer (at most one per 30 s) and dropped when the queue is older than a threshold. Users can always press "My progress".
- **Error classes:** 403 "bot was blocked" → set `users.blocked_at`, stop sending to that user. 400 "message is not modified" and "query is too old" → ignore. 5xx / network → retry with backoff. 429 → as above.

### 4.3 What must survive a restart

In-memory queues are lost on a crash. That is acceptable for anything the user can trigger again (pressing "Check"). It is not acceptable for:

- the "you qualified" message → `outbox` table, written in the same transaction that sets `qualified_at`;
- admin broadcasts → `outbox`;
- prize-channel join requests → `join_requests` table, since pending requests cannot be listed through the Bot API.

An outbox worker reads pending rows (`FOR UPDATE SKIP LOCKED`), pushes them through the sender, and marks them sent.

---

## 5. Flows

### 5.1 `/start` (with or without a referral code)

1. Upsert `users`. Load the active contest (cached in memory, refreshed every few seconds and on admin change). No active contest → one "no contest running" message.
2. `INSERT ... ON CONFLICT DO NOTHING` into `participants`. `referred_by` is set **only on this first insert**, from the code in the payload, if the code exists in this contest and is not the user's own. It never changes afterwards.
3. Already verified → send the personal link and progress. Otherwise send **one** gate message: a numbered sponsor list, one URL button per channel, a "✅ I subscribed" button and a language button. Later steps edit this message; its id comes with each button press, so it is not stored. With a contest banner, the message is a picture with a caption (up to 1024 characters), and edits change the caption.

### 5.1a Languages

Every message exists in Uzbek, Russian and English (`src/flow/texts.ts`), and each contest can override any of them per language. A user's language is the one they picked with the 🌐 button or `/lang` (`users.locale`), else their Telegram language if it is Uzbek or Russian, else `DEFAULT_LOCALE` (Uzbek). Messages written ahead of time (the outbox "you qualified" message, broadcasts) are rendered in the recipient's language when they are queued.

### 5.1b Progress card screens

The card shown after verification has a progress bar (`▰▰▰▱▱ 3/5`), share and copy-link buttons, and two more screens that replace it in the same message: the leaderboard (top 10 by first name only, plus the user's own place; cached for 15 s per contest) and the user's own invitees, marked counted or not subscribed yet.

### 5.2 "I subscribed" click

1. Per-user cooldown (3 s) → `answerCallbackQuery("Please wait")`, nothing else.
2. Ask the membership service for all sponsor channels of the contest (section 6).
   - All known from the local table → answer immediately.
   - Some unknown → answer the callback with "Checking…", resolve in the background, then continue.
3. Not subscribed to all → `answerCallbackQuery` alert naming the missing channels. **No new message.** When the answer needed a Telegram lookup, the gate message is also edited to mark each channel ✅ or ❌ and keep only the missing channels' buttons; when everything was known locally it stays a popup only, so a stream of early clicks during a spike does not use the send limit.
4. Subscribed to all → run the credit transaction (5.3), then **edit** the gate message into the personal link + progress view.

### 5.3 Referral credit — one transaction, exactly once

```sql
BEGIN;
UPDATE participants SET verified_at = now()
 WHERE id = $me AND verified_at IS NULL
 RETURNING referred_by;                 -- 0 rows: already verified, COMMIT and stop

UPDATE participants SET invite_count = invite_count + 1
 WHERE id = $referrer AND disqualified_at IS NULL
 RETURNING invite_count, qualified_at;

-- if invite_count >= contest.required_invites AND qualified_at IS NULL:
UPDATE participants SET qualified_at = now()
 WHERE id = $referrer AND qualified_at IS NULL;
INSERT INTO outbox (dedupe_key, ...) VALUES ('qualified:' || $referrer, ...)
 ON CONFLICT (dedupe_key) DO NOTHING;
COMMIT;
```

The `verified_at IS NULL` condition is what makes double clicks, redelivered updates, and races harmless. `invite_count` is a counter for speed; the truth is always recomputable as `COUNT(*) WHERE referred_by = X AND verified_at IS NOT NULL`, and the admin panel has a "recount" action that does this.

If `required_invites = 0`, a user qualifies at their own verification.

### 5.4 Prize channel access

- On contest activation the bot creates **one** invite link for the prize chat with `creates_join_request = true` and stores it on the contest.
- Qualified users receive that link. Sharing it is harmless.
- On `chat_join_request`: insert into `join_requests` (pending). A worker decides: participant of the contest that owns this chat, `qualified_at` set, not disqualified → `approveChatJoinRequest` and set `prize_joined_at`. Otherwise `declineChatJoinRequest` and message the user (via `user_chat_id`, valid for 5 minutes) with how to qualify and a link to start the bot.

Single-use links (`member_limit = 1`) were rejected: whoever holds the link can use it, so they do not bind access to the qualified person, and creating thousands of links adds another rate-limited call.

### 5.5 Telegram methods used

`getUpdates`, `getMe`, `sendMessage`, `editMessageText`, `answerCallbackQuery`, `getChatMember`, `getChat`, `createChatInviteLink`, `approveChatJoinRequest`, `declineChatJoinRequest`, optionally `banChatMember`/`unbanChatMember` (remove from prize chat), `setWebhook`/`deleteWebhook` (webhook mode).

---

## 6. Membership service

Requirement: the bot must be an **administrator in every sponsor channel**. The admin panel verifies this when a channel is added and refuses otherwise.

**Source 1 — push.** As an admin, the bot receives a `chat_member` update for every join and leave. These are upserted into `channel_members(chat_id, user_id, is_member)`. Most contest users subscribe *after* `/start`, so their membership arrives by push and verification is a primary-key lookup with zero API calls.

**Source 2 — fallback.** No row for (channel, user) means the user subscribed before the bot became admin, or the event has not arrived yet. Then call `getChatMember` through the lookup lane and store the result.

Rules:

- Member = status `creator`, `administrator`, `member`, or `restricted` with `is_member = true`.
- Positive results are kept until a leave event. Negative API results are trusted for 15 s (the user may be subscribing right now).
- Concurrent lookups for the same (channel, user) are merged into one call.
- Add the bot to sponsor channels **as early as possible** before launch, so more of the audience is covered by push.
- `my_chat_member` shows the bot lost admin rights in a sponsor channel → mark the channel unhealthy, alert admins, and (default) skip that channel in checks rather than blocking every user.

The table is **global, not per contest**: membership is a fact about the world, and reusing it makes later contests cheaper.

---

## 7. Data model

The schema is [`migrations/001_init.sql`](migrations/001_init.sql) plus [`002_ui.sql`](migrations/002_ui.sql); those files are the source of truth.

| Table | Scope | Holds |
|---|---|---|
| `users` | global | One row per Telegram user: name, Telegram language, the language they picked in the bot, whether they blocked the bot. |
| `contests` | — | Title, status (`draft` / `active` / `finished`), required invites, prize chat and its join-request link, message overrides per language, banner `file_id`. A partial unique index allows one active contest. |
| `contest_banners` | per contest | The uploaded banner picture, only so the panel can show it. Kept out of `contests`, which the bot reads every few seconds. |
| `broadcasts` | per contest | One row per admin broadcast; its messages are `outbox` rows with `broadcast_id`, which gives delivery progress and lets one be stopped. |
| `sponsor_channels` | per contest | Channel id, title, join link, order, health (`ok` / `bot_not_admin`). |
| `participants` | per contest | **All contest state**: referral code, referrer (set once), `verified_at`, `invite_count`, `qualified_at`, `prize_joined_at`, `disqualified_at`. Unique on `(contest_id, user_id)`. |
| `channel_members` | global | Who is in which channel, from `chat_member` updates (`push`) or `getChatMember` (`api`). |
| `outbox` | — | Messages that must survive a restart, with a `dedupe_key` so each is queued once. |
| `join_requests` | — | Prize-chat join requests and what was decided. |
| `admin_login_tokens`, `admin_sessions`, `audit_log` | — | Admin sign-in and a record of every admin write. |

Only hashes of login tokens and session ids are stored.

### Why a new contest cannot conflict with an old one

- All contest state lives in `participants`, keyed by `(contest_id, user_id)`. A new contest starts with zero rows: counts, referrals, and qualification all begin from nothing without deleting anything.
- The partial unique index allows exactly one active contest. Activation is one transaction: finish the old one, activate the new one.
- Referral codes are unique across all contests, so an old link can never credit a new contest; it simply resolves to a participant of a finished contest and is treated as "no referrer".
- Join requests are matched to a contest through `prize_chat_id`, so an old prize link cannot admit anyone to a new prize chat.
- `users` and `channel_members` are deliberately shared across contests.
- Finished contests stay queryable in the admin panel and can be exported; a "purge" action for old contests can be added later if disk ever matters.

---

## 8. Failure modes

| Failure | Handling |
|---|---|
| Process crash / deploy | Unacknowledged updates are redelivered; handlers are idempotent; outbox and join requests resume from Postgres. Downtime only delays replies. |
| 429 from Telegram | Lane pauses for the stated delay and lowers its rate; queued work waits. |
| Send queue backlog at launch | Priorities keep `/start` replies first; progress notices are shed; queue age is shown in the admin panel. |
| User blocks the bot | Marked blocked, skipped in all sends. |
| Bot loses admin in a sponsor channel | Detected via `my_chat_member`; channel marked unhealthy; admins alerted. |
| `chat_member` event missed | Fallback lookup covers missing rows; a leave that was missed is caught by the final audit (section 11). |
| Popular referrer (thousands of invitees) | Counter increments queue on one row lock; each transaction is sub-millisecond. |
| Fake accounts farming invites | Credit requires real subscriptions to all sponsors; admin can view each participant's invitees, disqualify, and recount. Automatic scoring is out of scope for v1. |
| Postgres down | Handlers fail, poller stops acknowledging, Telegram holds updates up to 24 h. |

---

## 9. Admin panel

Same process (Fastify), served under `/admin` on the server's localhost. Reach it through an SSH tunnel, or through the server's own web server with HTTPS.

- **Auth:** admin Telegram IDs in config. `/admin` in the bot sends a one-time login link (random token, stored hashed, 5-minute life, single use) that sets an `HttpOnly; Secure; SameSite=Strict` session cookie. No passwords.
React app with a sidebar, light and dark themes, and a layout that works on a phone. No UI or chart libraries: charts are plain SVG.

- **Overview:** live numbers with the last hour's change, an hourly activity chart (24 h / 48 h / 7 d), the funnel (started → subscribed → qualified → in prize chat), which sponsor channel stops the most people, the language split, and bot health.
- **Contest setup wizard:** details → sponsor channels → prize chat → messages and banner → launch. A channel is checked live before it is added (title, members, whether the bot is an admin, whether it can invite). Sponsors can be reordered and re-checked. Messages are edited per screen and per language next to a Telegram-style preview. The launch step is a checklist; a live contest gets finish, recount, audit and export there.
- **Participants:** paginated search with filters; a side panel with dates, referrer, an expandable invite tree, and disqualify.
- **Leaderboard:** podium and ranked list, with invitees still pending subscription.
- **Broadcasts:** text per language (empty languages fall back), link buttons, audience segments with a live recipient count per language, a test send to yourself, then delivery progress per broadcast and a stop button. Broadcasts go through the outbox at the lowest priority; 10K recipients take about 6 minutes.
- **System:** lane rates, queue depth and age, 429s, poller lag, memory.
- Every write goes to `audit_log`.

---

## 10. Reuse for other clients

One Compose stack per client: its own bot token, its own database, the same image. All client differences live in config and in contest rows. A Node process uses about 150–250 MB, so three or four stacks fit on one 4 GB box, sharing a single Postgres server with one database each.

True multi-tenancy (many bots in one process, `bot_id` on every table) is not built. It adds complexity to every query and couples clients' failures together, for no benefit below roughly ten clients.

---

## 11. Policy defaults (change if you disagree)

1. **A user from a previous contest counts as a new invitee in the next contest.** Contests are independent.
2. **Leaving a sponsor channel after being counted does not reduce counts live.** The membership table always knows who is subscribed right now, and the "final audit" action lists qualified users whose invitees have left, for a decision before prizes. Live decrement causes flapping and extra messages.
3. **Joining the prize chat re-checks the user's own sponsor subscriptions** from the local table. A recorded leave blocks the request; no record passes.
4. **Unhealthy sponsor channel is skipped**, with an admin alert, rather than blocking all users.
5. **Referral progress notices are best-effort** and may be dropped under load.

---

## 12. Deployment on the VPS

The VPS turned out to be shared: it already runs two other apps (a Next.js app with Postgres and MinIO, and a URL shortener) behind nginx on ports 80 and 443. About 1.9 GB of the 3.7 GB is free, and the two CPUs are shared. The deployment is sized for that.

- **Image:** GitHub Actions builds it after tests pass and pushes it to `ghcr.io/mirzohid22/contest-bot`. The server pulls it. A build on the server would compete for memory with the live apps.
- **Compose:** `app` and `postgres:17`. Multi-stage image: compiles the TypeScript and the React admin, runs the compiled JavaScript on a slim Node LTS image with `--max-old-space-size=512`.
- **Limits:** Postgres 512 MB with `shared_buffers=256MB`, `effective_cache_size=768MB`, `work_mem=8MB`, `max_connections=40`; app 768 MB, pool of 16 connections. The data set is megabytes, so small buffers do not limit it. All of these are variables in `.env`.
- **Admin panel:** `127.0.0.1:3200` on the server, reached through an SSH tunnel, or through the existing nginx with a subdomain (`deploy/nginx-site.conf.example`).
- Run exactly one `app` container per bot (see 1.1). Postgres is not exposed outside the compose network.
- Backups: `pg_dump` nightly and before every contest activation/finish, copied off the server.
- Logs: structured JSON via `pino`. Metrics: a `/metrics` endpoint (`prom-client`, including event-loop lag) plus the admin dashboard; alerts go to an admin Telegram chat (queue age over threshold, repeated 429s, sponsor unhealthy, poller stalled).

**What sharing costs.** During a launch spike the bot and its database compete for CPU with the other apps, in both directions. The 10,000-user measurement in section 13 was taken on a development machine and says nothing about this server. A load test here slows the live apps for a few minutes, so run it at a quiet hour. If the contest matters more than the cost of a second small server, give the bot its own.

## 13. Testing and load testing

Real Telegram cannot be load-tested with 10K fake users, so the Telegram side is simulated:

- **Fake Telegram server** (`loadtest/fakeTelegram.ts`): implements the methods in 5.5, hands out updates with real offset semantics, and enforces configurable per-method rate limits by answering 429 with `retry_after`. The bot points at it through grammY's `client.apiRoot` option.
- **Tests** (`npm test`): the lane (rate, priorities, 429, shedding, per-chat spacing), the poll loop (acknowledge only after handling, per-user order, retry, poison update), the whole contest flow end to end, and the admin API.
- **Load generator** (`npm run loadtest`): N users arrive over a window, most through someone's link; 30% were subscribed before the bot could see it (forcing `getChatMember`), 10% never subscribe. At the end it compares every `invite_count` with the referral records.
- **Demo** (`npm run demo`): bot and admin panel against the fake server with sample data, no token needed.

### Measured on the development machine (not the VPS)

10,000 users in 60 seconds, generator and fake server sharing the bot's process:

| | Result |
|---|---|
| Updates handled | 50,235, about 840/s at peak |
| Update backlog | never above one batch (45) |
| Event-loop lag, p99 | 13 ms |
| Correctness | 0 mismatched counts, all 9,029 subscribers verified, every qualifier messaged, 0 updates dropped |

That run had no send limit, to measure the bot itself. A second run simulated Telegram's limits (30 sends/s, 50 lookups/s, 429 with a 3-second penalty) for 2,000 users arriving in 20 seconds:

| | Result |
|---|---|
| Send rate | held at 30/s, no send 429s |
| Send queue | peaked at 2,896 messages; the longest wait was 122 s |
| Everything delivered | 140 s after the first arrival |
| Lookups | 3,925 calls, two 429s absorbed by the limiter |
| Progress notices | 481 dropped on purpose (older than 60 s) |
| Correctness | all checks passed |

The bot itself stays idle in that run; the queues set the pace, as section 2 predicts. **Repeat both runs on the VPS before launch**; a 2-vCPU shared server is slower than a laptop.

Still to do against real Telegram: a smoke test with a test bot, two test channels, and a few real accounts, including join-request approve and decline. The fake server encodes my reading of the Bot API, not Telegram's actual behaviour.

## 14. Build phases

| # | Phase | Scope | State |
|---|---|---|---|
| 0 | Skeleton | Repo, config, migrations, Compose, health endpoint, image build in CI | Done |
| 1 | Pipeline | Lanes and limiter, poll loop, per-user sequencing, fake Telegram server | Done, tested |
| 2 | Gate | `/start`, gate message, membership service (push + fallback), "I subscribed" | Done, tested |
| 3 | Referrals | Ref codes, attribution, credit transaction, progress view, qualification, outbox | Done, tested |
| 4 | Prize access | Join-request link, approve/decline worker | Done, tested against the fake server |
| 5 | Admin | Auth, contests, sponsors, participants, dashboard, export, broadcast, audit | Done; API tested, UI checked by hand |
| 5b | UI round 2 | Languages, progress card, leaderboard and friends screens, banner; panel redesign, setup wizard, charts, broadcast composer | Done; tested against the fake server and checked in the browser, not yet on real Telegram |
| 6 | Hardening | Load test on the VPS, real-Telegram smoke test, backups, alerts | Load test and alerts exist; VPS run, smoke test, and backup schedule are open |

### Launch checklist

- Bot is admin in every sponsor channel, added days before launch.
- Bot is admin in the prize chat with the invite-users right; join-request link created.
- `allowed_updates` includes `chat_member` and `chat_join_request` (verify with `getWebhookInfo` / first poll).
- Load test passed on this VPS, not on a laptop.
- If possible, announce in sponsor channels a few minutes apart rather than all at once: it spreads the 30 msg/s queue.
