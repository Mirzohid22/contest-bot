/**
 * Local demo: the bot and admin panel running against the fake Telegram server, with a
 * contest and some participants already in place. No bot token needed.
 *
 *   npm run demo        then open the printed link
 *
 * Uses (and wipes) the test database.
 */
import { sql } from "kysely";
import { ADMIN_ID, boot, PRIZE_CHAT, SPONSOR_A, waitFor } from "../test/harness.js";
import { sha256 } from "../src/util.js";

const PORT = process.env.PORT ?? "3100";
const TOKEN = "demo-login-token-not-a-secret";

const h = await boot({ PORT, PUBLIC_URL: `http://localhost:${PORT}` });
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

await sql`
  INSERT INTO admin_login_tokens (token_hash, tg_id, expires_at)
  VALUES (${sha256(TOKEN)}, ${ADMIN_ID}, now() + interval '1 day')
`.execute(db);

console.log(`\nDemo is running. Open:\n\n  http://localhost:${PORT}/admin/login?token=${TOKEN}\n\nCtrl+C to stop.`);

process.on("SIGINT", () => void h.stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void h.stop().then(() => process.exit(0)));
