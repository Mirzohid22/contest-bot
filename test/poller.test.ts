import type { Api } from "grammy";
import type { Update } from "grammy/types";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { Poller } from "../src/ingest/poller.js";

const log = pino({ level: "silent" });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const msg = (update_id: number, userId: number): Update =>
  ({ update_id, message: { message_id: update_id, date: 0, chat: { id: userId, type: "private" }, from: { id: userId } } }) as Update;

/** A Bot API stub that serves the given batches, then long-polls until aborted. */
function stubApi(batches: Update[][]) {
  const offsets: number[] = [];
  let i = 0;
  const api = {
    async getUpdates(args: { offset: number; timeout: number }, signal?: AbortSignal) {
      offsets.push(args.offset);
      if (i < batches.length) return batches[i++]!;
      if (args.timeout === 0) return [];
      await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      return [];
    },
  } as unknown as Api;
  return { api, offsets };
}

async function run(batches: Update[][], handle: (u: Update) => Promise<void>) {
  const { api, offsets } = stubApi(batches);
  const poller = new Poller(api, async () => {}, handle, log);
  poller.start();
  // Wait until the stub has served everything and is parked in the long poll.
  for (let n = 0; n < 400 && offsets.length <= batches.length; n++) await tick();
  await poller.stop();
  return { offsets, poller };
}

describe("Poller", () => {
  it("acknowledges a batch only after every update in it was handled", async () => {
    const handled: number[] = [];
    let offsetsSeenWhileHandling: number[] = [];
    const { api, offsets } = stubApi([[msg(10, 1), msg(11, 2)]]);
    const poller = new Poller(
      api,
      async () => {},
      async (u) => {
        await tick(30);
        offsetsSeenWhileHandling = [...offsets];
        handled.push(u.update_id);
      },
      log,
    );
    poller.start();
    for (let n = 0; n < 200 && offsets.length < 2; n++) await tick();
    await poller.stop();

    expect(handled.sort()).toEqual([10, 11]);
    // While handlers ran, only the first request (offset 0) had been made.
    expect(offsetsSeenWhileHandling).toEqual([0]);
    expect(offsets[1]).toBe(12);
  });

  it("keeps one user's updates in order and runs different users concurrently", async () => {
    const log1: string[] = [];
    await run([[msg(1, 7), msg(2, 8), msg(3, 7), msg(4, 7)]], async (u) => {
      log1.push(`start ${u.update_id}`);
      await tick(u.update_id === 1 ? 40 : 5);
      log1.push(`end ${u.update_id}`);
    });
    // User 7: 1 fully finishes before 3 starts, 3 before 4.
    expect(log1.indexOf("end 1")).toBeLessThan(log1.indexOf("start 3"));
    expect(log1.indexOf("end 3")).toBeLessThan(log1.indexOf("start 4"));
    // User 8 did not wait for user 7's slow update.
    expect(log1.indexOf("end 2")).toBeLessThan(log1.indexOf("end 1"));
  });

  it("retries a failed update without re-running the ones that succeeded", async () => {
    const calls = new Map<number, number>();
    const { offsets } = await run([[msg(1, 1), msg(2, 2)]], async (u) => {
      const n = (calls.get(u.update_id) ?? 0) + 1;
      calls.set(u.update_id, n);
      if (u.update_id === 2 && n === 1) throw new Error("database hiccup");
    });
    expect(calls.get(1)).toBe(1);
    expect(calls.get(2)).toBe(2);
    expect(offsets[1]).toBe(3);
  });

  it("gives up on an update that always fails, so it cannot block the queue", async () => {
    let attempts = 0;
    const handled: number[] = [];
    const { offsets, poller } = await run([[msg(1, 1)], [msg(2, 1)]], async (u) => {
      if (u.update_id === 1) {
        attempts++;
        throw new Error("poison");
      }
      handled.push(u.update_id);
    });
    expect(attempts).toBe(3);
    expect(handled).toEqual([2]);
    expect(poller.stats.dropped).toBe(1);
    expect(offsets).toContain(3);
  });

  it("stores membership changes before handling clicks from the same batch", async () => {
    const order: string[] = [];
    const member = {
      update_id: 1,
      chat_member: {
        chat: { id: -100, type: "channel", title: "c" },
        from: { id: 5 },
        date: 1_700_000_000,
        old_chat_member: { user: { id: 5 }, status: "left" },
        new_chat_member: { user: { id: 5 }, status: "member" },
      },
    } as unknown as Update;
    const { api, offsets } = stubApi([[msg(2, 5), member]]);
    const poller = new Poller(
      api,
      async (events) => {
        await tick(20);
        order.push(`members:${events[0]!.chatId}:${events[0]!.userId}:${events[0]!.isMember}`);
      },
      async () => {
        order.push("click");
      },
      log,
    );
    poller.start();
    for (let n = 0; n < 200 && offsets.length < 2; n++) await tick();
    await poller.stop();
    expect(order).toEqual(["members:-100:5:true", "click"]);
  });
});
