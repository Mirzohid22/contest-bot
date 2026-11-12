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
- A server with Docker and about 1.5 GB of free memory.

## Deploy

Every push to `main` runs the tests and, if they pass, builds the image and pushes it to `ghcr.io/mirzohid22/contest-bot`. The server only pulls that image; it does not need the source code.

On the server, once:

```bash
docker login ghcr.io
```

(Use a GitHub token with the `read:packages` scope as the password.)

Put [compose.yml](compose.yml) and a copy of [.env.example](.env.example) named `.env` into a folder, for example `~/contest-bot`. Edit `.env`: set `BOT_TOKEN`, `ADMIN_IDS`, and a long random `POSTGRES_PASSWORD`. Then:

```bash
docker compose pull && docker compose up -d
```

```bash
docker compose logs -f app
```

The log line `started` with your bot's username means it is running. Database migrations run on every start.

**Run exactly one `app` container per bot token.** The rate limiter lives in memory, and Telegram rejects two readers of the same token.

The defaults fit a small server shared with other apps: Postgres is limited to 512 MB and the bot to 768 MB. On a server of its own, raise the `PG_*` values in `.env`.

To build on the server instead of pulling (needs about 1.5 GB of free memory):

```bash
docker compose -f compose.yml -f compose.build.yml up -d --build
```

### Automatic deploys

Every push to `main` runs three jobs: **test**, **image** (build and push to GHCR), and **deploy**. The deploy job connects to the server with an SSH key that can run only [deploy/deploy.sh](deploy/deploy.sh). That script:

1. pulls the image for the pushed commit,
2. backs up the database to `backups/` (the last 20 are kept),
3. restarts the app on the new image,
4. waits for `/healthz`, and if it does not answer, restarts the previous version and fails the job.

One-time setup, from this repo on your computer, after copying the script to the server:

```bash
scp deploy/deploy.sh lab:contest-bot/ && ssh lab 'chmod 755 ~/contest-bot/deploy.sh'
```

```bash
deploy/setup-deploy-key.sh lab
```

The second command creates a key for GitHub Actions, adds it to the server's `authorized_keys` restricted to `deploy.sh` (no shell, no forwarding), stores it and the server address as `DEPLOY_*` repository secrets, and deletes the local copy. Until the secrets exist, the deploy job is skipped with a warning.

Deploy by hand on the server, or redeploy an older commit:

```bash
cd ~/contest-bot && ./deploy.sh deploy <full commit sha>
```

### Opening the admin panel

Send `/admin` to the bot. It replies with a sign-in link that works once, for five minutes.

The panel listens only on the server's localhost, port 3200. Open a tunnel from your computer, then use the link:

```bash
ssh -L 3200:127.0.0.1:3200 user@your-server
```

For a public address, put the server's web server in front of port 3200 and set `PUBLIC_URL` to that address. [deploy/nginx-site.conf.example](deploy/nginx-site.conf.example) has an nginx site with the commands.

### Updating

Push to `main`; the deploy job does the rest. Without automatic deploys, on the server:

```bash
docker compose pull && docker compose up -d
```

A restart loses nothing: Telegram keeps undelivered updates for 24 hours, and messages that must arrive are stored in the database.

### Backups

```bash
mkdir -p backups && docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > backups/contest-$(date +%F-%H%M).sql.gz
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
