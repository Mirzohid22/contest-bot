import { sql } from "kysely";
import pg from "pg";
import { FakeTelegram, type FakeOptions } from "../loadtest/fakeTelegram.js";
import { type App, createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Participant } from "../src/db/types.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/contest_bot_test";

export const SPONSOR_A = -1001;
export const SPONSOR_B = -1002;
export const PRIZE_CHAT = -1009;
export const ADMIN_ID = 1;

/** Wipes the test database. Refuses to touch anything that is not obviously a test database. */
export async function resetDb(url = TEST_DB): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/test/i.test(name)) throw new Error(`Refusing to wipe "${name}": the database name must contain "test"`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await client.end();
  }
}

export interface Harness {
  app: App;
  fake: FakeTelegram;
  stop: () => Promise<void>;
  participant: (userId: number) => Promise<Participant | undefined>;
  /** Creates an active contest with two sponsors and a prize chat; returns its id. */
  seedContest: (requiredInvites?: number) => Promise<number>;
  /** /start, subscribe to both sponsors, click "I subscribed". */
  join: (userId: number, refCode?: string) => void;
}

export async function boot(env: Record<string, string> = {}, fakeOpts: FakeOptions = {}): Promise<Harness> {
  await resetDb();
  const fake = new FakeTelegram(fakeOpts);
  const apiRoot = await fake.listen();
  const cfg = loadConfig({
    BOT_TOKEN: "123456:TEST-TOKEN",
    DATABASE_URL: TEST_DB,
    TG_API_ROOT: apiRoot,
    ADMIN_IDS: String(ADMIN_ID),
    PORT: "0",
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    // No artificial waiting in tests.
    SEND_RATE: "2000",
    SEND_RATE_MAX: "2000",
    CALLBACK_RATE: "2000",
    CALLBACK_RATE_MAX: "2000",
    LOOKUP_RATE: "2000",
    LOOKUP_RATE_MAX: "2000",
    MANAGE_RATE: "500",
    MANAGE_RATE_MAX: "500",
    PER_CHAT_MS: "0",
    CHECK_COOLDOWN_MS: "0",
    START_COOLDOWN_MS: "0",
    NEGATIVE_TTL_MS: "0",
    NOTICE_COALESCE_MS: "0",
    ...env,
  });
  const app = await createApp(cfg);
  await app.start();
  const { db } = app.deps;

  return {
    app,
    fake,
    async stop() {
      await app.stop();
      await fake.close();
    },
    async participant(userId) {
      const r = await sql<Participant>`
        SELECT p.* FROM participants p JOIN contests c ON c.id = p.contest_id
         WHERE p.user_id = ${userId} AND c.status = 'active'
      `.execute(db);
      return r.rows[0];
    },
    async seedContest(requiredInvites = 2) {
      await sql`UPDATE contests SET status = 'finished', finished_at = now() WHERE status = 'active'`.execute(db);
      const c = await sql<{ id: number }>`
        INSERT INTO contests (title, status, required_invites, prize_chat_id, prize_chat_title, prize_invite_link, started_at)
        VALUES ('Test contest', 'active', ${requiredInvites}, ${PRIZE_CHAT}, 'Prize', 'https://t.me/+prize', now())
        RETURNING id
      `.execute(db);
      const id = c.rows[0]!.id;
      await sql`
        INSERT INTO sponsor_channels (contest_id, chat_id, title, join_url, position)
        VALUES (${id}, ${SPONSOR_A}, 'Sponsor A', 'https://t.me/sponsor_a', 1),
               (${id}, ${SPONSOR_B}, 'Sponsor B', 'https://t.me/sponsor_b', 2)
      `.execute(db);
      app.deps.cache.invalidate();
      return id;
    },
    join(userId, refCode = "") {
      fake.push(fake.start(userId, refCode));
      fake.push(fake.memberChange(SPONSOR_A, userId, true));
      fake.push(fake.memberChange(SPONSOR_B, userId, true));
      fake.push(fake.click(userId, "check"));
    },
  };
}

/** Polls until `fn` returns something truthy (a non-empty array, for arrays), or fails after the timeout. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  what = "condition",
  timeoutMs = 5000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (Array.isArray(v) ? v.length > 0 : v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
