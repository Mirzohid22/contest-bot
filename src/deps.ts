import type { UserFromGetMe } from "grammy/types";
import type { Logger } from "pino";
import type { Config } from "./config.js";
import type { ContestCache } from "./contest/service.js";
import type { Db } from "./db/index.js";
import type { Membership } from "./member/service.js";
import type { Tg } from "./tg/gateway.js";
import type { Cooldown } from "./util.js";

/** Everything the handlers, workers, and admin API share. Built once in app.ts. */
export interface Deps {
  cfg: Config;
  db: Db;
  tg: Tg;
  cache: ContestCache;
  member: Membership;
  log: Logger;
  me: UserFromGetMe;
  cooldown: Cooldown;
  /** Sends a message to every admin, at most once per `key` per 10 minutes. */
  alert: (key: string, text: string) => void;
}
