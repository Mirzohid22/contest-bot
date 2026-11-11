import { useState } from "react";
import { api, type Contest, fmtDate } from "./api";

export function StatusBadge({ status }: { status: Contest["status"] }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

export function Contests({
  contests,
  reload,
  onOpen,
}: {
  contests: Contest[];
  reload: () => void;
  onOpen: (id: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [required, setRequired] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const c = await api<Contest>("/contests", { body: { title, required_invites: required } });
      setTitle("");
      reload();
      onOpen(c.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section>
        <h2>New contest</h2>
        <form className="row" onSubmit={create}>
          <label className="grow">
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
          </label>
          <label>
            Invites required
            <input
              type="number"
              min={0}
              value={required}
              onChange={(e) => setRequired(Number(e.target.value))}
              required
            />
          </label>
          <button disabled={busy}>Create draft</button>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="muted small">
          A new contest starts as a draft with no participants. Nothing changes for users until you activate it.
        </p>
      </section>

      <section>
        <h2>Contests</h2>
        {contests.length === 0 ? (
          <p className="muted">No contests yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Status</th>
                <th className="num">Required</th>
                <th className="num">Participants</th>
                <th className="num">Qualified</th>
                <th>Started</th>
                <th>Finished</th>
              </tr>
            </thead>
            <tbody>
              {contests.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => onOpen(c.id)}>
                  <td>{c.title}</td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="num">{c.required_invites}</td>
                  <td className="num">{c.participants}</td>
                  <td className="num">{c.qualified}</td>
                  <td>{fmtDate(c.started_at)}</td>
                  <td>{fmtDate(c.finished_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
