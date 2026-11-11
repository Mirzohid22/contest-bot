import { z } from "zod";

const num = (def: number) => z.coerce.number().default(def);

const schema = z.object({
  BOT_TOKEN: z.string().min(10, "BOT_TOKEN is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  ADMIN_IDS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isSafeInteger(n) && n > 0),
    ),
  PUBLIC_URL: z
    .string()
    .default("http://localhost:3000")
    .transform((s) => s.replace(/\/+$/, "")),
  PORT: num(3000),
  HOST: z.string().default("0.0.0.0"),
  /** Override the Bot API base URL. Used by tests and the load test. */
  TG_API_ROOT: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  DB_POOL: num(16),

  // Lane rates, in calls per second. Only the send rate is documented by Telegram;
  // the others are starting points that adapt down on 429 and back up on success.
  SEND_RATE: num(25),
  SEND_RATE_MAX: num(30),
  CALLBACK_RATE: num(100),
  CALLBACK_RATE_MAX: num(300),
  LOOKUP_RATE: num(20),
  LOOKUP_RATE_MAX: num(60),
  MANAGE_RATE: num(10),
  MANAGE_RATE_MAX: num(20),

  /** Minimum gap between two messages to the same chat (Telegram asks for about one per second). */
  PER_CHAT_MS: num(1000),

  /** Minimum gap between two "I subscribed" clicks from one user. */
  CHECK_COOLDOWN_MS: num(3000),
  /** Minimum gap between two /start replies to one user. */
  START_COOLDOWN_MS: num(3000),
  /** How long a "not a member" answer is trusted before asking Telegram again. */
  NEGATIVE_TTL_MS: num(15_000),
  /** At most one "a friend joined" notice per referrer in this window. */
  NOTICE_COALESCE_MS: num(30_000),
  /** Notices older than this are dropped instead of sent. */
  NOTICE_MAX_AGE_MS: num(60_000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
