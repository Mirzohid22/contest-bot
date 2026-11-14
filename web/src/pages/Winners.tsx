import { useState } from "react";
import { api, displayName, fmtDate, fmtNum, useLoad } from "../api";
import { useApp } from "../app";
import { Avatar, Badge, Button, Card, Empty, ErrorNote, Field, Icon, Loading, Note, Progress, Segmented, useCopy, useUi } from "../ui";

type Eligibility = "qualified" | "invited";

interface Preview {
  candidates: number;
  tickets: number;
  top: { participant_id: number; user_id: number; first_name: string | null; username: string | null; tickets: number; share: number }[];
}

interface DrawRow {
  id: number;
  eligibility: Eligibility;
  winners_requested: number;
  seed: string;
  candidates: number;
  tickets: number;
  created_at: string;
  notified_at: string | null;
  winners: {
    place: number;
    tickets: number;
    participant_id: number;
    user_id: number;
    first_name: string | null;
    username: string | null;
    prize_joined_at: string | null;
    blocked_at: string | null;
  }[];
}

const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`;

export function Winners() {
  const { contest } = useApp();
  if (!contest) return <Empty icon="sparkles" title="No contests yet" />;
  return <WinnersFor key={contest.id} />;
}

function WinnersFor() {
  const { contest } = useApp();
  const c = contest!;
  const { run, confirm } = useUi();
  const copy = useCopy();
  const [eligibility, setEligibility] = useState<Eligibility>("qualified");
  const [count, setCount] = useState(3);
  const [excludePrevious, setExcludePrevious] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const preview = useLoad(
    () => api<Preview>(`/contests/${c.id}/draw/preview?eligibility=${eligibility}&exclude_previous=${excludePrevious}`),
    [c.id, eligibility, excludePrevious],
  );
  const draws = useLoad(() => api<DrawRow[]>(`/contests/${c.id}/draws`), [c.id]);
  const finished = c.status === "finished";

  const draw = async () => {
    const p = preview.data!;
    const n = Math.min(count, p.candidates);
    const ok = await confirm({
      title: `Draw ${n} winner${n > 1 ? "s" : ""}?`,
      body: (
        <div className="stack-sm">
          <p>
            From {fmtNum(p.candidates)} participants holding {fmtNum(p.tickets)} tickets (one per counted invite). The result
            is saved with its random seed and cannot be redrawn quietly.
          </p>
          <Note>
            Before drawing, disqualify fake accounts and press <b>Recount invites</b> in the contest's Launch step.
          </Note>
        </div>
      ),
      confirm: "Draw winners",
    });
    if (!ok) return;
    setBusy("draw");
    const r = await run(
      () => api(`/contests/${c.id}/draws`, { body: { winners: count, eligibility, exclude_previous: excludePrevious } }),
      "Winners drawn",
    );
    setBusy(null);
    if (r) {
      await draws.reload();
      await preview.reload();
    }
  };

  const notify = async (d: DrawRow) => {
    const ok = await confirm({
      title: `Message ${d.winners.length} winner${d.winners.length > 1 ? "s" : ""}?`,
      body: "Each winner gets the “Winner” message in their language (edit it under Messages). Sent once per draw.",
      confirm: "Send",
    });
    if (!ok) return;
    setBusy(`notify-${d.id}`);
    await run(() => api(`/draws/${d.id}/notify`, { body: {} }), "Winners notified");
    setBusy(null);
    await draws.reload();
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Winners</h1>
          <p className="muted">
            A random draw where every counted invite is one ticket: 10 invites give 10 times the chance of 1.
          </p>
        </div>
      </div>

      {!finished && (
        <Note tone="warn">
          Finish <b>{c.title}</b> before drawing, so invite counts stop changing.{" "}
          <a href={`#/contests/${c.id}/launch`}>Open the Launch step →</a>
        </Note>
      )}

      <div className="grid-2-1">
        <Card title="New draw">
          <div className="form-grid">
            <Field label="Who can win" hint={eligibility === "qualified" ? "Only people who reached the invite goal." : "Anyone with at least one counted invite."}>
              <Segmented
                value={eligibility}
                onChange={setEligibility}
                options={[
                  { value: "qualified", label: "Qualified only" },
                  { value: "invited", label: "Anyone with invites" },
                ]}
              />
            </Field>
            <Field label="Number of winners">
              <input type="number" min={1} max={1000} value={count} onChange={(e) => setCount(Math.max(1, Number(e.target.value)))} />
            </Field>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={excludePrevious} onChange={(e) => setExcludePrevious(e.target.checked)} />
            Skip people who already won in an earlier draw of this contest (use it to draw replacements)
          </label>

          {preview.error && <ErrorNote>{preview.error}</ErrorNote>}
          {!preview.data ? (
            <Loading />
          ) : preview.data.candidates === 0 ? (
            <p className="muted">Nobody is eligible yet.</p>
          ) : (
            <>
              <div className="estimate">
                <Icon name="users" size={16} />
                <b>{fmtNum(preview.data.candidates)}</b> eligible · <b>{fmtNum(preview.data.tickets)}</b> tickets
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Participant</th>
                      <th className="num">Tickets</th>
                      <th style={{ width: "34%" }}>Chance per draw</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.top.map((r) => (
                      <tr key={r.participant_id}>
                        <td>
                          <div className="person">
                            <Avatar name={displayName(r)} id={r.user_id} />
                            <div>
                              <div className="person-name">{displayName(r)}</div>
                              <div className="muted small">{r.username ? `@${r.username}` : r.user_id}</div>
                            </div>
                          </div>
                        </td>
                        <td className="num">
                          <b>{r.tickets}</b>
                        </td>
                        <td>
                          <div className="share-cell">
                            <Progress value={r.share} max={preview.data!.top[0]!.share} />
                            <span className="small">{pct(r.share)}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview.data.candidates > preview.data.top.length && (
                <p className="muted small">Top {preview.data.top.length} shown. The percentage is the chance of being picked first.</p>
              )}
            </>
          )}
          <div className="row end">
            <Button variant="primary" icon="sparkles" onClick={draw} busy={busy === "draw"} disabled={!finished || !preview.data?.candidates}>
              Draw {Math.min(count, preview.data?.candidates ?? count)} winner{count > 1 ? "s" : ""}
            </Button>
          </div>
        </Card>

        <Card title="How it works">
          <ul className="how">
            <li>Each eligible participant gets as many tickets as counted invites. Disqualified people are left out.</li>
            <li>Winners are picked one after another without repeats, each time with chances proportional to tickets.</li>
            <li>
              The server picks a secret random seed; each person's random number is HMAC-SHA256(seed, participant id). The
              seed is saved with the draw, so the result can be recomputed and checked.
            </li>
            <li>Drawing again with “skip previous winners” picks replacements, for example when a winner does not answer.</li>
          </ul>
        </Card>
      </div>

      <Card title="Draws" subtitle="Newest first.">
        {!draws.data ? (
          <Loading />
        ) : draws.data.length === 0 ? (
          <p className="muted">No draws yet.</p>
        ) : (
          <div className="stack">
            {draws.data.map((d) => (
              <section key={d.id} className="draw">
                <div className="row between wrap">
                  <div className="row-tight">
                    <b>Draw #{d.id}</b>
                    <span className="muted small">
                      {fmtDate(d.created_at)} · {d.eligibility === "qualified" ? "qualified only" : "anyone with invites"} ·{" "}
                      {fmtNum(d.candidates)} people, {fmtNum(d.tickets)} tickets
                    </span>
                  </div>
                  {d.notified_at ? (
                    <Badge tone="green">winners notified</Badge>
                  ) : (
                    <Button size="sm" variant="primary" icon="send" onClick={() => void notify(d)} busy={busy === `notify-${d.id}`}>
                      Notify winners
                    </Button>
                  )}
                </div>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 56 }}>Place</th>
                        <th>Winner</th>
                        <th className="num">Tickets</th>
                        <th className="num hide-sm">Chance</th>
                        <th className="hide-sm">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.winners.map((w) => (
                        <tr key={w.participant_id}>
                          <td>
                            <span className={`rank ${w.place <= 3 ? `rank-${w.place}` : ""}`}>{w.place}</span>
                          </td>
                          <td>
                            <div className="person">
                              <Avatar name={displayName(w)} id={w.user_id} />
                              <div>
                                <div className="person-name">{displayName(w)}</div>
                                <div className="muted small">
                                  {w.username ? (
                                    <a href={`https://t.me/${w.username}`} target="_blank" rel="noreferrer">
                                      @{w.username}
                                    </a>
                                  ) : (
                                    `id ${w.user_id}`
                                  )}
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="num">
                            <b>{w.tickets}</b>
                          </td>
                          <td className="num hide-sm muted">{pct(w.tickets / Math.max(d.tickets, 1))}</td>
                          <td className="hide-sm">
                            <div className="chips">
                              {w.prize_joined_at && <Badge tone="green">in prize chat</Badge>}
                              {w.blocked_at && <Badge tone="amber">blocked the bot</Badge>}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="seed">
                  <span className="muted small">Seed</span>
                  <code className="truncate">{d.seed}</code>
                  <button className="icon-btn" onClick={() => void copy(d.seed, "Seed copied")} aria-label="Copy seed">
                    <Icon name="copy" size={14} />
                  </button>
                </div>
              </section>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
