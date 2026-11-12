import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pickLocale, progressBar } from "../src/flow/texts.js";
import { ADMIN_ID, boot, type Harness, waitFor } from "./harness.js";

let h: Harness;
let sid = "";

beforeAll(async () => {
  h = await boot({ DEFAULT_LOCALE: "uz" });
  h.fake.push(h.fake.command(ADMIN_ID, "admin"));
  const [link] = await waitFor(() => h.fake.sent(ADMIN_ID), "login link");
  const token = /token=([\w-]+)/.exec(link!.payload.text)![1]!;
  const res = await h.app.http.inject({ method: "POST", url: "/admin/api/login", payload: { token } });
  sid = res.cookies.find((c) => c.name === "sid")!.value;
});
afterAll(async () => {
  await h.stop();
});

async function call(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, body?: unknown, type?: string) {
  const res = await h.app.http.inject({
    method,
    url: `/admin/api${url}`,
    cookies: { sid },
    payload: body as any,
    headers: type ? { "content-type": type } : undefined,
  });
  let json: any = null;
  try {
    json = res.json();
  } catch {}
  return { status: res.statusCode, json, res };
}

describe("texts", () => {
  it("picks the user's language", () => {
    expect(pickLocale("en", "ru", "uz")).toBe("en");
    expect(pickLocale(null, "ru-RU", "uz")).toBe("ru");
    expect(pickLocale(null, "de", "uz")).toBe("uz");
    expect(pickLocale("xx", null, "ru")).toBe("ru");
  });

  it("draws a progress bar", () => {
    expect(progressBar(0, 5)).toBe("▱▱▱▱▱");
    expect(progressBar(3, 5)).toBe("▰▰▰▱▱");
    expect(progressBar(9, 5)).toBe("▰▰▰▰▰");
    expect(progressBar(50, 100)).toBe("▰▰▰▰▰▱▱▱▱▱");
    expect(progressBar(0, 0)).toBe("▰");
  });
});

describe("bot screens", () => {
  it("speaks Uzbek by default, Russian to Russian users, and switches on request", async () => {
    await h.seedContest(2);
    h.fake.push(h.fake.start(500));
    const [gate] = await waitFor(() => h.fake.sent(500), "gate");
    expect(gate!.payload.text).toContain("xush kelibsiz");

    h.fake.push({ ...h.fake.start(501), message: { ...h.fake.start(501).message!, from: { id: 501, is_bot: false, first_name: "Ivan", language_code: "ru" } } } as any);
    const [ru] = await waitFor(() => h.fake.sent(501), "russian gate");
    expect(ru!.payload.text).toContain("Добро пожаловать");

    // Language picker, then English: the same message is redrawn.
    h.fake.push(h.fake.click(500, "lang"));
    await waitFor(() => h.fake.sent(500, "editMessageText").some((c) => c.payload.text.includes("Tilni")), "picker");
    h.fake.push(h.fake.click(500, "lang:en"));
    await waitFor(
      () => h.fake.sent(500, "editMessageText").some((c) => c.payload.text.includes("Welcome to")),
      "english gate",
    );
    const u = await sql<{ locale: string }>`SELECT locale FROM users WHERE tg_id = 500`.execute(h.app.deps.db);
    expect(u.rows[0]!.locale).toBe("en");
  });

  it("shows the leaderboard and the friends list", async () => {
    h.join(600);
    const me = await waitFor(async () => {
      const p = await h.participant(600);
      return p?.verified_at ? p : null;
    }, "600 verified");
    h.join(601, me.ref_code);
    h.fake.push(h.fake.start(602, me.ref_code)); // started, never subscribed
    await waitFor(async () => (await h.participant(600))!.invite_count === 1, "one invite");
    await waitFor(() => h.participant(602), "602 started");

    h.fake.push(h.fake.click(600, "top"));
    const top = await waitFor(
      () => h.fake.sent(600, "editMessageText").find((c) => c.payload.text.includes("faol")),
      "leaderboard",
    );
    expect(top.payload.text).toContain("🥇");
    expect(top.payload.text).toContain("#1");

    h.fake.push(h.fake.click(600, "friends"));
    const friends = await waitFor(
      () => h.fake.sent(600, "editMessageText").find((c) => c.payload.text.includes("doʻstlar")),
      "friends",
    );
    expect(friends.payload.text).toContain("(2)");
    expect(friends.payload.text).toContain("✅");
    expect(friends.payload.text).toContain("⏳");
    expect(friends.payload.reply_markup.inline_keyboard[0][0].callback_data).toBe("progress");
  });

  it("sends the banner as a picture and edits its caption", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const active = (await h.app.deps.cache.active())!.contest.id;
    const up = await call("PUT", `/contests/${active}/banner`, png, "image/png");
    expect(up.status).toBe(200);
    expect(up.json.banner_file_id).toMatch(/^fake-photo-/);
    // The admin gets the picture as a preview, and the panel can show it.
    expect(h.fake.sent(ADMIN_ID, "sendPhoto")).toHaveLength(1);
    const img = (await call("GET", `/contests/${active}/banner`)).res;
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.rawPayload.equals(png)).toBe(true);

    h.fake.push(h.fake.start(700));
    const [photo] = await waitFor(() => h.fake.sent(700, "sendPhoto"), "gate with banner");
    expect(photo!.payload.photo).toBe(up.json.banner_file_id);
    expect(photo!.payload.reply_markup.inline_keyboard.flat().some((b: any) => b.callback_data === "check")).toBe(true);

    expect((await call("DELETE", `/contests/${active}/banner`)).json.banner_file_id).toBeNull();
  });
});

