import { type Api, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import type { Logger } from "pino";
import { sleep } from "../util.js";

export const ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "chat_member",
  "my_chat_member",
  "chat_join_request",
] as const;

export interface MemberEvent {
  chatId: number;
  userId: number;
  isMember: boolean;
  at: Date;
}

const BATCH_ATTEMPTS = 3;

/**
 * Long-polling loop with at-least-once delivery.
 *
 * A batch is acknowledged (by the next request's offset) only after every update in it
 * was handled. If the process dies mid-batch, Telegram sends the batch again, so every
 * handler must be safe to run twice.
 *
 * grammY's bot.start() handles one update at a time, and its runner plugin fetches the
 * next batch while earlier updates are still in flight; neither gives this guarantee
 * together with concurrency, hence this loop.
 */
export class Poller {
  readonly stats = { lastPollAt: 0, lastBatchSize: 0, lastBatchMs: 0, updates: 0, dropped: 0 };
  private readonly ac = new AbortController();
  private running: Promise<void> | null = null;

  constructor(
    private readonly raw: Api,
    private readonly onMembers: (events: MemberEvent[]) => Promise<void>,
    private readonly handle: (u: Update) => Promise<void>,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.running = this.loop().catch((err) => {
      this.log.fatal({ err }, "poller stopped");
      process.exitCode = 1;
      process.kill(process.pid, "SIGTERM");
    });
  }

  async stop(): Promise<void> {
    this.ac.abort();
    await this.running;
  }

  private async loop(): Promise<void> {
    let offset = 0;
    let unacked = false;
    while (!this.ac.signal.aborted) {
      let updates: Update[];
      try {
        updates = await this.raw.getUpdates(
          { offset, limit: 100, timeout: 30, allowed_updates: ALLOWED_UPDATES },
          // grammY types its signal with the abort-controller polyfill; Node's own is compatible.
          this.ac.signal as unknown as Parameters<Api["getUpdates"]>[1],
        );
        this.stats.lastPollAt = Date.now();
        unacked = false;
      } catch (err) {
        if (this.ac.signal.aborted) break;
        if (err instanceof GrammyError && err.error_code === 401) throw err; // bad token: no point retrying
        const wait =
          err instanceof GrammyError && err.error_code === 429
            ? (err.parameters?.retry_after ?? 1) * 1000
            : err instanceof GrammyError && err.error_code === 409
              ? 5000 // another process is polling with this token, or a webhook is set
              : 2000;
        this.log.warn({ err, wait }, "getUpdates failed");
        await sleep(wait);
        continue;
      }
      if (updates.length === 0) continue;

      const t0 = Date.now();
      await this.processBatch(updates);
      offset = updates[updates.length - 1]!.update_id + 1;
      unacked = true;
      this.stats.lastBatchSize = updates.length;
      this.stats.lastBatchMs = Date.now() - t0;
      this.stats.updates += updates.length;
    }
    // Confirm the last batch so a clean restart does not replay it.
    if (unacked) await this.raw.getUpdates({ offset, limit: 1, timeout: 0 }).catch(() => {});
  }

  private async processBatch(updates: Update[]): Promise<void> {
    let pending = updates;
    for (let attempt = 1; pending.length > 0; attempt++) {
      pending = await this.runOnce(pending);
      if (pending.length === 0) return;
      if (attempt >= BATCH_ATTEMPTS) {
        // A handler that keeps failing must not block everyone else forever.
        this.stats.dropped += pending.length;
        this.log.error({ ids: pending.map((u) => u.update_id) }, "giving up on updates after retries");
        return;
      }
      await sleep(200 * attempt);
    }
  }

  /** Handles the updates once and returns those that failed. */
  private async runOnce(updates: Update[]): Promise<Update[]> {
    const failed: Update[] = [];
    const memberUpdates: Update[] = [];
    const groups = new Map<number, Update[]>();

    for (const u of updates) {
      if (u.chat_member) {
        memberUpdates.push(u);
        continue;
      }
      const key = groupKey(u);
      const g = groups.get(key);
      if (g) g.push(u);
      else groups.set(key, [u]);
    }

    // Membership changes first, in one statement: a click in the same batch must see them.
    if (memberUpdates.length > 0) {
      try {
        await this.onMembers(memberUpdates.map(toMemberEvent));
      } catch (err) {
        this.log.warn({ err }, "member batch failed");
        failed.push(...memberUpdates);
      }
    }

    // One user's updates run in order; different users run concurrently.
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (let i = 0; i < group.length; i++) {
          try {
            await this.handle(group[i]!);
          } catch (err) {
            this.log.warn({ err, update_id: group[i]!.update_id }, "handler failed");
            failed.push(...group.slice(i));
            return;
          }
        }
      }),
    );
    return failed;
  }
}

function groupKey(u: Update): number {
  return (
    u.message?.from?.id ??
    u.callback_query?.from.id ??
    u.chat_join_request?.from.id ??
    u.my_chat_member?.chat.id ??
    u.update_id
  );
}

function toMemberEvent(u: Update): MemberEvent {
  const cm = u.chat_member!;
  const m = cm.new_chat_member;
  const isMember =
    m.status === "creator" ||
    m.status === "administrator" ||
    m.status === "member" ||
    (m.status === "restricted" && m.is_member);
  return { chatId: cm.chat.id, userId: m.user.id, isMember, at: new Date(cm.date * 1000) };
}
