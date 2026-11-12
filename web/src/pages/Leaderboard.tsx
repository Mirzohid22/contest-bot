import { useState } from "react";
import { api, displayName, fmtNum, type LeaderRow, useLoad } from "../api";
import { useApp } from "../app";
import { Avatar, Badge, Card, Drawer, Empty, ErrorNote, Loading, Progress } from "../ui";
import { ParticipantPanel } from "./Participants";

export function Leaderboard() {
  const { contest } = useApp();
  if (!contest) return <Empty icon="medal" title="No contests yet" />;
  return <Board key={contest.id} />;
}

function Board() {
  const { contest } = useApp();
  const c = contest!;
  const rows = useLoad(() => api<LeaderRow[]>(`/contests/${c.id}/leaderboard?limit=100`), [c.id], c.status === "active" ? 15_000 : undefined);
  const [open, setOpen] = useState<number | null>(null);

  if (rows.error) return <ErrorNote>{rows.error}</ErrorNote>;
  if (!rows.data) return <Loading />;
  const list = rows.data;
  const counted = list.filter((r) => !r.disqualified_at);
  const podium = counted.slice(0, 3);
  const max = Math.max(c.required_invites, counted[0]?.invite_count ?? 0, 1);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Leaderboard</h1>
          <p className="muted">
            Top inviters of {c.title} · {c.required_invites} needed to qualify
          </p>
        </div>
      </div>

      {list.length === 0 ? (
        <Empty icon="medal" title="No invites yet">
          The leaderboard fills up as participants bring friends.
        </Empty>
      ) : (
        <>
          <div className="podium">
            {[1, 0, 2].map((i) => {
              const r = podium[i];
              if (!r) return <div key={i} className="podium-slot empty" />;
              return (
                <button key={r.id} className={`podium-slot place-${i + 1}`} onClick={() => setOpen(r.id)}>
                  <div className="podium-medal">{["🥇", "🥈", "🥉"][i]}</div>
                  <Avatar name={displayName(r)} id={r.user_id} />
                  <div className="podium-name">{displayName(r)}</div>
                  <div className="podium-count">{fmtNum(r.invite_count)}</div>
                  <div className="muted small">invites</div>
                  <div className="podium-base" />
                </button>
              );
            })}
          </div>

          <Card pad={false}>
            <div className="table-wrap">
              <table className="table hover">
                <thead>
                  <tr>
                    <th style={{ width: 56 }}>#</th>
                    <th>Participant</th>
                    <th className="hide-sm">Progress</th>
                    <th className="num">Invites</th>
                    <th className="num hide-sm">Pending</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const rank = r.disqualified_at ? null : counted.filter((x) => x.invite_count > r.invite_count).length + 1;
                    return (
                      <tr key={r.id} onClick={() => setOpen(r.id)} className={r.disqualified_at ? "row-muted" : ""}>
                        <td>
                          <span className={`rank ${rank && rank <= 3 ? `rank-${rank}` : ""}`}>{rank ?? "—"}</span>
                        </td>
                        <td>
                          <div className="person">
                            <Avatar name={displayName(r)} id={r.user_id} />
                            <div>
                              <div className="person-name">
                                {displayName(r)}{" "}
                                {r.disqualified_at ? (
                                  <Badge tone="red">disqualified</Badge>
                                ) : r.prize_joined_at ? (
                                  <Badge tone="green">in prize chat</Badge>
                                ) : r.qualified_at ? (
                                  <Badge tone="green">qualified</Badge>
                                ) : null}
                              </div>
                              <div className="muted small">{r.username ? `@${r.username}` : r.user_id}</div>
                            </div>
                          </div>
                        </td>
                        <td className="hide-sm" style={{ minWidth: 160 }}>
                          <Progress value={r.invite_count} max={max} tone={r.qualified_at ? "green" : undefined} />
                        </td>
                        <td className="num">
                          <b>{fmtNum(r.invite_count)}</b>
                        </td>
                        <td className="num hide-sm muted" title="Started with the link but not subscribed yet">
                          {r.pending > 0 ? `+${r.pending}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      <Drawer open={open !== null} title="Participant" onClose={() => setOpen(null)}>
        {open !== null && <ParticipantPanel id={open} required={c.required_invites} onOpen={setOpen} onChanged={() => void rows.reload()} />}
      </Drawer>
    </div>
  );
}
