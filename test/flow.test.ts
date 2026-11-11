import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { credit } from "../src/contest/service.js";
import type { Contest } from "../src/db/types.js";
import { boot, type Harness, PRIZE_CHAT, SPONSOR_A, SPONSOR_B, waitFor } from "./harness.js";

let h: Harness;

beforeAll(async () => {
  h = await boot();
});
afterAll(async () => {
  await h.stop();
});

const verified = (userId: number) => async () => (await h.participant(userId))?.verified_at;

describe("contest flow", () => {
  it("answers /start with a notice when no contest is active", async () => {
    h.fake.push(h.fake.start(50));
    const [msg] = await waitFor(() => h.fake.sent(50), "reply to /start");
    expect(msg!.payload.text).toContain("no active contest");
  });

  it("gates, verifies, counts invites, qualifies, and controls prize access", async () => {
    await h.seedContest(2);

    // 1. /start shows the gate: one button per sponsor plus the check button.
    h.fake.push(h.fake.start(100));
    const [gate] = await waitFor(() => h.fake.sent(100), "gate message");
    const buttons = gate!.payload.reply_markup.inline_keyboard.flat();
    expect(buttons.map((b: any) => b.url ?? b.callback_data)).toEqual([
      "https://t.me/sponsor_a",
      "https://t.me/sponsor_b",
      "check",
    ]);

    // 2. Clicking without subscribing: Telegram is asked, the answer is "not a member".
    h.fake.push(h.fake.click(100, "check"));
    const [edit] = await waitFor(() => h.fake.sent(100, "editMessageText"), "gate edit");
    expect(edit!.payload.text).toContain("Not subscribed yet: Sponsor A, Sponsor B");
    expect((await h.participant(100))!.verified_at).toBeNull();

    // 3. Subscribing to only one channel is not enough.
    h.fake.push(h.fake.memberChange(SPONSOR_A, 100, true));
    h.fake.push(h.fake.click(100, "check"));
    await waitFor(() => h.fake.sent(100, "editMessageText").length === 2, "second gate edit");
    expect(h.fake.sent(100, "editMessageText")[1]!.payload.text).toContain("Not subscribed yet: Sponsor B");

    // 4. Both channels: verified, and the message becomes the personal link.
    h.fake.push(h.fake.memberChange(SPONSOR_B, 100, true));
    h.fake.push(h.fake.click(100, "check"));
    await waitFor(verified(100), "user 100 verified");
    const me = (await h.participant(100))!;
    const status = await waitFor(
      () => h.fake.sent(100, "editMessageText").find((c) => c.payload.text.includes(me.ref_code)),
      "status view",
    );
    expect(status.payload.text).toContain(`https://t.me/${h.fake.botUsername}?start=${me.ref_code}`);
    expect(status.payload.text).toContain("0 / 2");

    // 5. A friend who starts with the link but does not subscribe is not counted.
    h.fake.push(h.fake.start(201, me.ref_code));
    await waitFor(() => h.participant(201), "participant 201");
    expect((await h.participant(100))!.invite_count).toBe(0);

    // 6. Two friends complete the gate: the count reaches the requirement.
    h.fake.push(h.fake.memberChange(SPONSOR_A, 201, true));
    h.fake.push(h.fake.memberChange(SPONSOR_B, 201, true));
    h.fake.push(h.fake.click(201, "check"));
    await waitFor(async () => (await h.participant(100))!.invite_count === 1, "first invite");
    expect((await h.participant(100))!.qualified_at).toBeNull();
    await waitFor(() => h.fake.sent(100).some((c) => c.payload.text.includes("1 / 2")), "progress notice");

    h.join(202, me.ref_code);
    await waitFor(async () => (await h.participant(100))!.qualified_at, "user 100 qualified");
    expect((await h.participant(100))!.invite_count).toBe(2);

    // 7. The durable "you qualified" message carries the prize link.
    const congrats = await waitFor(
      () => h.fake.sent(100).find((c) => c.payload.text.includes("Congratulations")),
      "qualified message",
    );
    expect(congrats.payload.reply_markup.inline_keyboard[0][0].url).toBe("https://t.me/+prize");

    // 8. The same prize link admits the qualified user and nobody else.
    h.fake.push(h.fake.joinRequest(PRIZE_CHAT, 100));
    h.fake.push(h.fake.joinRequest(PRIZE_CHAT, 201));
    h.fake.push(h.fake.joinRequest(PRIZE_CHAT, 999)); // never used the bot
    await waitFor(() => h.fake.count("approveChatJoinRequest") === 1, "approval");
    await waitFor(() => h.fake.count("declineChatJoinRequest") === 2, "declines");
    const approved = h.fake.calls.find((c) => c.method === "approveChatJoinRequest")!;
    expect(approved.payload.user_id).toBe(100);
    expect((await h.participant(100))!.prize_joined_at).not.toBeNull();
    await waitFor(() => h.fake.sent(999).some((c) => c.payload.text.includes("declined")), "decline message");
  });

  it("ignores repeated clicks and repeated credits", async () => {
    const referrer = (await h.participant(100))!;
    const before = referrer.invite_count;

    h.join(203, referrer.ref_code);
    for (let i = 0; i < 5; i++) h.fake.push(h.fake.click(203, "check"));
    await waitFor(verified(203), "user 203 verified");
    await waitFor(() => h.fake.backlog === 0, "all clicks handled");
    expect((await h.participant(100))!.invite_count).toBe(before + 1);

    // The transaction itself, hammered concurrently, still credits once.
    h.fake.push(h.fake.start(204, referrer.ref_code));
    const p204 = await waitFor(() => h.participant(204), "participant 204");
    const contest = (await h.app.deps.cache.active())!.contest as Contest;
    const results = await Promise.all(Array.from({ length: 20 }, () => credit(h.app.deps.db, contest, p204.id)));
    expect(results.filter((r) => r.verifiedNow)).toHaveLength(1);
    expect((await h.participant(100))!.invite_count).toBe(before + 2);
  });

  it("fixes the referrer at first contact and rejects self-referral and unknown codes", async () => {
    const a = (await h.participant(100))!;
    const b = (await h.participant(201))!;

    // Unknown code.
    h.fake.push(h.fake.start(301, "no-such-code"));
    expect((await waitFor(() => h.participant(301), "participant 301")).referred_by).toBeNull();

    // A second /start with another link does not change the referrer.
    h.fake.push(h.fake.start(302, a.ref_code));
    await waitFor(() => h.participant(302), "participant 302");
    h.fake.push(h.fake.start(302, b.ref_code));
    await waitFor(() => h.fake.sent(302).length === 2, "second reply to 302");
    expect((await h.participant(302))!.referred_by).toBe(a.id);

    // Own link: user 100 already exists, so nothing changes; and a brand-new user cannot
    // know their own code before the first /start.
    h.fake.push(h.fake.start(100, a.ref_code));
    await waitFor(() => h.fake.backlog === 0, "start handled");
    expect((await h.participant(100))!.referred_by).toBeNull();
  });

  it("verifies an existing subscriber through getChatMember, then answers from the table", async () => {
    // Subscribed before the bot could see it: no chat_member event, no row.
    h.fake.setMember(SPONSOR_A, 400);
    h.fake.setMember(SPONSOR_B, 400);
    h.fake.push(h.fake.start(400));
    h.fake.push(h.fake.click(400, "check"));
    await waitFor(verified(400), "user 400 verified");

    const lookups = h.fake.count("getChatMember");
    h.fake.push(h.fake.click(400, "check"));
    h.fake.push(h.fake.click(400, "progress"));
    await waitFor(() => h.fake.backlog === 0, "clicks handled");
    expect(h.fake.count("getChatMember")).toBe(lookups);
  });

  it("keeps an exact count when many friends finish at the same time", async () => {
    const referrer = (await h.participant(400))!;
    const N = 150;
    for (let i = 0; i < N; i++) h.join(5000 + i, referrer.ref_code);

    await waitFor(async () => (await h.participant(400))!.invite_count === N, "all invites counted", 20_000);
    await waitFor(() => h.fake.backlog === 0, "backlog drained");

    const truth = await sql<{ n: number }>`
      SELECT count(*) AS n FROM participants WHERE referred_by = ${referrer.id} AND verified_at IS NOT NULL
    `.execute(h.app.deps.db);
    expect(truth.rows[0]!.n).toBe(N);
    expect((await h.participant(400))!.invite_count).toBe(N);
  });

  it("declines a qualified user who left a sponsor channel", async () => {
    h.fake.push(h.fake.memberChange(SPONSOR_A, 400, false));
    await waitFor(() => h.fake.backlog === 0, "leave handled");
    const declines = h.fake.count("declineChatJoinRequest");
    h.fake.push(h.fake.joinRequest(PRIZE_CHAT, 400));
    await waitFor(() => h.fake.count("declineChatJoinRequest") === declines + 1, "decline");
    await waitFor(() => h.fake.sent(400).some((c) => c.payload.text.includes("no longer subscribed")), "reason");
  });

  it("skips a sponsor channel where the bot lost admin rights, and tells the admins", async () => {
    h.fake.push(h.fake.botAdminChange(SPONSOR_B, false));
    await waitFor(() => h.fake.sent(1).some((c) => c.payload.text.includes("no longer an admin")), "admin alert");

    // Only Sponsor A is checked now.
    h.fake.push(h.fake.start(600));
    h.fake.push(h.fake.memberChange(SPONSOR_A, 600, true));
    h.fake.push(h.fake.click(600, "check"));
    await waitFor(verified(600), "user 600 verified with one sponsor skipped");

    h.fake.push(h.fake.botAdminChange(SPONSOR_B, true));
    await waitFor(() => h.fake.sent(1).some((c) => c.payload.text.includes("again")), "recovery alert");
  });

  it("starts a new contest from zero without touching the old one", async () => {
    const oldCode = (await h.participant(100))!.ref_code;
    const old = await sql<{ n: number }>`SELECT count(*) AS n FROM participants`.execute(h.app.deps.db);

    const newId = await h.seedContest(1);
    expect(await h.participant(100)).toBeUndefined();

    // An old link starts the user in the new contest with no referrer.
    h.fake.push(h.fake.start(700, oldCode));
    const p = await waitFor(() => h.participant(700), "participant in new contest");
    expect(p.contest_id).toBe(newId);
    expect(p.referred_by).toBeNull();

    // User 100 is a fresh participant with a new code and a zero count.
    h.fake.push(h.fake.start(100));
    const again = await waitFor(() => h.participant(100), "user 100 in new contest");
    expect(again.invite_count).toBe(0);
    expect(again.ref_code).not.toBe(oldCode);
    // They are still subscribed (membership is global), so one click verifies them.
    h.fake.push(h.fake.click(100, "check"));
    await waitFor(verified(100), "user 100 verified in new contest");

    const total = await sql<{ n: number }>`SELECT count(*) AS n FROM participants`.execute(h.app.deps.db);
    expect(total.rows[0]!.n).toBe(old.rows[0]!.n + 2);
  });
});
