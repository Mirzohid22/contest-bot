import type { FastifyInstance } from "fastify";
import { type RawBuilder, sql } from "kysely";
import { z } from "zod";
import { qualifyIfReady } from "../contest/service.js";
import type { Executor } from "../db/index.js";
import type { Contest, Participant, Sponsor } from "../db/types.js";
import type { Deps } from "../deps.js";
import { defaultTexts } from "../flow/texts.js";
import type { Poller } from "../ingest/poller.js";
import { P } from "../tg/gateway.js";
import { HttpProblem } from "./server.js";

const idParam = z.object({ id: z.coerce.number().int().positive() });
const PAGE_SIZE = 50;

/** "@name", "https://t.me/name", or a numeric chat id. */
function parseChatRef(input: string): number | string {
  const s = input.trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  const m = s.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,})\/?$/) ?? s.match(/^@?([A-Za-z0-9_]{4,})$/);
  if (!m) throw new HttpProblem(400, "Enter a channel @username, a t.me link, or a numeric chat id");
  return `@${m[1]}`;
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Stop spreadsheet apps from running a cell that starts like a formula.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function registerRoutes(api: FastifyInstance, d: Deps, extra: { poller: Poller }): void {
  const { db, tg, cache } = d;

  const rows = async <T>(q: RawBuilder<T>, on: Executor = db) => (await q.execute(on)).rows;
  const audit = (adminId: number, action: string, detail: unknown = null) =>
    sql`
      INSERT INTO audit_log (admin_tg_id, action, detail)
      VALUES (${adminId}, ${action}, ${detail === null ? null : JSON.stringify(detail)}::jsonb)
    `.execute(db);

  async function contestById(id: number): Promise<Contest> {
    const [c] = await rows(sql<Contest>`SELECT * FROM contests WHERE id = ${id}`);
    if (!c) throw new HttpProblem(404, "Contest not found");
    return c;
  }

  /** The bot must be an administrator of the chat; returns its own member record. */
  async function requireBotAdmin(chatId: number) {
    const m = await tg.getChatMember(chatId, d.me.id);
    if (m.status !== "administrator") {
      throw new HttpProblem(400, "The bot is not an administrator of this chat. Add it as an admin first.");
    }
    return m;
  }

  /** Qualifies everyone who meets the requirement but is not marked yet. */
  async function sweepQualified(contest: Contest): Promise<number> {
    const ready = await rows(sql<{ id: number }>`
      SELECT id FROM participants
       WHERE contest_id = ${contest.id} AND qualified_at IS NULL AND verified_at IS NOT NULL
         AND disqualified_at IS NULL AND invite_count >= ${contest.required_invites}
    `);
    let n = 0;
    for (const r of ready) {
      const done = await db.transaction().execute((trx) => qualifyIfReady(trx, contest, r.id));
      if (done) n++;
    }
    return n;
  }

  // ---- session and health ----

  api.get("/me", async (req) => ({ tg_id: req.adminId, bot: d.me.username }));

  api.get("/texts/defaults", async () => defaultTexts);

  api.get("/health", async () => {
    const [q] = await rows(sql<{ outbox: number; joins: number }>`
      SELECT (SELECT count(*) FROM outbox WHERE status = 'pending') AS outbox,
             (SELECT count(*) FROM join_requests WHERE status = 'pending') AS joins
    `);
    return {
      lanes: Object.values(tg.lanes).map((l) => ({
        name: l.name,
        rate: Math.round(l.rate * 10) / 10,
        depth: l.depth,
        oldest_age_s: Math.round(l.oldestAgeMs / 1000),
        paused: l.paused,
        ...l.stats,
      })),
      poller: {
        seconds_since_poll: extra.poller.stats.lastPollAt
          ? Math.round((Date.now() - extra.poller.stats.lastPollAt) / 1000)
          : null,
        last_batch_size: extra.poller.stats.lastBatchSize,
        last_batch_ms: extra.poller.stats.lastBatchMs,
        updates: extra.poller.stats.updates,
        dropped: extra.poller.stats.dropped,
      },
      outbox_pending: q!.outbox,
      joins_pending: q!.joins,
      memory_mb: Math.round(process.memoryUsage().rss / 1048576),
      uptime_s: Math.round(process.uptime()),
    };
  });

  // ---- contests ----

  api.get("/contests", async () =>
    rows(sql`
      SELECT c.*,
             (SELECT count(*) FROM participants p WHERE p.contest_id = c.id) AS participants,
             (SELECT count(*) FROM participants p WHERE p.contest_id = c.id AND p.qualified_at IS NOT NULL) AS qualified
        FROM contests c ORDER BY c.id DESC
    `),
  );

  api.post("/contests", async (req) => {
    const body = z
      .object({ title: z.string().trim().min(1).max(200), required_invites: z.number().int().min(0).max(100000) })
      .parse(req.body);
    const [c] = await rows(sql<Contest>`
      INSERT INTO contests (title, required_invites) VALUES (${body.title}, ${body.required_invites}) RETURNING *
    `);
    await audit(req.adminId, "contest.create", { id: c!.id, ...body });
    return c;
  });

  api.get("/contests/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const contest = await contestById(id);
    const sponsors = await rows(sql<Sponsor>`
      SELECT * FROM sponsor_channels WHERE contest_id = ${id} ORDER BY position, id
    `);
    const [stats] = await rows(sql`
      SELECT count(*) AS total, count(verified_at) AS verified, count(qualified_at) AS qualified,
             count(prize_joined_at) AS joined_prize, count(disqualified_at) AS disqualified
        FROM participants WHERE contest_id = ${id}
    `);
    const timeline = await rows(sql`
      SELECT date_trunc('hour', created_at) AS hour, count(*) AS started, count(verified_at) AS verified
        FROM participants WHERE contest_id = ${id} AND created_at > now() - interval '72 hours'
       GROUP BY 1 ORDER BY 1
    `);
    return { contest, sponsors, stats, timeline };
  });

  api.patch("/contests/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        required_invites: z.number().int().min(0).max(100000).optional(),
        texts: z.record(z.string(), z.string().max(4000)).optional(),
      })
      .parse(req.body);
    const before = await contestById(id);
    if (before.status === "finished") throw new HttpProblem(400, "A finished contest cannot be edited");

    // Keep only overrides that differ from the default, so later default fixes still apply.
    const texts = body.texts
      ? Object.fromEntries(
          Object.entries(body.texts).filter(
            ([k, v]) => k in defaultTexts && v.trim() !== "" && v !== defaultTexts[k as keyof typeof defaultTexts],
          ),
        )
      : before.texts;
    const [contest] = await rows(sql<Contest>`
      UPDATE contests
         SET title = ${body.title ?? before.title},
             required_invites = ${body.required_invites ?? before.required_invites},
             texts = ${JSON.stringify(texts)}::jsonb
       WHERE id = ${id} RETURNING *
    `);
    cache.invalidate();
    // Lowering the requirement on a running contest can qualify people immediately.
    const newlyQualified = contest!.status === "active" ? await sweepQualified(contest!) : 0;
    await audit(req.adminId, "contest.update", { id, ...body });
    return { contest, newly_qualified: newlyQualified };
  });

  api.post("/contests/:id/prize", async (req) => {
    const { id } = idParam.parse(req.params);
    const { chat } = z.object({ chat: z.string().min(1) }).parse(req.body);
    await contestById(id);
    const info = await tg.getChat(parseChatRef(chat));
    const me = await requireBotAdmin(info.id);
    if (!("can_invite_users" in me) || !me.can_invite_users) {
      throw new HttpProblem(400, "Give the bot the “Invite users via link” admin right in this chat.");
    }
    // One shared link for the whole contest. Each join request is decided by the bot.
    const link = await tg.createInviteLink(info.id, { name: `Contest ${id}`, joinRequest: true });
    const [contest] = await rows(sql<Contest>`
      UPDATE contests
         SET prize_chat_id = ${info.id}, prize_chat_title = ${info.title ?? String(info.id)},
             prize_invite_link = ${link.invite_link}
       WHERE id = ${id} RETURNING *
    `);
    cache.invalidate();
    await audit(req.adminId, "contest.prize", { id, chat_id: info.id });
    return contest;
  });

  api.post("/contests/:id/activate", async (req) => {
    const { id } = idParam.parse(req.params);
    const contest = await contestById(id);
    if (contest.status !== "draft") throw new HttpProblem(400, "Only a draft contest can be activated");
    // One transaction: the unique index allows a single active contest at any instant.
    await db.transaction().execute(async (trx) => {
      await sql`UPDATE contests SET status = 'finished', finished_at = now() WHERE status = 'active'`.execute(trx);
      await sql`UPDATE contests SET status = 'active', started_at = now() WHERE id = ${id}`.execute(trx);
    });
    cache.invalidate();
    await audit(req.adminId, "contest.activate", { id });
    return contestById(id);
  });

  api.post("/contests/:id/finish", async (req) => {
    const { id } = idParam.parse(req.params);
    const [c] = await rows(sql<Contest>`
      UPDATE contests SET status = 'finished', finished_at = now()
       WHERE id = ${id} AND status = 'active' RETURNING *
    `);
    if (!c) throw new HttpProblem(400, "Only the active contest can be finished");
    cache.invalidate();
    await audit(req.adminId, "contest.finish", { id });
    return c;
  });

  // ---- sponsors ----

  api.post("/contests/:id/sponsors", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ chat: z.string().min(1), join_url: z.string().url().startsWith("https://").optional() })
      .parse(req.body);
    const contest = await contestById(id);
    if (contest.status === "finished") throw new HttpProblem(400, "A finished contest cannot be edited");

    const info = await tg.getChat(parseChatRef(body.chat));
    await requireBotAdmin(info.id);
    let joinUrl = body.join_url ?? (info.username ? `https://t.me/${info.username}` : info.invite_link);
    // Private channel without a link we can see: make one (needs the invite right).
    joinUrl ??= (await tg.createInviteLink(info.id, { name: `Contest ${id}` })).invite_link;

    const [sponsor] = await rows(sql<Sponsor>`
      INSERT INTO sponsor_channels (contest_id, chat_id, title, join_url, position)
      VALUES (${id}, ${info.id}, ${info.title ?? String(info.id)}, ${joinUrl},
              (SELECT COALESCE(max(position), 0) + 1 FROM sponsor_channels WHERE contest_id = ${id}))
      ON CONFLICT (contest_id, chat_id) DO UPDATE
        SET title = EXCLUDED.title, join_url = EXCLUDED.join_url, health = 'ok'
      RETURNING *
    `);
    cache.invalidate();
    await audit(req.adminId, "sponsor.add", { contest_id: id, chat_id: info.id });
    return sponsor;
  });

  api.delete("/sponsors/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const [gone] = await rows(sql<Sponsor>`DELETE FROM sponsor_channels WHERE id = ${id} RETURNING *`);
    if (!gone) throw new HttpProblem(404, "Sponsor not found");
    cache.invalidate();
    await audit(req.adminId, "sponsor.remove", { contest_id: gone.contest_id, chat_id: gone.chat_id });
    return { ok: true };
  });

  // ---- participants ----

  api.get("/contests/:id/participants", async (req) => {
    const { id } = idParam.parse(req.params);
    const query = z
      .object({
        q: z.string().trim().max(100).optional(),
        filter: z.enum(["all", "verified", "qualified", "joined", "disqualified"]).default("all"),
        page: z.coerce.number().int().min(1).default(1),
      })
      .parse(req.query);

    const conds = [sql`p.contest_id = ${id}`];
    if (query.filter === "verified") conds.push(sql`p.verified_at IS NOT NULL`);
    if (query.filter === "qualified") conds.push(sql`p.qualified_at IS NOT NULL`);
    if (query.filter === "joined") conds.push(sql`p.prize_joined_at IS NOT NULL`);
    if (query.filter === "disqualified") conds.push(sql`p.disqualified_at IS NOT NULL`);
    if (query.q) {
      const term = query.q.replace(/^@/, "");
      if (/^\d+$/.test(term)) conds.push(sql`p.user_id = ${Number(term)}`);
      else {
        const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
        conds.push(sql`(u.username ILIKE ${like} OR u.first_name ILIKE ${like} OR p.ref_code = ${term})`);
      }
    }
    const where = sql.join(conds, sql` AND `);

    const [count] = await rows(sql<{ n: number }>`
      SELECT count(*) AS n FROM participants p JOIN users u ON u.tg_id = p.user_id WHERE ${where}
    `);
    const items = await rows(sql`
      SELECT p.*, u.username, u.first_name, u.blocked_at
        FROM participants p JOIN users u ON u.tg_id = p.user_id
       WHERE ${where}
       ORDER BY p.invite_count DESC, p.id
       LIMIT ${PAGE_SIZE} OFFSET ${(query.page - 1) * PAGE_SIZE}
    `);
    return { items, total: count!.n, page: query.page, page_size: PAGE_SIZE };
  });

  api.get("/participants/:id", async (req) => {
    const { id } = idParam.parse(req.params);
    const [participant] = await rows(sql`
      SELECT p.*, u.username, u.first_name, u.blocked_at,
             ru.tg_id AS referrer_user_id, ru.username AS referrer_username, ru.first_name AS referrer_first_name
        FROM participants p
        JOIN users u ON u.tg_id = p.user_id
        LEFT JOIN participants r ON r.id = p.referred_by
        LEFT JOIN users ru ON ru.tg_id = r.user_id
       WHERE p.id = ${id}
    `);
    if (!participant) throw new HttpProblem(404, "Participant not found");
    const invitees = await rows(sql`
      SELECT i.id, i.user_id, i.verified_at, i.disqualified_at, i.created_at, u.username, u.first_name
        FROM participants i JOIN users u ON u.tg_id = i.user_id
       WHERE i.referred_by = ${id} ORDER BY i.id LIMIT 500
    `);
    return { participant, invitees };
  });

  api.post("/participants/:id/disqualify", async (req) => {
    const { id } = idParam.parse(req.params);
    const { disqualified } = z.object({ disqualified: z.boolean() }).parse(req.body);
    const [p] = await rows(sql<Participant>`
      UPDATE participants SET disqualified_at = ${disqualified ? sql`COALESCE(disqualified_at, now())` : null}
       WHERE id = ${id} RETURNING *
    `);
    if (!p) throw new HttpProblem(404, "Participant not found");
    await audit(req.adminId, disqualified ? "participant.disqualify" : "participant.restore", { id });
    return p;
  });

  /**
   * Rebuilds every invite_count from the referral rows (the source of truth), leaving out
   * disqualified invitees. Run it after disqualifying fake accounts.
   */
  api.post("/contests/:id/recount", async (req) => {
    const { id } = idParam.parse(req.params);
    const contest = await contestById(id);
    const result = await db.transaction().execute(async (trx) => {
      // Blocks concurrent credits for the moment the counts are rewritten.
      await sql`LOCK TABLE participants IN SHARE ROW EXCLUSIVE MODE`.execute(trx);
      const changed = await rows(
        sql<{ id: number }>`
          WITH counts AS (
            SELECT p.id, (SELECT count(*) FROM participants i
                           WHERE i.referred_by = p.id AND i.verified_at IS NOT NULL
                             AND i.disqualified_at IS NULL)::int AS c
              FROM participants p WHERE p.contest_id = ${id}
          )
          UPDATE participants p SET invite_count = counts.c
            FROM counts WHERE p.id = counts.id AND p.invite_count <> counts.c
          RETURNING p.id
        `,
        trx,
      );
      // Not in the prize chat yet and no longer meeting the requirement: take the status back.
      const unqualified = await rows(
        sql<{ id: number }>`
          UPDATE participants SET qualified_at = NULL
           WHERE contest_id = ${id} AND qualified_at IS NOT NULL AND prize_joined_at IS NULL
             AND invite_count < ${contest.required_invites}
          RETURNING id
        `,
        trx,
      );
      return { changed: changed.length, unqualified: unqualified.length };
    });
    const newlyQualified = contest.status === "active" ? await sweepQualified(contest) : 0;
    await audit(req.adminId, "contest.recount", { id, ...result, newly_qualified: newlyQualified });
    return { ...result, newly_qualified: newlyQualified };
  });

  /** Qualified participants and how much of their result rests on people who have since left a sponsor. */
  api.get("/contests/:id/audit", async (req) => {
    const { id } = idParam.parse(req.params);
    return rows(sql`
      SELECT p.id, p.user_id, u.username, u.first_name, p.invite_count, p.prize_joined_at,
             EXISTS (SELECT 1 FROM sponsor_channels s
                       JOIN channel_members m ON m.chat_id = s.chat_id AND m.user_id = p.user_id
                      WHERE s.contest_id = p.contest_id AND m.is_member = false) AS self_left,
             (SELECT count(*) FROM participants i
               WHERE i.referred_by = p.id AND i.verified_at IS NOT NULL AND i.disqualified_at IS NULL
                 AND EXISTS (SELECT 1 FROM sponsor_channels s
                               JOIN channel_members m ON m.chat_id = s.chat_id AND m.user_id = i.user_id
                              WHERE s.contest_id = p.contest_id AND m.is_member = false)) AS invitees_left
        FROM participants p JOIN users u ON u.tg_id = p.user_id
       WHERE p.contest_id = ${id} AND p.qualified_at IS NOT NULL AND p.disqualified_at IS NULL
       ORDER BY invitees_left DESC, p.id
       LIMIT 1000
    `);
  });

  api.post("/contests/:id/broadcast", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        text: z.string().trim().min(1).max(4000),
        segment: z.enum(["all", "verified", "not_verified", "qualified", "not_qualified"]),
        test: z.boolean().default(false),
      })
      .parse(req.body);
    await contestById(id);
    const payload = { text: body.text };

    // A test goes only to the admin who pressed the button: bad HTML shows up here, not in 10,000 chats.
    if (body.test) {
      await tg.send(req.adminId, body.text, { priority: P.IMPORTANT });
      return { queued: 0, test: true };
    }

    const segment = {
      all: sql`TRUE`,
      verified: sql`p.verified_at IS NOT NULL`,
      not_verified: sql`p.verified_at IS NULL`,
      qualified: sql`p.qualified_at IS NOT NULL`,
      not_qualified: sql`p.verified_at IS NOT NULL AND p.qualified_at IS NULL`,
    }[body.segment];
    const queued = await rows(sql<{ id: number }>`
      INSERT INTO outbox (chat_id, priority, payload)
      SELECT p.user_id, ${P.BROADCAST}, ${JSON.stringify(payload)}::jsonb
        FROM participants p JOIN users u ON u.tg_id = p.user_id
       WHERE p.contest_id = ${id} AND u.blocked_at IS NULL AND ${segment}
      RETURNING id
    `);
    await audit(req.adminId, "contest.broadcast", { id, segment: body.segment, queued: queued.length });
    return { queued: queued.length, test: false };
  });

  api.get("/contests/:id/export.csv", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await contestById(id);
    const cols = [
      "id", "user_id", "username", "first_name", "ref_code", "referred_by", "invite_count",
      "created_at", "verified_at", "qualified_at", "prize_joined_at", "disqualified_at",
    ] as const;
    reply.raw.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="contest-${id}-participants.csv"`,
    });
    reply.raw.write(cols.join(",") + "\n");
    // Keyset pages: constant memory, and the event loop gets to breathe between pages.
    let after = 0;
    for (;;) {
      const page = await rows(sql<Record<(typeof cols)[number], unknown> & { id: number }>`
        SELECT p.id, p.user_id, u.username, u.first_name, p.ref_code, p.referred_by, p.invite_count,
               p.created_at, p.verified_at, p.qualified_at, p.prize_joined_at, p.disqualified_at
          FROM participants p JOIN users u ON u.tg_id = p.user_id
         WHERE p.contest_id = ${id} AND p.id > ${after}
         ORDER BY p.id LIMIT 2000
      `);
      if (page.length === 0) break;
      reply.raw.write(page.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n") + "\n");
      after = page[page.length - 1]!.id;
    }
    reply.raw.end();
    return reply;
  });
}
