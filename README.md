# Contest Bot

A Telegram bot for referral contests.

1. A user starts the bot and must subscribe to every sponsor channel.
2. After that they get a personal invite link.
3. A friend counts once they start the bot through that link **and** subscribe to the sponsors.
4. At the required number of friends the user qualifies and receives the link to a private channel or group.
5. That link is shared by everyone, and the bot approves or declines each join request, so it is useless to anyone who has not qualified.

An admin panel creates contests, manages sponsor channels, lists participants, and starts the next contest from zero.

The design and the reasons behind it are in [ARCHITECTURE.md](ARCHITECTURE.md).

## What you need

- A bot token from [@BotFather](https://t.me/BotFather).
- Your Telegram user id (ask [@userinfobot](https://t.me/userinfobot)).
- A server with Docker. Sized for 2 vCPU / 4 GB RAM.

## Deploy

```bash
git clone <this repo> contest-bot && cd contest-bot
cp .env.example .env
```

Edit `.env`: set `BOT_TOKEN`, `ADMIN_IDS`, and a long random `POSTGRES_PASSWORD`. Then:

```bash
docker compose up -d --build
```

```bash
docker compose logs -f app
```

The log line `started` with your bot's username means it is running. Database migrations run on every start.

**Run exactly one `app` container per bot token.** The rate limiter lives in memory, and Telegram rejects two readers of the same token.

### Opening the admin panel

Send `/admin` to the bot. It replies with a sign-in link that works once, for five minutes.

Without a domain, the panel listens only on the server's localhost. Open a tunnel from your computer, then use the link:

```bash
ssh -L 3000:127.0.0.1:3000 user@your-server
```

With a domain, point it at the server, set `ADMIN_DOMAIN=admin.example.com` and `PUBLIC_URL=https://admin.example.com` in `.env`, and start Caddy too (it obtains the certificate):

```bash
docker compose --profile https up -d
```

### Updating

```bash
git pull && docker compose up -d --build
```

A restart loses nothing: Telegram keeps undelivered updates for 24 hours, and messages that must arrive are stored in the database.

### Backups

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > backups/contest-$(date +%F-%H%M).sql.gz
```

Run this nightly (cron) and before activating or finishing a contest, and copy the file off the server.

## Running a contest

1. **Contests → New contest.** It starts as a draft; users see nothing yet.
2. **Sponsor channels.** Add the bot as an administrator of each channel, then add the channel in the panel. Do this days before launch if you can: the bot learns about subscribers from join events, and that is much cheaper than asking Telegram about each user.
3. **Prize chat.** Add the bot as an administrator with the "Invite users via link" right, then set the chat in the panel. The bot creates a join-request link.
4. **Messages.** Reword anything the bot says, per contest.
5. **Activate.** The previously active contest, if any, is finished automatically.
6. During the contest, the dashboard shows participants by stage and the state of the queues.
7. **Before awarding prizes:** disqualify fake accounts under Participants, press **Recount invites**, and look at **Final audit**.
8. **Finish**, or activate the next contest.

## What to expect at launch

Telegram lets a bot send about 30 messages per second. Each user needs two (the channel list, then their personal link), so if 10,000 people arrive within one minute, the last of them gets their link roughly 11 minutes later. The bot is not overloaded when this happens; it is waiting for Telegram. The dashboard shows the queue and it drains on its own.

Announcing in the sponsor channels a few minutes apart spreads the load.

## Development

Requires Node 22+ and a local PostgreSQL.

```bash
npm install && npm install --prefix web
```

```bash
createdb contest_bot_test && npm test
```

```bash
npm run build --prefix web && npm run dev
```

`npm run dev` reads `.env`; set `DATABASE_URL` there for local runs.

| Command | What it does |
|---|---|
| `npm test` | Unit and integration tests against a fake Telegram server |
| `npm run typecheck` | TypeScript check |
| `npm run loadtest` | 10,000 simulated users with Telegram-like rate limits; verifies counts at the end |
| `npm run dev --prefix web` | Admin panel with hot reload, proxied to a bot on port 3000 |

Tests use the database in `TEST_DATABASE_URL` (default `postgres://localhost:5432/contest_bot_test`) and wipe it; the helper refuses any database whose name does not contain "test".

### Layout

```
src/tg/         every call to Telegram goes through here: four rate-limited lanes
src/ingest/     long-polling loop, at-least-once, per-user ordering
src/flow/       update handlers and message texts
src/member/     "is this user subscribed?" (local table first, Telegram second)
src/contest/    contest cache, participants, the referral credit transaction
src/workers/    durable message delivery, join-request decisions
src/admin/      admin API and session handling
web/            React admin panel
migrations/     SQL schema
loadtest/       fake Telegram server and load generator
test/           tests
```

## Reusing it for another client

One copy of this stack per bot: its own `.env`, its own database, the same image. Nothing in the code is specific to one client; texts, sponsors, and rules are data.
