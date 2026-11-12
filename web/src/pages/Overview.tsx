import { useState } from "react";
import { api, fmtAgo, fmtNum, type Health, LOCALE_FLAG, LOCALE_LABEL, type Stats, useLoad } from "../api";
import { useApp } from "../app";
import { AreaChart, Donut, Funnel } from "../charts";
import { Badge, Button, Card, Empty, ErrorNote, Icon, Loading, Note, Segmented, Stat, StatusBadge } from "../ui";

const COLORS = {
  started: "#6366f1",
  verified: "#0ea5e9",
  qualified: "#10b981",
  joined: "#f59e0b",
};
const LANG_COLORS = { uz: "#6366f1", ru: "#0ea5e9", en: "#f59e0b" };

export function Overview() {
  const { contest } = useApp();
  if (!contest) {
    return (
      <Empty icon="trophy" title="No contests yet">
        <p>Create your first contest to see live numbers here.</p>
        <a className="btn btn-primary" href="#/contests">
          <Icon name="plus" size={16} /> New contest
        </a>
      </Empty>
    );
  }
  return <ContestOverview key={contest.id} />;
}

function ContestOverview() {
  const { contest } = useApp();
  const c = contest!;
  const [hours, setHours] = useState("48");
  const live = c.status === "active";
  const stats = useLoad(() => api<Stats>(`/contests/${c.id}/stats?hours=${hours}`), [c.id, hours], live ? 10_000 : undefined);
  const health = useLoad(() => api<Health>("/health"), [], 5_000);

  if (stats.error) return <ErrorNote>{stats.error}</ErrorNote>;
  if (!stats.data) return <Loading />;
  const f = stats.data.funnel;
  const queue = health.data?.lanes.find((l) => l.name === "send");

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">
            <StatusBadge status={c.status} />
            {live && (
              <span className="live">
                <span className="pulse" /> Updating every 10 s
              </span>
            )}
          </div>
          <h1>{c.title}</h1>
          <p className="muted">
            {c.required_invites} invites to qualify ·{" "}
            {c.started_at ? `started ${fmtAgo(c.started_at)}` : "not started yet"}
          </p>
        </div>
        <div className="row">
          <a className="btn btn-secondary" href={`#/contests/${c.id}`}>
            <Icon name="trophy" size={16} /> Manage contest
          </a>
          <Button icon="refresh" onClick={() => void stats.reload()} busy={stats.loading && !!stats.data}>
            Refresh
          </Button>
        </div>
      </div>

      {c.status === "draft" && (
        <Note tone="warn">
          This contest is a draft: users see “no active contest”. Finish the setup and press <b>Launch</b> in{" "}
          <a href={`#/contests/${c.id}/launch`}>Manage contest</a>.
        </Note>
      )}

      <div className="stats-grid">
        <Stat
          label="Started the bot"
          value={fmtNum(f.started)}
          icon="users"
          delta={f.started_1h}
          hint="in the last hour"
        />
        <Stat
          label="Subscribed"
          value={fmtNum(f.verified)}
          icon="check"
          hint={`${pct(f.verified, f.started)} of starters · +${fmtNum(f.verified_1h)} / h`}
        />
        <Stat
          label="Qualified"
          value={fmtNum(f.qualified)}
          icon="trophy"
          tone="green"
          hint={`${pct(f.qualified, f.verified)} of subscribed · +${fmtNum(f.qualified_1h)} / h`}
        />
        <Stat label="Counted invites" value={fmtNum(f.invites)} icon="link" hint={`${fmtNum(f.joined)} joined the prize chat`} />
      </div>

      <div className="grid-2-1">
        <Card
          title="Activity"
          subtitle="New users, completed subscriptions and qualifications per hour"
          actions={
            <Segmented
              value={hours}
              onChange={setHours}
              options={[
                { value: "24", label: "24h" },
                { value: "48", label: "48h" },
                { value: "168", label: "7d" },
              ]}
            />
          }
        >
          <AreaChart
            data={stats.data.timeline}
            series={[
              { key: "started", label: "Started", color: COLORS.started },
              { key: "verified", label: "Subscribed", color: COLORS.verified },
              { key: "qualified", label: "Qualified", color: COLORS.qualified },
            ]}
          />
        </Card>
        <Card title="Funnel" subtitle="Share of the step before">
          <Funnel
            steps={[
              { label: "Started", value: f.started, color: COLORS.started },
              { label: "Subscribed", value: f.verified, color: COLORS.verified },
              { label: "Qualified", value: f.qualified, color: COLORS.qualified },
              { label: "Joined prize chat", value: f.joined, color: COLORS.joined },
            ]}
          />
          {f.disqualified > 0 && (
            <p className="muted small" style={{ marginTop: 12 }}>
              {fmtNum(f.disqualified)} disqualified
            </p>
          )}
        </Card>
      </div>

      <div className="grid-3">
        <Card title="Sponsor channels" subtitle="Where unsubscribed users get stuck">
          {stats.data.sponsors.length === 0 ? (
            <p className="muted">No sponsor channels yet.</p>
          ) : (
            <ul className="list">
              {stats.data.sponsors.map((s) => (
                <li key={s.id}>
                  <div className="list-main">
                    <span className="truncate">{s.title}</span>
                    {s.health !== "ok" && <Badge tone="red">bot not admin</Badge>}
                  </div>
                  <span className="muted small" title="Unsubscribed starters known to be missing this channel">
                    {fmtNum(s.blocking)} missing
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Languages">
          <Donut
            parts={stats.data.languages.map((l) => ({
              label: `${LOCALE_FLAG[l.locale]} ${LOCALE_LABEL[l.locale]}`,
              value: l.n,
              color: LANG_COLORS[l.locale],
            }))}
          />
        </Card>
        <Card title="Bot health" actions={<a href="#/system" className="small">Details →</a>}>
          {health.data ? (
            <ul className="list">
              <li>
                <span>Telegram updates</span>
                <HealthDot ok={(health.data.poller.seconds_since_poll ?? 99) < 60}>
                  {health.data.poller.seconds_since_poll === null ? "—" : `${health.data.poller.seconds_since_poll}s ago`}
                </HealthDot>
              </li>
              <li>
                <span>Messages waiting</span>
                <HealthDot ok={(queue?.depth ?? 0) < 500}>{fmtNum(queue?.depth)}</HealthDot>
              </li>
              <li>
                <span>Oldest in queue</span>
                <HealthDot ok={(queue?.oldest_age_s ?? 0) < 120}>{queue?.oldest_age_s ?? 0}s</HealthDot>
              </li>
              <li>
                <span>Durable queue</span>
                <HealthDot ok={health.data.outbox_pending < 1000}>{fmtNum(health.data.outbox_pending)}</HealthDot>
              </li>
              <li>
                <span>Memory</span>
                <span>{health.data.memory_mb} MB</span>
              </li>
            </ul>
          ) : (
            <Loading />
          )}
        </Card>
      </div>
    </div>
  );
}

function HealthDot({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className="health">
      <span className={`dot ${ok ? "dot-ok" : "dot-warn"}`} />
      {children}
    </span>
  );
}

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");
