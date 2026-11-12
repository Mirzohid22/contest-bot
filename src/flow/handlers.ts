import { randomBytes } from "node:crypto";
import type { Bot } from "grammy";
import type { MaybeInaccessibleMessage } from "grammy/types";
import { sql } from "kysely";
import {
  type ActiveContest,
  credit,
  ensureParticipant,
  friendsOf,
  getParticipant,
  setLocale,
  upsertUser,
} from "../contest/service.js";
import type { ParticipantWithUser } from "../db/types.js";
import type { Deps } from "../deps.js";
import { P } from "../tg/gateway.js";
import { escapeHtml, sha256, truncate } from "../util.js";
import {
  friendsView,
  gateView,
  isLocale,
  languageView,
  leaderboardView,
  type Locale,
  pickLocale,
  progressBar,
  render,
  sponsorNames,
  statusView,
  textsOf,
  type View,
} from "./texts.js";

/** Telegram's limit for a picture caption. Longer views are sent as plain text instead. */
const CAPTION_MAX = 1024;

/**
 * Update handlers. Two rules keep the poll loop fast and replay-safe:
 *
 * 1. A handler awaits only the database. Telegram calls are queued (tg.fire / tg.answer),
 *    never awaited, so a slow or rate-limited API cannot stall a batch.
 * 2. A handler may run twice for the same update. State changes are conditional or
 *    idempotent; the worst a replay does is send a message again.
 */
