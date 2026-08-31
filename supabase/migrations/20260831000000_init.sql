-- Multiverse Cable schema.
--
-- The JSON-file store worked for prototyping but has no transactions: two
-- processes clobbered each other's writes, and a credit ledger cannot be
-- "mostly right". Everything money touches runs inside a single SQL function
-- so a bid can never debit credits without also creating the bid.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- users ----
create table if not exists app_users (
  id             uuid primary key default gen_random_uuid(),
  email          text unique not null,
  pass_hash      text not null,
  salt           text not null,
  credits        integer not null default 0 check (credits >= 0),
  -- 18+ / policy attestation, captured at signup and kept for audit
  age_attested_at timestamptz,
  terms_version  text,
  signup_ip      text,
  is_admin       boolean not null default false,
  created_at     timestamptz not null default now()
);

create table if not exists sessions (
  token      text primary key,
  user_id    uuid not null references app_users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions(user_id);

-- --------------------------------------------------------------- ledger ----
-- Append-only. A user's credits column is only ever changed by adjust_credits()
-- below, which writes the matching ledger row in the same transaction.
create table if not exists ledger (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references app_users(id) on delete cascade,
  delta      integer not null,
  reason     text not null,
  ref        text,
  created_at timestamptz not null default now()
);
create index if not exists ledger_user_idx on ledger(user_id, created_at desc);
-- Stripe retries webhooks; this makes double-crediting a session impossible.
create unique index if not exists ledger_purchase_ref_idx
  on ledger(ref) where reason = 'purchase';

-- ---------------------------------------------------------------- clips ----
create table if not exists clips (
  id          uuid primary key default gen_random_uuid(),
  file        text not null,
  title       text not null,
  channel     integer not null,
  duration    double precision not null check (duration > 0),
  genre       text,
  source      text not null check (source in ('auto','bid','ad','archive','upload')),
  is_ad       boolean not null default false,
  prompt      text,
  archive_id  text,
  bidder      text,
  amount      integer,
  mock        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists clips_created_idx on clips(created_at);
-- Never splice the same archival reel twice
create unique index if not exists clips_archive_idx on clips(archive_id) where archive_id is not null;

-- ----------------------------------------------------------------- bids ----
create table if not exists bids (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references app_users(id) on delete set null,
  name         text not null,
  idea         text not null,
  kind         text not null default 'show' check (kind in ('show','ad')),
  genre        text,
  duration_sec integer not null default 6,
  amount       integer not null check (amount > 0),
  status       text not null default 'pending'
               check (status in ('pending','generating','aired','failed','rejected')),
  ad_brand     text,
  ad_product   text,
  ad_cta       text,
  attempts     integer not null default 0,
  refunded     boolean not null default false,
  clip_id      uuid references clips(id) on delete set null,
  created_at   timestamptz not null default now()
);
-- The auction picks the winner with this ordering
create index if not exists bids_pending_idx on bids(amount desc, created_at) where status = 'pending';

-- -------------------------------------------------------------- uploads ----
-- Uploaded video can't be machine-screened the way a prompt can, so it always
-- waits for a human. Nothing here airs until status = 'approved'.
create table if not exists uploads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_users(id) on delete cascade,
  email       text not null,
  file        text not null,
  title       text not null,
  duration    double precision not null,
  amount      integer not null,
  status      text not null default 'pending_review'
              check (status in ('pending_review','approved','rejected')),
  ip          text,
  review_note text,
  reviewed_at timestamptz,
  clip_id     uuid references clips(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists uploads_pending_idx on uploads(created_at) where status = 'pending_review';

-- ----------------------------------------------------------------- dmca ----
create table if not exists dmca_reports (
  id         uuid primary key default gen_random_uuid(),
  clip_id    uuid,
  reporter   text,
  email      text not null,
  claim      text not null,
  ip         text,
  status     text not null default 'received',
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------ moderation ----
-- Audit trail of everything the content filters rejected. Needed to show a
-- pattern of enforcement if anyone ever asks.
create table if not exists moderation_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references app_users(id) on delete set null,
  surface    text not null,           -- 'bid' | 'chat' | 'upload'
  text       text not null,
  reason     text not null,
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists moderation_created_idx on moderation_log(created_at desc);

-- ------------------------------------------------------------- functions ----
-- Single entry point for credit movement: balance and ledger always agree, and
-- the CHECK (credits >= 0) makes overdraft impossible even under concurrency.
create or replace function adjust_credits(
  p_user uuid, p_delta integer, p_reason text, p_ref text default null
) returns integer
language plpgsql
as $$
declare
  new_balance integer;
begin
  update app_users set credits = credits + p_delta
   where id = p_user
   returning credits into new_balance;

  if not found then
    raise exception 'no such user %', p_user;
  end if;

  insert into ledger(user_id, delta, reason, ref) values (p_user, p_delta, p_reason, p_ref);
  return new_balance;
end;
$$;

-- Place a bid: debit and insert atomically, so credits can never be taken
-- without a bid existing (or vice versa).
create or replace function place_bid(
  p_user uuid, p_name text, p_idea text, p_kind text, p_genre text,
  p_duration integer, p_amount integer,
  p_brand text default null, p_product text default null, p_cta text default null
) returns bids
language plpgsql
as $$
declare
  row bids;
begin
  perform adjust_credits(p_user, -p_amount, 'bid_' || p_kind, null);
  insert into bids(user_id, name, idea, kind, genre, duration_sec, amount,
                   ad_brand, ad_product, ad_cta)
       values (p_user, p_name, p_idea, p_kind, p_genre, p_duration, p_amount,
               p_brand, p_product, p_cta)
    returning * into row;
  return row;
end;
$$;

-- Refund a bid exactly once, however many times a retry path calls it.
create or replace function refund_bid(p_bid uuid, p_status text)
returns void
language plpgsql
as $$
declare
  b bids;
begin
  select * into b from bids where id = p_bid for update;
  if not found then return; end if;

  update bids set status = p_status where id = p_bid;

  if not b.refunded and b.user_id is not null then
    update bids set refunded = true where id = p_bid;
    perform adjust_credits(b.user_id, b.amount, 'refund_' || p_status, p_bid::text);
  end if;
end;
$$;

-- RLS: the app connects with the service role and enforces its own auth, so
-- lock the tables down to deny anon/authenticated access by default.
alter table app_users     enable row level security;
alter table sessions      enable row level security;
alter table ledger        enable row level security;
alter table bids          enable row level security;
alter table uploads       enable row level security;
alter table dmca_reports  enable row level security;
alter table moderation_log enable row level security;
-- clips are public read-only (the broadcast itself)
alter table clips enable row level security;
create policy clips_public_read on clips for select using (true);
