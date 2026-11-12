-- Groups and channels the bot was added to, from my_chat_member updates. The admin panel
-- offers them as a list, because a private chat has no @username and Telegram does not
-- let bots look a chat up by its invite link.
CREATE TABLE bot_chats (
  chat_id    bigint PRIMARY KEY,
  title      text    NOT NULL,
  type       text    NOT NULL,
  username   text,
  status     text    NOT NULL,
  can_invite boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