export function registerHandlers(bot: Bot, d: Deps): void {
  const { cfg, db, tg, cache, member, cooldown, log, leaderboard } = d;
  const dm = bot.chatType("private");
  const localeOfP = (p: ParticipantWithUser): Locale => pickLocale(p.locale, p.lang, cfg.DEFAULT_LOCALE);

  /**
   * Shows a view: edits the message the user clicked on, or sends a new one.
   * A message with a picture can only have its caption edited.
   */
  const show = (chatId: number, v: View, msg?: MaybeInaccessibleMessage) => {
    if (msg) {
      const isPhoto = "photo" in msg && msg.photo !== undefined;
      if (!isPhoto) return tg.fire(tg.edit(msg.chat.id, msg.message_id, v.text, v.markup));
      if (v.text.length <= CAPTION_MAX) {
        return tg.fire(tg.editCaption(msg.chat.id, msg.message_id, v.text, v.markup));
      }
      return tg.fire(tg.send(chatId, v.text, { markup: v.markup, priority: P.EDIT }));
    }
    if (v.photo && v.text.length <= CAPTION_MAX) {
      return tg.fire(tg.sendPhoto(chatId, v.photo, v.text, { markup: v.markup, priority: P.START }));
    }
    tg.fire(tg.send(chatId, v.text, { markup: v.markup, priority: P.START }));
  };

  const home = (a: ActiveContest, p: ParticipantWithUser, locale: Locale): View =>
    p.verified_at ? statusView(a, p, d.me.username, locale) : gateView(a, locale);

  /** Shared start of every button handler: cooldown, active contest, participant. */
  async function context(cb: string, userId: number, key: string, fallback: Locale) {
    if (cooldown.active(`${key}:${userId}`)) {
      tg.answer(cb, textsOf(null, fallback).wait);
      return null;
    }
    cooldown.set(`${key}:${userId}`, cfg.CHECK_COOLDOWN_MS);
    const a = await cache.active();
    if (!a) {
      tg.answer(cb, textsOf(null, fallback).no_contest, true);
      return null;
    }
    const p = await getParticipant(db, a.contest.id, userId);
    if (!p) {
      tg.answer(cb, textsOf(a.contest, fallback).press_start, true);
      return null;
    }
    return { a, p, locale: localeOfP(p) };
  }

  /** Language for answers sent before the participant row is loaded. */
  const quickLocale = (code: string | undefined): Locale => pickLocale(null, code, cfg.DEFAULT_LOCALE);

  dm.command("start", async (ctx) => {
    const user = ctx.from;
    if (cooldown.active(`start:${user.id}`)) return;

    const u = await upsertUser(db, user);
    const locale = pickLocale(u.locale, u.lang, cfg.DEFAULT_LOCALE);
    const a = await cache.active();
    if (!a) {
      tg.fire(tg.send(user.id, textsOf(null, locale).no_contest, { priority: P.START }));
    } else {
      const p = await ensureParticipant(db, a.contest.id, user.id, ctx.match.trim());
      show(user.id, p.verified_at ? statusView(a, p, d.me.username, locale) : gateView(a, locale));
    }
    // Set last: if anything above threw, the retry must not be swallowed by the cooldown.
    cooldown.set(`start:${user.id}`, cfg.START_COOLDOWN_MS);
  });

  dm.command(["lang", "language", "til", "yazyk"], async (ctx) => {
    const u = await upsertUser(db, ctx.from);
    const a = await cache.active();
    show(ctx.from.id, languageView(a?.contest ?? null, pickLocale(u.locale, u.lang, cfg.DEFAULT_LOCALE)));
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
    const c = await context(cb, userId, "check", quickLocale(ctx.from.language_code));
    if (!c) return;
    const { a, p, locale } = c;
    const t = textsOf(a.contest, locale);

    if (p.verified_at) {
      tg.answer(cb);
      return show(userId, statusView(a, p, d.me.username, locale), msg);
    }

    const local = await member.check(userId, a.sponsors);
    if (local.unknown.length === 0) {
      // Everything was known locally: finish inside the handler, no Telegram lookup.
      if (local.missing.length > 0) {
        // Only a popup: answering a click is cheap, while an edit would take a slot of the
        // 30-per-second send limit that new users are waiting for during a spike.
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
        if (missing.length > 0) return show(userId, gateView(a, locale, missing), msg);
        return verified(a, p, msg);
      })
      .catch((err) => log.warn({ err, userId }, "membership lookup failed"));
  });

  bot.callbackQuery("progress", async (ctx) => {
    const cb = ctx.callbackQuery.id;
    const c = await context(cb, ctx.from.id, "progress", quickLocale(ctx.from.language_code));
    if (!c) return;
    tg.answer(cb);
    show(ctx.from.id, home(c.a, c.p, c.locale), ctx.callbackQuery.message);
  });

  bot.callbackQuery("top", async (ctx) => {
    const cb = ctx.callbackQuery.id;
    const c = await context(cb, ctx.from.id, "top", quickLocale(ctx.from.language_code));
    if (!c) return;
    const { a, p, locale } = c;
    const top = await leaderboard.top(a.contest.id);
    const counted = p.verified_at !== null && p.disqualified_at === null;
    const me = counted ? { rank: await leaderboard.rank(a.contest.id, p.invite_count), count: p.invite_count } : null;
    tg.answer(cb);
    show(ctx.from.id, leaderboardView(a, locale, top, me), ctx.callbackQuery.message);
  });

  bot.callbackQuery("friends", async (ctx) => {
    const cb = ctx.callbackQuery.id;
    const c = await context(cb, ctx.from.id, "friends", quickLocale(ctx.from.language_code));
    if (!c) return;
    const { rows, total } = await friendsOf(db, c.p.id);
    tg.answer(cb);
    show(ctx.from.id, friendsView(c.a, c.locale, rows, total), ctx.callbackQuery.message);
  });

  bot.callbackQuery("lang", async (ctx) => {
    const cb = ctx.callbackQuery.id;
    const a = await cache.active();
    const p = a ? await getParticipant(db, a.contest.id, ctx.from.id) : null;
    const locale = p ? localeOfP(p) : quickLocale(ctx.from.language_code);
    tg.answer(cb);
    show(ctx.from.id, languageView(a?.contest ?? null, locale), ctx.callbackQuery.message);
  });

  bot.callbackQuery(/^lang:(\w+)$/, async (ctx) => {
    const cb = ctx.callbackQuery.id;
    const chosen = ctx.match[1];
    if (!isLocale(chosen)) return tg.answer(cb);
    await upsertUser(db, ctx.from);
    await setLocale(db, ctx.from.id, chosen);
    tg.answer(cb, "✓");
    const a = await cache.active();
    if (!a) return show(ctx.from.id, { text: textsOf(null, chosen).no_contest, markup: { inline_keyboard: [] } }, ctx.callbackQuery.message);
    const p = await getParticipant(db, a.contest.id, ctx.from.id);
    if (!p) return show(ctx.from.id, gateView(a, chosen), ctx.callbackQuery.message);
    show(ctx.from.id, home(a, p, chosen), ctx.callbackQuery.message);
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
  async function verified(a: ActiveContest, p: ParticipantWithUser, msg?: MaybeInaccessibleMessage): Promise<void> {
    const result = await credit(db, a.contest, p.id, cfg.DEFAULT_LOCALE);
    const fresh = (await getParticipant(db, a.contest.id, p.user_id)) ?? p;
    show(p.user_id, statusView(a, fresh, d.me.username, localeOfP(fresh)), msg);

    const ref = result.referrer;
    // A referrer who just qualified gets the durable outbox message instead of a notice.
    if (!ref || ref.qualifiedNow || cooldown.active(`notice:${ref.userId}`)) return;
    cooldown.set(`notice:${ref.userId}`, cfg.NOTICE_COALESCE_MS);
    const required = a.contest.required_invites;
    tg.fire(
      tg.send(
        ref.userId,
        render(textsOf(a.contest, ref.locale).notice, {
          count: ref.inviteCount,
          required,
          bar: progressBar(ref.inviteCount, required),
        }),
        { priority: P.NOTICE, maxAgeMs: cfg.NOTICE_MAX_AGE_MS },
      ),
    );
  }
}
