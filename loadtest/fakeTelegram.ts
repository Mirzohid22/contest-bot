import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Update } from "grammy/types";

/**
 * A stand-in for the Telegram Bot API, used by the tests and the load test.
 *
 * It implements the methods the bot uses, hands out updates through getUpdates with real
 * offset semantics (an update is redelivered until a later offset confirms it), and can
 * enforce per-method rate limits by answering 429 with retry_after, like the real API.
 */
export interface FakeOptions {
  /** Artificial delay before every response, in ms. */
  latencyMs?: number;
  /** Calls per second allowed per method (or per group, see `groups`). Unlisted methods are unlimited. */
  limits?: Record<string, number>;
  /** Methods that share one limit: method name to group name. The group name is the key in `limits`. */
  groups?: Record<string, string>;
  /** retry_after sent with a 429, in seconds. */
  retryAfter?: number;
  /** Keep every call's payload in `calls`. Turn off for big load tests. */
  record?: boolean;
}

export interface Call {
  method: string;
  payload: any;
  at: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type UpdateBody = DistributiveOmit<Update, "update_id">;

export class FakeTelegram {
  readonly botId = 7_000_000_001;
  readonly botUsername = "fake_contest_bot";
  readonly calls: Call[] = [];
  readonly counts: Record<string, number> = {};
  readonly limited: Record<string, number> = {};
  /** Called for every accepted call (after rate limiting). */
  onCall: ((method: string, payload: any) => void) | null = null;
  /** Total updates handed to the bot and confirmed by a later offset. */
  confirmed = 0;

  private readonly opts: Required<FakeOptions>;
  private readonly server: Server;
  private updates: Update[] = [];
  private head = 0;
  private waiters = new Set<() => void>();
  private nextUpdateId = 1;
  private nextMessageId = 1;
  private nextCallbackId = 1;
  private nextLink = 1;
  private members = new Map<number, Set<number>>();
  private buckets = new Map<string, { tokens: number; last: number }>();

  constructor(opts: FakeOptions = {}) {
    this.opts = { latencyMs: 0, limits: {}, groups: {}, retryAfter: 1, record: true, ...opts };
    this.server = createServer((req, res) => void this.route(req, res));
    this.server.keepAliveTimeout = 60_000;
  }

