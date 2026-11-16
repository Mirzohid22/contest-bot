import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, type Harness, PRIZE_CHAT, waitFor } from "./harness.js";

/**
 * 30 people qualify at the same moment, then all 30 ask to join the prize chat at once,
 * with the production lane rates and a fake Telegram that enforces limits and adds latency.
 * A newcomer pressing /start in the middle must not wait behind any of it.
 */
const N = 30;
let h: Harness;

beforeAll(async () => {
  h = await boot(
    {
      // Production defaults (the harness otherwise runs everything at test speed).
      SEND_RATE: "25",
      SEND_RATE_MAX: "30",
      CALLBACK_RATE: "100",
      CALLBACK_RATE_MAX: "300",
      LOOKUP_RATE: "20",
      LOOKUP_RATE_MAX: "60",
      MANAGE_RATE: "10",
      MANAGE_RATE_MAX: "20",
      PER_CHAT_MS: "1000",
    },
    {
      latencyMs: 60,
      limits: { send: 30, manage: 20 },
      groups: {
        sendMessage: "send",
        editMessageText: "send",
        sendPhoto: "send",
        createChatInviteLink: "manage",
        revokeChatInviteLink: "manage",
        approveChatJoinRequest: "manage",
        declineChatJoinRequest: "manage",
      },
    },
  );
}, 60_000);
afterAll(async () => {
  await h.stop();
});

const verifiedCode = async (userId: number) =>
  (await waitFor(async () => {
    const p = await h.participant(userId);
    return p?.verified_at ? p : null;
  }, `user ${userId} verified`, 30_000)).ref_code;

describe("burst of 30 on the prize path", () => {
  it("serves everyone in parallel and keeps newcomers fast", async () => {
    await h.seedContest(1);
    const referrers = Array.from({ length: N }, (_, i) => 10_000 + i);
    for (const r of referrers) h.join(r);
    const codes = await Promise.all(referrers.map(verifiedCode));
    await waitFor(() => h.fake.backlog === 0, "setup drained", 30_000);
    // Let the setup's own messages leave the send queue first.
    await new Promise((r) => setTimeout(r, 4000));

    // 1. Thirty friends finish at the same moment: thirty referrers qualify together.
    const t0 = Date.now();
    referrers.forEach((_, i) => h.join(20_000 + i, codes[i]));
    // A newcomer arrives in the middle of it.
    setTimeout(() => h.fake.push(h.fake.start(99_999)), 300);

    const qualifiedMsgs = () =>
      referrers.map((r) => h.fake.sent(r).find((c) => c.payload.text.includes("met the requirements")));
    await waitFor(() => qualifiedMsgs().every(Boolean), "all 30 qualified messages", 60_000);
    const tQualified = Date.now() - t0;
    const links = qualifiedMsgs().map((m) => m!.payload.reply_markup.inline_keyboard[0][0].url as string);
    expect(new Set(links).size).toBe(N); // thirty different personal links

    const newcomer = h.fake.calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === 99_999)!;
    const tNewcomer = newcomer.at - (t0 + 300);

    // 2. All thirty ask to join at once, plus ten people trying a link that is not theirs.
    const t1 = Date.now();
    referrers.forEach((r, i) => h.fake.push(h.fake.joinRequest(PRIZE_CHAT, r, links[i])));
    for (let i = 0; i < 10; i++) h.fake.push(h.fake.joinRequest(PRIZE_CHAT, 30_000 + i, links[i]));
    await waitFor(() => h.fake.count("approveChatJoinRequest") === N, "30 approvals", 60_000);
    const tApproved = Date.now() - t1;
    await waitFor(() => h.fake.count("declineChatJoinRequest") === 10, "10 declines", 60_000);
    await waitFor(() => h.fake.count("revokeChatInviteLink") === N, "30 revokes", 60_000);
    const tAll = Date.now() - t1;

    const report = {
      "30 qualify at once → all have their personal link (s)": tQualified / 1000,
      "newcomer /start reply during the burst (s)": tNewcomer / 1000,
      "30 join requests → all approved (s)": tApproved / 1000,
      "…and 10 strangers declined, 30 links revoked (s)": tAll / 1000,
      "429s from fake Telegram": h.fake.limited,
    };
    if (process.env.BURST_REPORT) writeFileSync(process.env.BURST_REPORT, JSON.stringify(report, null, 2));

    expect(tNewcomer).toBeLessThan(3000);
    expect(tQualified).toBeLessThan(20_000);
    expect(tApproved).toBeLessThan(10_000);
  }, 180_000);
});
