/**
 * Local demo: the bot and admin panel running against the fake Telegram server, with a
 * contest and some participants already in place. No bot token needed.
 *
 *   npm run demo        then open the printed link
 *
 * Uses (and wipes) its own database, contest_bot_demo_test (createdb it once), so it can
 * run while the tests do.
 */
import { sql } from "kysely";
import { ADMIN_ID, boot, PRIZE_CHAT, SPONSOR_A, waitFor } from "../test/harness.js";
import { sha256 } from "../src/util.js";

const PORT = process.env.PORT ?? "3100";
const TOKEN = "demo-login-token-not-a-secret";

const h = await boot({ PORT, PUBLIC_URL: `http://localhost:${PORT}`, DEFAULT_LOCALE: "uz" });
const { db } = h.app.deps;
await h.seedContest(3);

const verifiedCode = async (userId: number) =>
  (
    await waitFor(async () => {
      const p = await h.participant(userId);
      return p?.verified_at ? p : null;
    }, `user ${userId} verified`)
  ).ref_code;

// Three referrers with different results, plus people who never finished the gate.
h.join(100);
h.join(200);
h.join(300);
const [a, b, c] = [await verifiedCode(100), await verifiedCode(200), await verifiedCode(300)];
for (let i = 0; i < 7; i++) h.join(1000 + i, a);
for (let i = 0; i < 3; i++) h.join(2000 + i, b);
h.join(3000, c);
for (let i = 0; i < 6; i++) h.fake.push(h.fake.start(4000 + i, i % 2 ? a : ""));
h.fake.push(h.fake.start(4100, b));
h.fake.push(h.fake.memberChange(SPONSOR_A, 4100, true));
h.fake.push(h.fake.click(4100, "check"));

await waitFor(async () => (await h.participant(100))?.invite_count === 7, "invites counted");
await waitFor(async () => (await h.participant(200))?.qualified_at, "second referrer qualified");
h.fake.push(h.fake.joinRequest(PRIZE_CHAT, 100));
h.fake.push(h.fake.memberChange(SPONSOR_A, 2001, false)); // an invitee who left a sponsor
await waitFor(async () => (await h.participant(100))?.prize_joined_at, "prize chat joined");

// A few hundred more people spread over the last two days, so the charts, funnel and
// leaderboard have something to show. Inserted directly: the fake server is not needed.
const contestId = (await h.app.deps.cache.active())!.contest.id;
const NAMES = [
  "Aziza", "Bekzod", "Dilnoza", "Jasur", "Kamola", "Sardor", "Nilufar", "Otabek", "Madina", "Shahzod",
  "Gulnoza", "Javohir", "Malika", "Ulugbek", "Zarina", "Akmal", "Sevara", "Bobur", "Feruza", "Rustam",
  "Ivan", "Anna", "Dmitriy", "Olga", "Timur", "Laylo", "Diyor", "Mohira", "Sanjar", "Charos",
];
await sql`
  UPDATE users SET first_name = (${NAMES}::text[])[1 + (tg_id % ${NAMES.length})],
                   lang = (ARRAY['uz','uz','ru','en','uz'])[1 + (tg_id % 5)]
`.execute(db);
await sql`
  INSERT INTO users (tg_id, first_name, username, lang)
  SELECT 50000 + g, (${NAMES}::text[])[1 + (g % ${NAMES.length})],
         CASE WHEN g % 3 = 0 THEN 'user' || g END,
         (ARRAY['uz','uz','ru','en','uz','ru','uz'])[1 + (g % 7)]
    FROM generate_series(1, 420) g
`.execute(db);
await sql`
  WITH times AS (
    SELECT g, now() - interval '46 hours' * power(random(), 1.6) AS t FROM generate_series(1, 420) g
  )
  INSERT INTO participants (contest_id, user_id, ref_code, verified_at, created_at)
  SELECT ${contestId}, 50000 + g, 'demo' || g,
         CASE WHEN random() < 0.72 THEN t + interval '1 minute' * (1 + random() * 20) END, t
    FROM times
`.execute(db);
// The first 40 demo people brought in the rest.
await sql`
  UPDATE participants i SET referred_by = (
    SELECT r.id FROM participants r
     WHERE r.contest_id = i.contest_id AND r.user_id BETWEEN 50001 AND 50040 AND r.verified_at IS NOT NULL
     ORDER BY md5(i.id::text || r.id::text) LIMIT 1)
   WHERE i.contest_id = ${contestId} AND i.user_id > 50040 AND random() < 0.8
`.execute(db);
await sql`
  UPDATE participants p SET invite_count = (
    SELECT count(*) FROM participants i WHERE i.referred_by = p.id AND i.verified_at IS NOT NULL)
   WHERE p.contest_id = ${contestId} AND p.user_id > 50000
`.execute(db);
await sql`
  UPDATE participants p SET qualified_at = GREATEST(p.verified_at, (
    SELECT max(i.verified_at) FROM participants i WHERE i.referred_by = p.id))
   WHERE p.contest_id = ${contestId} AND p.user_id > 50000 AND p.verified_at IS NOT NULL
     AND p.invite_count >= (SELECT required_invites FROM contests WHERE id = ${contestId})
`.execute(db);
await sql`
  UPDATE participants SET prize_joined_at = qualified_at + interval '3 minutes'
   WHERE contest_id = ${contestId} AND qualified_at IS NOT NULL AND user_id % 3 <> 0
`.execute(db);
await sql`UPDATE contests SET title = 'Bahor tanlovi 2026', started_at = now() - interval '47 hours' WHERE id = ${contestId}`.execute(db);
h.app.deps.cache.invalidate();

await sql`
  INSERT INTO admin_login_tokens (token_hash, tg_id, expires_at)
  VALUES (${sha256(TOKEN)}, ${ADMIN_ID}, now() + interval '1 day')
`.execute(db);

console.log(`\nDemo is running. Open:\n\n  http://localhost:${PORT}/admin/login?token=${TOKEN}\n\nCtrl+C to stop.`);

process.on("SIGINT", () => void h.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void h.stop().then(() => process.exit(0)));
