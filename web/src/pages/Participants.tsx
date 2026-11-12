import { useEffect, useState } from "react";
import {
  api,
  displayName,
  fmtAgo,
  fmtDate,
  fmtNum,
  type Invitee,
  type ParticipantDetail,
  type ParticipantRow,
  useLoad,
  userLabel,
} from "../api";
import { useApp } from "../app";
import { Avatar, Badge, Button, Card, Drawer, Empty, ErrorNote, Icon, Loading, Progress, Segmented, useCopy, useUi } from "../ui";

type Filter = "all" | "verified" | "qualified" | "joined" | "disqualified";

export function Participants() {
  const { contest } = useApp();
  if (!contest) return <Empty icon="users" title="No contests yet" />;
  return <ParticipantTable key={contest.id} />;
}

function ParticipantTable() {
  const { contest } = useApp();
  const c = contest!;
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);

  // Search as you type, without a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const data = useLoad(
    () =>
      api<{ items: ParticipantRow[]; total: number; page: number; page_size: number }>(
        `/contests/${c.id}/participants?filter=${filter}&page=${page}${query ? `&q=${encodeURIComponent(query)}` : ""}`,
      ),
    [c.id, filter, page, query],
  );
  const pages = data.data ? Math.max(1, Math.ceil(data.data.total / data.data.page_size)) : 1;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Participants</h1>
          <p className="muted">
            {data.data ? `${fmtNum(data.data.total)} ${filter === "all" ? "in total" : filter}` : "…"} · {c.title}
          </p>
        </div>
        <a className="btn btn-secondary" href={`/admin/api/contests/${c.id}/export.csv`}>
          <Icon name="download" size={16} /> Export CSV
        </a>
      </div>

      <Card pad={false}>
        <div className="toolbar">
          <div className="search">
            <Icon name="search" size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, @username, Telegram id or code" />
          </div>
          <Segmented
            value={filter}
            onChange={(f) => {
              setFilter(f);
              setPage(1);
            }}
            options={[
              { value: "all", label: "All" },
              { value: "verified", label: "Subscribed" },
              { value: "qualified", label: "Qualified" },
              { value: "joined", label: "In prize chat" },
              { value: "disqualified", label: "Disqualified" },
            ]}
          />
        </div>
        {data.error && <ErrorNote>{data.error}</ErrorNote>}
        {!data.data ? (
          <Loading />
        ) : data.data.items.length === 0 ? (
          <Empty icon="search" title="Nobody here">
            {query ? "Try another search." : "No participants match this filter yet."}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table hover">
              <thead>
                <tr>
                  <th>Participant</th>
                  <th>Status</th>
                  <th className="num">Invites</th>
                  <th className="hide-sm">Progress</th>
                  <th className="hide-sm">Joined</th>
                </tr>
              </thead>
              <tbody>
                {data.data.items.map((p) => (
                  <tr key={p.id} onClick={() => setOpen(p.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpen(p.id)}>
                    <td>
                      <div className="person">
                        <Avatar name={displayName(p)} id={p.user_id} />
                        <div>
                          <div className="person-name">{displayName(p)}</div>
                          <div className="muted small">{p.username ? `@${p.username}` : p.user_id}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <StatusChips p={p} />
                    </td>
                    <td className="num">
                      <b>{p.invite_count}</b>
                    </td>
                    <td className="hide-sm" style={{ minWidth: 120 }}>
                      <Progress value={p.invite_count} max={c.required_invites} tone={p.qualified_at ? "green" : undefined} />
                    </td>
                    <td className="hide-sm muted small">{fmtAgo(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.data && pages > 1 && (
          <div className="pager">
            <Button size="sm" icon="chevronLeft" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <span className="muted small">
              Page {page} of {pages}
            </span>
            <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next <Icon name="chevronRight" size={16} />
            </Button>
          </div>
        )}
      </Card>

      <Drawer open={open !== null} title="Participant" onClose={() => setOpen(null)}>
        {open !== null && (
          <ParticipantPanel
            id={open}
            required={c.required_invites}
            onOpen={setOpen}
            onChanged={() => void data.reload()}
          />
        )}
      </Drawer>
    </div>
  );
}

export function StatusChips({ p }: { p: Pick<ParticipantRow, "verified_at" | "qualified_at" | "prize_joined_at" | "disqualified_at" | "blocked_at"> }) {
  return (
    <div className="chips">
      {p.disqualified_at ? (
        <Badge tone="red">disqualified</Badge>
      ) : p.prize_joined_at ? (
        <Badge tone="green">in prize chat</Badge>
      ) : p.qualified_at ? (
        <Badge tone="green">qualified</Badge>
      ) : p.verified_at ? (
        <Badge tone="blue">subscribed</Badge>
      ) : (
        <Badge>started</Badge>
      )}
      {p.blocked_at && <Badge tone="amber">blocked bot</Badge>}
    </div>
  );
}

export function ParticipantPanel({
  id,
  required,
  onOpen,
  onChanged,
}: {
  id: number;
  required: number;
  onOpen: (id: number) => void;
  onChanged: () => void;
}) {
  const { run, confirm } = useUi();
  const copy = useCopy();
  const d = useLoad(() => api<ParticipantDetail>(`/participants/${id}`), [id]);
  const [busy, setBusy] = useState(false);

  if (d.error) return <ErrorNote>{d.error}</ErrorNote>;
  if (!d.data) return <Loading />;
  const p = d.data.participant;
  const name = displayName(p);

  const toggle = async () => {
    const disqualify = !p.disqualified_at;
    if (
      disqualify &&
      !(await confirm({
        title: `Disqualify ${name}?`,
        body: "They stop counting as an invite and cannot be approved into the prize chat. Press Recount invites afterwards to update their referrer.",
        confirm: "Disqualify",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    const r = await run(() => api(`/participants/${id}/disqualify`, { body: { disqualified: disqualify } }), disqualify ? "Disqualified" : "Restored");
    setBusy(false);
    if (r) {
      await d.reload();
      onChanged();
    }
  };

  return (
    <div className="stack">
      <div className="profile">
        <Avatar name={name} id={p.user_id} />
        <div className="grow">
          <h3>{name}</h3>
          <div className="muted small">
            {p.username && (
              <a href={`https://t.me/${p.username}`} target="_blank" rel="noreferrer">
                @{p.username}
              </a>
            )}{" "}
            · id {p.user_id}
          </div>
          <StatusChips p={p} />
        </div>
      </div>

      <div className="stats-grid compact">
        <div className="mini-stat">
          <b>
            {p.invite_count} / {required}
          </b>
          <span>invites</span>
        </div>
        <div className="mini-stat">
          <b>{d.data.invitees.length}</b>
          <span>started with link</span>
        </div>
      </div>
      <Progress value={p.invite_count} max={required} tone={p.qualified_at ? "green" : undefined} />

      <dl className="facts">
        <dt>Referral code</dt>
        <dd>
          <code>{p.ref_code}</code>
          <button className="icon-btn" onClick={() => void copy(p.ref_code)} aria-label="Copy code">
            <Icon name="copy" size={14} />
          </button>
        </dd>
        <dt>Invited by</dt>
        <dd>
          {p.referred_by ? (
            <button className="link-btn" onClick={() => onOpen(p.referred_by!)}>
              {p.referrer_first_name ?? (p.referrer_username ? `@${p.referrer_username}` : p.referrer_user_id)}
            </button>
          ) : (
            "—"
          )}
        </dd>
        <dt>Started</dt>
        <dd>{fmtDate(p.created_at)}</dd>
        <dt>Subscribed</dt>
        <dd>{fmtDate(p.verified_at)}</dd>
        <dt>Qualified</dt>
        <dd>{fmtDate(p.qualified_at)}</dd>
        <dt>Prize chat</dt>
        <dd>{fmtDate(p.prize_joined_at)}</dd>
      </dl>

      <section>
        <h4 className="section-title">
          <Icon name="tree" size={15} /> Invite tree
        </h4>
        {d.data.invitees.length === 0 ? (
          <p className="muted small">Nobody has started the bot with this person's link yet.</p>
        ) : (
          <ul className="tree">
            {d.data.invitees.map((i) => (
              <TreeNode key={i.id} node={i} onOpen={onOpen} depth={0} />
            ))}
          </ul>
        )}
      </section>

      <div className="row">
        <Button variant={p.disqualified_at ? "secondary" : "danger"} icon={p.disqualified_at ? "refresh" : "x"} onClick={toggle} busy={busy}>
          {p.disqualified_at ? "Restore" : "Disqualify"}
        </Button>
      </div>
    </div>
  );
}

function TreeNode({ node, onOpen, depth }: { node: Invitee; onOpen: (id: number) => void; depth: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<Invitee[] | null>(null);
  const canExpand = node.invite_count > 0 && depth < 4;

  const toggle = async () => {
    if (!open && children === null) {
      const r = await api<ParticipantDetail>(`/participants/${node.id}`).catch(() => null);
      setChildren(r?.invitees ?? []);
    }
    setOpen(!open);
  };

  return (
    <li>
      <div className="tree-row">
        <button className={`tree-toggle ${canExpand ? "" : "invisible"}`} onClick={() => void toggle()} aria-label="Expand">
          <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        <span className={`tree-dot ${node.disqualified_at ? "bad" : node.verified_at ? "ok" : "wait"}`} />
        <button className="link-btn" onClick={() => onOpen(node.id)}>
          {node.first_name ?? userLabel(node)}
        </button>
        <span className="muted small">
          {node.disqualified_at ? "disqualified" : node.verified_at ? "counted" : "not subscribed yet"}
          {node.invite_count > 0 && ` · invited ${node.invite_count}`}
        </span>
      </div>
      {open && children && children.length > 0 && (
        <ul className="tree">
          {children.map((c) => (
            <TreeNode key={c.id} node={c} onOpen={onOpen} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
