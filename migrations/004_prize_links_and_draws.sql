-- Each qualified participant gets their own join-request link to the prize chat. The bot
-- approves only the person it was made for, then revokes it, so it works once.
ALTER TABLE participants ADD COLUMN prize_invite_link text;
ALTER TABLE participants ADD COLUMN prize_link_used_at timestamptz;
CREATE UNIQUE INDEX participants_prize_link ON participants (prize_invite_link) WHERE prize_invite_link IS NOT NULL;

-- The link a join request came through, so the worker can tell personal links apart.
ALTER TABLE join_requests ADD COLUMN invite_link text;

-- Winner draws. Each invite is one ticket. The seed is kept so anyone can recompute the
-- result: a participant's random number is HMAC-SHA256(seed, participant id).
CREATE TABLE draws (
  id                bigserial PRIMARY KEY,
  contest_id        bigint NOT NULL REFERENCES contests ON DELETE CASCADE,
  eligibility       text   NOT NULL CHECK (eligibility IN ('qualified','invited')),
  winners_requested int    NOT NULL,
  seed              text   NOT NULL,
  candidates        int    NOT NULL,
  tickets           int    NOT NULL,
  created_by        bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  notified_at       timestamptz
);
CREATE INDEX draws_contest ON draws (contest_id, id DESC);

CREATE TABLE draw_winners (
  draw_id        bigint NOT NULL REFERENCES draws ON DELETE CASCADE,
  participant_id bigint NOT NULL REFERENCES participants,
  place          int    NOT NULL,
  tickets        int    NOT NULL,
  PRIMARY KEY (draw_id, participant_id)
);
