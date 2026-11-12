import { useState } from "react";
import { api, type Contest, fmtDate, fmtNum } from "../api";
import { go, useApp } from "../app";
import { Badge, Button, Empty, Field, Icon, Modal, StatusBadge, useUi } from "../ui";

export function Contests() {
  const { contests } = useApp();
  const [creating, setCreating] = useState(false);
  const active = contests.filter((c) => c.status === "active");
  const drafts = contests.filter((c) => c.status === "draft");
  const finished = contests.filter((c) => c.status === "finished");

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Contests</h1>
          <p className="muted">Each contest starts from zero: its own participants, invites and prize chat.</p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          New contest
        </Button>
      </div>

      {contests.length === 0 ? (
        <Empty icon="trophy" title="No contests yet">
          <p>A guided setup walks you through sponsors, the prize chat and messages.</p>
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            Create the first contest
          </Button>
        </Empty>
      ) : (
        <>
          {active.length > 0 && <Group title="Live" items={active} />}
          {drafts.length > 0 && <Group title="Drafts" items={drafts} />}
          {finished.length > 0 && <Group title="Finished" items={finished} />}
        </>
      )}
      <CreateContest open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function Group({ title, items }: { title: string; items: Contest[] }) {
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      <div className="contest-grid">
        {items.map((c) => (
          <a key={c.id} className={`contest-card ${c.status}`} href={`#/contests/${c.id}`}>
            <div className="contest-card-top">
              <StatusBadge status={c.status} />
              <span className="muted small">#{c.id}</span>
            </div>
            <h3>{c.title}</h3>
            <div className="contest-card-meta">
              <span>
                <Icon name="link" size={14} /> {c.required_invites} invites to qualify
              </span>
              {c.banner_file_id && (
                <span>
                  <Icon name="image" size={14} /> banner
                </span>
              )}
            </div>
            <div className="contest-card-nums">
              <div>
                <b>{fmtNum(c.participants)}</b>
                <span>participants</span>
              </div>
              <div>
                <b>{fmtNum(c.qualified)}</b>
                <span>qualified</span>
              </div>
            </div>
            <div className="contest-card-foot muted small">
              {c.status === "finished"
                ? `Finished ${fmtDate(c.finished_at)}`
                : c.status === "active"
                  ? `Live since ${fmtDate(c.started_at)}`
                  : `Created ${fmtDate(c.created_at)}`}
              {!c.prize_chat_id && c.status !== "finished" && <Badge tone="amber">no prize chat</Badge>}
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

function CreateContest({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { reloadContests, selectContest } = useApp();
  const { run } = useUi();
  const [title, setTitle] = useState("");
  const [required, setRequired] = useState(5);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const c = await run(() => api<Contest>("/contests", { body: { title: title.trim(), required_invites: required } }));
    setBusy(false);
    if (!c) return;
    await reloadContests();
    selectContest(c.id);
    onClose();
    setTitle("");
    go(`/contests/${c.id}/sponsors`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New contest"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!title.trim()} form="new-contest" type="submit">
            Create and continue
          </Button>
        </>
      }
    >
      <form id="new-contest" className="stack-sm" onSubmit={submit}>
        <Field label="Title" hint="Shown to users in the bot's messages.">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Spring giveaway" autoFocus maxLength={200} />
        </Field>
        <Field label="Invites needed to qualify" hint="A friend counts once they start the bot with the link and subscribe.">
          <input type="number" min={0} max={100000} value={required} onChange={(e) => setRequired(Number(e.target.value))} />
        </Field>
        <p className="muted small">
          The contest starts as a draft. Next you'll add sponsor channels, the prize chat and messages, then launch it.
        </p>
      </form>
    </Modal>
  );
}
