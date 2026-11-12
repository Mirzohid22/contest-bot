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
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex"><title>Admin sign-in</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--border:#e6e8ec;--text:#0f172a;--muted:#64748b;--accent:#5b5bf0;--accent2:#7c3aed;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#12151c;--border:#232834;--text:#e8ebf1;--muted:#8a93a5;--accent:#8083ff;--accent2:#a78bfa;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);
font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:360px;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:32px 28px;text-align:center;
box-shadow:0 1px 2px rgb(15 23 42/.04),0 12px 32px rgb(15 23 42/.08)}
.mark{width:52px;height:52px;margin:0 auto 16px;border-radius:14px;display:grid;place-items:center;color:#fff;
background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 8px 20px rgb(91 91 240/.35)}
h1{font-size:20px;margin:0 0 4px;letter-spacing:-.01em}p{margin:0 0 22px;color:var(--muted);font-size:14px}
button{font:inherit;font-weight:600;width:100%;padding:11px 16px;border-radius:11px;border:0;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}#msg{color:var(--bad);min-height:1.4em;margin:14px 0 0;font-size:13.5px}
</style></head>
<body><main><div class="mark"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3a3 3 0 0 1-3 4M7 5H4a3 3 0 0 0 3 4"/></svg></div>
<h1>Contest Admin</h1><p>One-time sign-in link from the bot.</p>
<button id="go">Sign in</button><p id="msg"></p></main>
<script>
const go = document.getElementById("go");
go.onclick = async () => {
  go.disabled = true;
  const token = new URLSearchParams(location.search).get("token");
  const res = await fetch("/admin/api/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token })
  }).catch(() => null);
  if (res && res.ok) return location.replace("/admin/");
  go.disabled = false;
  document.getElementById("msg").textContent = "This link is invalid or expired. Send /admin to the bot for a new one.";
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
