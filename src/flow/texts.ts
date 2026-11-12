import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import type { ActiveContest } from "../contest/service.js";
import type { Contest, Participant, Sponsor } from "../db/types.js";
import { escapeHtml, truncate } from "../util.js";

export const LOCALES = ["uz", "ru", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_NAMES: Record<Locale, string> = {
  uz: "🇺🇿 Oʻzbekcha",
  ru: "🇷🇺 Русский",
  en: "🇬🇧 English",
};

export const isLocale = (s: unknown): s is Locale => typeof s === "string" && (LOCALES as readonly string[]).includes(s);

/**
 * The language to talk to a user in: the one they picked in the bot, else their Telegram
 * language if we have it, else the bot's default.
 */
export function pickLocale(chosen: string | null | undefined, telegram: string | null | undefined, fallback: Locale): Locale {
  if (isLocale(chosen)) return chosen;
  const tg = (telegram ?? "").slice(0, 2).toLowerCase();
  if (tg === "uz" || tg === "ru") return tg;
  return fallback;
}

/**
 * Message templates per language. Each contest can override any key per language through
 * the admin panel (stored in contests.texts as {"uz": {...}, ...}). Templates are Telegram
 * HTML; {placeholders} are filled in and escaped.
 */
const uz = {
  no_contest: "Hozircha faol tanlov yoʻq. Keyinroq qayta urinib koʻring.",
  gate: "👋 <b>{title}</b> tanloviga xush kelibsiz!\n\nIshtirok etish uchun quyidagi kanallarga obuna boʻling, soʻng «{btn_check}» tugmasini bosing:",
  gate_missing: "⚠️ ❌ belgisi bor kanallarga hali obuna boʻlmagansiz.",
  not_subscribed: "Hali obuna boʻlmagansiz: {channels}",
  checking: "Obunalar tekshirilmoqda…",
  wait: "Bir necha soniyadan soʻng qayta urinib koʻring.",
  press_start: "Iltimos, avval /start buyrugʻini yuboring.",
  status:
    "🏆 <b>{title}</b>\n\n{bar}  <b>{count}/{required}</b>\nYana <b>{left}</b> ta doʻstingizni taklif qiling!\n\n🔗 Shaxsiy havolangiz:\n{link}\n\n<i>Doʻstingiz havolangiz orqali botga kirib, barcha kanallarga obuna boʻlgach hisoblanadi.</i>",
  status_qualified:
    "🎉 <b>{title}</b>\n\n{bar}  <b>{count}/{required}</b>\nShartlar bajarildi! Yopiq kanalga qoʻshilish uchun pastdagi tugmani bosing.\n\n🔗 Shaxsiy havolangiz:\n{link}",
  qualified:
    "🎉 Tabriklaymiz! Siz <b>{title}</b> tanlovi shartlarini bajardingiz.\n\nPastdagi tugmani bosing va yopiq kanalga qoʻshilish soʻrovini yuboring — u avtomatik tasdiqlanadi.",
  notice: "👤 Havolangiz orqali yangi doʻst qoʻshildi!\n{bar}  <b>{count}/{required}</b>",
  declined: "Soʻrovingiz rad etildi: siz hali tanlov shartlarini bajarmagansiz.\n\nIshtirok etish uchun {bot_link} ni oching.",
  declined_sponsors:
    "Soʻrovingiz rad etildi: siz homiy kanallardan chiqib ketgansiz.\n\nQayta obuna boʻling va soʻrovni yana yuboring.",
  share_text: "Mening havolam orqali tanlovda ishtirok eting!",
  top_title: "🏅 <b>Eng faol ishtirokchilar</b>",
  top_empty: "Hozircha hech kim doʻst taklif qilmagan. Birinchi boʻling!",
  top_you: "Sizning oʻrningiz: <b>#{rank}</b> · {count} ta doʻst",
  friends_title: "👥 <b>Siz taklif qilgan doʻstlar</b> ({total})",
  friends_empty: "Hali hech kim yoʻq. Havolangizni doʻstlaringizga yuboring!",
  friends_legend: "✅ hisoblandi · ⏳ kanallarga hali obuna boʻlmagan",
  friends_more: "…va yana {n} ta",
  lang_pick: "🌐 Tilni tanlang:",
  btn_check: "✅ Obuna boʻldim",
  btn_progress: "🔄 Yangilash",
  btn_share: "📨 Ulashish",
  btn_copy: "📋 Nusxalash",
  btn_prize: "🔓 Yopiq kanalga kirish",
  btn_top: "🏅 Reyting",
  btn_friends: "👥 Doʻstlarim",
  btn_back: "⬅️ Orqaga",
  btn_lang: "🌐 Til",
};

export type TextKey = keyof typeof uz;
export type Texts = Record<TextKey, string>;

const ru: Texts = {
  no_contest: "Сейчас нет активного конкурса. Загляните позже.",
  gate: "👋 Добро пожаловать в конкурс <b>{title}</b>!\n\nЧтобы участвовать, подпишитесь на каналы ниже и нажмите «{btn_check}»:",
  gate_missing: "⚠️ Вы ещё не подписаны на каналы, отмеченные ❌.",
  not_subscribed: "Вы ещё не подписаны на: {channels}",
  checking: "Проверяем подписки…",
  wait: "Подождите несколько секунд и попробуйте снова.",
  press_start: "Сначала отправьте /start.",
  status:
    "🏆 <b>{title}</b>\n\n{bar}  <b>{count}/{required}</b>\nПригласите ещё <b>{left}</b>!\n\n🔗 Ваша личная ссылка:\n{link}\n\n<i>Друг засчитывается, когда откроет бота по вашей ссылке и подпишется на все каналы.</i>",
  status_qualified:
    "🎉 <b>{title}</b>\n\n{bar}  <b>{count}/{required}</b>\nУсловия выполнены! Нажмите кнопку ниже, чтобы вступить в закрытый канал.\n\n🔗 Ваша личная ссылка:\n{link}",
  qualified:
    "🎉 Поздравляем! Вы выполнили условия конкурса <b>{title}</b>.\n\nНажмите кнопку ниже и отправьте заявку в закрытый канал — она будет одобрена автоматически.",
  notice: "👤 По вашей ссылке присоединился друг!\n{bar}  <b>{count}/{required}</b>",
  declined: "Ваша заявка отклонена: вы ещё не выполнили условия конкурса.\n\nОткройте {bot_link}, чтобы участвовать.",
  declined_sponsors:
    "Ваша заявка отклонена: вы отписались от каналов спонсоров.\n\nПодпишитесь снова и отправьте заявку ещё раз.",
  share_text: "Участвуй в конкурсе по моей ссылке!",
  top_title: "🏅 <b>Самые активные участники</b>",
  top_empty: "Пока никто никого не пригласил. Будьте первым!",
  top_you: "Ваше место: <b>#{rank}</b> · друзей: {count}",
  friends_title: "👥 <b>Приглашённые вами друзья</b> ({total})",
  friends_empty: "Пока никого. Отправьте свою ссылку друзьям!",
  friends_legend: "✅ засчитан · ⏳ ещё не подписался на каналы",
  friends_more: "…и ещё {n}",
  lang_pick: "🌐 Выберите язык:",
  btn_check: "✅ Я подписался",
  btn_progress: "🔄 Обновить",
  btn_share: "📨 Поделиться",
  btn_copy: "📋 Копировать",
  btn_prize: "🔓 Войти в закрытый канал",
  btn_top: "🏅 Рейтинг",
  btn_friends: "👥 Мои друзья",
  btn_back: "⬅️ Назад",
  btn_lang: "🌐 Язык",
};

const en: Texts = {
  no_contest: "There is no active contest right now. Please check back later.",
  gate: "👋 Welcome to <b>{title}</b>!\n\nTo take part, subscribe to the channels below, then press «{btn_check}»:",
  gate_missing: "⚠️ Not subscribed yet to the channels marked ❌.",
  not_subscribed: "You are not subscribed yet to: {channels}",
  checking: "Checking your subscriptions…",
  wait: "Please wait a few seconds and try again.",
  press_start: "Please send /start first.",
  status:
    "🏆 <b>{title}</b>\n\n{bar}  <b>{count}/{required}</b>\nInvite <b>{left}</b> more!\n\n🔗 Your personal link:\n{link}\n\n<i>A friend counts once they open the bot with your link and subscribe to all channels.</i>",
  status_qualified:
    "🎉 <b>{title}</b>\n\n{bar}  <b>{count}/{required}</b>\nYou have met the requirements! Press the button below to join the private channel.\n\n🔗 Your personal link:\n{link}",
  qualified:
    "🎉 Congratulations! You have met the requirements of <b>{title}</b>.\n\nPress the button below and request to join the private channel. Your request is approved automatically.",
  notice: "👤 A friend joined with your link!\n{bar}  <b>{count}/{required}</b>",
  declined:
    "Your request to join was declined: you have not met the contest requirements yet.\n\nOpen {bot_link} to take part.",
  declined_sponsors:
    "Your request to join was declined: you are no longer subscribed to all sponsor channels.\n\nSubscribe again, then request to join once more.",
  share_text: "Join the contest with my link!",
  top_title: "🏅 <b>Top inviters</b>",
  top_empty: "Nobody has invited anyone yet. Be the first!",
  top_you: "Your place: <b>#{rank}</b> · {count} friends",
  friends_title: "👥 <b>Friends you invited</b> ({total})",
  friends_empty: "Nobody yet. Send your link to your friends!",
  friends_legend: "✅ counted · ⏳ not subscribed to the channels yet",
  friends_more: "…and {n} more",
  lang_pick: "🌐 Choose your language:",
  btn_check: "✅ I subscribed",
  btn_progress: "🔄 Refresh",
  btn_share: "📨 Share",
  btn_copy: "📋 Copy link",
  btn_prize: "🔓 Open the private channel",
  btn_top: "🏅 Leaderboard",
  btn_friends: "👥 My friends",
  btn_back: "⬅️ Back",
  btn_lang: "🌐 Language",
};

export const defaultTexts: Record<Locale, Texts> = { uz, ru, en };
export const TEXT_KEYS = Object.keys(uz) as TextKey[];

/** The contest's texts in one language: its overrides on top of the defaults. */
export function textsOf(contest: Contest | null, locale: Locale): Texts {
  const overrides = (contest?.texts as Record<string, Record<string, string>> | undefined)?.[locale] ?? {};
  return { ...defaultTexts[locale], ...overrides };
}

export function render(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? escapeHtml(String(vars[key])) : whole,
  );
}

