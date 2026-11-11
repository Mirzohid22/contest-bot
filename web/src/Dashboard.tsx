import { api, type Contest, type ContestDetail, useLoad } from "./api";

interface Health {
  lanes: {
    name: string; rate: number; depth: number; oldest_age_s: number; paused: boolean;
    ok: number; limited: number; dropped: number; failed: number;
  }[];
  poller: { seconds_since_poll: number | null; last_batch_size: number; last_batch_ms: number; updates: number; dropped: number };
  outbox_pending: number;
  joins_pending: number;
  memory_mb: number;
  uptime_s: number;
}

const LANE_HELP: Record<string, string> = {
  send: "Messages and edits",
  callback: "Button answers",
  lookup: "Subscription checks",
  manage: "Join requests, links",
};

export function Stat({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
  return (
    <div className={warn ? "stat warn" : "stat"}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function Dashboard({ contests, onOpen }: { contests: Contest[]; onOpen: (id: number) => void }) {
  const active = contests.find((c) => c.status === "active");
  const health = useLoad(() => api<Health>("/health"), [], 5000);
  const detail = useLoad(
    () => (active ? api<ContestDetail>(`/contests/${active.id}`) : Promise.resolve(null)),
    [active?.id],
    5000,
  );
  const h = health.data;
  const s = detail.data?.stats;

  return (
    <>
      <section>
        <h2>Active contest</h2>
        {!active && <p className="muted">No contest is active. Create one under Contests and activate it.</p>}
        {active && (
          <>
            <p>
              <button className="link" onClick={() => onOpen(active.id)}>
                {active.title}
              </button>{" "}
              <span className="muted">· {active.required_invites} invites required</span>
            </p>
            {s && (
              <div className="stats">
                <Stat label="Started the bot" value={s.total} />
                <Stat label="Passed the gate" value={s.verified} />
                <Stat label="Qualified" value={s.qualified} />
                <Stat label="In the prize chat" value={s.joined_prize} />
                <Stat label="Disqualified" value={s.disqualified} />
              </div>
            )}
          </>
        )}
      </section>

      <section>
        <h2>Bot health</h2>
        {health.error && <p className="error">{health.error}</p>}
        {h && (
          <>
            <div className="stats">
              <Stat
                label="Seconds since last update fetch"
                value={h.poller.seconds_since_poll ?? "—"}
                warn={(h.poller.seconds_since_poll ?? 0) > 60}
              />
              <Stat label="Updates handled" value={h.poller.updates} />
              <Stat label="Last batch" value={`${h.poller.last_batch_size} in ${h.poller.last_batch_ms} ms`} />
              <Stat label="Durable messages waiting" value={h.outbox_pending} />
              <Stat label="Join requests waiting" value={h.joins_pending} />
              <Stat label="Memory" value={`${h.memory_mb} MB`} warn={h.memory_mb > 450} />
            </div>
            <table>
              <thead>
                <tr>
                  <th>Lane</th>
                  <th className="num">Rate / s</th>
                  <th className="num">Waiting</th>
                  <th className="num">Oldest, s</th>
                  <th className="num">Sent</th>
                  <th className="num">429s</th>
                  <th className="num">Dropped</th>
                  <th className="num">Failed</th>
                </tr>
              </thead>
              <tbody>
                {h.lanes.map((l) => (
                  <tr key={l.name}>
                    <td>
                      {LANE_HELP[l.name] ?? l.name} {l.paused && <span className="badge bad">paused</span>}
                    </td>
                    <td className="num">{l.rate}</td>
                    <td className="num">{l.depth}</td>
                    <td className={l.oldest_age_s > 60 ? "num bad-text" : "num"}>{l.oldest_age_s}</td>
                    <td className="num">{l.ok}</td>
                    <td className="num">{l.limited}</td>
                    <td className="num">{l.dropped}</td>
                    <td className="num">{l.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              “Waiting” on the first lane is the queue behind Telegram's limit of about 30 messages per second. It
              grows during a launch spike and drains on its own.
            </p>
          </>
        )}
      </section>
    </>
  );
}
