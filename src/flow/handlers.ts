import { randomBytes } from "node:crypto";
import type { Bot } from "grammy";
import type { MaybeInaccessibleMessage } from "grammy/types";
import { sql } from "kysely";
import {
  type ActiveContest,
  credit,
  ensureParticipant,
  getParticipant,
  upsertUser,
} from "../contest/service.js";
import type { Participant } from "../db/types.js";
import type { Deps } from "../deps.js";
import { P } from "../tg/gateway.js";
import { escapeHtml, sha256, truncate } from "../util.js";
import { defaultTexts, gateView, render, sponsorNames, statusView, textsOf, type View } from "./texts.js";

/**
 * Update handlers. Two rules keep the poll loop fast and replay-safe:
 *
 * 1. A handler awaits only the database. Telegram calls are queued (tg.fire / tg.answer),
 *    never awaited, so a slow or rate-limited API cannot stall a batch.
 * 2. A handler may run twice for the same update. State changes are conditional or
 *    idempotent; the worst a replay does is send a message again.
 */
export function registerHandlers(bot: Bot, d: Deps): void {
  const { cfg, db, tg, cache, member, cooldown, log } = d;
  const dm = bot.chatType("private");

  const show = (chatId: number, v: View, msg?: MaybeInaccessibleMessage) =>
    tg.fire(
      msg
        ? tg.edit(msg.chat.id, msg.message_id, v.text, v.markup)
        : tg.send(chatId, v.text, { markup: v.markup, priority: P.START }),
    );

  dm.command("start", async (ctx) => {
    const user = ctx.from;
    if (cooldown.active(`start:${user.id}`)) return;

    await upsertUser(db, user);
    const a = await cache.active();
    if (!a) {
      tg.fire(tg.send(user.id, defaultTexts.no_contest, { priority: P.START }));
    } else {
      const p = await ensureParticipant(db, a.contest.id, user.id, ctx.match.trim());
      show(user.id, p.verified_at ? statusView(a, p, d.me.username) : gateView(a));
    }
    // Set last: if anything above threw, the retry must not be swallowed by the cooldown.
    cooldown.set(`start:${user.id}`, cfg.START_COOLDOWN_MS);
  });

  dm.command("admin", async (ctx) => {
    if (!cfg.ADMIN_IDS.includes(ctx.from.id)) return;
    const token = randomBytes(32).toString("base64url");
    await sql`
      INSERT INTO admin_login_tokens (token_hash, tg_id, expires_at)
      VALUES (${sha256(token)}, ${ctx.from.id}, now() + interval '5 minutes')
    `.execute(db);
    const url = `${cfg.PUBLIC_URL}/admin/login?token=${token}`;
    tg.fire(
      tg.send(ctx.from.id, `Admin sign-in link, valid for 5 minutes, single use:\n${escapeHtml(url)}`, {
        priority: P.IMPORTANT,
      }),
    );
  });

  bot.callbackQuery("check", async (ctx) => {
    const userId = ctx.from.id;
    const cb = ctx.callbackQuery.id;
    const msg = ctx.callbackQuery.message;

    if (cooldown.active(`check:${userId}`)) return tg.answer(cb, defaultTexts.wait);
    cooldown.set(`check:${userId}`, cfg.CHECK_COOLDOWN_MS);

    const a = await cache.active();
    if (!a) return tg.answer(cb, defaultTexts.no_contest, true);
    const t = textsOf(a.contest);

    const p = await getParticipant(db, a.contest.id, userId);
    if (!p) return tg.answer(cb, t.press_start, true);
    if (p.verified_at) {
      tg.answer(cb);
      return show(userId, statusView(a, p, d.me.username), msg);
    }

    const local = await member.check(userId, a.sponsors);
    if (local.unknown.length === 0) {
      // Everything was known locally: finish inside the handler, no Telegram lookup.
      if (local.missing.length > 0) {
        return tg.answer(cb, truncate(render(t.not_subscribed, { channels: sponsorNames(local.missing) }), 200), true);
      }
      tg.answer(cb);
      return verified(a, p, msg);
    }

    // Some channels need a getChatMember call. Answer the click now and finish later;
    // the handler returns immediately so the batch is not held up.
    tg.answer(cb, t.checking);
    void member
      .resolve(userId, local.unknown)
      .then((more) => {
        const missing = [...local.missing, ...more];
        if (missing.length > 0) return show(userId, gateView(a, missing), msg);
        return verified(a, p, msg);
      })
      .catch((err) => log.warn({ err, userId }, "membership lookup failed"));
  });

  bot.callbackQuery("progress", async (ctx) => {
    const userId = ctx.from.id;
    const cb = ctx.callbackQuery.id;
    if (cooldown.active(`progress:${userId}`)) return tg.answer(cb, defaultTexts.wait);
    cooldown.set(`progress:${userId}`, cfg.CHECK_COOLDOWN_MS);

    const a = await cache.active();
    if (!a) return tg.answer(cb, defaultTexts.no_contest, true);
    const p = await getParticipant(db, a.contest.id, userId);
    if (!p) return tg.answer(cb, textsOf(a.contest).press_start, true);
    tg.answer(cb);
    show(userId, p.verified_at ? statusView(a, p, d.me.username) : gateView(a), ctx.callbackQuery.message);
  });

  // Any other button (for example from a message of an old contest): just stop the spinner.
  bot.on("callback_query", (ctx) => tg.answer(ctx.callbackQuery.id));

  bot.on("chat_join_request", async (ctx) => {
    const r = ctx.chatJoinRequest;
    // The worker decides; here we only record the request so it survives a restart.
    await sql`
      INSERT INTO join_requests (chat_id, user_id, user_chat_id, requested_at)
      VALUES (${r.chat.id}, ${r.from.id}, ${r.user_chat_id}, to_timestamp(${r.date}))
      ON CONFLICT (chat_id, user_id, requested_at) DO NOTHING
    `.execute(db);
  });

  bot.on("my_chat_member", async (ctx) => {
    const { chat, new_chat_member: m } = ctx.myChatMember;
    if (chat.type === "private") {
      // The user blocked or unblocked the bot.
      const blocked = m.status === "kicked";
      await sql`
        UPDATE users SET blocked_at = ${blocked ? sql`now()` : null} WHERE tg_id = ${chat.id}
      `.execute(db);
      return;
    }
    const isAdmin = m.status === "administrator" || m.status === "creator";
    const changed = await sql<{ title: string }>`
      UPDATE sponsor_channels s SET health = ${isAdmin ? "ok" : "bot_not_admin"}
        FROM contests c
       WHERE s.contest_id = c.id AND c.status <> 'finished' AND s.chat_id = ${chat.id}
         AND s.health <> ${isAdmin ? "ok" : "bot_not_admin"}
      RETURNING s.title
    `.execute(db);
    if (changed.rows.length === 0) return;
    cache.invalidate();
    const title = escapeHtml(changed.rows[0]!.title);
    d.alert(
      `sponsor:${chat.id}:${isAdmin}`,
      isAdmin
        ? `✅ The bot is an admin in sponsor channel <b>${title}</b> again. Subscription checks for it are back on.`
        : `⚠️ The bot is no longer an admin in sponsor channel <b>${title}</b>. Subscription checks for it are skipped until this is fixed.`,
    );
  });

  /** The user passed the gate: credit the referrer (once) and show the personal link. */
  async function verified(a: ActiveContest, p: Participant, msg?: MaybeInaccessibleMessage): Promise<void> {
    const result = await credit(db, a.contest, p.id);
    const fresh = (await getParticipant(db, a.contest.id, p.user_id)) ?? p;
    show(p.user_id, statusView(a, fresh, d.me.username), msg);

    const ref = result.referrer;
    // A referrer who just qualified gets the durable outbox message instead of a notice.
    if (!ref || ref.qualifiedNow || cooldown.active(`notice:${ref.userId}`)) return;
    cooldown.set(`notice:${ref.userId}`, cfg.NOTICE_COALESCE_MS);
    tg.fire(
      tg.send(
        ref.userId,
        render(textsOf(a.contest).notice, { count: ref.inviteCount, required: a.contest.required_invites }),
        { priority: P.NOTICE, maxAgeMs: cfg.NOTICE_MAX_AGE_MS },
      ),
    );
  }
}
