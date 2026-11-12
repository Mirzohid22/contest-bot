import { useEffect, useMemo, useRef, useState } from "react";

export interface Series {
  key: string;
  label: string;
  color: string;
}

/**
 * Hourly area chart with a hover read-out. Drawn in plain SVG so the panel needs no
 * chart library; it scales to its container width.
 */
export function AreaChart<T extends { t: string }>({
  data,
  series,
  height = 240,
}: {
  data: T[];
  series: Series[];
  height?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the real pixel width, so text and lines are never stretched.
  const [W, setW] = useState(800);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const pad = { l: 36, r: 12, t: 12, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const max = useMemo(() => {
    let m = 0;
    for (const d of data) for (const s of series) m = Math.max(m, Number((d as any)[s.key]) || 0);
    return niceMax(m);
  }, [data, series]);

  const x = (i: number) => pad.l + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (max === 0 ? 0 : (v / max) * ih);

  const paths = series.map((s) => {
    const pts = data.map((d, i) => [x(i), y(Number((d as any)[s.key]) || 0)] as const);
    const line = smooth(pts);
    const area = pts.length ? `${line} L${pts[pts.length - 1]![0]},${pad.t + ih} L${pts[0]![0]},${pad.t + ih} Z` : "";
    return { s, line, area };
  });

  const ticks = [...new Set([0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => Math.round(max * f)))];
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 70))));

  const onMove = (e: React.MouseEvent) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r || data.length === 0) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - pad.l) / iw) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };

  const h = hover !== null ? data[hover] : null;

  return (
    <div className="chart" ref={wrap} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`g-${s.key}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 8} y={y(t) + 4} className="axis" textAnchor="end">
              {compact(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={d.t} x={x(i)} y={H - 6} className="axis" textAnchor="middle">
              {hourLabel(d.t)}
            </text>
          ) : null,
        )}
        {paths.map(({ s, area }) => (
          <path key={`a-${s.key}`} d={area} fill={`url(#g-${s.key})`} />
        ))}
        {paths.map(({ s, line }) => (
          <path key={`l-${s.key}`} d={line} fill="none" stroke={s.color} strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} className="crosshair" />
            {series.map((s) => (
              <circle
                key={s.key}
                cx={x(hover)}
                cy={y(Number((data[hover] as any)[s.key]) || 0)}
                r={4}
                fill={s.color}
                stroke="var(--surface)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        )}
      </svg>
      {h && hover !== null && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <div className="chart-tip-title">{fullHourLabel(h.t)}</div>
          {series.map((s) => (
            <div key={s.key} className="chart-tip-row">
              <span className="dot" style={{ background: s.color }} />
              {s.label}
              <b>{(Number((h as any)[s.key]) || 0).toLocaleString()}</b>
            </div>
          ))}
        </div>
      )}
      <div className="legend">
        {series.map((s) => (
          <span key={s.key}>
            <span className="dot" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Horizontal funnel: each step as a bar, with the share kept from the step before. */
export function Funnel({ steps }: { steps: { label: string; value: number; color: string }[] }) {
  const top = Math.max(steps[0]?.value ?? 0, 1);
  return (
    <div className="funnel">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1]!.value : null;
        const conv = prev ? Math.round((s.value / Math.max(prev, 1)) * 100) : null;
        return (
          <div key={s.label} className="funnel-row">
            <div className="funnel-label">
              <span>{s.label}</span>
              <span className="funnel-num">
                <b>{s.value.toLocaleString()}</b>
                {conv !== null && <span className="muted small"> · {conv}%</span>}
              </span>
            </div>
            <div className="funnel-track">
              <div
                className="funnel-bar"
                style={{ width: `${Math.max((s.value / top) * 100, s.value > 0 ? 2 : 0)}%`, background: s.color }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Ring chart for a small set of shares (languages). */
export function Donut({ parts, size = 132 }: { parts: { label: string; value: number; color: string }[]; size?: number }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const r = 15.9155; // circumference 100
  let offset = 25;
  return (
    <div className="donut">
      <svg viewBox="0 0 42 42" width={size} height={size}>
        <circle cx="21" cy="21" r={r} fill="none" stroke="var(--track)" strokeWidth="5" />
        {total > 0 &&
          parts.map((p) => {
            const pct = (p.value / total) * 100;
            const el = (
              <circle
                key={p.label}
                cx="21"
                cy="21"
                r={r}
                fill="none"
                stroke={p.color}
                strokeWidth="5"
                strokeDasharray={`${pct} ${100 - pct}`}
                strokeDashoffset={offset}
              />
            );
            offset -= pct;
            return el;
          })}
        <text x="21" y="22.5" textAnchor="middle" className="donut-total">
          {compact(total)}
        </text>
      </svg>
      <ul className="donut-legend">
        {parts.map((p) => (
          <li key={p.label}>
            <span className="dot" style={{ background: p.color }} />
            <span>{p.label}</span>
            <b>{total > 0 ? Math.round((p.value / total) * 100) : 0}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Sparkline({ values, color = "var(--accent)", height = 32 }: { values: number[]; color?: string; height?: number }) {
  const W = 120;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / Math.max(values.length - 1, 1)) * W, height - 2 - (v / max) * (height - 4)] as const);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none" className="sparkline">
      <path d={smooth(pts)} fill="none" stroke={color} strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ---- helpers ----

function smooth(pts: readonly (readonly [number, number])[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0]![0]},${pts[0]![1]}`;
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return d;
}

function niceMax(m: number): number {
  if (m <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(m));
  const n = m / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

const hourLabel = (t: string) => {
  const d = new Date(t);
  return d.getHours() === 0 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : `${d.getHours()}:00`;
};
const fullHourLabel = (t: string) =>
  new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
