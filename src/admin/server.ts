import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { GrammyError } from "grammy";
import { sql } from "kysely";
import { z, ZodError } from "zod";
import type { Deps } from "../deps.js";
import type { Poller } from "../ingest/poller.js";
import { buildMetrics } from "../metrics.js";
import { sha256 } from "../util.js";
import { registerRoutes } from "./routes.js";

declare module "fastify" {
  interface FastifyRequest {
    adminId: number;
  }
}

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const SESSION_DAYS = 7;

export class HttpProblem extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

// The token is consumed by the button's POST, not by opening the page, so a link
// preview or a mail scanner that fetches the URL cannot burn it.
const LOGIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Admin sign-in</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f5f4;color:#1c1917}
main{background:#fff;padding:32px;border-radius:12px;border:1px solid #e7e5e4;text-align:center;max-width:320px}
button{font:inherit;padding:10px 24px;border-radius:8px;border:0;background:#1c1917;color:#fff;cursor:pointer}
p{color:#b91c1c;min-height:1.2em}</style></head>
<body><main><h2>Contest bot admin</h2><button id="go">Sign in</button><p id="msg"></p></main>
<script>
document.getElementById("go").onclick = async () => {
  const token = new URLSearchParams(location.search).get("token");
  const res = await fetch("/admin/api/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token })
  });
  if (res.ok) location.replace("/admin/");
  else document.getElementById("msg").textContent = "This link is invalid or expired. Send /admin to the bot for a new one.";
};
</script></body></html>`;

export async function buildAdmin(d: Deps, extra: { poller: Poller }): Promise<FastifyInstance> {
  const { db, cfg, log } = d;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: true });
  const secure = cfg.PUBLIC_URL.startsWith("https://");
  const metrics = buildMetrics(d, extra.poller);

  await app.register(cookie);
  app.decorateRequest("adminId", 0);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    if (err instanceof HttpProblem) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof GrammyError) return reply.code(400).send({ error: `Telegram: ${err.description}` });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    log.error({ err }, "admin request failed");
    return reply.code(500).send({ error: "Internal error" });
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/metrics", async (_req, reply) => reply.type(metrics.contentType).send(await metrics.metrics()));

  app.get("/admin/login", async (_req, reply) => reply.type("text/html").send(LOGIN_PAGE));

  app.post("/admin/api/login", async (req, reply) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const used = await sql<{ tg_id: number }>`
      UPDATE admin_login_tokens SET used_at = now()
       WHERE token_hash = ${sha256(token)} AND used_at IS NULL AND expires_at > now()
      RETURNING tg_id
    `.execute(db);
    const row = used.rows[0];
    // Being removed from ADMIN_IDS must lock someone out even if they hold a fresh link.
    if (!row || !cfg.ADMIN_IDS.includes(row.tg_id)) throw new HttpProblem(401, "Invalid or expired link");

    const session = randomBytes(32).toString("base64url");
    await sql`
      INSERT INTO admin_sessions (token_hash, tg_id, expires_at)
      VALUES (${sha256(session)}, ${row.tg_id}, now() + make_interval(days => ${SESSION_DAYS}))
    `.execute(db);
    await sql`DELETE FROM admin_sessions WHERE expires_at < now()`.execute(db);
    await sql`DELETE FROM admin_login_tokens WHERE expires_at < now() - interval '1 day'`.execute(db);
    await sql`
      INSERT INTO audit_log (admin_tg_id, action) VALUES (${row.tg_id}, 'login')
    `.execute(db);
    reply.setCookie("sid", session, {
      path: "/admin",
      httpOnly: true,
      sameSite: "strict",
      secure,
      maxAge: SESSION_DAYS * 86_400,
    });
    return { ok: true };
  });

  await app.register(
    async (api) => {
      api.addHook("preHandler", async (req) => {
        const sid = req.cookies.sid;
        if (!sid) throw new HttpProblem(401, "Not signed in");
        const s = await sql<{ tg_id: number }>`
          SELECT tg_id FROM admin_sessions WHERE token_hash = ${sha256(sid)} AND expires_at > now()
        `.execute(db);
        const row = s.rows[0];
        if (!row || !cfg.ADMIN_IDS.includes(row.tg_id)) throw new HttpProblem(401, "Not signed in");
        req.adminId = row.tg_id;
      });

      api.post("/logout", async (req, reply) => {
        await sql`DELETE FROM admin_sessions WHERE token_hash = ${sha256(req.cookies.sid ?? "")}`.execute(db);
        reply.clearCookie("sid", { path: "/admin" });
        return { ok: true };
      });

      registerRoutes(api, d, extra);
    },
    { prefix: "/admin/api" },
  );

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST, prefix: "/admin/" });
    app.get("/admin", async (_req, reply) => reply.redirect("/admin/"));
  } else {
    log.warn({ dir: WEB_DIST }, "admin web build not found; run `npm run build --prefix web`");
  }
  app.get("/", async (_req, reply) => reply.redirect("/admin/"));

  return app;
}
