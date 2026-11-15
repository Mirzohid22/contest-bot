import { GrammyError } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { sql } from "kysely";
import { ensurePrizeLink } from "../contest/prize.js";
import type { Contest, OutboxRow, Participant } from "../db/types.js";
import type { Deps } from "../deps.js";
import { isBlocked } from "../tg/gateway.js";
import { every } from "../util.js";

const MAX_INFLIGHT = 200;
const MAX_ATTEMPTS = 5;

/**
 * Delivers messages that must not be lost ("you qualified", admin broadcasts).
 *
 * Rows stay 'pending' until Telegram accepts the message, so a crash between the send and
 * the UPDATE re-sends it after restart: a duplicate is possible, a loss is not.
 * Only one process runs this worker (one container per bot), so no row locking is needed.
 */
export class OutboxWorker {
  private readonly inflight = new Set<number>();
  private stopLoop: (() => Promise<void>) | null = null;

  constructor(private readonly d: Deps) {}

  start(): void {
    this.stopLoop = every(500, () => this.tick(), (err) => this.d.log.warn({ err }, "outbox tick failed"));
  }

  async stop(): Promise<void> {
    await this.stopLoop?.();
  }

  get pendingInMemory(): number {
    return this.inflight.size;
  }

  private async tick(): Promise<void> {
    const room = MAX_INFLIGHT - this.inflight.size;
    if (room <= 0) return;
    const rows = await sql<OutboxRow>`
      SELECT id, chat_id, priority, payload, attempts FROM outbox
       WHERE status = 'pending' AND not_before <= now()
         AND id <> ALL(${[...this.inflight]}::bigint[])
       ORDER BY priority, id
       LIMIT ${room}
    `.execute(this.d.db);
    for (const row of rows.rows) {
      this.inflight.add(row.id);
      void this.deliver(row).finally(() => this.inflight.delete(row.id));
    }
  }

  private async deliver(row: OutboxRow): Promise<void> {
    const { db, tg, log } = this.d;
    try {
      let markup = row.payload.markup as InlineKeyboardMarkup | undefined;
      if (row.payload.prize_for) markup = await this.prizeButton(row.payload.prize_for, row.payload.prize_button);
      await tg.send(row.chat_id, row.payload.text, { priority: row.priority, markup });
      await sql`UPDATE outbox SET status = 'sent', sent_at = now() WHERE id = ${row.id}`.execute(db);
    } catch (err) {
      // Blocked by the user, or Telegram rejected the message itself: retrying cannot help.
      const permanent = isBlocked(err) || (err instanceof GrammyError && err.error_code === 400);
      const attempts = row.attempts + 1;
      if (permanent || attempts >= MAX_ATTEMPTS) {
        if (!isBlocked(err)) log.warn({ err, id: row.id }, "outbox message failed permanently");
        await sql`UPDATE outbox SET status = 'failed', attempts = ${attempts} WHERE id = ${row.id}`
          .execute(db)
          .catch(() => {});
      } else {
        await sql`
          UPDATE outbox SET attempts = ${attempts}, not_before = now() + make_interval(secs => ${5 * 2 ** attempts})
           WHERE id = ${row.id}
        `
          .execute(db)
          .catch(() => {});
      }
    }
  }

  /** The "join the prize chat" button with the participant's own single-use link. */
  private async prizeButton(participantId: number, label = "🔓"): Promise<InlineKeyboardMarkup | undefined> {
    const r = await sql<Participant & { c: Contest }>`
      SELECT p.*, to_jsonb(c) AS c FROM participants p JOIN contests c ON c.id = p.contest_id WHERE p.id = ${participantId}
    `.execute(this.d.db);
    const row = r.rows[0];
    if (!row) return undefined;
    // Without a link (no prize chat yet, or Telegram refused) the message goes without the
    // button: the user's /link makes the link later. Never a shared link instead.
    try {
      const link = await ensurePrizeLink(this.d, row.c, row);
      return link ? { inline_keyboard: [[{ text: label, url: link }]] } : undefined;
    } catch (err) {
      this.d.log.warn({ err, participant: participantId }, "could not create a personal prize link");
      this.d.alert(
        "prize-link",
        "⚠️ The bot could not create a personal link to the prize chat. Check that it is still an admin there with the “Invite users via link” right.",
      );
      return undefined;
    }
  }
}
