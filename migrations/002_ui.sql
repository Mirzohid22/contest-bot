-- The language a user picked in the bot. NULL: follow their Telegram language.
ALTER TABLE users ADD COLUMN locale text CHECK (locale IN ('uz','ru','en'));

-- Telegram file_id of the contest banner, shown with the welcome and status messages.
ALTER TABLE contests ADD COLUMN banner_file_id text;
-- The uploaded picture itself, only for showing it in the admin panel. Kept apart from
-- contests because the bot reads that table every few seconds.
CREATE TABLE contest_banners (
  contest_id   bigint PRIMARY KEY REFERENCES contests ON DELETE CASCADE,
  content_type text  NOT NULL,
  image        bytea NOT NULL,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

-- Message overrides are now kept per language: {"uz": {...}, "ru": {...}, "en": {...}}.
-- Overrides saved before this migration were written against the English defaults.
UPDATE contests SET texts = jsonb_build_object('en', texts)
 WHERE texts <> '{}'::jsonb AND NOT (texts ?| array['uz','ru','en']);

-- Admin broadcasts, so the panel can show delivery progress and cancel one.
CREATE TABLE broadcasts (
  id           bigserial PRIMARY KEY,
  contest_id   bigint NOT NULL REFERENCES contests ON DELETE CASCADE,
  segment      text   NOT NULL,
  payload      jsonb  NOT NULL,
  total        int    NOT NULL DEFAULT 0,
  created_by   bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
CREATE INDEX broadcasts_contest ON broadcasts (contest_id, id DESC);

ALTER TABLE outbox ADD COLUMN broadcast_id bigint REFERENCES broadcasts ON DELETE SET NULL;
CREATE INDEX outbox_broadcast ON outbox (broadcast_id, status) WHERE broadcast_id IS NOT NULL;

ALTER TABLE outbox DROP CONSTRAINT outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('pending','sent','failed','cancelled'));
