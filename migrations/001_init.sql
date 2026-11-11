-- Global: one row per Telegram user, shared by all contests.
CREATE TABLE users (
  tg_id        bigint PRIMARY KEY,
  username     text,
  first_name   text,
  lang         text,
  blocked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contests (
  id                bigserial PRIMARY KEY,
  title             text NOT NULL,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','finished')),
  required_invites  int  NOT NULL DEFAULT 5 CHECK (required_invites >= 0),
  prize_chat_id     bigint,
  prize_chat_title  text,
  prize_invite_link text,
  texts             jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);
-- At most one active contest.
CREATE UNIQUE INDEX one_active_contest ON contests ((true)) WHERE status = 'active';
CREATE INDEX contests_prize_chat ON contests (prize_chat_id) WHERE prize_chat_id IS NOT NULL;

CREATE TABLE sponsor_channels (
  id         bigserial PRIMARY KEY,
  contest_id bigint NOT NULL REFERENCES contests ON DELETE CASCADE,
  chat_id    bigint NOT NULL,
  title      text   NOT NULL,
  join_url   text   NOT NULL,
  position   int    NOT NULL DEFAULT 0,
  health     text   NOT NULL DEFAULT 'ok' CHECK (health IN ('ok','bot_not_admin')),
  UNIQUE (contest_id, chat_id)
);
CREATE INDEX sponsor_channels_chat ON sponsor_channels (chat_id);

-- All per-contest state. A new contest starts with zero rows here.
CREATE TABLE participants (
  id              bigserial PRIMARY KEY,
  contest_id      bigint NOT NULL REFERENCES contests,
  user_id         bigint NOT NULL REFERENCES users,
  ref_code        text   NOT NULL UNIQUE,
  referred_by     bigint REFERENCES participants,  -- set once, on insert
  verified_at     timestamptz,
  invite_count    int NOT NULL DEFAULT 0,
  qualified_at    timestamptz,
  prize_joined_at timestamptz,
  disqualified_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contest_id, user_id)
);
CREATE INDEX participants_referred_by ON participants (referred_by) WHERE referred_by IS NOT NULL;
CREATE INDEX participants_qualified ON participants (contest_id, qualified_at) WHERE qualified_at IS NOT NULL;
CREATE INDEX participants_ranking ON participants (contest_id, invite_count DESC, id);

-- Global: who is in which channel, fed by chat_member updates and getChatMember.
CREATE TABLE channel_members (
  chat_id    bigint NOT NULL,
  user_id    bigint NOT NULL,
  is_member  boolean NOT NULL,
  source     text NOT NULL CHECK (source IN ('push','api')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX channel_members_user ON channel_members (user_id);

-- Messages that must survive a restart.
CREATE TABLE outbox (
  id         bigserial PRIMARY KEY,
  dedupe_key text UNIQUE,
  chat_id    bigint NOT NULL,
  priority   smallint NOT NULL,
  payload    jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts   int NOT NULL DEFAULT 0,
  not_before timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX outbox_pending ON outbox (priority, id) WHERE status = 'pending';

CREATE TABLE join_requests (
  id           bigserial PRIMARY KEY,
  chat_id      bigint NOT NULL,
  user_id      bigint NOT NULL,
  user_chat_id bigint NOT NULL,
  requested_at timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','approved','declined','ignored','error')),
  attempts     int NOT NULL DEFAULT 0,
  detail       text,
  decided_at   timestamptz,
  UNIQUE (chat_id, user_id, requested_at)
);
CREATE INDEX join_requests_pending ON join_requests (id) WHERE status = 'pending';

CREATE TABLE admin_login_tokens (
  token_hash text PRIMARY KEY,
  tg_id      bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE TABLE admin_sessions (
  token_hash text PRIMARY KEY,
  tg_id      bigint NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  admin_tg_id bigint,
  action      text NOT NULL,
  detail      jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
