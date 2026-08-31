# Multiverse Cable — Content, Age & Copyright Policy

*Version 2026-08-31. Not legal advice — have a lawyer review before public launch.*

## 1. Mature content / age restriction

This service broadcasts **AI-generated video 24/7 with no human reviewing each
clip before it airs**. Output is unpredictable and may be surreal, disturbing,
or otherwise unsuitable for minors.

- **Viewers must be 18+.** An age gate is shown before playback and the
  confirmation is stored in the browser.
- **Account holders must attest to being 18+** at signup. The attestation
  timestamp, the accepted policy version, and the signup IP are recorded on the
  user record (`ageAttestedAt`, `termsVersion`, `signupIp`).
- The player is labeled AI-generated, 18+, and no-human-pre-review at all times.

## 2. Prohibited content — minors

**Nothing involving minors may ever be generated.** This is enforced in five
independent layers:

1. Keyword + word-root blocklist at bid intake (`lib/moderation.js`) covering
   plurals, irregular plurals, compounds, and numeric age references under 18.
2. An optional Claude moderation gate (when `ANTHROPIC_API_KEY` is set) that
   catches phrasings the list cannot enumerate. Anything other than an explicit
   ALLOW blocks.
3. Re-moderation immediately before generation, so a bid can't slip through if
   it was queued before a rule changed.
4. A safety instruction appended to **every** prompt sent to **every** backend:
   all characters are adults 30+, no minors in any form.
5. Minors-related terms in the GPU worker's negative prompt.

Prohibited alongside this: sexual content, graphic violence/gore, self-harm,
and hate content.

## 3. Copyright, trademarks, and likeness

We cannot make infringement impossible, but the system is designed to make it
unlikely:

- **Prompt screening** (`lib/copyright.js`) blocks named franchises, characters,
  studios, trademarked brands, high-profile real people, and "in the style of
  <artist>" constructions.
- **Originality instruction** appended to every prompt: all characters, logos,
  products, and settings must be wholly original; no real person, existing
  character, trademark, or copyrighted work may be depicted or imitated.
- **Genre styles describe techniques, never named shows.** The house style is
  described as "late-night adult-animation absurdism / stop-motion / VHS grain",
  never by reference to an existing series. Keep it that way.
- **Advertisements** must be for fictional brands. Ad copy fields (brand,
  product, call to action) run through the same screening as show ideas.
- **Found footage** is sourced only from public-domain-oriented Internet Archive
  collections (Prelinger, classic cartoons), with titles screened by the same
  filters. Provenance (`archive.org/<identifier>`) is retained.
- **Provenance retained**: every clip stores the exact prompt, its source, and
  the bidder, so any complaint is actionable.

### Takedown / DMCA

Any viewer can report the clip currently on air (⚑ report button) or via
`POST /api/dmca` with a clip id, contact email, and description of the claim.

**Reported clips are pulled off air immediately, before review** — removal is
automatic and does not wait on a human. The report is retained with reporter
contact details and IP for follow-up.

Before public launch you must additionally: designate a DMCA agent and register
with the U.S. Copyright Office, publish that agent's contact details here, and
add a counter-notice process and repeat-infringer policy.

## 4. Credits and payments

Credits are a prepaid programming currency, purchased via Stripe Checkout.
Credits are **held when a bid is placed** and **automatically refunded** if the
slot fails to generate or is rejected by moderation. Credits have no cash value
and are not redeemable.

## 5. What still needs doing before public launch

- Legal review of this policy, terms of service, and privacy policy
- Registered DMCA agent + counter-notice + repeat-infringer policy
- Rate limiting / captcha on signup and bidding
- Password reset + email verification
- Persistent moderation audit log of every blocked submission
- Human spot-review queue for aired content
