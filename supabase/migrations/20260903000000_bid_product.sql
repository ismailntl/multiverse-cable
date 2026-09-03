-- Paid ad slots can advertise a real product the bidder owns. The product's
-- name, price and photo are resolved server-side from their own page at bid
-- time, then held here so the scheduler still has them when the slot is
-- generated (which can be minutes later, or after a restart).
--
-- ad_owns_product records the ownership attestation. Lifting the originality
-- rule for a render depends on it, so it is a stored fact, not a form field.

alter table bids add column if not exists ad_product_data jsonb;
alter table bids add column if not exists ad_owns_product boolean not null default false;

create or replace function place_bid(
  p_user uuid, p_name text, p_idea text, p_kind text, p_genre text,
  p_duration integer, p_amount integer,
  p_brand text default null, p_product text default null, p_cta text default null,
  p_idem text default null,
  p_product_data jsonb default null, p_owns_product boolean default false
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
                   ad_brand, ad_product, ad_cta, idem_key,
                   ad_product_data, ad_owns_product)
       values (p_user, p_name, p_idea, p_kind, p_genre, p_duration, p_amount,
               p_brand, p_product, p_cta, p_idem,
               p_product_data, p_owns_product)
    returning * into row;
  return row;
end;
$$;
