-- Clips are served from object storage so the web app can run anywhere.
-- `url` is the CDN/bucket address; `file` stays as the local cache filename
-- and the fallback path when no bucket is configured.
alter table clips add column if not exists url text;
