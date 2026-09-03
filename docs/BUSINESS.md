# From novelty to business

## The honest read

Week one: 204 users, decaying to ~20/day, zero tracked conversions. The 24/7
channel is a thing people watch once. The category is crowded (levels.io's
infinite slop, several clones, one competitor already banned from Twitch and
Kick over copyright). Novelty is not retention.

But one part of it is a product: **paste a product URL, get a broadcast-quality
pitchman ad holding that real product, in ten seconds, for about six cents.**

The business is that. The channel is its showroom.

## The single biggest gap

Today a business can pay credits to have an ad **air on our channel**. Our
channel has ~20 viewers a day. That is worth approximately nothing to them.

**The value is the file, not the slot.** A seller wants an MP4 they can put on
TikTok, Reels, and Meta ads — where their customers already are. Until the
generated ad is downloadable, there is no product, only a curiosity.

Everything below is secondary to shipping that.

## What the product becomes

| Now | Should be |
|---|---|
| Landing page is a TV player | Landing page is the generator: paste a URL, see your ad |
| You buy a slot on our channel | You buy an ad file; airing on the channel is a free bonus |
| Credits priced by slot length | Priced per generated ad, with a free first one |
| Success = viewers | Success = ads generated, downloaded, and paid for |

The channel stays. It is genuinely good marketing — a 24/7 stream of ads for
real products is proof the thing works, and it is a funnel, not the product.

## Pricing

Marginal cost is ~$0.06 per 15s ad on h3-max-turbo ($0.01/s promotional,
$0.04/s after 2026-09-07). The comparable purchase is a UGC-style ad from a
freelancer or an agency: $200-2000 and a week of turnaround.

That gap is the whole business. Suggested shape:

- **First ad free.** The demo *is* the funnel; do not gate it.
- **$9 per ad** thereafter, or **$29/month for 10**.
- One free regeneration per ad — pitchmen sometimes come out wrong, and a retry
  is far cheaper than a refund or a churned customer.

At $9 against $0.06 the margin is not the constraint. Distribution is.

## What has to be built, in order

1. **Deliver the file.** Generated ad downloadable by the buyer. Nothing else
   matters until this exists.
2. **Generator as the front door.** Paste URL → preview product → generate →
   watch → download. No account required to *see* the preview; account required
   to download.
3. **Conversion tracking.** `Key events: 0` in GA today means the funnel is
   invisible even to us. Instrument: product looked up, ad generated, ad
   downloaded, payment completed.
4. **Vertical formats.** 9:16 for TikTok/Reels is where these ads actually run.
   Currently everything is 16:9 for the TV channel — backwards for the customer.
5. **Multiple takes.** Generate three variants per product and let the buyer
   pick. At six cents each this costs nothing and dramatically raises perceived
   value.

## Who to sell to

Not "brands". Specifically:

- Shopify and Etsy sellers with a product page and no ad budget
- Dropshippers, who need creative volume and iterate constantly
- Amazon sellers wanting video for listings
- Agencies wanting to produce variants cheaply

All of them already have the one input required: a product URL.

## The moat question, answered honestly

A competent team rebuilds the generation call in a month. What is harder to copy
is the workflow around it: URL to structured product data, image-conditioned
render, moderation, the ownership attestation, and brand-safety. That is real,
but it is a head start, not a moat.

The durable version is owning a specific niche's ad workflow end to end —
knowing what converts for Shopify home goods, having the templates, being the
default. That comes from customers, not code.

## What to stop doing

- Generating filler for the main channel. It costs money and nobody watches it.
- Adding channel features (rewind, chat, auctions) until the generator sells.
- Chasing channel virality. The spike proved reach is achievable; the decay
  proved reach is not the problem.
