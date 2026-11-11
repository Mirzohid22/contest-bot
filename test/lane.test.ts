import { describe, expect, it } from "vitest";
import { Dropped, Lane, RateLimited } from "../src/tg/lane.js";

const lane = (o: Partial<ConstructorParameters<typeof Lane>[0]> = {}) =>
  new Lane({ name: "t", rate: 100, minRate: 1, maxRate: 100, maxInflight: 50, priorities: 2, ...o });

describe("Lane", () => {
  it("does not exceed its rate", async () => {
    const l = lane({ rate: 100 });
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 80 }, () => l.schedule(async () => 1)));
    // The bucket holds a third of a second (33 calls); the other 47 need about 470 ms.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(l.stats.ok).toBe(80);
  });

  it("runs urgent jobs before earlier, less urgent ones", async () => {
    const l = lane({ rate: 20 });
    const order: string[] = [];
    const jobs = [];
    for (let i = 0; i < 12; i++) jobs.push(l.schedule(async () => order.push(`low${i}`), { priority: 1 }));
    jobs.push(l.schedule(async () => order.push("high"), { priority: 0 }));
    await Promise.all(jobs);
    // The first few low jobs used the initial tokens; "high" must beat everything still queued.
    expect(order.indexOf("high")).toBeLessThan(order.indexOf("low11"));
    expect(order.indexOf("high")).toBeLessThanOrEqual(7);
  });

  it("pauses on a 429, halves its rate, and still delivers the job", async () => {
    const l = lane({ rate: 100 });
    let calls = 0;
    const t0 = Date.now();
    const result = await l.schedule(async () => {
      if (++calls === 1) throw new RateLimited(0.3);
      return "done";
    });
    expect(result).toBe("done");
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(l.rate).toBe(50);
    expect(l.stats.limited).toBe(1);
  });

  it("drops jobs that waited longer than their max age", async () => {
    const l = lane({ rate: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => l.schedule(async () => "sent", { maxAgeMs: 60 })),
    );
    const sent = results.filter((r) => r.status === "fulfilled").length;
    const dropped = results.filter((r) => r.status === "rejected" && r.reason instanceof Dropped).length;
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(dropped).toBeGreaterThanOrEqual(1);
    expect(sent + dropped).toBe(4);
  });

  it("spaces messages to the same chat", async () => {
    const l = lane({ rate: 100, perChatMs: 150 });
    const t0 = Date.now();
    const times: number[] = [];
    await Promise.all([
      l.schedule(async () => times.push(Date.now() - t0), { chatId: 7 }),
      l.schedule(async () => times.push(Date.now() - t0), { chatId: 7 }),
      l.schedule(async () => times.push(Date.now() - t0), { chatId: 8 }),
    ]);
    times.sort((a, b) => a - b);
    expect(times[1]!).toBeLessThan(100); // the other chat is not held back
    expect(times[2]!).toBeGreaterThanOrEqual(140);
  });

  it("passes non-rate-limit errors to the caller", async () => {
    const l = lane();
    await expect(l.schedule(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(l.stats.failed).toBe(1);
  });
});
