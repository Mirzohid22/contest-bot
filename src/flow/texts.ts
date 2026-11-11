import type { InlineKeyboardMarkup } from "grammy/types";
import type { ActiveContest } from "../contest/service.js";
import type { Contest, Participant, Sponsor } from "../db/types.js";
import { escapeHtml } from "../util.js";

/**
 * Default message templates. Each contest can override any key through the admin panel
 * (stored in contests.texts). Templates are Telegram HTML; {placeholders} are escaped.
 */
export const defaultTexts = {
  no_contest: "There is no active contest right now. Please check back later.",
  gate: "👋 Welcome to <b>{title}</b>!\n\nTo take part, subscribe to all channels below, then press «{btn_check}».",
  gate_missing: "❌ Not subscribed yet: {channels}",
  not_subscribed: "You are not subscribed yet to: {channels}",
  checking: "Checking your subscriptions…",
  wait: "Please wait a few seconds and try again.",
  press_start: "Please send /start first.",
  status:
    "✅ You are in <b>{title}</b>!\n\nYour personal link:\n{link}\n\nInvited friends: <b>{count} / {required}</b>\n\nA friend counts once they open the bot with your link and subscribe to all channels.",
  status_qualified:
    "🎉 You have met the contest requirements!\n\nInvited friends: <b>{count} / {required}</b>\n\nYour personal link:\n{link}",
  qualified:
    "🎉 Congratulations! You have met the requirements of <b>{title}</b>.\n\nPress the button below and request to join the private channel. Your request is approved automatically.",
  notice: "👤 A friend joined with your link: <b>{count} / {required}</b>",
  declined:
    "Your request to join was declined: you have not met the contest requirements yet.\n\nOpen {bot_link} to take part.",
  declined_sponsors:
    "Your request to join was declined: you are no longer subscribed to all sponsor channels.\n\nSubscribe again, then request to join once more.",
  share_text: "Join the contest with my link!",
  btn_check: "✅ I subscribed",
  btn_progress: "🔄 My progress",
  btn_share: "📨 Share my link",
  btn_prize: "🔓 Open the private channel",
} as const;

export type TextKey = keyof typeof defaultTexts;
export type Texts = Record<TextKey, string>;

export function textsOf(contest: Contest | null): Texts {
  return { ...defaultTexts, ...(contest?.texts ?? {}) } as Texts;
}

export function render(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? escapeHtml(String(vars[key])) : whole,
  );
}

export interface View {
  text: string;
  markup: InlineKeyboardMarkup;
}

export const refLink = (botUsername: string, refCode: string) => `https://t.me/${botUsername}?start=${refCode}`;

const names = (sponsors: Sponsor[]) => sponsors.map((s) => s.title).join(", ");

/** The "subscribe to these channels" message. */
export function gateView(a: ActiveContest, missing: Sponsor[] = []): View {
  const t = textsOf(a.contest);
  let text = render(t.gate, { title: a.contest.title, btn_check: t.btn_check });
  if (missing.length > 0) text += "\n\n" + render(t.gate_missing, { channels: names(missing) });
  return {
    text,
    markup: {
      inline_keyboard: [
        ...a.sponsors.map((s) => [{ text: s.title, url: s.join_url }]),
        [{ text: t.btn_check, callback_data: "check" }],
      ],
    },
  };
}

/** The "your link and progress" message shown after verification. */
export function statusView(a: ActiveContest, p: Participant, botUsername: string): View {
  const t = textsOf(a.contest);
  const link = refLink(botUsername, p.ref_code);
  const qualified = p.qualified_at !== null && p.disqualified_at === null;
  const text = render(qualified ? t.status_qualified : t.status, {
    title: a.contest.title,
    link,
    count: p.invite_count,
    required: a.contest.required_invites,
  });
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(t.share_text)}`;
  const rows: InlineKeyboardMarkup["inline_keyboard"] = [
    [{ text: t.btn_share, url: share }],
    [{ text: t.btn_progress, callback_data: "progress" }],
  ];
  if (qualified && a.contest.prize_invite_link) {
    rows.unshift([{ text: t.btn_prize, url: a.contest.prize_invite_link }]);
  }
  return { text, markup: { inline_keyboard: rows } };
}

/** The durable "you qualified" message. */
export function qualifiedView(contest: Contest): { text: string; markup?: InlineKeyboardMarkup } {
  const t = textsOf(contest);
  return {
    text: render(t.qualified, { title: contest.title, required: contest.required_invites }),
    markup: contest.prize_invite_link
      ? { inline_keyboard: [[{ text: t.btn_prize, url: contest.prize_invite_link }]] }
      : undefined,
  };
}

export const sponsorNames = names;
