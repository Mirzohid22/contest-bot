import { type Api, GrammyError } from "grammy";
import type { ChatFullInfo, ChatInviteLink, ChatMember, InlineKeyboardMarkup, Message } from "grammy/types";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { Dropped, Lane, RateLimited } from "./lane.js";

/** Send-lane priorities. Lower is sooner; equal priorities are served in arrival order. */
export const P = {
  /** First reply to /start: the user is staring at an empty chat. */
  START: 0,
  /**
   * Edits of a message the user just interacted with. Same level as START on purpose:
   * if new arrivals always went first, people one step from finishing would wait behind
   * every newcomer for as long as the spike lasts.
   */
  EDIT: 0,
  /** "You qualified", join-request answers, admin alerts. */
  IMPORTANT: 1,
  /** "A friend joined" notices: nice to have, dropped under load. */
  NOTICE: 2,
  /** Admin broadcasts. */
  BROADCAST: 3,
} as const;

export interface SendOptions {
  priority?: number;
  markup?: InlineKeyboardMarkup;
  maxAgeMs?: number;
}

export const isBlocked = (e: unknown) => e instanceof GrammyError && e.error_code === 403;

/** Errors that mean "nothing to do", not "something is wrong". */
export function isIgnorable(e: unknown): boolean {
  if (e instanceof Dropped) return true;
  if (!(e instanceof GrammyError) || e.error_code !== 400) return false;
  const d = e.description.toLowerCase();
  return (
    d.includes("message is not modified") ||
    d.includes("query is too old") ||
    d.includes("query id is invalid") ||
    d.includes("message to edit not found") ||
    d.includes("message can't be edited")
  );
}

/**
 * The only way out to Telegram. Every call goes through one of four lanes,
 * so no handler can exceed a limit by accident.
 */
export class Tg {
  readonly lanes: { send: Lane; callback: Lane; lookup: Lane; manage: Lane };

  constructor(
    readonly raw: Api,
    cfg: Config,
    private readonly log: Logger,
    private readonly onBlocked: (chatId: number) => void,
  ) {
    this.lanes = {
      send: new Lane({
        name: "send",
        rate: cfg.SEND_RATE,
        minRate: 5,
        maxRate: cfg.SEND_RATE_MAX,
        maxInflight: 30,
        priorities: 4,
        perChatMs: cfg.PER_CHAT_MS,
      }),
      callback: new Lane({
        name: "callback",
        rate: cfg.CALLBACK_RATE,
        minRate: 10,
        maxRate: cfg.CALLBACK_RATE_MAX,
        maxInflight: 50,
      }),
      lookup: new Lane({
        name: "lookup",
        rate: cfg.LOOKUP_RATE,
        minRate: 2,
        maxRate: cfg.LOOKUP_RATE_MAX,
        maxInflight: 20,
      }),
      manage: new Lane({
        name: "manage",
        rate: cfg.MANAGE_RATE,
        minRate: 1,
        maxRate: cfg.MANAGE_RATE_MAX,
        maxInflight: 5,
      }),
    };
  }

  send(chatId: number, text: string, o: SendOptions = {}): Promise<Message.TextMessage> {
    return this.lanes.send
      .schedule(
        () =>
          this.raw.sendMessage(chatId, text, {
            parse_mode: "HTML",
            reply_markup: o.markup,
            link_preview_options: { is_disabled: true },
          }),
        { priority: o.priority ?? P.START, chatId, maxAgeMs: o.maxAgeMs },
      )
      .catch((e) => {
        if (isBlocked(e)) this.onBlocked(chatId);
        throw e;
      });
  }

  edit(chatId: number, messageId: number, text: string, markup?: InlineKeyboardMarkup, priority: number = P.EDIT) {
    return this.lanes.send.schedule(
      () =>
        this.raw.editMessageText(chatId, messageId, text, {
          parse_mode: "HTML",
          reply_markup: markup,
          link_preview_options: { is_disabled: true },
        }),
      { priority, chatId },
    );
  }

  /** Answers a button press. Never throws: a late answer is useless but harmless. */
  answer(callbackQueryId: string, text?: string, alert = false): void {
    this.fire(
      this.lanes.callback.schedule(
        () => this.raw.answerCallbackQuery(callbackQueryId, { text, show_alert: alert }),
        { maxAgeMs: 20_000 },
      ),
    );
  }

  /** For calls whose result nobody waits for: log real failures, ignore expected ones. */
  fire(p: Promise<unknown>): void {
    p.catch((e) => {
      if (isIgnorable(e) || isBlocked(e)) return;
      this.log.warn({ err: e }, "telegram call failed");
    });
  }

  getChatMember(chatId: number, userId: number): Promise<ChatMember> {
    return this.lanes.lookup.schedule(() => this.raw.getChatMember(chatId, userId));
  }

  getChat(chat: number | string): Promise<ChatFullInfo> {
    return this.lanes.manage.schedule(() => this.raw.getChat(chat));
  }

  createInviteLink(chatId: number, o: { name?: string; joinRequest?: boolean } = {}): Promise<ChatInviteLink> {
    return this.lanes.manage.schedule(() =>
      this.raw.createChatInviteLink(chatId, { name: o.name, creates_join_request: o.joinRequest }),
    );
  }

  approveJoin(chatId: number, userId: number): Promise<true> {
    return this.lanes.manage.schedule(() => this.raw.approveChatJoinRequest(chatId, userId));
  }

  declineJoin(chatId: number, userId: number): Promise<true> {
    return this.lanes.manage.schedule(() => this.raw.declineChatJoinRequest(chatId, userId));
  }

  /**
   * Safety net for a second Api object (the one grammY gives to handlers as ctx.api):
   * if anyone calls it directly, the call is still routed through a lane.
   */
  guard(api: Api): void {
    api.config.use((prev, method, payload, signal) => {
      const lane = this.laneFor(method);
      return lane.schedule(async () => {
        const res = await prev(method, payload, signal);
        if (!res.ok && res.error_code === 429) throw new RateLimited(res.parameters?.retry_after ?? 1);
        return res;
      });
    });
  }

  private laneFor(method: string): Lane {
    if (method === "answerCallbackQuery") return this.lanes.callback;
    if (method === "getChatMember") return this.lanes.lookup;
    if (method.startsWith("send") || method.startsWith("edit") || method.startsWith("forward") || method.startsWith("copy")) {
      return this.lanes.send;
    }
    return this.lanes.manage;
  }
}
