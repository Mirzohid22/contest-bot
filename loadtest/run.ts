/**
 * Load test: N simulated users arrive within a time window and go through the whole flow
 * against the fake Telegram server, with Telegram-like rate limits.
 *
 *   npm run loadtest                              10,000 users in 60 s, 30 msg/s limit
 *   USERS=2000 ARRIVAL_S=20 npm run loadtest      smaller run
 *   SEND_LIMIT=0 npm run loadtest                 no send limit: measures the bot itself
 *
 * The generator and the fake server share the bot's process and CPU core, so the numbers
 * are a lower bound on what the bot alone can do.
 *
 * It checks correctness, not only speed: at the end every invite_count must equal the
 * number of verified invitees, and every user who should be verified must be.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { type RawBuilder, sql } from "kysely";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { resetDb } from "../test/harness.js";
import { FakeTelegram } from "./fakeTelegram.js";

const env = (name: string, def: number) => (process.env[name] !== undefined ? Number(process.env[name]) : def);

const USERS = env("USERS", 10_000);
const ARRIVAL_S = env("ARRIVAL_S", 60);
/** Telegram's send limit to simulate, messages per second. 0 = unlimited. */
const SEND_LIMIT = env("SEND_LIMIT", 30);
/** getChatMember limit to simulate. Undocumented in reality; 0 = unlimited. */
const LOOKUP_LIMIT = env("LOOKUP_LIMIT", 50);
const LATENCY_MS = env("LATENCY_MS", 15);
/** Share of users already subscribed before the bot could see it (need getChatMember). */
const PRESUBSCRIBED = env("PRESUBSCRIBED", 0.3);
/** Share of users who click without ever subscribing. */
const NEVER_SUBSCRIBE = env("NEVER_SUBSCRIBE", 0.1);
const REQUIRED_INVITES = env("REQUIRED_INVITES", 5);
const TIMEOUT_S = env("TIMEOUT_S", 1800);
const DB_URL = process.env.LOADTEST_DATABASE_URL ?? "postgres://localhost:5432/contest_bot_loadtest";

const SPONSORS = [-1001, -1002, -1003, -1004, -1005];
const PRIZE = -1009;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

await resetDb(DB_URL);

const fake = new FakeTelegram({
  latencyMs: LATENCY_MS,
  record: false,
  retryAfter: 3,
  groups: { sendMessage: "send", editMessageText: "send" },
  limits: {
    ...(SEND_LIMIT > 0 ? { send: SEND_LIMIT } : {}),
    ...(LOOKUP_LIMIT > 0 ? { getChatMember: LOOKUP_LIMIT } : {}),
  },
});
const apiRoot = await fake.listen();

const app = await createApp(
  loadConfig({
    BOT_TOKEN: "123456:LOADTEST",
    DATABASE_URL: DB_URL,
    TG_API_ROOT: apiRoot,
    ADMIN_IDS: "1",
    PORT: "0",
    HOST: "127.0.0.1",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "error",
    ...(SEND_LIMIT === 0 ? { SEND_RATE: "5000", SEND_RATE_MAX: "5000", PER_CHAT_MS: "0" } : {}),
    ...(LOOKUP_LIMIT === 0 ? { LOOKUP_RATE: "5000", LOOKUP_RATE_MAX: "5000" } : {}),
  }),
);
const { db, tg, cache } = app.deps;

const contest = await sql<{ id: number }>`
  INSERT INTO contests (title, status, required_invites, prize_chat_id, prize_chat_title, prize_invite_link, started_at)
  VALUES ('Load test', 'active', ${REQUIRED_INVITES}, ${PRIZE}, 'Prize', 'https://t.me/+prize', now())
  RETURNING id
`.execute(db);
const contestId = contest.rows[0]!.id;
for (const [i, chat] of SPONSORS.entries()) {
  await sql`
    INSERT INTO sponsor_channels (contest_id, chat_id, title, join_url, position)
    VALUES (${contestId}, ${chat}, ${"Sponsor " + (i + 1)}, ${"https://t.me/sponsor" + (i + 1)}, ${i})
  `.execute(db);
}
cache.invalidate();
await app.start();

