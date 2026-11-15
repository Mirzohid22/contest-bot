import { GrammyError } from "grammy";
import { sql } from "kysely";
import type { Contest, JoinRequestRow, Participant } from "../db/types.js";
import type { Deps } from "../deps.js";
import { localeOf } from "../contest/service.js";
import { render, textsOf } from "../flow/texts.js";
import { P } from "../tg/gateway.js";
import { every } from "../util.js";

const MAX_ATTEMPTS = 5;

type Verdict =
  | { approve: true; personalLink: string | null }
  | { approve: false; reason: "not_qualified" | "left_sponsor" | "not_yours" | "use_own_link" };

/**
 * Decides prize-channel join requests. The invite link is shared by everyone, so this is
 * the actual access control: only qualified participants of the contest that owns the
 * chat are approved.
 */
export class JoinWorker {
  private readonly inflight = new Set<number>();
  private stopLoop: (() => Promise<void>) | null = null;

  constructor(private readonly d: Deps) {}

  start(): void {
    this.stopLoop = every(500, () => this.tick(), (err) => this.d.log.warn({ err }, "join tick failed"));
  }

  async stop(): Promise<void> {
    await this.stopLoop?.();
  }

  private async tick(): Promise<void> {
    const rows = await sql<JoinRequestRow>`
      SELECT id, chat_id, user_id, user_chat_id, invite_link, attempts FROM join_requests
       WHERE status = 'pending' AND id <> ALL(${[...this.inflight]}::bigint[])
       ORDER BY id LIMIT 50
    `.execute(this.d.db);
    for (const row of rows.rows) {
      this.inflight.add(row.id);
      void this.decide(row)
        .catch((err) => this.d.log.warn({ err, id: row.id }, "join decision failed"))
        .finally(() => this.inflight.delete(row.id));
    }
  }

  private async decide(r: JoinRequestRow): Promise<void> {
    const { db, tg } = this.d;
    const c = await sql<Contest>`
      SELECT * FROM contests
       WHERE prize_chat_id = ${r.chat_id} AND status IN ('active','finished')
       ORDER BY id DESC LIMIT 1
    `.execute(db);
    const contest = c.rows[0];
    // Not a prize chat of ours: leave the request for the chat's human admins.
    if (!contest) return this.finish(r.id, "ignored");

    const verdict = await this.judge(contest, r.user_id, r.invite_link);
    try {
      if (verdict.approve) {
        await tg.approveJoin(r.chat_id, r.user_id);
        await sql`
          UPDATE participants SET prize_joined_at = COALESCE(prize_joined_at, now()),
                 prize_link_used_at = CASE WHEN ${verdict.personalLink}::text IS NOT NULL
                                           THEN COALESCE(prize_link_used_at, now()) END
           WHERE contest_id = ${contest.id} AND user_id = ${r.user_id}
        `.execute(db);
        // A personal link has done its job: revoke it so it cannot be used again.
        if (verdict.personalLink) tg.fire(tg.revokeInviteLink(r.chat_id, verdict.personalLink));
        return this.finish(r.id, "approved");
      }
      await tg.declineJoin(r.chat_id, r.user_id);
      await this.finish(r.id, "declined", verdict.reason);
      const t = textsOf(contest, await localeOf(db, r.user_id, this.d.cfg.DEFAULT_LOCALE));
      const botLink = `https://t.me/${this.d.me.username}`;
      const text = {
        left_sponsor: t.declined_sponsors,
        use_own_link: t.declined_use_own,
        not_yours: render(t.declined_not_yours, { bot_link: botLink }),
        not_qualified: render(t.declined, { bot_link: botLink }),
      }[verdict.reason];
      // Telegram lets the bot write to user_chat_id for a few minutes after the request.
      tg.fire(tg.send(r.user_chat_id, text, { priority: P.IMPORTANT, maxAgeMs: 4 * 60_000 }));
    } catch (err) {
      if (!(err instanceof GrammyError)) throw err; // network: stays pending, retried next tick
      const desc = err.description;
      if (desc.includes("USER_ALREADY_PARTICIPANT")) return this.finish(r.id, "approved", desc);
      // The request is gone (withdrawn, or handled by a human admin).
      if (desc.includes("HIDE_REQUESTER_MISSING")) return this.finish(r.id, "error", desc);
      if (r.attempts + 1 >= MAX_ATTEMPTS) return this.finish(r.id, "error", desc);
      await sql`UPDATE join_requests SET attempts = attempts + 1, detail = ${desc} WHERE id = ${r.id}`.execute(db);
    }
  }

  private async judge(contest: Contest, userId: number, link: string | null): Promise<Verdict> {
    const { db } = this.d;
    // Only a participant's own personal link admits anyone, and only them: a link that was
    // passed on, the contest's shared link, or any other invite link of the chat is declined.
    let ownLink = false;
    if (link) {
      const owner = await sql<{ user_id: number }>`
        SELECT user_id FROM participants WHERE contest_id = ${contest.id} AND prize_invite_link = ${link}
      `.execute(db);
      const o = owner.rows[0];
      if (o && o.user_id !== userId) return { approve: false, reason: "not_yours" };
      ownLink = o !== undefined;
    }

    const p = await sql<Participant>`
      SELECT * FROM participants WHERE contest_id = ${contest.id} AND user_id = ${userId}
    `.execute(db);
    const row = p.rows[0];
    if (!row || !row.qualified_at || row.disqualified_at) return { approve: false, reason: "not_qualified" };
    if (!ownLink) return { approve: false, reason: "use_own_link" };

    // Known to have left a sponsor channel? "Unknown" passes: only a recorded leave blocks.
    const left = await sql<{ n: number }>`
      SELECT count(*) AS n FROM sponsor_channels s
        JOIN channel_members m ON m.chat_id = s.chat_id AND m.user_id = ${userId}
       WHERE s.contest_id = ${contest.id} AND s.health = 'ok' AND m.is_member = false
    `.execute(db);
    if (left.rows[0]!.n > 0) return { approve: false, reason: "left_sponsor" };
    return { approve: true, personalLink: link };
  }

  private async finish(id: number, status: string, detail: string | null = null): Promise<void> {
    await sql`
      UPDATE join_requests SET status = ${status}, detail = ${detail}, decided_at = now() WHERE id = ${id}
    `.execute(this.d.db);
  }
}