/** "▰▰▰▱▱": at most ten segments, full when the requirement is met. */
export function progressBar(count: number, required: number): string {
  const width = Math.min(Math.max(required, 1), 10);
  const filled = required <= 0 ? width : Math.min(width, Math.floor((count / required) * width));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

export interface View {
  text: string;
  markup: InlineKeyboardMarkup;
  /** Telegram file_id of a picture to show with the text, when the message is new. */
  photo?: string | null;
}

export const refLink = (botUsername: string, refCode: string) => `https://t.me/${botUsername}?start=${refCode}`;

const names = (sponsors: Sponsor[]) => sponsors.map((s) => s.title).join(", ");
export const sponsorNames = names;

const langButton = (t: Texts): InlineKeyboardButton => ({ text: t.btn_lang, callback_data: "lang" });

/**
 * The "subscribe to these channels" message. `missing` marks channels the user is not in;
 * when it is given, every other channel is shown as done.
 */
export function gateView(a: ActiveContest, locale: Locale, missing?: Sponsor[]): View {
  const t = textsOf(a.contest, locale);
  const missingIds = new Set(missing?.map((s) => s.id));
  const lines = a.sponsors.map((s, i) => {
    const mark = missing === undefined ? "▫️" : missingIds.has(s.id) ? "❌" : "✅";
    return `${i + 1}. ${mark} ${escapeHtml(s.title)}`;
  });
  let text = render(t.gate, { title: a.contest.title, btn_check: t.btn_check });
  if (lines.length > 0) text += "\n\n" + lines.join("\n");
  if (missing && missing.length > 0) text += "\n\n" + render(t.gate_missing, { channels: names(missing) });
  const toJoin = missing ?? a.sponsors;
  return {
    text,
    photo: a.contest.banner_file_id,
    markup: {
      inline_keyboard: [
        ...toJoin.map((s) => [{ text: `➕ ${s.title}`, url: s.join_url }]),
        [{ text: t.btn_check, callback_data: "check" }],
        [langButton(t)],
      ],
    },
  };
}

/** The "your link and progress" card shown after verification. */
export function statusView(a: ActiveContest, p: Participant, botUsername: string, locale: Locale): View {
  const t = textsOf(a.contest, locale);
  const link = refLink(botUsername, p.ref_code);
  const required = a.contest.required_invites;
  const qualified = p.qualified_at !== null && p.disqualified_at === null;
  const text = render(qualified ? t.status_qualified : t.status, {
    title: a.contest.title,
    link,
    count: p.invite_count,
    required,
    left: Math.max(required - p.invite_count, 0),
    bar: progressBar(p.invite_count, required),
  });
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(t.share_text)}`;
  const rows: InlineKeyboardButton[][] = [
    [
      { text: t.btn_share, url: share },
      { text: t.btn_copy, copy_text: { text: link } },
    ],
    [
      { text: t.btn_top, callback_data: "top" },
      { text: t.btn_friends, callback_data: "friends" },
    ],
    [
      { text: t.btn_progress, callback_data: "progress" },
      langButton(t),
    ],
  ];
  if (qualified && a.contest.prize_invite_link) {
    rows.unshift([{ text: t.btn_prize, url: a.contest.prize_invite_link }]);
  }
  return { text, markup: { inline_keyboard: rows }, photo: a.contest.banner_file_id };
}

export interface LeaderRow {
  first_name: string | null;
  username: string | null;
  invite_count: number;
}

const MEDALS = ["🥇", "🥈", "🥉"];

/** Shows first names only (no usernames): the list is visible to every participant. */
const publicName = (r: { first_name: string | null }) => escapeHtml(truncate((r.first_name ?? "").trim() || "—", 18));

export function leaderboardView(
  a: ActiveContest,
  locale: Locale,
  top: LeaderRow[],
  me: { rank: number; count: number } | null,
): View {
  const t = textsOf(a.contest, locale);
  const lines = top.map((r, i) => `${MEDALS[i] ?? `<b>${i + 1}.</b>`} ${publicName(r)} — <b>${r.invite_count}</b>`);
  let text = `${t.top_title}\n\n${lines.length > 0 ? lines.join("\n") : t.top_empty}`;
  if (me) text += "\n\n" + render(t.top_you, { rank: me.rank, count: me.count });
  return { text, markup: { inline_keyboard: [[{ text: t.btn_back, callback_data: "progress" }]] } };
}

export interface FriendRow {
  first_name: string | null;
  verified_at: Date | null;
  disqualified_at: Date | null;
}

export function friendsView(a: ActiveContest, locale: Locale, friends: FriendRow[], total: number): View {
  const t = textsOf(a.contest, locale);
  let text = render(t.friends_title, { total });
  if (friends.length === 0) {
    text += "\n\n" + t.friends_empty;
  } else {
    const lines = friends.map((f) => `${f.disqualified_at ? "🚫" : f.verified_at ? "✅" : "⏳"} ${publicName(f)}`);
    text += "\n\n" + lines.join("\n");
    if (total > friends.length) text += "\n" + render(t.friends_more, { n: total - friends.length });
    text += "\n\n<i>" + t.friends_legend + "</i>";
  }
  return { text, markup: { inline_keyboard: [[{ text: t.btn_back, callback_data: "progress" }]] } };
}

export function languageView(contest: Contest | null, locale: Locale): View {
  const t = textsOf(contest, locale);
  return {
    text: t.lang_pick,
    markup: {
      inline_keyboard: LOCALES.map((l) => [
        { text: (l === locale ? "• " : "") + LOCALE_NAMES[l], callback_data: `lang:${l}` },
      ]),
    },
  };
}

/** The durable "you qualified" message. */
export function qualifiedView(contest: Contest, locale: Locale): { text: string; markup?: InlineKeyboardMarkup } {
  const t = textsOf(contest, locale);
  return {
    text: render(t.qualified, { title: contest.title, required: contest.required_invites }),
    markup: contest.prize_invite_link
      ? { inline_keyboard: [[{ text: t.btn_prize, url: contest.prize_invite_link }]] }
      : undefined,
  };
}
