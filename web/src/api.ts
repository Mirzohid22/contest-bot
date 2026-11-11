import { useCallback, useEffect, useState } from "react";

export class Unauthorized extends Error {}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  const res = await fetch(`/admin/api${path}`, {
    method: init.method ?? (hasBody ? "POST" : "GET"),
    headers: hasBody ? { "content-type": "application/json" } : undefined,
    body: hasBody ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event("unauthorized"));
    throw new Unauthorized("Not signed in");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Loads data on mount and whenever deps change; `reload` fetches again without clearing what is shown. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps);

  const reload = useCallback(() => {
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (!(e instanceof Unauthorized)) setError(e.message);
      });
  }, [load]);

  useEffect(() => {
    setData(null);
    reload();
    if (!refreshMs) return;
    const t = setInterval(reload, refreshMs);
    return () => clearInterval(t);
  }, [reload, refreshMs]);

  return { data, error, reload };
}

export interface Contest {
  id: number;
  title: string;
  status: "draft" | "active" | "finished";
  required_invites: number;
  prize_chat_id: number | null;
  prize_chat_title: string | null;
  prize_invite_link: string | null;
  texts: Record<string, string>;
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
  health: "ok" | "bot_not_admin";
}

export interface ContestDetail {
  contest: Contest;
  sponsors: Sponsor[];
  stats: { total: number; verified: number; qualified: number; joined_prize: number; disqualified: number };
  timeline: { hour: string; started: number; verified: number }[];
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

export const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
export const userLabel = (u: { username: string | null; first_name: string | null; user_id: number }) =>
  u.username ? `@${u.username}` : (u.first_name ?? String(u.user_id));
