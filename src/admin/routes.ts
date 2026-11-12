import type { FastifyInstance } from "fastify";
import { type RawBuilder, sql } from "kysely";
import { z } from "zod";
import { qualifyIfReady } from "../contest/service.js";
import type { Executor } from "../db/index.js";
import type { Contest, Participant, Sponsor } from "../db/types.js";
import type { Deps } from "../deps.js";
import { InputFile } from "grammy";
import { defaultTexts, LOCALES, type Locale, TEXT_KEYS } from "../flow/texts.js";
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
      const done = await db.transaction().execute((trx) => qualifyIfReady(trx, contest, r.id, d.cfg.DEFAULT_LOCALE));
      if (done) n++;
    }
    return n;
  }

  // ---- session and health ----

  api.get("/me", async (req) => ({ tg_id: req.adminId, bot: d.me.username }));

  api.get("/texts/defaults", async () => ({
    locales: LOCALES,
    default_locale: d.cfg.DEFAULT_LOCALE,
    keys: TEXT_KEYS,
    texts: defaultTexts,
  }));

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
        texts: z.partialRecord(z.enum(LOCALES), z.record(z.string(), z.string().max(4000))).optional(),
      })
      .parse(req.body);
    const before = await contestById(id);
    if (before.status === "finished") throw new HttpProblem(400, "A finished contest cannot be edited");

    // Keep only overrides that differ from the default, so later default fixes still apply.
    const texts = body.texts
      ? Object.fromEntries(
          Object.entries(body.texts).map(([locale, byKey]) => [
            locale,
            Object.fromEntries(
              Object.entries(byKey).filter(
                ([k, v]) =>
                  (TEXT_KEYS as string[]).includes(k) &&
                  v.trim() !== "" &&
                  v !== defaultTexts[locale as Locale][k as keyof (typeof defaultTexts)["uz"]],
              ),
            ),
          ]),
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
      SELECT i.id, i.user_id, i.verified_at, i.qualified_at, i.disqualified_at, i.created_at, i.invite_count,
             u.username, u.first_name
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

  // ---- statistics ----

  api.get("/contests/:id/stats", async (req) => {
    const { id } = idParam.parse(req.params);
    const { hours } = z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(48) }).parse(req.query);
    await contestById(id);
    const [funnel] = await rows(sql<Record<string, number>>`
      SELECT count(*) AS started, count(verified_at) AS verified, count(qualified_at) AS qualified,
             count(prize_joined_at) AS joined, count(disqualified_at) AS disqualified,
             count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS started_1h,
             count(*) FILTER (WHERE created_at > now() - interval '2 hours'
                                AND created_at <= now() - interval '1 hour') AS started_prev_1h,
             count(*) FILTER (WHERE verified_at > now() - interval '1 hour') AS verified_1h,
             count(*) FILTER (WHERE qualified_at > now() - interval '1 hour') AS qualified_1h,
             coalesce(sum(invite_count), 0) AS invites
        FROM participants WHERE contest_id = ${id}
    `);
    // One row per hour, including empty hours, so the chart has no gaps.
    const timeline = await rows(sql`
      WITH h AS (
        SELECT generate_series(date_trunc('hour', now()) - make_interval(hours => ${hours - 1}),
                               date_trunc('hour', now()), interval '1 hour') AS t
      )
      SELECT h.t,
             (SELECT count(*) FROM participants p WHERE p.contest_id = ${id}
                AND p.created_at >= h.t AND p.created_at < h.t + interval '1 hour') AS started,
             (SELECT count(*) FROM participants p WHERE p.contest_id = ${id}
                AND p.verified_at >= h.t AND p.verified_at < h.t + interval '1 hour') AS verified,
             (SELECT count(*) FROM participants p WHERE p.contest_id = ${id}
                AND p.qualified_at >= h.t AND p.qualified_at < h.t + interval '1 hour') AS qualified
        FROM h ORDER BY h.t
    `);
    // Which sponsor stops people: unverified participants known not to be in each channel.
    const sponsors = await rows(sql`
      SELECT s.id, s.title, s.health,
             (SELECT count(*) FROM channel_members m WHERE m.chat_id = s.chat_id AND m.is_member) AS members_known,
             (SELECT count(*) FROM participants p
                JOIN channel_members m ON m.chat_id = s.chat_id AND m.user_id = p.user_id AND NOT m.is_member
               WHERE p.contest_id = s.contest_id AND p.verified_at IS NULL) AS blocking
        FROM sponsor_channels s WHERE s.contest_id = ${id} ORDER BY s.position, s.id
    `);
    const languages = await rows(sql`
      SELECT COALESCE(u.locale, CASE WHEN left(u.lang, 2) IN ('uz', 'ru') THEN left(u.lang, 2)
                                     ELSE ${d.cfg.DEFAULT_LOCALE} END) AS locale,
             count(*) AS n
        FROM participants p JOIN users u ON u.tg_id = p.user_id
       WHERE p.contest_id = ${id} GROUP BY 1 ORDER BY 2 DESC
    `);
    return { funnel, timeline, sponsors, languages };
  });

  api.get("/contests/:id/leaderboard", async (req) => {
    const { id } = idParam.parse(req.params);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return rows(sql`
      SELECT p.id, p.user_id, u.username, u.first_name, p.invite_count, p.qualified_at, p.prize_joined_at,
             p.disqualified_at,
             (SELECT count(*) FROM participants i
               WHERE i.referred_by = p.id AND i.verified_at IS NULL) AS pending
        FROM participants p JOIN users u ON u.tg_id = p.user_id
       WHERE p.contest_id = ${id} AND p.invite_count > 0
       ORDER BY (p.disqualified_at IS NULL) DESC, p.invite_count DESC, p.id
       LIMIT ${limit}
    `);
  });

  // ---- chat checks (used by the setup wizard before anything is saved) ----

  api.post("/chats/inspect", async (req) => {
    const { chat, purpose } = z
      .object({ chat: z.string().min(1).max(200), purpose: z.enum(["sponsor", "prize"]) })
      .parse(req.body);
    const info = await tg.getChat(parseChatRef(chat));
    const me = await tg.getChatMember(info.id, d.me.id);
    const isAdmin = me.status === "administrator" || me.status === "creator";
    const canInvite = me.status === "creator" || ("can_invite_users" in me && me.can_invite_users === true);
    const members = await tg.lanes.manage.schedule(() => tg.raw.getChatMemberCount(info.id)).catch(() => null);
    let problem: string | null = null;
    if (!isAdmin) problem = "The bot is not an administrator of this chat. Add it as an admin, then check again.";
    else if (purpose === "prize" && !canInvite) problem = "Give the bot the “Invite users via link” admin right.";
    else if (purpose === "sponsor" && !info.username && !canInvite) {
      problem = "This channel is private: give the bot the “Invite users via link” right so it can make a join link.";
    }
    return {
      id: info.id,
      title: info.title ?? String(info.id),
      type: info.type,
      username: info.username ?? null,
      members,
      bot_status: me.status,
      can_invite_users: canInvite,
      ok: problem === null,
      problem,
    };
  });

  /** Asks Telegram again whether the bot is still an admin in every sponsor channel. */
  api.post("/contests/:id/sponsors/check", async (req) => {
    const { id } = idParam.parse(req.params);
    const sponsors = await rows(sql<Sponsor>`SELECT * FROM sponsor_channels WHERE contest_id = ${id} ORDER BY position, id`);
    const out = [];
    for (const s of sponsors) {
      const m = await tg.getChatMember(s.chat_id, d.me.id).catch(() => null);
      const health = m && (m.status === "administrator" || m.status === "creator") ? "ok" : "bot_not_admin";
      if (health !== s.health) await sql`UPDATE sponsor_channels SET health = ${health} WHERE id = ${s.id}`.execute(db);
      out.push({ ...s, health });
    }
    cache.invalidate();
    return out;
  });

  api.post("/contests/:id/sponsors/order", async (req) => {
    const { id } = idParam.parse(req.params);
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(100) }).parse(req.body);
    await db.transaction().execute(async (trx) => {
      for (const [i, sid] of ids.entries()) {
        await sql`UPDATE sponsor_channels SET position = ${i + 1} WHERE id = ${sid} AND contest_id = ${id}`.execute(trx);
      }
    });
    cache.invalidate();
    return { ok: true };
  });

  // ---- banner ----

  const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const MAX_IMAGE = 10 * 1024 * 1024;
  api.addContentTypeParser(IMAGE_TYPES, { parseAs: "buffer", bodyLimit: MAX_IMAGE }, (_req, body, done) =>
    done(null, body),
  );

  /**
   * Uploads the picture to Telegram once (sent to the admin's own chat as a preview) and
   * keeps its file_id: every later message reuses it without uploading again.
   */
  api.put("/contests/:id/banner", { bodyLimit: MAX_IMAGE }, async (req) => {
    const { id } = idParam.parse(req.params);
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim();
    if (!IMAGE_TYPES.includes(type) || !Buffer.isBuffer(req.body)) {
      throw new HttpProblem(400, "Upload a JPEG, PNG or WebP picture");
    }
    const contest = await contestById(id);
    if (contest.status === "finished") throw new HttpProblem(400, "A finished contest cannot be edited");
    const image = req.body as Buffer;
    const msg = await tg.sendPhoto(
      req.adminId,
      new InputFile(image, `banner.${type.split("/")[1]}`),
      `Banner for <b>${contest.title.replace(/[<>&]/g, "")}</b>. This is how it looks in the bot.`,
      { priority: P.IMPORTANT },
    );
    const fileId = msg.photo[msg.photo.length - 1]!.file_id;
    await db.transaction().execute(async (trx) => {
      await sql`UPDATE contests SET banner_file_id = ${fileId} WHERE id = ${id}`.execute(trx);
      await sql`
        INSERT INTO contest_banners (contest_id, content_type, image) VALUES (${id}, ${type}, ${image})
        ON CONFLICT (contest_id) DO UPDATE
          SET content_type = EXCLUDED.content_type, image = EXCLUDED.image, uploaded_at = now()
      `.execute(trx);
    });
    cache.invalidate();
    await audit(req.adminId, "contest.banner", { id });
    return contestById(id);
  });

  api.delete("/contests/:id/banner", async (req) => {
    const { id } = idParam.parse(req.params);
    await sql`UPDATE contests SET banner_file_id = NULL WHERE id = ${id}`.execute(db);
    await sql`DELETE FROM contest_banners WHERE contest_id = ${id}`.execute(db);
    cache.invalidate();
    await audit(req.adminId, "contest.banner_remove", { id });
    return contestById(id);
  });

  api.get("/contests/:id/banner", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [b] = await rows(sql<{ content_type: string; image: Buffer }>`
      SELECT content_type, image FROM contest_banners WHERE contest_id = ${id}
    `);
    if (!b) throw new HttpProblem(404, "No banner");
    return reply.type(b.content_type).header("cache-control", "private, max-age=60").send(b.image);
  });

  // ---- broadcasts ----

  const SEGMENTS = {
    all: sql`TRUE`,
    verified: sql`p.verified_at IS NOT NULL`,
    not_verified: sql`p.verified_at IS NULL`,
    qualified: sql`p.qualified_at IS NOT NULL AND p.disqualified_at IS NULL`,
    not_qualified: sql`p.verified_at IS NOT NULL AND p.qualified_at IS NULL`,
    qualified_not_joined: sql`p.qualified_at IS NOT NULL AND p.prize_joined_at IS NULL AND p.disqualified_at IS NULL`,
  } as const;
  const segmentName = z.enum(Object.keys(SEGMENTS) as [keyof typeof SEGMENTS, ...(keyof typeof SEGMENTS)[]]);

  /** The language each user gets messages in, as SQL (same rule as pickLocale). */
  const userLocaleSql = sql`COALESCE(u.locale, CASE WHEN left(u.lang, 2) IN ('uz', 'ru') THEN left(u.lang, 2) ELSE ${d.cfg.DEFAULT_LOCALE} END)`;

  api.get("/contests/:id/broadcast/estimate", async (req) => {
    const { id } = idParam.parse(req.params);
    const { segment } = z.object({ segment: segmentName }).parse(req.query);
    const r = await rows(sql<{ locale: string; n: number }>`
      SELECT ${userLocaleSql} AS locale, count(*) AS n
        FROM participants p JOIN users u ON u.tg_id = p.user_id
       WHERE p.contest_id = ${id} AND u.blocked_at IS NULL AND ${SEGMENTS[segment]}
       GROUP BY 1
    `);
    return { total: r.reduce((a, x) => a + x.n, 0), by_locale: Object.fromEntries(r.map((x) => [x.locale, x.n])) };
  });

  api.post("/contests/:id/broadcast", async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        texts: z.object({
          uz: z.string().trim().max(4000).optional(),
          ru: z.string().trim().max(4000).optional(),
          en: z.string().trim().max(4000).optional(),
        }),
        buttons: z
          .array(z.object({ text: z.string().trim().min(1).max(64), url: z.string().url().startsWith("https://") }))
          .max(6)
          .default([]),
        segment: segmentName,
        test: z.boolean().default(false),
      })
      .parse(req.body);
    await contestById(id);

    const given = LOCALES.filter((l) => body.texts[l]);
    if (given.length === 0) throw new HttpProblem(400, "Write the message in at least one language");
    // A language left empty falls back to the default language, or the first one written.
    const fallback = body.texts[d.cfg.DEFAULT_LOCALE] ? d.cfg.DEFAULT_LOCALE : given[0]!;
    const markup = body.buttons.length > 0 ? { inline_keyboard: body.buttons.map((b) => [b]) } : undefined;
    const payloadFor = (l: Locale) => ({ text: body.texts[l] || body.texts[fallback]!, ...(markup ? { markup } : {}) });

    // A test goes only to the admin who pressed the button: bad HTML shows up here, not in 10,000 chats.
    if (body.test) {
      for (const l of given) {
        const p = payloadFor(l);
        await tg.send(req.adminId, p.text, { priority: P.IMPORTANT, markup });
      }
      return { queued: 0, test: true };
    }

    const payloads = Object.fromEntries(LOCALES.map((l) => [l, payloadFor(l)]));
    const result = await db.transaction().execute(async (trx) => {
      const [b] = await rows(
        sql<{ id: number }>`
          INSERT INTO broadcasts (contest_id, segment, payload, created_by)
          VALUES (${id}, ${body.segment}, ${JSON.stringify(payloads)}::jsonb, ${req.adminId})
          RETURNING id
        `,
        trx,
      );
      const queued = await rows(
        sql<{ id: number }>`
          INSERT INTO outbox (chat_id, priority, payload, broadcast_id)
          SELECT p.user_id, ${P.BROADCAST},
                 (${JSON.stringify(payloads)}::jsonb) -> (${userLocaleSql}),
                 ${b!.id}
            FROM participants p JOIN users u ON u.tg_id = p.user_id
           WHERE p.contest_id = ${id} AND u.blocked_at IS NULL AND ${SEGMENTS[body.segment]}
          RETURNING id
        `,
        trx,
      );
      await sql`UPDATE broadcasts SET total = ${queued.length} WHERE id = ${b!.id}`.execute(trx);
      return { id: b!.id, queued: queued.length };
    });
    await audit(req.adminId, "contest.broadcast", {
      contest_id: id,
      segment: body.segment,
      broadcast_id: result.id,
      queued: result.queued,
    });
    return { ...result, test: false };
  });

  api.get("/contests/:id/broadcasts", async (req) => {
    const { id } = idParam.parse(req.params);
    return rows(sql`
      SELECT b.id, b.segment, b.total, b.created_at, b.cancelled_at, b.created_by,
             b.payload -> ${d.cfg.DEFAULT_LOCALE} ->> 'text' AS preview,
             count(o.id) FILTER (WHERE o.status = 'sent') AS sent,
             count(o.id) FILTER (WHERE o.status = 'failed') AS failed,
             count(o.id) FILTER (WHERE o.status = 'pending') AS pending,
             count(o.id) FILTER (WHERE o.status = 'cancelled') AS cancelled
        FROM broadcasts b LEFT JOIN outbox o ON o.broadcast_id = b.id
       WHERE b.contest_id = ${id}
       GROUP BY b.id ORDER BY b.id DESC LIMIT 50
    `);
  });

  api.post("/broadcasts/:id/cancel", async (req) => {
    const { id } = idParam.parse(req.params);
    const stopped = await rows(sql<{ id: number }>`
      UPDATE outbox SET status = 'cancelled' WHERE broadcast_id = ${id} AND status = 'pending' RETURNING id
    `);
    await sql`UPDATE broadcasts SET cancelled_at = COALESCE(cancelled_at, now()) WHERE id = ${id}`.execute(db);
    await audit(req.adminId, "broadcast.cancel", { id, stopped: stopped.length });
    return { stopped: stopped.length };
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
