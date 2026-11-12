import { useEffect, useState } from "react";
import { api, fmtNum, type Health, useLoad } from "../api";
import { Sparkline } from "../charts";
import { Badge, Card, ErrorNote, Loading, Stat } from "../ui";

const LANE_LABEL: Record<string, string> = {
  send: "Messages and edits",
  callback: "Button answers",
  lookup: "Subscription checks",
  manage: "Join requests, links",
};

export function System() {
  const health = useLoad(() => api<Health>("/health"), [], 3_000);
  const [history, setHistory] = useState<number[]>([]);

  // Keep a short in-memory history of the send queue for the sparkline.
  useEffect(() => {
    const send = health.data?.lanes.find((l) => l.name === "send");
    if (send) setHistory((h) => [...h.slice(-59), send.depth]);
  }, [health.data]);

  if (health.error) return <ErrorNote>{health.error}</ErrorNote>;
  if (!health.data) return <Loading />;
  const h = health.data;
  const pollAge = h.poller.seconds_since_poll;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>System</h1>
          <p className="muted">Live view of the bot process. Refreshes every 3 seconds.</p>
        </div>
      </div>

      <div className="stats-grid">
        <Stat
          label="Last Telegram fetch"
          value={pollAge === null ? "—" : `${pollAge}s ago`}
          tone={pollAge !== null && pollAge > 60 ? "red" : undefined}
          hint={`${h.poller.last_batch_size} updates in ${h.poller.last_batch_ms} ms`}
          icon="activity"
        />
        <Stat label="Updates handled" value={fmtNum(h.poller.updates)} hint={`${fmtNum(h.poller.dropped)} dropped`} icon="check" />
        <Stat label="Durable queue" value={fmtNum(h.outbox_pending)} hint={`${fmtNum(h.joins_pending)} join requests waiting`} icon="send" />
        <Stat label="Memory" value={`${h.memory_mb} MB`} hint={`up ${uptime(h.uptime_s)}`} icon="overview" />
      </div>

      <Card title="Send queue" subtitle="Messages waiting behind Telegram's limit of about 30 per second. It grows during a launch spike and drains on its own.">
        <Sparkline values={history.length > 1 ? history : [0, 0]} height={56} />
      </Card>

      <Card title="Telegram lanes" pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Lane</th>
                <th className="num">Rate / s</th>
                <th className="num">Waiting</th>
                <th className="num">Oldest</th>
                <th className="num">Done</th>
                <th className="num">429s</th>
                <th className="num">Dropped</th>
                <th className="num">Failed</th>
              </tr>
            </thead>
            <tbody>
              {h.lanes.map((l) => (
                <tr key={l.name}>
                  <td>
                    {LANE_LABEL[l.name] ?? l.name} {l.paused && <Badge tone="amber">paused</Badge>}
                  </td>
                  <td className="num">{l.rate}</td>
                  <td className="num">{fmtNum(l.depth)}</td>
                  <td className="num">{l.oldest_age_s}s</td>
                  <td className="num">{fmtNum(l.ok)}</td>
                  <td className="num">{fmtNum(l.limited)}</td>
                  <td className="num">{fmtNum(l.dropped)}</td>
                  <td className="num">{fmtNum(l.failed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function uptime(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}
