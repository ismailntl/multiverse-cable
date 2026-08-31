-- Bidding hardening for production.

-- A crash between claiming a bid and finishing generation used to leave the bid
-- stuck in 'generating' forever: it never airs, never refunds, and the credits
-- stay taken. Track when the claim happened so a sweeper can reclaim it.
alter table bids add column if not exists claimed_at timestamptz;

-- Double-submit protection. A double-clicked bid button previously created two
-- bids and debited twice; the client sends a key and the DB enforces one bid
-- per key per user.
alter table bids add column if not exists idem_key text;
create unique index if not exists bids_idem_idx on bids(user_id, idem_key)
  where idem_key is not null;

-- Claim atomically AND stamp the time, so the sweeper can find stale claims.
create or replace function claim_bid(p_bid uuid)
returns bids
language plpgsql
as $$
declare
  row bids;
begin
  update bids set status = 'generating', claimed_at = now()
   where id = p_bid and status = 'pending'
   returning * into row;
  return row;
end;
$$;

-- Return bids whose generation stalled to the queue without consuming a retry.
create or replace function reclaim_stale_bids(p_older_than_minutes integer default 30)
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  update bids set status = 'pending', claimed_at = null
   where status = 'generating'
     and claimed_at is not null
     and claimed_at < now() - (p_older_than_minutes || ' minutes')::interval;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- place_bid gains the idempotency key.
create or replace function place_bid(
  p_user uuid, p_name text, p_idea text, p_kind text, p_genre text,
  p_duration integer, p_amount integer,
  p_brand text default null, p_product text default null, p_cta text default null,
  p_idem text default null
) returns bids
language plpgsql
as $$
declare
  row bids;
begin
  -- Same key from the same user: return the original bid, do not charge again
  if p_idem is not null then
    select * into row from bids where user_id = p_user and idem_key = p_idem;
    if found then return row; end if;
  end if;

  perform adjust_credits(p_user, -p_amount, 'bid_' || p_kind, null);
  insert into bids(user_id, name, idea, kind, genre, duration_sec, amount,
                   ad_brand, ad_product, ad_cta, idem_key)
       values (p_user, p_name, p_idea, p_kind, p_genre, p_duration, p_amount,
               p_brand, p_product, p_cta, p_idem)
    returning * into row;
  return row;
end;
$$;
