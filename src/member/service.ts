import { GrammyError } from "grammy";
import { sql } from "kysely";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import type { Sponsor } from "../db/types.js";
import type { MemberEvent } from "../ingest/poller.js";
import type { Tg } from "../tg/gateway.js";

export interface CheckResult {
  /** Known not to be a member, recently enough to trust. */
  missing: Sponsor[];
  /** No trustworthy local answer: needs a getChatMember call. */
  unknown: Sponsor[];
}

/**
 * Answers "is this user subscribed to these channels?".
 *
 * Source 1 is the channel_members table, fed by chat_member updates (push): a primary-key
 * lookup, no Telegram call. Source 2 is getChatMember, used only when the table has no
 * answer or an old negative one.
 */
export class Membership {
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly db: Db,
    private readonly tg: Tg,
    private readonly cfg: Config,
    private readonly log: Logger,
    /** Called when a channel cannot be checked at all (bot is not an admin there any more). */
    private readonly onUnhealthy: (chatId: number, reason: string) => void,
  ) {}

  /** Local answer only. Unhealthy channels are skipped, so one broken sponsor cannot block everyone. */
  async check(userId: number, sponsors: Sponsor[]): Promise<CheckResult> {
    const healthy = sponsors.filter((s) => s.health === "ok");
    const result: CheckResult = { missing: [], unknown: [] };
    if (healthy.length === 0) return result;

    const rows = await sql<{ chat_id: number; is_member: boolean; updated_at: Date }>`
      SELECT chat_id, is_member, updated_at FROM channel_members
       WHERE user_id = ${userId} AND chat_id = ANY(${healthy.map((s) => s.chat_id)}::bigint[])
    `.execute(this.db);
    const byChat = new Map(rows.rows.map((r) => [r.chat_id, r]));

    const now = Date.now();
    for (const s of healthy) {
      const row = byChat.get(s.chat_id);
      if (!row) result.unknown.push(s);
      else if (row.is_member) continue;
      else if (now - row.updated_at.getTime() < this.cfg.NEGATIVE_TTL_MS) result.missing.push(s);
      // An old "not a member" may be a join event we never received: ask Telegram.
      else result.unknown.push(s);
    }
    return result;
  }

  /** Asks Telegram about each channel and returns those the user is not in. */
  async resolve(userId: number, sponsors: Sponsor[]): Promise<Sponsor[]> {
    const answers = await Promise.all(sponsors.map((s) => this.lookup(s.chat_id, userId)));
    return sponsors.filter((_, i) => !answers[i]);
  }

  /** One getChatMember call per (channel, user) at a time, however many clicks arrive. */
  lookup(chatId: number, userId: number): Promise<boolean> {
    const key = `${chatId}:${userId}`;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.fetch(chatId, userId).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async fetch(chatId: number, userId: number): Promise<boolean> {
    let isMember: boolean;
    try {
      const m = await this.tg.getChatMember(chatId, userId);
      isMember =
        m.status === "creator" ||
        m.status === "administrator" ||
        m.status === "member" ||
        (m.status === "restricted" && m.is_member);
    } catch (err) {
      if (!(err instanceof GrammyError)) throw err;
      const d = err.description.toLowerCase();
      if (err.error_code === 400 && (d.includes("user not found") || d.includes("participant_id_invalid") || d.includes("member not found"))) {
        isMember = false;
      } else if (
        err.error_code === 403 ||
        d.includes("chat not found") ||
        d.includes("chat_admin_required") ||
        d.includes("member list is inaccessible")
      ) {
        // The channel itself cannot be checked. Let the user through and tell the admins.
        this.onUnhealthy(chatId, err.description);
        return true;
      } else {
        throw err;
      }
    }
    await sql`
      INSERT INTO channel_members (chat_id, user_id, is_member, source, updated_at)
      VALUES (${chatId}, ${userId}, ${isMember}, 'api', now())
      ON CONFLICT (chat_id, user_id) DO UPDATE
        SET is_member = EXCLUDED.is_member, source = 'api', updated_at = EXCLUDED.updated_at
        WHERE channel_members.updated_at <= EXCLUDED.updated_at
    `.execute(this.db);
    return isMember;
  }

  /**
   * Stores a batch of chat_member updates in one statement. The date guard makes a
   * redelivered or out-of-order event unable to overwrite a newer one. Within the same
   * second the later arrival wins, which is the order Telegram sent them in.
   */
  async applyEvents(events: MemberEvent[]): Promise<void> {
    const latest = new Map<string, MemberEvent>();
    for (const e of events) {
      const key = `${e.chatId}:${e.userId}`;
      const prev = latest.get(key);
      if (!prev || prev.at <= e.at) latest.set(key, e);
    }
    const list = [...latest.values()];
    if (list.length === 0) return;
    await sql`
      INSERT INTO channel_members (chat_id, user_id, is_member, source, updated_at)
      SELECT c, u, m, 'push', t
        FROM unnest(
          ${list.map((e) => e.chatId)}::bigint[],
          ${list.map((e) => e.userId)}::bigint[],
          ${list.map((e) => e.isMember)}::boolean[],
          ${list.map((e) => e.at.toISOString())}::timestamptz[]
        ) AS x(c, u, m, t)
      ON CONFLICT (chat_id, user_id) DO UPDATE
        SET is_member = EXCLUDED.is_member, source = 'push', updated_at = EXCLUDED.updated_at
        -- Telegram dates are whole seconds, our own rows are not: compare at second precision,
        -- or a leave in the same second as a getChatMember answer would be thrown away.
        WHERE date_trunc('second', channel_members.updated_at) <= EXCLUDED.updated_at
    `.execute(this.db);
  }
}
