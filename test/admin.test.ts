import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_ID, boot, type Harness, SPONSOR_A, SPONSOR_B, waitFor } from "./harness.js";

let h: Harness;
let sid = "";

beforeAll(async () => {
  h = await boot();
});
afterAll(async () => {
  await h.stop();
});

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object, cookie = sid) =>
  h.app.http.inject({ method, url: `/admin/api${url}`, payload, cookies: cookie ? { sid: cookie } : undefined });

async function loginToken(): Promise<string> {
  const before = h.fake.sent(ADMIN_ID).length;
  h.fake.push(h.fake.command(ADMIN_ID, "admin"));
  await waitFor(() => h.fake.sent(ADMIN_ID).length > before, "login link");
  const text: string = h.fake.sent(ADMIN_ID).at(-1)!.payload.text;
  return /token=([\w-]+)/.exec(text)![1]!;
}

describe("admin panel", () => {
  it("refuses requests without a session", async () => {
    expect((await call("GET", "/me", undefined, "")).statusCode).toBe(401);
    expect((await call("GET", "/contests", undefined, "made-up")).statusCode).toBe(401);
    expect((await call("POST", "/contests", { title: "x", required_invites: 1 }, "")).statusCode).toBe(401);
  });

  it("does not send a login link to someone who is not an admin", async () => {
    h.fake.push(h.fake.command(555, "admin"));
    await waitFor(() => h.fake.backlog === 0, "command handled");
    await new Promise((r) => setTimeout(r, 50));
    expect(h.fake.sent(555)).toHaveLength(0);
  });

  it("signs an admin in with a one-time link", async () => {
    const token = await loginToken();

    // Opening the link (as a preview bot would) does not consume the token.
    const page = await h.app.http.inject({ method: "GET", url: `/admin/login?token=${token}` });
    expect(page.statusCode).toBe(200);

    const res = await h.app.http.inject({ method: "POST", url: "/admin/api/login", payload: { token } });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === "sid")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
    sid = cookie.value;

    expect((await call("GET", "/me")).json()).toMatchObject({ tg_id: ADMIN_ID });

    // The same link cannot be used twice.
    const again = await h.app.http.inject({ method: "POST", url: "/admin/api/login", payload: { token } });
    expect(again.statusCode).toBe(401);
  });

  it("runs a contest from draft to finished and starts the next one from zero", async () => {
    // Create and configure.
    const created = await call("POST", "/contests", { title: "Spring books", required_invites: 1 });
    expect(created.statusCode).toBe(200);
    const id: number = created.json().id;
    expect(created.json().status).toBe("draft");

    expect((await call("POST", `/contests/${id}/sponsors`, { chat: String(SPONSOR_A) })).statusCode).toBe(200);
    const byName = await call("POST", `/contests/${id}/sponsors`, { chat: "https://t.me/some_channel" });
    expect(byName.json().join_url).toBe("https://t.me/some_channel");
    expect((await call("POST", `/contests/${id}/sponsors`, { chat: "not a channel!" })).statusCode).toBe(400);

    const prize = await call("POST", `/contests/${id}/prize`, { chat: "-1009" });
    expect(prize.json().prize_invite_link).toMatch(/^https:\/\/t\.me\/\+/);
    const linkCall = h.fake.calls.filter((c) => c.method === "createChatInviteLink").at(-1)!;
    expect(linkCall.payload.creates_join_request).toBe(true);

    // Remove the second sponsor so the test users only need Sponsor A.
    await call("DELETE", `/sponsors/${byName.json().id}`);

    // A draft is invisible to users.
    h.fake.push(h.fake.start(900));
    await waitFor(() => h.fake.sent(900).some((c) => c.payload.text.includes("no active contest")), "no contest");

    expect((await call("POST", `/contests/${id}/activate`)).json().status).toBe("active");
    expect((await call("POST", `/contests/${id}/activate`)).statusCode).toBe(400);

    // Two users: 901 invites 902 and qualifies (1 invite required).
    h.fake.push(h.fake.start(901));
    h.fake.push(h.fake.memberChange(SPONSOR_A, 901, true));
    h.fake.push(h.fake.click(901, "check"));
    const referrer = await waitFor(async () => {
      const p = await h.participant(901);
      return p?.verified_at ? p : null;
    }, "901 verified");
    h.fake.push(h.fake.start(902, referrer.ref_code));
    h.fake.push(h.fake.memberChange(SPONSOR_A, 902, true));
    h.fake.push(h.fake.click(902, "check"));
    await waitFor(async () => (await h.participant(901))!.qualified_at, "901 qualified");

    const detail = (await call("GET", `/contests/${id}`)).json();
    expect(detail.stats).toMatchObject({ total: 2, verified: 2, qualified: 1 });
    expect(detail.sponsors).toHaveLength(1);

    const list = (await call("GET", `/contests/${id}/participants?filter=qualified`)).json();
    expect(list.total).toBe(1);
    expect(list.items[0].user_id).toBe(901);
    const found = (await call("GET", `/contests/${id}/participants?q=user902`)).json();
    expect(found.items.map((p: any) => p.user_id)).toEqual([902]);

    // Disqualify the invitee as a fake account, then recount: 901 loses the invite and the status.
    const invitee = (await h.participant(902))!;
    await call("POST", `/participants/${invitee.id}/disqualify`, { disqualified: true });
    const recount = (await call("POST", `/contests/${id}/recount`)).json();
    expect(recount).toMatchObject({ changed: 1, unqualified: 1, newly_qualified: 0 });
    expect((await h.participant(901))!.invite_count).toBe(0);
    expect((await h.participant(901))!.qualified_at).toBeNull();

    // Restore and recount: back to qualified.
    await call("POST", `/participants/${invitee.id}/disqualify`, { disqualified: false });
    expect((await call("POST", `/contests/${id}/recount`)).json()).toMatchObject({ changed: 1, newly_qualified: 1 });

    // Export.
    const csv = await call("GET", `/contests/${id}/export.csv`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\n");
    expect(lines[0]).toMatch(/^id,user_id,username/);
    expect(lines).toHaveLength(3);

    // Broadcast: a test goes only to the admin; the real one is queued for the segment.
    const before = h.fake.count("sendMessage");
    expect((await call("POST", `/contests/${id}/broadcast`, { texts: { en: "Hello" }, segment: "all", test: true })).json().queued).toBe(0);
    await waitFor(() => h.fake.sent(ADMIN_ID).some((c) => c.payload.text === "Hello"), "test broadcast");
    const real = await call("POST", `/contests/${id}/broadcast`, { texts: { en: "Results are in" }, segment: "all" });
    expect(real.json().queued).toBe(2);
    await waitFor(
      () => [901, 902].every((u) => h.fake.sent(u).some((c) => c.payload.text === "Results are in")),
      "broadcast delivered",
    );
    expect(h.fake.count("sendMessage")).toBeGreaterThan(before);

    // Second contest: activating it finishes the first, and it has no participants.
    const second: number = (await call("POST", "/contests", { title: "Summer", required_invites: 3 })).json().id;
    await call("POST", `/contests/${second}/activate`);
    const all = (await call("GET", "/contests")).json();
    expect(all.find((c: any) => c.id === id).status).toBe("finished");
    expect(all.find((c: any) => c.id === second)).toMatchObject({ status: "active", participants: 0, qualified: 0 });
    // The finished contest keeps its data and is read-only.
    expect(all.find((c: any) => c.id === id).participants).toBe(2);
    expect((await call("PATCH", `/contests/${id}`, { title: "renamed" })).statusCode).toBe(400);
  });

  it("qualifies people at once when the requirement is lowered", async () => {
    const id = await h.seedContest(5);
    h.join(950);
    const a = await waitFor(async () => {
      const p = await h.participant(950);
      return p?.verified_at ? p : null;
    }, "950 verified");
    h.join(951, a.ref_code);
    await waitFor(async () => (await h.participant(950))!.invite_count === 1, "invite counted");
    expect((await h.participant(950))!.qualified_at).toBeNull();

    const res = await call("PATCH", `/contests/${id}`, { required_invites: 1 });
    expect(res.json().newly_qualified).toBe(1);
    expect((await h.participant(950))!.qualified_at).not.toBeNull();
  });

  it("validates input", async () => {
    expect((await call("POST", "/contests", { title: "", required_invites: 1 })).statusCode).toBe(400);
    expect((await call("POST", "/contests", { title: "x", required_invites: -1 })).statusCode).toBe(400);
    expect((await call("GET", "/contests/999999")).statusCode).toBe(404);
    expect((await call("GET", "/contests/abc")).statusCode).toBe(400);
  });

  it("signs out", async () => {
    expect((await call("POST", "/logout")).statusCode).toBe(200);
    expect((await call("GET", "/me")).statusCode).toBe(401);
  });

  it("exposes health and metrics", async () => {
    expect((await h.app.http.inject({ url: "/healthz" })).json()).toEqual({ ok: true });
    const metrics = await h.app.http.inject({ url: "/metrics" });
    expect(metrics.body).toContain("tg_lane_queue_depth");
    expect(metrics.body).toContain("nodejs_eventloop_lag_seconds");
    // SPONSOR_B is unused here; keep the import honest.
    expect(SPONSOR_B).toBeLessThan(0);
  });
});
