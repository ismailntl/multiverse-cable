-- Persistent chat.
--
-- Chat lived in an in-memory ring buffer, so every server restart wiped the
-- room and there was no record of what was said — no good for moderation
-- follow-up or abuse reports.

create table if not exists chat_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references app_users(id) on delete set null,
  name       text not null,
  text       text not null,
  system     boolean not null default false,
  guest      boolean not null default false,
  guest_key  text,              -- hashed browser handle, for per-guest rate limits
  ip         text,
  hidden     boolean not null default false,  -- moderator takedown, keeps the record
  created_at timestamptz not null default now()
);

create index if not exists chat_created_idx on chat_messages(created_at desc);
create index if not exists chat_visible_idx on chat_messages(created_at desc) where not hidden;

alter table chat_messages enable row level security;
