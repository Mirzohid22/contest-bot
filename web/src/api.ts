import { useCallback, useEffect, useRef, useState } from "react";

export class Unauthorized extends Error {}

async function request(path: string, init: RequestInit): Promise<Response> {
  const res = await fetch(`/admin/api${path}`, { credentials: "same-origin", ...init });
  if (res.status === 401) {
    window.dispatchEvent(new Event("unauthorized"));
    throw new Unauthorized("Not signed in");
  }
  return res;
}

async function parse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  const res = await request(path, {
    method: init.method ?? (hasBody ? "POST" : "GET"),
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });
  return parse<T>(res);
}

/** Sends a file as the raw request body (used for the banner picture). */
export async function upload<T = unknown>(path: string, file: File, method = "PUT"): Promise<T> {
  const res = await request(path, { method, headers: { "content-type": file.type }, body: file });
  return parse<T>(res);
}

/**
 * Loads data on mount and whenever deps change. `reload` fetches again without clearing
 * what is shown; with `refreshMs` it refreshes on its own while the tab is visible.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps);
  const seq = useRef(0);

  const reload = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    return load()
      .then((d) => {
        if (n !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (n === seq.current && !(e instanceof Unauthorized)) setError(e.message);
      })
      .finally(() => n === seq.current && setLoading(false));
  }, [load]);

  useEffect(() => {
    setData(null);
    void reload();
    if (!refreshMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, refreshMs);
    return () => clearInterval(t);
  }, [reload, refreshMs]);

  return { data, error, loading, reload, setData };
}

export type Locale = "uz" | "ru" | "en";
export const LOCALES: Locale[] = ["uz", "ru", "en"];
export const LOCALE_LABEL: Record<Locale, string> = { uz: "Oʻzbekcha", ru: "Русский", en: "English" };
export const LOCALE_FLAG: Record<Locale, string> = { uz: "🇺🇿", ru: "🇷🇺", en: "🇬🇧" };

export interface Contest {
  id: number;
  title: string;
  status: "draft" | "active" | "finished";
  required_invites: number;
  prize_chat_id: number | null;
  prize_chat_title: string | null;
  prize_invite_link: string | null;
  texts: Partial<Record<Locale, Record<string, string>>>;
  banner_file_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  participants?: number;
  qualified?: number;
}

export interface Sponsor {
  id: number;
  chat_id: number;
  title: string;
  join_url: string;
  position: number;
  health: "ok" | "bot_not_admin";
}

export interface ContestDetail {
  contest: Contest;
  sponsors: Sponsor[];
  stats: { total: number; verified: number; qualified: number; joined_prize: number; disqualified: number };
}

export interface Stats {
  funnel: {
    started: number;
    verified: number;
    qualified: number;
    joined: number;
    disqualified: number;
    started_1h: number;
    started_prev_1h: number;
    verified_1h: number;
    qualified_1h: number;
    invites: number;
  };
  timeline: { t: string; started: number; verified: number; qualified: number }[];
  sponsors: { id: number; title: string; health: string; members_known: number; blocking: number }[];
  languages: { locale: Locale; n: number }[];
}

export interface Health {
  lanes: {
    name: string;
    rate: number;
    depth: number;
    oldest_age_s: number;
    paused: boolean;
    ok: number;
    limited: number;
    dropped: number;
    failed: number;
  }[];
  poller: {
    seconds_since_poll: number | null;
    last_batch_size: number;
    last_batch_ms: number;
    updates: number;
    dropped: number;
  };
  outbox_pending: number;
  joins_pending: number;
  memory_mb: number;
  uptime_s: number;
}

export interface ParticipantRow {
  id: number;
  user_id: number;
  username: string | null;
  first_name: string | null;
  ref_code: string;
  referred_by: number | null;
  invite_count: number;
  created_at: string;
  verified_at: string | null;
  qualified_at: string | null;
  prize_joined_at: string | null;
  disqualified_at: string | null;
  blocked_at: string | null;
}

export interface LeaderRow {
  id: number;
  user_id: number;
  username: string | null;
  first_name: string | null;
  invite_count: number;
  pending: number;
  qualified_at: string | null;
  prize_joined_at: string | null;
  disqualified_at: string | null;
}

export interface Invitee {
  id: number;
  user_id: number;
  username: string | null;
  first_name: string | null;
  verified_at: string | null;
  qualified_at: string | null;
  disqualified_at: string | null;
  created_at: string;
  invite_count: number;
}

export interface ParticipantDetail {
  participant: ParticipantRow & {
    referrer_user_id: number | null;
    referrer_username: string | null;
    referrer_first_name: string | null;
  };
  invitees: Invitee[];
}

export interface ChatCheck {
  id: number;
  title: string;
  type: string;
  username: string | null;
  members: number | null;
  bot_status: string;
  can_invite_users: boolean;
  ok: boolean;
  problem: string | null;
}

export interface TextDefaults {
  locales: Locale[];
  default_locale: Locale;
  keys: string[];
  texts: Record<Locale, Record<string, string>>;
}

export interface BroadcastRow {
  id: number;
  segment: string;
  total: number;
  created_at: string;
  cancelled_at: string | null;
  preview: string | null;
  sent: number;
  failed: number;
  pending: number;
  cancelled: number;
}

export const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export const fmtNum = (n: number | null | undefined) => (n ?? 0).toLocaleString();

export function fmtAgo(s: string | null): string {
  if (!s) return "—";
  const sec = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} d ago`;
}

export const userLabel = (u: { username: string | null; first_name: string | null; user_id: number }) =>
  u.username ? `@${u.username}` : (u.first_name ?? String(u.user_id));

export const displayName = (u: { first_name: string | null; username: string | null; user_id: number }) =>
  u.first_name?.trim() || (u.username ? `@${u.username}` : `User ${u.user_id}`);
