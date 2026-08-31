-- Takedown must not be destructive.
--
-- /api/dmca used to DELETE the clip row, the S3 object and the local file, with
-- no authentication — so anyone could enumerate clip ids from the public API and
-- erase the whole channel, including slots people had paid for, unrecoverably.
-- Reports now hide the clip; only an admin can delete.
alter table clips add column if not exists hidden boolean not null default false;
alter table clips add column if not exists hidden_reason text;
create index if not exists clips_visible_idx on clips(created_at) where not hidden;
