import { useEffect, useState } from "react";
import { api, type ContestDetail, fmtDate, useLoad, userLabel } from "./api";
import { StatusBadge } from "./Contests";
import { Stat } from "./Dashboard";

/** Runs an action, showing its error or a success note next to the button that started it. */
function useAction(after?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const msg = await fn();
      if (msg) setNote(msg);
      after?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const status = (
    <>
      {error && <p className="error">{error}</p>}
      {note && <p className="ok">{note}</p>}
    </>
  );
  return { busy, run, status };
}

interface AuditRow {
  id: number;
  user_id: number;
  username: string | null;
  first_name: string | null;
  invite_count: number;
  self_left: boolean;
  invitees_left: number;
}

export function ContestPage({ id, onBack, onChanged }: { id: number; onBack: () => void; onChanged: () => void }) {
  const detail = useLoad(() => api<ContestDetail>(`/contests/${id}`), [id]);
  const refresh = () => {
    detail.reload();
    onChanged();
  };
  if (detail.error) return <p className="error">{detail.error}</p>;
  if (!detail.data) return <p className="muted">Loading…</p>;
  const { contest, sponsors, stats } = detail.data;
  const editable = contest.status !== "finished";

  return (
    <>
      <p>
        <button className="link" onClick={onBack}>
          ← All contests
        </button>
      </p>
      <h1>
        {contest.title} <StatusBadge status={contest.status} />
      </h1>
      <div className="stats">
        <Stat label="Started the bot" value={stats.total} />
        <Stat label="Passed the gate" value={stats.verified} />
        <Stat label="Qualified" value={stats.qualified} />
        <Stat label="In the prize chat" value={stats.joined_prize} />
        <Stat label="Disqualified" value={stats.disqualified} />
      </div>

      <Lifecycle detail={detail.data} refresh={refresh} />
      {editable && <Settings detail={detail.data} refresh={refresh} />}
      <Prize detail={detail.data} refresh={refresh} editable={editable} />
      <Sponsors detail={detail.data} refresh={refresh} editable={editable} />
      {editable && <Texts detail={detail.data} refresh={refresh} />}
      <Tools id={id} sponsorCount={sponsors.length} />
    </>
  );
}

type SectionProps = { detail: ContestDetail; refresh: () => void };

function Lifecycle({ detail, refresh }: SectionProps) {
  const { contest, sponsors } = detail;
  const act = useAction(refresh);
  const problems: string[] = [];
  if (sponsors.length === 0) problems.push("no sponsor channels, so everyone passes the gate immediately");
  if (!contest.prize_chat_id) problems.push("no prize chat, so qualified users get no link");

  return (
    <section>
      <h2>Lifecycle</h2>
      <p className="muted">
        Created {fmtDate(contest.created_at)} · Started {fmtDate(contest.started_at)} · Finished{" "}
        {fmtDate(contest.finished_at)}
      </p>
      {contest.status === "draft" && (
        <>
          {problems.length > 0 && <p className="warn-text">Before you activate: {problems.join("; ")}.</p>}
          <button
            disabled={act.busy}
            onClick={() =>
              confirm("Activate this contest? The currently active contest, if any, will be finished.") &&
              act.run(() => api(`/contests/${contest.id}/activate`, { method: "POST" }).then(() => {}))
            }
          >
            Activate
          </button>
        </>
      )}
      {contest.status === "active" && (
        <button
          className="danger"
          disabled={act.busy}
          onClick={() =>
            confirm("Finish this contest? New users will see “no active contest”. This cannot be undone.") &&
            act.run(() => api(`/contests/${contest.id}/finish`, { method: "POST" }).then(() => {}))
          }
        >
          Finish contest
        </button>
      )}
      {contest.status === "finished" && <p className="muted">This contest is finished and read-only.</p>}
      {act.status}
    </section>
  );
}

function Settings({ detail, refresh }: SectionProps) {
  const { contest } = detail;
  const [title, setTitle] = useState(contest.title);
  const [required, setRequired] = useState(contest.required_invites);
  const act = useAction(refresh);
  return (
    <section>
      <h2>Settings</h2>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            const r = await api<{ newly_qualified: number }>(`/contests/${contest.id}`, {
              method: "PATCH",
              body: { title, required_invites: required },
            });
            return r.newly_qualified > 0 ? `Saved. ${r.newly_qualified} participants qualified.` : "Saved.";
          });
        }}
      >
        <label className="grow">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </label>
        <label>
          Invites required
          <input type="number" min={0} value={required} onChange={(e) => setRequired(Number(e.target.value))} />
        </label>
        <button disabled={act.busy}>Save</button>
      </form>
      {act.status}
    </section>
  );
}