// ---- the crowd ----

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(0).padStart(4);

/** Referral codes of verified users, refreshed from the database: new arrivals pick one at random. */
let codes: string[] = [];
const refreshCodes = setInterval(async () => {
  const r = await sql<{ ref_code: string }>`
    SELECT ref_code FROM participants WHERE contest_id = ${contestId} AND verified_at IS NOT NULL
  `.execute(db);
  codes = r.rows.map((x) => x.ref_code);
}, 1000);

let expectedVerified = 0;
let pushed = 0;
const push = (u: Parameters<FakeTelegram["push"]>[0]) => {
  fake.push(u);
  pushed++;
};

for (let i = 0; i < USERS; i++) {
  const userId = 1_000_000 + i;
  const at = Math.random() * ARRIVAL_S * 1000;
  const roll = Math.random();
  const never = roll < NEVER_SUBSCRIBE;
  const pre = !never && roll < NEVER_SUBSCRIBE + PRESUBSCRIBED;
  if (!never) expectedVerified++;
  if (pre) for (const chat of SPONSORS) fake.setMember(chat, userId);

  setTimeout(() => {
    // 80% arrive through someone's link once links exist.
    const code = codes.length > 0 && Math.random() < 0.8 ? codes[Math.floor(Math.random() * codes.length)]! : "";
    push(fake.start(userId, code));
  }, at);
  if (!never && !pre) {
    setTimeout(() => {
      for (const chat of SPONSORS) push(fake.memberChange(chat, userId, true));
    }, at + 4000);
  }
  // The click comes after the cooldowns; real people are slower than this.
  setTimeout(() => push(fake.click(userId, "check")), at + 6000);
}
const totalUpdates = () => pushed;

console.log(
  `\n${USERS} users over ${ARRIVAL_S}s · send limit ${SEND_LIMIT || "none"}/s · lookup limit ${LOOKUP_LIMIT || "none"}/s · API latency ${LATENCY_MS}ms\n`,
);
console.log("   t   updates  backlog  send-queue  oldest  send/s  lookup-queue  verified  429s  loop-p99");

let peakBacklog = 0;
let peakSendQueue = 0;
let peakOldest = 0;
let peakLoopP99 = 0;
let ingestDoneAt = 0;
let lastOk = 0;

for (;;) {
  await sleep(5000);
  const v = await sql<{ n: number }>`
    SELECT count(*) AS n FROM participants WHERE contest_id = ${contestId} AND verified_at IS NOT NULL
  `.execute(db);
  const verified = v.rows[0]!.n;
  const send = tg.lanes.send;
  const p99 = loop.percentile(99) / 1e6;
  loop.reset();
  const sendRate = (send.stats.ok - lastOk) / 5;
  lastOk = send.stats.ok;
  const limited = Object.values(tg.lanes).reduce((n, l) => n + l.stats.limited, 0);

  peakBacklog = Math.max(peakBacklog, fake.backlog);
  peakSendQueue = Math.max(peakSendQueue, send.depth);
  peakOldest = Math.max(peakOldest, send.oldestAgeMs);
  peakLoopP99 = Math.max(peakLoopP99, p99);

  console.log(
    `${elapsed()}s ${String(fake.confirmed).padStart(8)} ${String(fake.backlog).padStart(8)} ${String(send.depth).padStart(11)} ${(send.oldestAgeMs / 1000).toFixed(0).padStart(6)}s ${sendRate.toFixed(0).padStart(7)} ${String(tg.lanes.lookup.depth).padStart(13)} ${String(verified).padStart(9)} ${String(limited).padStart(5)} ${p99.toFixed(0).padStart(7)}ms`,
  );

  const arrivalsOver = Date.now() - t0 > (ARRIVAL_S + 7) * 1000;
  const ingested = arrivalsOver && fake.backlog === 0 && fake.confirmed >= totalUpdates();
  if (ingested && !ingestDoneAt) ingestDoneAt = Date.now();
  const idle = Object.values(tg.lanes).every((l) => l.depth === 0);
  const outbox = await sql<{ n: number }>`SELECT count(*) AS n FROM outbox WHERE status = 'pending'`.execute(db);
  if (ingested && idle && outbox.rows[0]!.n === 0 && verified >= expectedVerified) break;
  if (Date.now() - t0 > TIMEOUT_S * 1000) {
    console.log("\nTIMEOUT: stopping before everything drained.");
    break;
  }
}
clearInterval(refreshCodes);
const drainedAt = Date.now();

