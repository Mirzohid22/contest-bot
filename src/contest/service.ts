import { sql } from "kysely";
import type { Db, Executor } from "../db/index.js";
import type { Contest, Participant, ParticipantWithUser, Sponsor } from "../db/types.js";
import { type FriendRow, type LeaderRow, type Locale, pickLocale, qualifiedView } from "../flow/texts.js";
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

/** Records the user and returns the language fields needed to answer them. */
export async function upsertUser(
  db: Executor,
  u: { id: number; username?: string; first_name?: string; language_code?: string },
): Promise<{ locale: string | null; lang: string | null }> {
  const r = await sql<{ locale: string | null; lang: string | null }>`
    INSERT INTO users (tg_id, username, first_name, lang)
    VALUES (${u.id}, ${u.username ?? null}, ${u.first_name ?? null}, ${u.language_code ?? null})
    ON CONFLICT (tg_id) DO UPDATE
      SET username = EXCLUDED.username, first_name = EXCLUDED.first_name,
          lang = EXCLUDED.lang, last_seen_at = now(), blocked_at = NULL
    RETURNING locale, lang
  `.execute(db);
  return r.rows[0]!;
}

/** The language to write to a user in; works for users the bot has never seen too. */
export async function localeOf(db: Executor, userId: number, fallback: Locale): Promise<Locale> {
  const r = await sql<{ locale: string | null; lang: string | null }>`
    SELECT locale, lang FROM users WHERE tg_id = ${userId}
  `.execute(db);
  return pickLocale(r.rows[0]?.locale, r.rows[0]?.lang, fallback);
}

export async function setLocale(db: Executor, userId: number, locale: Locale): Promise<void> {
  await sql`UPDATE users SET locale = ${locale} WHERE tg_id = ${userId}`.execute(db);
}

export async function getParticipant(
  db: Executor,
  contestId: number,
  userId: number,
): Promise<ParticipantWithUser | null> {
  const r = await sql<ParticipantWithUser>`
    SELECT p.*, u.locale, u.lang
      FROM participants p JOIN users u ON u.tg_id = p.user_id
     WHERE p.contest_id = ${contestId} AND p.user_id = ${userId}
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
  referrer?: { userId: number; inviteCount: number; qualifiedNow: boolean; locale: Locale };
}

/**
 * Marks a participant verified and credits their referrer, exactly once.
 *
 * Everything hinges on `verified_at IS NULL` in the first UPDATE: a double click, a
 * redelivered update, or two racing requests all find the row already verified and stop.
 * Lock order is always invitee then referrer, and a referrer always has a lower id than
 * the invitee, so two of these transactions cannot deadlock.
 */
export async function credit(
  db: Db,
  contest: Contest,
  participantId: number,
  fallback: Locale,
): Promise<CreditResult> {
  return db.transaction().execute(async (trx) => {
    const me = await sql<{ referred_by: number | null }>`
      UPDATE participants SET verified_at = now()
       WHERE id = ${participantId} AND verified_at IS NULL
      RETURNING referred_by
    `.execute(trx);
    if (!me.rows[0]) return { verifiedNow: false };

    // Only matters when the contest requires zero invites.
    await qualifyIfReady(trx, contest, participantId, fallback);

    const referrerId = me.rows[0].referred_by;
    if (referrerId === null) return { verifiedNow: true };

    const ref = await sql<{ user_id: number; invite_count: number; locale: string | null; lang: string | null }>`
      WITH r AS (
        UPDATE participants SET invite_count = invite_count + 1
         WHERE id = ${referrerId} AND disqualified_at IS NULL
        RETURNING user_id, invite_count
      )
      SELECT r.user_id, r.invite_count, u.locale, u.lang FROM r JOIN users u ON u.tg_id = r.user_id
    `.execute(trx);
    const row = ref.rows[0];
    if (!row) return { verifiedNow: true };

    const qualifiedNow = await qualifyIfReady(trx, contest, referrerId, fallback);
    return {
      verifiedNow: true,
      referrer: {
        userId: row.user_id,
        inviteCount: row.invite_count,
        qualifiedNow,
        locale: pickLocale(row.locale, row.lang, fallback),
      },
    };
  });
}

/**
 * Sets qualified_at if the participant now meets the requirement, and queues the durable
 * "you qualified" message in the same transaction. Returns true if it qualified just now.
 */
export async function qualifyIfReady(
  trx: Executor,
  contest: Contest,
  participantId: number,
  fallback: Locale,
): Promise<boolean> {
  const q = await sql<{ user_id: number; locale: string | null; lang: string | null }>`
    WITH q AS (
      UPDATE participants SET qualified_at = now()
       WHERE id = ${participantId}
         AND qualified_at IS NULL AND verified_at IS NOT NULL AND disqualified_at IS NULL
         AND invite_count >= ${contest.required_invites}
      RETURNING user_id
    )
    SELECT q.user_id, u.locale, u.lang FROM q JOIN users u ON u.tg_id = q.user_id
  `.execute(trx);
  const row = q.rows[0];
  if (!row) return false;
  await enqueue(trx, {
    chatId: row.user_id,
    priority: P.IMPORTANT,
    payload: qualifiedView(contest, pickLocale(row.locale, row.lang, fallback)),
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

/**
 * Top inviters of a contest, cached briefly: during a spike many people open the
 * leaderboard at once and it does not need to be exact to the second.
 */
export class Leaderboard {
  private cached = new Map<number, { at: number; rows: LeaderRow[] }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 15_000,
  ) {}

  async top(contestId: number, limit = 10): Promise<LeaderRow[]> {
    const hit = this.cached.get(contestId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.rows;
    const r = await sql<LeaderRow>`
      SELECT u.first_name, u.username, p.invite_count
        FROM participants p JOIN users u ON u.tg_id = p.user_id
       WHERE p.contest_id = ${contestId} AND p.disqualified_at IS NULL AND p.invite_count > 0
       ORDER BY p.invite_count DESC, p.id
       LIMIT ${limit}
    `.execute(this.db);
    this.cached.set(contestId, { at: Date.now(), rows: r.rows });
    return r.rows;
  }

  /** 1 + the number of people with strictly more invites: ties share a place. */
  async rank(contestId: number, inviteCount: number): Promise<number> {
    const r = await sql<{ n: number }>`
      SELECT count(*) AS n FROM participants
       WHERE contest_id = ${contestId} AND disqualified_at IS NULL AND invite_count > ${inviteCount}
    `.execute(this.db);
    return r.rows[0]!.n + 1;
  }
}

/** The newest people a participant brought in, and how many there are in total. */
export async function friendsOf(db: Executor, participantId: number, limit = 15): Promise<{ rows: FriendRow[]; total: number }> {
  const rows = await sql<FriendRow>`
    SELECT u.first_name, i.verified_at, i.disqualified_at
      FROM participants i JOIN users u ON u.tg_id = i.user_id
     WHERE i.referred_by = ${participantId}
     ORDER BY i.id DESC
     LIMIT ${limit}
  `.execute(db);
  const total = await sql<{ n: number }>`
    SELECT count(*) AS n FROM participants WHERE referred_by = ${participantId}
  `.execute(db);
  return { rows: rows.rows, total: total.rows[0]!.n };
}