  listen(port = 0): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(port, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${(this.server.address() as AddressInfo).port}`);
      });
    });
  }

  close(): Promise<void> {
    for (const wake of this.waiters) wake();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // ---- test controls ----

  /** Queues an update for the bot. */
  push(body: UpdateBody): number {
    const update = { update_id: this.nextUpdateId++, ...body } as Update;
    this.updates.push(update);
    for (const wake of this.waiters) wake();
    return update.update_id;
  }

  /** Makes getChatMember report the user as a member, without sending a chat_member update. */
  setMember(chatId: number, userId: number, isMember = true): void {
    let set = this.members.get(chatId);
    if (!set) this.members.set(chatId, (set = new Set()));
    if (isMember) set.add(userId);
    else set.delete(userId);
  }

  /** Updates queued but not yet confirmed by the bot. */
  get backlog(): number {
    return this.updates.length - this.head;
  }

  count(method: string): number {
    return this.counts[method] ?? 0;
  }

  /** Recorded calls of one method to one chat. */
  sent(chatId: number, method = "sendMessage"): Call[] {
    return this.calls.filter((c) => c.method === method && c.payload.chat_id === chatId);
  }

  // ---- update builders ----

  user(id: number) {
    return { id, is_bot: false, first_name: `User ${id}`, username: `user${id}` };
  }

  start(userId: number, payload = ""): UpdateBody {
    const text = payload ? `/start ${payload}` : "/start";
    return {
      message: {
        message_id: this.nextMessageId++,
        date: now(),
        chat: { id: userId, type: "private", first_name: `User ${userId}` },
        from: this.user(userId),
        text,
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      },
    };
  }

  command(userId: number, name: string): UpdateBody {
    const text = `/${name}`;
    return {
      message: {
        message_id: this.nextMessageId++,
        date: now(),
        chat: { id: userId, type: "private", first_name: `User ${userId}` },
        from: this.user(userId),
        text,
        entities: [{ type: "bot_command", offset: 0, length: text.length }],
      },
    };
  }

  click(userId: number, data: string, messageId = 1): UpdateBody {
    return {
      callback_query: {
        id: String(this.nextCallbackId++),
        from: this.user(userId),
        chat_instance: "fake",
        data,
        message: {
          message_id: messageId,
          date: now(),
          chat: { id: userId, type: "private", first_name: `User ${userId}` },
          from: { id: this.botId, is_bot: true, first_name: "Fake", username: this.botUsername },
          text: "…",
        },
      },
    };
  }

  /** A user joined or left a channel. Also updates what getChatMember reports. */
  memberChange(chatId: number, userId: number, joined: boolean, date = now()): UpdateBody {
    this.setMember(chatId, userId, joined);
    const u = this.user(userId);
    return {
      chat_member: {
        chat: { id: chatId, type: "channel", title: `Channel ${chatId}` },
        from: u,
        date,
        old_chat_member: { user: u, status: joined ? "left" : "member" },
        new_chat_member: { user: u, status: joined ? "member" : "left" },
      },
    };
  }

  joinRequest(chatId: number, userId: number): UpdateBody {
    return {
      chat_join_request: {
        chat: { id: chatId, type: "channel", title: `Channel ${chatId}` },
        from: this.user(userId),
        user_chat_id: userId,
        date: now(),
      },
    };
  }

  /** The bot was promoted to or demoted from admin in a channel. */
  botAdminChange(chatId: number, isAdmin: boolean): UpdateBody {
    const bot = { id: this.botId, is_bot: true, first_name: "Fake", username: this.botUsername };
    // Only the fields the bot reads; the full administrator record has many more rights.
    const admin: any = { user: bot, status: "administrator", can_invite_users: true };
    const left: any = { user: bot, status: "left" };
    return {
      my_chat_member: {
        chat: { id: chatId, type: "channel", title: `Channel ${chatId}` },
        from: this.user(1),
        date: now(),
        old_chat_member: isAdmin ? left : admin,
        new_chat_member: isAdmin ? admin : left,
      },
    };
  }

  // ---- HTTP ----

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.url?.split("/").pop()?.split("?")[0] ?? "";
    let payload: any = {};
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) payload = JSON.parse(raw);
    } catch {
      return this.reply(res, 400, { ok: false, error_code: 400, description: "Bad Request: invalid body" });
    }

    if (this.opts.latencyMs > 0) await new Promise((r) => setTimeout(r, this.opts.latencyMs));

    if (!this.allow(method)) {
      this.limited[method] = (this.limited[method] ?? 0) + 1;
      return this.reply(res, 429, {
        ok: false,
        error_code: 429,
        description: `Too Many Requests: retry after ${this.opts.retryAfter}`,
        parameters: { retry_after: this.opts.retryAfter },
      });
    }

    if (method !== "getUpdates") {
      this.counts[method] = (this.counts[method] ?? 0) + 1;
      if (this.opts.record) this.calls.push({ method, payload, at: Date.now() });
      this.onCall?.(method, payload);
    }

    const result = await this.handle(method, payload, req);
    if (result === undefined) {
      return this.reply(res, 404, { ok: false, error_code: 404, description: `Not Found: method ${method}` });
    }
    this.reply(res, 200, { ok: true, result });
  }

  private reply(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private allow(method: string): boolean {
    const key = this.opts.groups[method] ?? method;
    const rate = this.opts.limits[key];
    if (rate === undefined) return true;
    const t = Date.now();
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { tokens: rate, last: t }));
    b.tokens = Math.min(rate, b.tokens + ((t - b.last) / 1000) * rate);
    b.last = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private async handle(method: string, p: any, req: IncomingMessage): Promise<unknown> {
    const bot = { id: this.botId, is_bot: true, first_name: "Fake", username: this.botUsername };
    switch (method) {
      case "getMe":
        return { ...bot, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
      case "deleteWebhook":
      case "answerCallbackQuery":
      case "approveChatJoinRequest":
      case "declineChatJoinRequest":
        return true;
      case "getUpdates":
        return this.getUpdates(p, req);
      case "sendMessage":
      case "editMessageText":
        return {
          message_id: method === "sendMessage" ? this.nextMessageId++ : p.message_id,
          date: now(),
          chat: { id: p.chat_id, type: "private" },
          from: bot,
          text: p.text,
        };
      case "getChatMember": {
        const target = { id: p.user_id, is_bot: p.user_id === this.botId, first_name: "x" };
        if (p.user_id === this.botId) {
          return { user: target, status: "administrator", can_invite_users: true, can_be_edited: false, is_anonymous: false };
        }
        const isMember = this.members.get(Number(p.chat_id))?.has(p.user_id) ?? false;
        return { user: target, status: isMember ? "member" : "left" };
      }
      case "getChat": {
        if (typeof p.chat_id === "string" && p.chat_id.startsWith("@")) {
          const name = p.chat_id.slice(1);
          let h = 0;
          for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 1_000_000;
          return { id: -1_002_000_000_000 - h, type: "channel", title: name, username: name };
        }
        return { id: Number(p.chat_id), type: "channel", title: `Channel ${p.chat_id}` };
      }
      case "createChatInviteLink":
        return {
          invite_link: `https://t.me/+fake${this.nextLink++}`,
          creator: bot,
          creates_join_request: p.creates_join_request === true,
          is_primary: false,
          is_revoked: false,
          name: p.name,
        };
      default:
        return undefined;
    }
  }

  private async getUpdates(p: any, req: IncomingMessage): Promise<Update[]> {
    const offset = Number(p.offset ?? 0);
    // Everything below the offset is confirmed and never sent again.
    while (this.head < this.updates.length && this.updates[this.head]!.update_id < offset) {
      this.head++;
      this.confirmed++;
    }
    if (this.head > 50_000) {
      this.updates = this.updates.slice(this.head);
      this.head = 0;
    }
    const limit = Math.min(Number(p.limit ?? 100), 100);
    if (this.backlog === 0 && Number(p.timeout ?? 0) > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          req.off("close", done);
          resolve();
        };
        const timer = setTimeout(done, Number(p.timeout) * 1000);
        this.waiters.add(done);
        req.on("close", done);
      });
    }
    return this.updates.slice(this.head, this.head + limit);
  }
}

const now = () => Math.floor(Date.now() / 1000);
