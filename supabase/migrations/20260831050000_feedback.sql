-- Viewer feedback. Deliberately open to guests: the people most likely to tell
-- you the channel is broken are the ones who never signed up.
create table if not exists feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references app_users(id) on delete set null,
  email      text,
  message    text not null,
  kind       text not null default 'general' check (kind in ('general','bug','idea','content')),
  page       text,
  user_agent text,
  ip         text,
  handled    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists feedback_created_idx on feedback(created_at desc) where not handled;
alter table feedback enable row level security;
