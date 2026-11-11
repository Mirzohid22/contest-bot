import { useEffect, useState } from "react";
import { api, type Contest, fmtDate, type ParticipantRow, useLoad, userLabel } from "./api";

interface Page {
  items: ParticipantRow[];
  total: number;
  page: number;
  page_size: number;
}

interface Detail {
  participant: ParticipantRow & {
    referrer_user_id: number | null;
    referrer_username: string | null;
    referrer_first_name: string | null;
  };
  invitees: {
    id: number;
    user_id: number;
    username: string | null;
    first_name: string | null;
    verified_at: string | null;
    disqualified_at: string | null;
    created_at: string;
  }[];
}

function state(p: ParticipantRow) {
  if (p.disqualified_at) return <span className="badge bad">disqualified</span>;
  if (p.prize_joined_at) return <span className="badge active">in prize chat</span>;
  if (p.qualified_at) return <span className="badge active">qualified</span>;
  if (p.verified_at) return <span className="badge draft">passed gate</span>;
  return <span className="badge finished">started</span>;
}

export function Participants({ contests }: { contests: Contest[] }) {
  const fallback = contests.find((c) => c.status === "active")?.id ?? contests[0]?.id ?? null;
  const [contestId, setContestId] = useState<number | null>(fallback);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (contestId === null && fallback !== null) setContestId(fallback);
  }, [contestId, fallback]);
  // Search as you type, but not on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const list = useLoad(
    () =>
      contestId === null
        ? Promise.resolve(null)
        : api<Page>(
            `/contests/${contestId}/participants?page=${page}&filter=${filter}&q=${encodeURIComponent(search)}`,
          ),
    [contestId, page, filter, search],
  );

  if (contests.length === 0) return <p className="muted">Create a contest first.</p>;
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <>
      <section>
        <div className="row">
          <label>
            Contest
            <select
              value={contestId ?? ""}
              onChange={(e) => {
                setContestId(Number(e.target.value));
                setPage(1);
                setSelected(null);
              }}
            >
              {contests.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} ({c.status})
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            Search by @username, name, Telegram id, or referral code
            <input value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <label>
            Show
            <select
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">Everyone</option>
              <option value="verified">Passed the gate</option>
              <option value="qualified">Qualified</option>
              <option value="joined">In the prize chat</option>
              <option value="disqualified">Disqualified</option>
            </select>
          </label>
        </div>
        {list.error && <p className="error">{list.error}</p>}
        {data && (
          <>
            <p className="muted">
              {data.total} participants · sorted by invites · page {data.page} of {pages}
            </p>
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Telegram id</th>
                  <th>State</th>
                  <th className="num">Invites</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr
                    key={p.id}
                    className={selected === p.id ? "clickable selected" : "clickable"}
                    onClick={() => setSelected(p.id)}
                  >
                    <td>
                      {userLabel(p)} {p.blocked_at && <span className="badge finished">blocked the bot</span>}
                    </td>
                    <td>{p.user_id}</td>
                    <td>{state(p)}</td>
                    <td className="num">{p.invite_count}</td>
                    <td>{fmtDate(p.created_at)}</td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Nobody matches.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="row">
              <button className="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <button className="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </div>
          </>
        )}
      </section>
      {selected !== null && <ParticipantDetail id={selected} onChanged={list.reload} onOpen={setSelected} />}
    </>
  );
}

function ParticipantDetail({
  id,
  onChanged,
  onOpen,
}: {
  id: number;
  onChanged: () => void;
  onOpen: (id: number) => void;
}) {
  const detail = useLoad(() => api<Detail>(`/participants/${id}`), [id]);
  const [error, setError] = useState<string | null>(null);
  if (detail.error) return <p className="error">{detail.error}</p>;
  if (!detail.data) return null;
  const { participant: p, invitees } = detail.data;

  const toggle = async () => {
    const disqualified = !p.disqualified_at;
    if (
      disqualified &&
      !confirm(
        "Disqualify this participant? They cannot enter the prize chat, and after a recount they no longer count as anyone's invite.",
      )
    )
      return;
    try {
      await api(`/participants/${id}/disqualify`, { body: { disqualified } });
      setError(null);
      detail.reload();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section>
      <h2>
        {userLabel(p)} <span className="muted">({p.user_id})</span> {state(p)}
      </h2>
      <dl>
        <dt>Referral code</dt>
        <dd>
          <code>{p.ref_code}</code>
        </dd>
        <dt>Invited by</dt>
        <dd>
          {p.referred_by ? (
            <button className="link" onClick={() => onOpen(p.referred_by!)}>
              {userLabel({
                username: p.referrer_username,
                first_name: p.referrer_first_name,
                user_id: p.referrer_user_id ?? 0,
              })}
            </button>
          ) : (
            "nobody"
          )}
        </dd>
        <dt>Passed the gate</dt>
        <dd>{fmtDate(p.verified_at)}</dd>
        <dt>Qualified</dt>
        <dd>{fmtDate(p.qualified_at)}</dd>
        <dt>Joined the prize chat</dt>
        <dd>{fmtDate(p.prize_joined_at)}</dd>
      </dl>
      <button className={p.disqualified_at ? "secondary" : "danger"} onClick={toggle}>
        {p.disqualified_at ? "Restore participant" : "Disqualify"}
      </button>
      {error && <p className="error">{error}</p>}

      <h3>
        People who started with this link ({invitees.length}, counted: {p.invite_count})
      </h3>
      {invitees.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Telegram id</th>
              <th>Started</th>
              <th>Passed the gate</th>
            </tr>
          </thead>
          <tbody>
            {invitees.map((i) => (
              <tr key={i.id} className="clickable" onClick={() => onOpen(i.id)}>
                <td>
                  {userLabel(i)} {i.disqualified_at && <span className="badge bad">disqualified</span>}
                </td>
                <td>{i.user_id}</td>
                <td>{fmtDate(i.created_at)}</td>
                <td>{i.verified_at ? fmtDate(i.verified_at) : <span className="muted">not yet</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
