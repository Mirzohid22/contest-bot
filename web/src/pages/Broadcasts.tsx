import { useState } from "react";
import { api, type BroadcastRow, fmtAgo, fmtNum, LOCALE_FLAG, LOCALE_LABEL, type Locale, LOCALES, useLoad } from "../api";
import { useApp } from "../app";
import { TelegramPreview } from "../TelegramPreview";
import { Badge, Button, Card, Empty, Field, Icon, Loading, Note, Progress, Segmented, useUi } from "../ui";

const SEGMENTS = [
  { value: "all", label: "Everyone", hint: "Everyone who started the bot in this contest" },
  { value: "not_verified", label: "Not subscribed", hint: "Started but did not finish subscribing — a good reminder target" },
  { value: "not_qualified", label: "Not qualified", hint: "Subscribed, still inviting friends" },
  { value: "qualified", label: "Qualified", hint: "Met the requirement" },
  { value: "qualified_not_joined", label: "Qualified, not in prize chat", hint: "Qualified but never requested to join" },
  { value: "verified", label: "Subscribed", hint: "Everyone who passed the sponsor check" },
] as const;
type Segment = (typeof SEGMENTS)[number]["value"];

export function Broadcasts() {
  const { contest } = useApp();
  if (!contest) return <Empty icon="send" title="No contests yet" />;
  return <Composer key={contest.id} />;
}

