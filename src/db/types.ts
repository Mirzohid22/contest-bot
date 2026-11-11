export interface Contest {
  id: number;
  title: string;
  status: "draft" | "active" | "finished";
  required_invites: number;
  prize_chat_id: number | null;
  prize_chat_title: string | null;
  prize_invite_link: string | null;
  texts: Record<string, string>;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface Sponsor {
  id: number;
  contest_id: number;
  chat_id: number;
  title: string;
  join_url: string;
  position: number;
  health: "ok" | "bot_not_admin";
}

export interface Participant {
  id: number;
  contest_id: number;
  user_id: number;
  ref_code: string;
  referred_by: number | null;
  verified_at: Date | null;
  invite_count: number;
  qualified_at: Date | null;
  prize_joined_at: Date | null;
  disqualified_at: Date | null;
  created_at: Date;
}

export interface OutboxRow {
  id: number;
  chat_id: number;
  priority: number;
  payload: { text: string; markup?: unknown };
  attempts: number;
}

export interface JoinRequestRow {
  id: number;
  chat_id: number;
  user_id: number;
  user_chat_id: number;
  attempts: number;
}