function Prize({ detail, refresh, editable }: SectionProps & { editable: boolean }) {
  const { contest } = detail;
  const [chat, setChat] = useState("");
  const act = useAction(refresh);
  return (
    <section>
      <h2>Prize chat</h2>
      {contest.prize_chat_id ? (
        <p>
          <strong>{contest.prize_chat_title}</strong> <span className="muted">({contest.prize_chat_id})</span>
          <br />
          Join-request link sent to qualified users: <code>{contest.prize_invite_link}</code>
        </p>
      ) : (
        <p className="muted">Not set.</p>
      )}
      {editable && (
        <>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              act.run(async () => {
                await api(`/contests/${contest.id}/prize`, { body: { chat } });
                setChat("");
                return "Prize chat set and a join-request link created.";
              });
            }}
          >
            <label className="grow">
              Channel or group: @username, t.me link, or numeric id
              <input value={chat} onChange={(e) => setChat(e.target.value)} placeholder="-1001234567890" required />
            </label>
            <button disabled={act.busy}>{contest.prize_chat_id ? "Replace" : "Set"}</button>
          </form>
          <p className="muted small">
            Add the bot to the chat as an admin with the “Invite users via link” right first. The link can be shared
            freely: the bot approves only qualified participants and declines everyone else.
          </p>
        </>
      )}
      {act.status}
    </section>
  );
}

function Sponsors({ detail, refresh, editable }: SectionProps & { editable: boolean }) {
  const { contest, sponsors } = detail;
  const [chat, setChat] = useState("");
  const [joinUrl, setJoinUrl] = useState("");
  const act = useAction(refresh);
  return (
    <section>
      <h2>Sponsor channels</h2>
      {sponsors.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Channel</th>
              <th>Chat id</th>
              <th>Join link shown to users</th>
              <th>Checks</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sponsors.map((s) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td>{s.chat_id}</td>
                <td>
                  <a href={s.join_url} target="_blank" rel="noreferrer">
                    {s.join_url}
                  </a>
                </td>
                <td>
                  {s.health === "ok" ? (
                    <span className="badge active">working</span>
                  ) : (
                    <span className="badge bad" title="The bot is not an admin there; this channel is skipped">
                      skipped
                    </span>
                  )}
                </td>
                <td className="num">
                  {editable && (
                    <button
                      className="link danger-text"
                      disabled={act.busy}
                      onClick={() =>
                        confirm(`Remove ${s.title}? Users will no longer need to subscribe to it.`) &&
                        act.run(() => api(`/sponsors/${s.id}`, { method: "DELETE" }).then(() => {}))
                      }
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              act.run(async () => {
                await api(`/contests/${contest.id}/sponsors`, {
                  body: { chat, ...(joinUrl ? { join_url: joinUrl } : {}) },
                });
                setChat("");
                setJoinUrl("");
              });
            }}
          >
            <label className="grow">
              Channel: @username, t.me link, or numeric id
              <input value={chat} onChange={(e) => setChat(e.target.value)} placeholder="@channel" required />
            </label>
            <label className="grow">
              Join link (optional, for private channels)
              <input
                value={joinUrl}
                onChange={(e) => setJoinUrl(e.target.value)}
                placeholder="https://t.me/+…"
                type="url"
              />
            </label>
            <button disabled={act.busy}>Add</button>
          </form>
          <p className="muted small">
            The bot must be an admin of the channel, or it cannot see who subscribes. Add it a few days before launch
            if you can.
          </p>
        </>
      )}
      {act.status}
    </section>
  );
}