function Composer() {
  const { contest, bot } = useApp();
  const c = contest!;
  const { run, confirm } = useUi();
  const [locale, setLocale] = useState<Locale>("uz");
  const [texts, setTexts] = useState<Record<Locale, string>>({ uz: "", ru: "", en: "" });
  const [buttons, setButtons] = useState<{ text: string; url: string }[]>([]);
  const [segment, setSegment] = useState<Segment>("all");
  const [busy, setBusy] = useState<"test" | "send" | null>(null);
  const history = useLoad(() => api<BroadcastRow[]>(`/contests/${c.id}/broadcasts`), [c.id], 4_000);
  const estimate = useLoad(
    () => api<{ total: number; by_locale: Partial<Record<Locale, number>> }>(`/contests/${c.id}/broadcast/estimate?segment=${segment}`),
    [c.id, segment],
  );

  const written = LOCALES.filter((l) => texts[l].trim());
  const validButtons = buttons.every((b) => b.text.trim() && /^https:\/\/\S+$/.test(b.url.trim()));
  const ready = written.length > 0 && validButtons;
  const fallback: Locale = texts.uz.trim() ? "uz" : (written[0] ?? "uz");

  const body = (test: boolean) => ({
    texts: Object.fromEntries(written.map((l) => [l, texts[l].trim()])),
    buttons: buttons.map((b) => ({ text: b.text.trim(), url: b.url.trim() })),
    segment,
    test,
  });

  const sendTest = async () => {
    setBusy("test");
    await run(() => api(`/contests/${c.id}/broadcast`, { body: body(true) }), `Test sent to you in Telegram (${written.length} language${written.length > 1 ? "s" : ""})`);
    setBusy(null);
  };

  const send = async () => {
    const n = estimate.data?.total ?? 0;
    const missing = LOCALES.filter((l) => !texts[l].trim() && (estimate.data?.by_locale[l] ?? 0) > 0);
    const ok = await confirm({
      title: `Send to ${fmtNum(n)} people?`,
      body: (
        <div className="stack-sm">
          <p>
            Audience: <b>{SEGMENTS.find((s) => s.value === segment)!.label}</b>. Messages go out at about 25 per second,
            after messages the bot owes to users right now.
          </p>
          {missing.length > 0 && (
            <Note tone="warn">
              No {missing.map((l) => LOCALE_LABEL[l]).join(", ")} text: those users get the {LOCALE_LABEL[fallback]} one.
            </Note>
          )}
        </div>
      ),
      confirm: `Send to ${fmtNum(n)}`,
    });
    if (!ok) return;
    setBusy("send");
    const r = await run(() => api<{ queued: number }>(`/contests/${c.id}/broadcast`, { body: body(false) }));
    setBusy(null);
    if (r) {
      setTexts({ uz: "", ru: "", en: "" });
      setButtons([]);
      await history.reload();
    }
  };

  const cancel = async (b: BroadcastRow) => {
    if (!(await confirm({ title: "Stop this broadcast?", body: "Messages not sent yet are cancelled. Already delivered ones stay.", confirm: "Stop", danger: true }))) return;
    await run(() => api(`/broadcasts/${b.id}/cancel`, { body: {} }), "Broadcast stopped");
    await history.reload();
  };

  const shown = texts[locale].trim() ? texts[locale] : texts[fallback];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Broadcasts</h1>
          <p className="muted">Message the participants of {c.title}, each in their own language.</p>
        </div>
      </div>

      <div className="grid-2-1">
        <Card title="New broadcast">
          <div className="stack">
            <Field label="Audience" hint={SEGMENTS.find((s) => s.value === segment)!.hint}>
              <div className="audience">
                {SEGMENTS.map((s) => (
                  <button key={s.value} type="button" className={segment === s.value ? "on" : ""} onClick={() => setSegment(s.value)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </Field>
            <div className="estimate">
              <Icon name="users" size={16} />
              {estimate.data ? (
                <>
                  <b>{fmtNum(estimate.data.total)}</b> recipients
                  <span className="muted small">
                    {LOCALES.filter((l) => estimate.data!.by_locale[l]).map((l) => `${LOCALE_FLAG[l]} ${fmtNum(estimate.data!.by_locale[l])}`).join("  ")}
                  </span>
                </>
              ) : (
                <span className="muted">Counting…</span>
              )}
            </div>

            <div>
              <div className="row between">
                <span className="field-label">Message</span>
                <Segmented
                  value={locale}
                  onChange={setLocale}
                  options={LOCALES.map((l) => ({
                    value: l,
                    label: (
                      <>
                        {LOCALE_FLAG[l]} {l.toUpperCase()}
                        {texts[l].trim() && <span className="dot dot-accent" />}
                      </>
                    ),
                  }))}
                />
              </div>
              <textarea
                className="composer"
                rows={7}
                value={texts[locale]}
                onChange={(e) => setTexts({ ...texts, [locale]: e.target.value })}
                placeholder={
                  locale === fallback || !written.length
                    ? `Write the ${LOCALE_LABEL[locale]} message…`
                    : `Optional. Empty: ${LOCALE_LABEL[locale]} users get the ${LOCALE_LABEL[fallback]} text.`
                }
                maxLength={4000}
              />
              <div className="row between muted small">
                <span>
                  <code>&lt;b&gt;</code> <code>&lt;i&gt;</code> <code>&lt;a href="…"&gt;</code> work
                </span>
                <span>{texts[locale].length} / 4000</span>
              </div>
            </div>

            <div className="stack-sm">
              <span className="field-label">Buttons</span>
              {buttons.map((b, i) => (
                <div key={i} className="button-row">
                  <input
                    placeholder="Button text"
                    value={b.text}
                    maxLength={64}
                    onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                  />
                  <input
                    placeholder="https://t.me/…"
                    value={b.url}
                    onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                  />
                  <button className="icon-btn danger" onClick={() => setButtons(buttons.filter((_, j) => j !== i))} aria-label="Remove button">
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              ))}
              {buttons.length < 6 && (
                <Button size="sm" variant="ghost" icon="plus" onClick={() => setButtons([...buttons, { text: "", url: "" }])}>
                  Add link button
                </Button>
              )}
              {!validButtons && <span className="field-error">Every button needs text and an https:// link.</span>}
            </div>

            <div className="row end">
              <Button icon="eye" onClick={sendTest} busy={busy === "test"} disabled={!ready}>
                Send test to me
              </Button>
              <Button variant="primary" icon="send" onClick={send} busy={busy === "send"} disabled={!ready || !estimate.data?.total}>
                Send to {fmtNum(estimate.data?.total)}
              </Button>
            </div>
          </div>
        </Card>

        <div className="preview-col sticky">
          <div className="muted small preview-label">
            <Icon name="eye" size={14} /> Preview · {LOCALE_LABEL[locale]}
          </div>
          <TelegramPreview
            text={shown || "<i>Your message appears here</i>"}
            buttons={buttons.filter((b) => b.text.trim()).map((b) => [{ text: b.text, url: b.url }])}
            botName={bot}
          />
        </div>
      </div>

      <Card title="History" subtitle="Delivery updates live.">
        {!history.data ? (
          <Loading />
        ) : history.data.length === 0 ? (
          <p className="muted">No broadcasts yet.</p>
        ) : (
          <ul className="broadcasts">
            {history.data.map((b) => {
              const done = b.sent + b.failed + b.cancelled;
              const running = b.pending > 0 && !b.cancelled_at;
              return (
                <li key={b.id}>
                  <div className="row between">
                    <div className="row-tight">
                      {running ? <Badge tone="blue" dot>sending</Badge> : b.cancelled_at ? <Badge tone="amber">stopped</Badge> : <Badge tone="green">done</Badge>}
                      <span className="muted small">
                        {SEGMENTS.find((s) => s.value === b.segment)?.label ?? b.segment} · {fmtAgo(b.created_at)}
                      </span>
                    </div>
                    {running && (
                      <Button size="sm" variant="ghost" icon="stop" onClick={() => void cancel(b)}>
                        Stop
                      </Button>
                    )}
                  </div>
                  <p className="broadcast-text">{(b.preview ?? "").replace(/<[^>]+>/g, "").slice(0, 160)}</p>
                  <Progress value={done} max={Math.max(b.total, 1)} tone={running ? undefined : "green"} />
                  <div className="muted small">
                    {fmtNum(b.sent)} delivered of {fmtNum(b.total)}
                    {b.failed > 0 && ` · ${fmtNum(b.failed)} failed (blocked the bot)`}
                    {b.cancelled > 0 && ` · ${fmtNum(b.cancelled)} cancelled`}
                    {running && ` · ${fmtNum(b.pending)} waiting`}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
