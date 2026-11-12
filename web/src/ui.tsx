import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

// ---- icons (inline, stroke-based, 24px grid) ----

const PATHS: Record<string, string> = {
  overview: "M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z",
  trophy: "M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3a3 3 0 0 1-3 4M7 5H4a3 3 0 0 0 3 4",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  medal: "M7.2 2h9.6L14 8H10zM12 22a7 7 0 1 0 0-14 7 7 0 0 0 0 14M12 12l1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.4z",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  plus: "M12 5v14M5 12h14",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  chevronRight: "m9 18 6-6-6-6",
  chevronLeft: "m15 18-6-6 6-6",
  chevronDown: "m6 9 6 6 6-6",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.3-4.3",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  refresh: "M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  image: "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M21 15l-5-5L5 21",
  trash: "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0M12 9v4M12 17h.01",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 16v-4M12 8h.01",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  menu: "M3 12h18M3 6h18M3 18h18",
  grip: "M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01",
  up: "m18 15-6-6-6 6",
  down: "m6 9 6 6 6-6",
  play: "m6 3 14 9-14 9z",
  stop: "M6 6h12v12H6z",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20",
  sparkles: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9zM5 2l.7 1.6L7.3 4.3 5.7 5 5 6.6 4.3 5 2.7 4.3l1.6-.7z",
  copy: "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10",
  tree: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9a9 9 0 0 1-9 9",
};

export function Icon({ name, size = 18, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

// ---- basic building blocks ----

type BtnVariant = "primary" | "secondary" | "ghost" | "danger" | "success";

export function Button({
  variant = "secondary",
  icon,
  busy,
  children,
  size,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  icon?: string;
  busy?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <button
      {...rest}
      className={`btn btn-${variant} ${size === "sm" ? "btn-sm" : ""} ${rest.className ?? ""}`}
      disabled={rest.disabled || busy}
    >
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  pad = true,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={pad ? "card-body" : ""}>{children}</div>
    </section>
  );
}

export function Badge({ tone = "neutral", children, dot }: { tone?: string; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}

export const STATUS_TONE: Record<string, string> = { active: "green", draft: "amber", finished: "neutral" };
export const STATUS_LABEL: Record<string, string> = { active: "Live", draft: "Draft", finished: "Finished" };

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status]} dot={status === "active"}>
      {STATUS_LABEL[status] ?? status}
    </Badge>
  );
}

export function Stat({
  label,
  value,
  hint,
  delta,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: number | null;
  icon?: string;
  tone?: string;
}) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ""}`}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon && (
          <span className="stat-icon">
            <Icon name={icon} size={16} />
          </span>
        )}
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-foot">
        {delta !== undefined && delta !== null && (
          <span className={`delta ${delta > 0 ? "up" : delta < 0 ? "down" : ""}`}>
            {delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} {Math.abs(delta).toLocaleString()}
          </span>
        )}
        {hint && <span className="muted small">{hint}</span>}
      </div>
    </div>
  );
}

export function Empty({ icon = "sparkles", title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <h4>{title}</h4>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
          type="button"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Progress({ value, max, tone }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={`progress ${tone ? `progress-${tone}` : ""}`}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Avatar({ name, id }: { name: string; id: number }) {
  const hue = (id * 47) % 360;
  const letter = [...name.replace(/^@/, "")][0]?.toUpperCase() ?? "?";
  return (
    <span className="avatar" style={{ "--h": hue } as React.CSSProperties}>
      {letter}
    </span>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" /> {label}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="note note-bad">
      <Icon name="alert" size={16} />
      <div>{children}</div>
    </div>
  );
}

export function Note({ tone = "info", children }: { tone?: "info" | "warn" | "ok" | "bad"; children: ReactNode }) {
  const icon = tone === "ok" ? "check" : tone === "info" ? "info" : "alert";
  return (
    <div className={`note note-${tone}`}>
      <Icon name={icon} size={16} />
      <div>{children}</div>
    </div>
  );
}

// ---- dialogs and drawers ----

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true">
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({ open, title, onClose, children }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEscape(open, onClose);
  return (
    <div className={`drawer-wrap ${open ? "open" : ""}`} aria-hidden={!open}>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="drawer-body">{open && children}</div>
      </aside>
    </div>
  );
}

function useEscape(active: boolean, fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => e.key === "Escape" && ref.current();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [active]);
}

// ---- confirm + toasts (one provider for the whole app) ----

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirm?: string;
  danger?: boolean;
}
interface Toast {
  id: number;
  tone: "ok" | "bad" | "info";
  text: string;
}
interface UiApi {
  toast: (text: string, tone?: Toast["tone"]) => void;
  confirm: (o: ConfirmOpts) => Promise<boolean>;
  /** Runs an action, shows its error as a toast, and returns whether it worked. */
  run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;
}

const UiContext = createContext<UiApi | null>(null);

export function useUi(): UiApi {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("UiProvider missing");
  return ui;
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [ask, setAsk] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const next = useRef(1);

  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = next.current++;
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "bad" ? 7000 : 3500);
  }, []);

  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setAsk({ ...o, resolve })), []);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string) => {
      try {
        const r = await fn();
        if (success) toast(success);
        return r;
      } catch (e) {
        toast((e as Error).message, "bad");
        return undefined;
      }
    },
    [toast],
  );

  const close = (v: boolean) => {
    ask?.resolve(v);
    setAsk(null);
  };

  return (
    <UiContext.Provider value={{ toast, confirm, run }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={t.tone === "bad" ? "alert" : t.tone === "ok" ? "check" : "info"} size={16} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
      <Modal
        open={ask !== null}
        title={ask?.title ?? ""}
        onClose={() => close(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant={ask?.danger ? "danger" : "primary"} onClick={() => close(true)} autoFocus>
              {ask?.confirm ?? "Confirm"}
            </Button>
          </>
        }
      >
        {ask?.body}
      </Modal>
    </UiContext.Provider>
  );
}

/** Copies text and confirms with a toast. */
export function useCopy() {
  const { toast } = useUi();
  return (text: string, what = "Copied") =>
    navigator.clipboard.writeText(text).then(
      () => toast(what),
      () => toast("Could not copy", "bad"),
    );
}