describe("admin panel data", () => {
  it("returns stats, leaderboard and per-language texts", async () => {
    const id = (await h.app.deps.cache.active())!.contest.id;
    const stats = (await call("GET", `/contests/${id}/stats?hours=24`)).json;
    expect(stats.timeline).toHaveLength(24);
    expect(stats.funnel.started).toBeGreaterThan(0);
    expect(stats.sponsors).toHaveLength(2);
    expect(stats.languages.map((l: any) => l.locale)).toEqual(expect.arrayContaining(["uz", "ru", "en"]));

    const board = (await call("GET", `/contests/${id}/leaderboard`)).json;
    expect(board[0].invite_count).toBe(1);
    expect(board[0].pending).toBe(1);

    const defaults = (await call("GET", "/texts/defaults")).json;
    expect(defaults.locales).toEqual(["uz", "ru", "en"]);
    expect(defaults.default_locale).toBe("uz");

    const patched = await call("PATCH", `/contests/${id}`, {
      texts: { ru: { btn_check: "Готово", gate: defaults.texts.ru.gate }, uz: { btn_check: "" } },
    });
    // Unchanged defaults and empty fields are not stored.
    expect(patched.json.contest.texts).toEqual({ ru: { btn_check: "Готово" }, uz: {} });
  });

  it("checks a chat before it is added", async () => {
    const r = (await call("POST", "/chats/inspect", { chat: "@some_channel", purpose: "sponsor" })).json;
    expect(r).toMatchObject({ title: "some_channel", ok: true, members: 1234, bot_status: "administrator" });
  });

  it("estimates, sends per language, tracks and cancels a broadcast", async () => {
    const id = (await h.app.deps.cache.active())!.contest.id;
    const est = (await call("GET", `/contests/${id}/broadcast/estimate?segment=all`)).json;
    expect(est.total).toBeGreaterThan(3);
    expect(est.by_locale.ru).toBe(1);

    const r = await call("POST", `/contests/${id}/broadcast`, {
      texts: { uz: "Salom!", ru: "Привет!" },
      buttons: [{ text: "Kanal", url: "https://t.me/sponsor_a" }],
      segment: "all",
    });
    expect(r.json.queued).toBe(est.total);
    await waitFor(() => h.fake.sent(501).some((c) => c.payload.text === "Привет!"), "russian broadcast");
    // No English text was written: English users get the default language.
    await waitFor(() => h.fake.sent(500).some((c) => c.payload.text === "Salom!"), "fallback broadcast");
    const msg = h.fake.sent(501).find((c) => c.payload.text === "Привет!")!;
    expect(msg.payload.reply_markup.inline_keyboard[0][0].url).toBe("https://t.me/sponsor_a");

    const list = await waitFor(async () => {
      const l = (await call("GET", `/contests/${id}/broadcasts`)).json;
      return l[0].sent === est.total ? l : null;
    }, "broadcast fully sent");
    expect(list[0]).toMatchObject({ total: est.total, failed: 0, pending: 0, preview: "Salom!" });

    // Cancelling stops whatever has not gone out yet; nothing is left pending.
    const second = await call("POST", `/contests/${id}/broadcast`, { texts: { uz: "Later" }, segment: "all" });
    const cancel = (await call("POST", `/broadcasts/${second.json.id}/cancel`)).json;
    await new Promise((r) => setTimeout(r, 300));
    const after = (await call("GET", `/contests/${id}/broadcasts`)).json.find((b: any) => b.id === second.json.id);
    expect(after.pending).toBe(0);
    expect(after.cancelled).toBe(cancel.stopped);
    expect(after.sent + after.cancelled).toBe(second.json.queued);
    expect(after.cancelled_at).not.toBeNull();
  });
});