function Texts({ detail, refresh }: SectionProps) {
  const { contest } = detail;
  const defaults = useLoad(() => api<Record<string, string>>("/texts/defaults"), []);
  const [texts, setTexts] = useState<Record<string, string>>(contest.texts);
  const [open, setOpen] = useState(false);
  const act = useAction(refresh);
  useEffect(() => setTexts(contest.texts), [contest.texts]);

  return (
    <section>
      <h2>Messages</h2>
      <p className="muted">
        Every message the bot sends can be reworded per contest. Leave a field empty to use the default. Telegram HTML
        (<code>&lt;b&gt;</code>, <code>&lt;i&gt;</code>, <code>&lt;a href&gt;</code>) is allowed; keep the{" "}
        <code>{"{placeholders}"}</code>.
      </p>
      <button className="secondary" onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Edit messages"} ({Object.keys(contest.texts).length} customised)
      </button>
      {open && defaults.data && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act.run(async () => {
              await api(`/contests/${contest.id}`, { method: "PATCH", body: { texts } });
              return "Messages saved.";
            });
          }}
        >
          {Object.entries(defaults.data).map(([key, def]) => (
            <label key={key} className="block">
              <code>{key}</code>
              <textarea
                rows={key.startsWith("btn_") ? 1 : 3}
                value={texts[key] ?? ""}
                placeholder={def}
                onChange={(e) => setTexts({ ...texts, [key]: e.target.value })}
              />
            </label>
          ))}
          <button disabled={act.busy}>Save messages</button>
        </form>
      )}
      {act.status}
    </section>
  );
}

function Tools({ id, sponsorCount }: { id: number; sponsorCount: number }) {
  const recount = useAction();
  const broadcast = useAction();
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const auditAct = useAction();
  const [text, setText] = useState("");
  const [segment, setSegment] = useState("all");

  const send = (test: boolean) =>
    broadcast.run(async () => {
      const r = await api<{ queued: number }>(`/contests/${id}/broadcast`, { body: { text, segment, test } });
      return test
        ? "Test sent to you in Telegram."
        : `Queued for ${r.queued} people. At about 30 messages per second this takes roughly ${Math.ceil(r.queued / 30 / 60)} min.`;
    });

  return (
    <>
      <section>
        <h2>Export and checks</h2>
        <div className="row">
          <a className="button secondary" href={`/admin/api/contests/${id}/export.csv`}>
            Download participants (CSV)
          </a>
          <button
            className="secondary"
            disabled={recount.busy}
            onClick={() =>
              recount.run(async () => {
                const r = await api<{ changed: number; unqualified: number; newly_qualified: number }>(
                  `/contests/${id}/recount`,
                  { method: "POST" },
                );
                return `Recount done: ${r.changed} counts corrected, ${r.unqualified} lost qualified status, ${r.newly_qualified} newly qualified.`;
              })
            }
          >
            Recount invites
          </button>
          <button
            className="secondary"
            disabled={auditAct.busy || sponsorCount === 0}
            onClick={() => auditAct.run(async () => setAudit(await api<AuditRow[]>(`/contests/${id}/audit`)))}
          >
            Final audit
          </button>
        </div>
        <p className="muted small">
          Recount rebuilds every invite count from the referral records, leaving out disqualified invitees. Run it after
          disqualifying fake accounts. The final audit lists qualified participants whose invitees have since left a
          sponsor channel.
        </p>
        {recount.status}
        {auditAct.status}
        {audit &&
          (audit.length === 0 ? (
            <p className="muted">No qualified participants.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Participant</th>
                  <th className="num">Invites</th>
                  <th className="num">Invitees who left a sponsor</th>
                  <th>Left a sponsor themselves</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {userLabel(a)} <span className="muted">({a.user_id})</span>
                    </td>
                    <td className="num">{a.invite_count}</td>
                    <td className={a.invitees_left > 0 ? "num bad-text" : "num"}>{a.invitees_left}</td>
                    <td>{a.self_left ? <span className="badge bad">yes</span> : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </section>

      <section>
        <h2>Broadcast</h2>
        <label className="block">
          Message (Telegram HTML allowed)
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
        </label>
        <div className="row">
          <label>
            Send to
            <select value={segment} onChange={(e) => setSegment(e.target.value)}>
              <option value="all">Everyone who started the bot</option>
              <option value="verified">Passed the gate</option>
              <option value="not_verified">Did not pass the gate</option>
              <option value="qualified">Qualified</option>
              <option value="not_qualified">Passed the gate, not qualified</option>
            </select>
          </label>
          <button className="secondary" disabled={broadcast.busy || !text.trim()} onClick={() => send(true)}>
            Send a test to me
          </button>
          <button
            disabled={broadcast.busy || !text.trim()}
            onClick={() => confirm("Send this message to the whole segment? It cannot be recalled.") && send(false)}
          >
            Send
          </button>
        </div>
        {broadcast.status}
      </section>
    </>
  );
}