// ---- verdict ----

const one = async (q: RawBuilder<unknown>) => ((await q.execute(db)).rows[0] as { n: number }).n;
const verified = await one(sql`SELECT count(*) AS n FROM participants WHERE contest_id = ${contestId} AND verified_at IS NOT NULL`);
const participants = await one(sql`SELECT count(*) AS n FROM participants WHERE contest_id = ${contestId}`);
const mismatched = await one(sql`
  SELECT count(*) AS n FROM participants p
   WHERE p.contest_id = ${contestId}
     AND p.invite_count <> (SELECT count(*) FROM participants i WHERE i.referred_by = p.id AND i.verified_at IS NOT NULL)
`);
const qualified = await one(sql`SELECT count(*) AS n FROM participants WHERE contest_id = ${contestId} AND qualified_at IS NOT NULL`);
const shouldQualify = await one(sql`
  SELECT count(*) AS n FROM participants WHERE contest_id = ${contestId} AND verified_at IS NOT NULL AND invite_count >= ${REQUIRED_INVITES}
`);
const qualifiedSent = await one(sql`SELECT count(*) AS n FROM outbox WHERE status = 'sent' AND dedupe_key LIKE 'qualified:%'`);

const checks: [string, boolean, string][] = [
  ["every user has a participant row", participants === USERS, `${participants} / ${USERS}`],
  ["everyone who subscribed is verified", verified === expectedVerified, `${verified} / ${expectedVerified}`],
  ["invite counts match the referral records", mismatched === 0, `${mismatched} mismatched`],
  ["everyone at the requirement is qualified", qualified === shouldQualify, `${qualified} / ${shouldQualify}`],
  ["every qualified user got the durable message", qualifiedSent === qualified, `${qualifiedSent} / ${qualified}`],
  ["no update was dropped", app.poller.stats.dropped === 0, `${app.poller.stats.dropped} dropped`],
];

const ingestS = ((ingestDoneAt || drainedAt) - t0) / 1000;
console.log(`
Updates handled        ${fake.confirmed} (${(fake.confirmed / ingestS).toFixed(0)}/s average over ${ingestS.toFixed(0)}s)
Peak update backlog    ${peakBacklog}
Peak send queue        ${peakSendQueue} messages, oldest waited ${(peakOldest / 1000).toFixed(0)}s
Everything delivered   ${((drainedAt - t0) / 1000).toFixed(0)}s after the first arrival
Telegram calls         send ${fake.count("sendMessage")}, edit ${fake.count("editMessageText")}, answer ${fake.count("answerCallbackQuery")}, getChatMember ${fake.count("getChatMember")}
429 responses          ${Object.entries(fake.limited).map(([m, n]) => `${m} ${n}`).join(", ") || "none"}
Notices dropped        ${tg.lanes.send.stats.dropped}
Final send rate        ${tg.lanes.send.rate.toFixed(1)}/s
Event loop lag p99     ${peakLoopP99.toFixed(0)}ms (worst 5s window)
Memory (RSS)           ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB, including the generator and fake server
`);
for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name} (${detail})`);

await app.stop();
await fake.close();
process.exit(checks.every((c) => c[1]) ? 0 : 1);
