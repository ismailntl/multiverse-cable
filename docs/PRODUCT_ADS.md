# Product ads — turning "Upload your own clip" into a paid ad slot

## Where this came from

The upload panel currently accepts a finished video and airs it after review.
That is the least valuable thing the box can do: it asks a customer to already
own an ad. The channel's actual capability is that it can *make* the ad — a
pitchman, a price burst, a stock counter, and a product held up to the lens, in
under ten seconds for about six cents.

So the panel should accept a **product**, not just a clip.

## Two modes in one panel

**Mode A — Upload a clip** (what exists today)
Advertiser supplies finished footage. We host, review, and air it.
Cost: `UPLOAD_COST_CREDITS` (100). Max `MAX_UPLOAD_SEC` (60s) / `MAX_UPLOAD_MB` (200MB).

**Mode B — Submit a product, we make the ad** (new)
Advertiser supplies:

| Field | Why |
|---|---|
| Product photo(s) | Becomes the **first frame** for image-to-video, so the pitchman holds the *real* product |
| Product name | Spoken and shown on screen |
| Price | Drives the on-screen price burst |
| One-line pitch | What the pitchman claims |
| Ownership attestation | See the trademark carve-out below |

We generate a Live Shopping segment on `h3-max-turbo/image-to-video`, queue it
for human review, and air it on approval. The advertiser gets the clip back.

Mode B should cost more than Mode A — it consumes generation, not just storage
— but the marginal cost is small (~$0.06–0.15 per render at Turbo pricing), so
the price is set by what the slot is worth, not by COGS. Allow one free
regeneration; pitchmen sometimes come out wrong and a single retry is cheaper
than a refund.

## The trademark carve-out (important)

Every other path through this system forbids real brands, logos and products —
that is what `copyright.js` and `SAFETY_SUFFIX` enforce, and it is deliberate.

Mode B is the **one** legitimate exception: an advertiser may show their own
brand, because they own it and are asking us to. That exception cannot be
inferred from the upload alone, so it has to be asserted:

- An explicit checkbox: *"I own or am authorised to advertise this product and
  its branding."* Recorded with the submission, not just shown.
- The generated prompt carries the brand only for submissions carrying that
  attestation, and never picks up a brand from a free-text field on any other
  path.
- Human review still applies. The attestation shifts liability; it does not
  replace looking at it.
- Trademarked-character detection (`trademarkedCharacterHit`) still runs. Owning
  a brand does not license someone else's cartoon mouse alongside it.

## Storage: Supabase instead of / alongside S3

S3 uploads began failing on the production host on 2026-09-03 — four clips
landed with `url = null`, are absent from the bucket, and 404 for viewers. The
IAM credentials themselves verify fine from elsewhere, so the fault is specific
to that host. A single storage backend with no fallback turns one host-level
problem into dead slots on air.

Supabase Storage is already provisioned (same project as the database) and is a
natural second target:

- `lib/storage.js` already isolates this behind `uploadClip` / `publicUrl` /
  `deleteClip`, so a second backend slots in without touching call sites.
- Order of preference: S3/CloudFront first (cheapest egress, 1TB free tier),
  Supabase on failure, local disk last.
- A clip that fails **both** should be recorded `hidden` rather than with a null
  URL, so a broken upload never reaches air.
- Backfill: `scripts/backfill-s3.js` should learn to push existing null-URL
  clips to whichever backend is reachable.

**Blocked on:** a Supabase service-role key. The env carries only
`SUPABASE_URL`, `SUPABASE_PROJECT_REF` and `SUPABASE_DB_PASSWORD`; Storage needs
the service-role key from the project's API settings. Nothing else here is
blocked.

Costs to weigh before committing: Supabase Storage egress is billed and has no
free-tier equivalent to CloudFront's 1TB, so it belongs as a **fallback**, not
as the primary. Using it for everything would raise the bill it was meant to
avoid.
