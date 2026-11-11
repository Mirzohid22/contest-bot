import { fileURLToPath } from "node:url";
import { Api, Bot } from "grammy";
import { sql } from "kysely";
import { pino, type Logger } from "pino";
import { buildAdmin } from "./admin/server.js";
import type { Config } from "./config.js";
import { ContestCache } from "./contest/service.js";
import { createDb, migrate } from "./db/index.js";
import type { Deps } from "./deps.js";
import { registerHandlers } from "./flow/handlers.js";
import { Poller } from "./ingest/poller.js";
import { Membership } from "./member/service.js";
import { P, Tg } from "./tg/gateway.js";
import { Cooldown, escapeHtml, every } from "./util.js";
import { JoinWorker } from "./workers/joins.js";
import { OutboxWorker } from "./workers/outbox.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export type App = Awaited<ReturnType<typeof createApp>>;

/** Builds the whole application. Nothing talks to Telegram or listens until start(). */
export async function createApp(cfg: Config, logger?: Logger) {
  const log = logger ?? pino({ level: cfg.LOG_LEVEL });
  const { db, pool } = createDb(cfg.DATABASE_URL, cfg.DB_POOL);
  pool.on("error", (err) => log.error({ err }, "postgres pool error"));

  const applied = await migrate(pool, MIGRATIONS_DIR);
  if (applied.length > 0) log.info({ applied }, "migrations applied");

  const client = cfg.TG_API_ROOT ? { apiRoot: cfg.TG_API_ROOT } : undefined;
  // `raw` is used only by the gateway and the poller. Handlers never see it.
  const raw = new Api(cfg.BOT_TOKEN, client);
  const me = await raw.getMe();
  // Long polling fails with 409 while a webhook is set; pending updates are kept.
  await raw.deleteWebhook();

  const tg = new Tg(raw, cfg, log, (chatId) => {
    sql`UPDATE users SET blocked_at = now() WHERE tg_id = ${chatId} AND blocked_at IS NULL`
      .execute(db)
      .catch(() => {});
  });

  const cache = new ContestCache(db);
  const cooldown = new Cooldown();

  const alert = (key: string, text: string) => {
    if (cooldown.active(`alert:${key}`)) return;
    cooldown.set(`alert:${key}`, 10 * 60_000);
    log.warn({ key }, text);
    for (const id of cfg.ADMIN_IDS) tg.fire(tg.send(id, text, { priority: P.IMPORTANT }));
  };

  const member = new Membership(db, tg, cfg, log, (chatId, reason) => {
    sql<{ title: string }>`
      UPDATE sponsor_channels SET health = 'bot_not_admin'
       WHERE chat_id = ${chatId} AND health = 'ok' RETURNING title
    `
      .execute(db)
      .then((r) => {
        if (r.rows.length === 0) return;
        cache.invalidate();
        alert(
          `sponsor:${chatId}:false`,
          `⚠️ Cannot check subscriptions in sponsor channel <b>${escapeHtml(r.rows[0]!.title)}</b> (${escapeHtml(reason)}). It is skipped until the bot is an admin there again.`,
        );
      })
      .catch((err) => log.warn({ err }, "could not mark sponsor unhealthy"));
  });

  const deps: Deps = { cfg, db, tg, cache, member, log, me, cooldown, alert };

  const bot = new Bot(cfg.BOT_TOKEN, { botInfo: me, client });
  tg.guard(bot.api);
  registerHandlers(bot, deps);

  const poller = new Poller(
    raw,
    (events) => member.applyEvents(events),
    (update) => bot.handleUpdate(update),
    log,
  );
  const outbox = new OutboxWorker(deps);
  const joins = new JoinWorker(deps);
  const http = await buildAdmin(deps, { poller });

  let stopWatchdog: (() => Promise<void>) | null = null;
  const startedAt = Date.now();
  const watchdog = async () => {
    const lag = tg.lanes.send.oldestAgeMs;
    if (lag > 120_000) {
      alert("send-lag", `⏳ The send queue is ${Math.round(lag / 1000)} s behind (${tg.lanes.send.depth} messages waiting). Replies are delayed by Telegram's rate limit.`);
    }
    const sincePoll = Date.now() - (poller.stats.lastPollAt || startedAt);
    if (sincePoll > 120_000) {
      alert("poller-stalled", `🛑 No successful update fetch for ${Math.round(sincePoll / 1000)} s. The bot may be offline.`);
    }
  };

  return {
    deps,
    poller,
    http,
    async start() {
      await http.listen({ port: cfg.PORT, host: cfg.HOST });
      outbox.start();
      joins.start();
      poller.start();
      stopWatchdog = every(30_000, watchdog, (err) => log.warn({ err }, "watchdog failed"));
      log.info({ bot: me.username, port: cfg.PORT }, "started");
    },
    async stop() {
      // Order matters: stop taking work, finish what is in hand, then close the database.
      await poller.stop();
      await stopWatchdog?.();
      await outbox.stop();
      await joins.stop();
      await http.close();
      await db.destroy();
      log.info("stopped");
    },
  };
}
