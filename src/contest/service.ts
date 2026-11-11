import { sql } from "kysely";
import type { Db, Executor } from "../db/index.js";
import type { Contest, Participant, Sponsor } from "../db/types.js";
import { qualifiedView } from "../flow/texts.js";
import { P } from "../tg/gateway.js";
import { randomCode } from "../util.js";

export interface ActiveContest {
  contest: Contest;
  sponsors: Sponsor[];
}

/**
 * The active contest and its sponsors, cached in memory. Every /start and every click
 * needs it, and it changes only when an admin edits something (which calls invalidate).
 */
export class ContestCache {
  private value: ActiveContest | null = null;
  private loadedAt = 0;
  private loading: Promise<ActiveContest | null> | null = null;

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 3000,
  ) {}

  async active(): Promise<ActiveContest | null> {
    if (Date.now() - this.loadedAt < this.ttlMs) return this.value;
    this.loading ??= this.load().finally(() => (this.loading = null));
    return this.loading;
  }

  invalidate(): void {
    this.loadedAt = 0;
  }

  private async load(): Promise<ActiveContest | null> {
    const c = await sql<Contest>`SELECT * FROM contests WHERE status = 'active'`.execute(this.db);
    const contest = c.rows[0];
    if (!contest) {
      this.value = null;
    } else {
      const s = await sql<Sponsor>`
        SELECT * FROM sponsor_channels WHERE contest_id = ${contest.id} ORDER BY position, id
      `.execute(this.db);
      this.value = { contest, sponsors: s.rows };
    }
    this.loadedAt = Date.now();
    return this.value;
  }
}

export async function upsertUser(
  db: Executor,
  u: { id: number; username?: string; first_name?: string; language_code?: string },
): Promise<void> {
  await sql`
    INSERT INTO users (tg_id, username, first_name, lang)
    VALUES (${u.id}, ${u.username ?? null}, ${u.first_name ?? null}, ${u.language_code ?? null})
    ON CONFLICT (tg_id) DO UPDATE
      SET username = EXCLUDED.username, first_name = EXCLUDED.first_name,
          lang = EXCLUDED.lang, last_seen_at = now(), blocked_at = NULL
  `.execute(db);
}

export async function getParticipant(db: Executor, contestId: number, userId: number): Promise<Participant | null> {
  const r = await sql<Participant>`
    SELECT * FROM participants WHERE contest_id = ${contestId} AND user_id = ${userId}
  `.execute(db);
  return r.rows[0] ?? null;
}

const REF_CODE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Returns the user's participant row for this contest, creating it on first contact.
 *
 * The referrer is fixed here and never changes afterwards: a later /start with another
 * link hits ON CONFLICT DO NOTHING. A code from another contest, an unknown code, or the
 * user's own code resolves to no referrer.
 */
export async function ensureParticipant(
  db: Executor,
  contestId: number,
  userId: number,
  payload: string,
): Promise<Participant> {
  const code = REF_CODE.test(payload) ? payload : null;
  const inserted = await sql<Participant>`
    INSERT INTO participants (contest_id, user_id, ref_code, referred_by)
    VALUES (
      ${contestId}, ${userId}, ${randomCode()},
      (SELECT id FROM participants
        WHERE ref_code = ${code} AND contest_id = ${contestId} AND user_id <> ${userId})
    )
    ON CONFLICT (contest_id, user_id) DO NOTHING
    RETURNING *
  `.execute(db);
  if (inserted.rows[0]) return inserted.rows[0];
  return (await getParticipant(db, contestId, userId))!;
}

export interface CreditResult {
  /** False when the participant was already verified: nothing was changed. */
  verifiedNow: boolean;
  referrer?: { userId: number; inviteCount: number; qualifiedNow: boolean };
}

/**
 * Marks a participant verified and credits their referrer, exactly once.
 *
 * Everything hinges on `verified_at IS NULL` in the first UPDATE: a double click, a
 * redelivered update, or two racing requests all find the row already verified and stop.
 * Lock order is always invitee then referrer, and a referrer always has a lower id than
 * the invitee, so two of these transactions cannot deadlock.
 */
export async function credit(db: Db, contest: Contest, participantId: number): Promise<CreditResult> {
  return db.transaction().execute(async (trx) => {
    const me = await sql<{ referred_by: number | null }>`
      UPDATE participants SET verified_at = now()
       WHERE id = ${participantId} AND verified_at IS NULL
      RETURNING referred_by
    `.execute(trx);
    if (!me.rows[0]) return { verifiedNow: false };

    // Only matters when the contest requires zero invites.
    await qualifyIfReady(trx, contest, participantId);

    const referrerId = me.rows[0].referred_by;
    if (referrerId === null) return { verifiedNow: true };

    const ref = await sql<{ user_id: number; invite_count: number }>`
      UPDATE participants SET invite_count = invite_count + 1
       WHERE id = ${referrerId} AND disqualified_at IS NULL
      RETURNING user_id, invite_count
    `.execute(trx);
    if (!ref.rows[0]) return { verifiedNow: true };

    const qualifiedNow = await qualifyIfReady(trx, contest, referrerId);
    return {
      verifiedNow: true,
      referrer: { userId: ref.rows[0].user_id, inviteCount: ref.rows[0].invite_count, qualifiedNow },
    };
  });
}

/**
 * Sets qualified_at if the participant now meets the requirement, and queues the durable
 * "you qualified" message in the same transaction. Returns true if it qualified just now.
 */
export async function qualifyIfReady(trx: Executor, contest: Contest, participantId: number): Promise<boolean> {
  const q = await sql<{ user_id: number }>`
    UPDATE participants SET qualified_at = now()
     WHERE id = ${participantId}
       AND qualified_at IS NULL AND verified_at IS NOT NULL AND disqualified_at IS NULL
       AND invite_count >= ${contest.required_invites}
    RETURNING user_id
  `.execute(trx);
  const row = q.rows[0];
  if (!row) return false;
  await enqueue(trx, {
    chatId: row.user_id,
    priority: P.IMPORTANT,
    payload: qualifiedView(contest),
    dedupeKey: `qualified:${participantId}`,
  });
  return true;
}

export async function enqueue(
  db: Executor,
  m: { chatId: number; priority: number; payload: { text: string; markup?: unknown }; dedupeKey?: string },
): Promise<void> {
  await sql`
    INSERT INTO outbox (dedupe_key, chat_id, priority, payload)
    VALUES (${m.dedupeKey ?? null}, ${m.chatId}, ${m.priority}, ${JSON.stringify(m.payload)}::jsonb)
    ON CONFLICT (dedupe_key) DO NOTHING
  `.execute(db);
}
