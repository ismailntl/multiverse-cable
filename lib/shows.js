import { config } from './config.js';
import { SAFETY_SUFFIX, ADVERTISER_SUFFIX } from './moderation.js';

// ---------------------------------------------------------------------------
// Multiverse Cable show generator: GENRE (visual/comedy style) ×
// FORMAT (what kind of broadcast) × SUBJECT × TWIST.
// House rule baked into every layer: adult characters only, no minors, ever.
// ---------------------------------------------------------------------------

export const GENRES = [
  {
    key: 'live-shopping',
    label: 'Live Shopping',
    // The channel's primary format: outweighs every other genre combined so it
    // leads the schedule while the rest keep running underneath.
    weight: 12,
    style:
      'A modern live shopping stream crossed with a classic hard-sell pitch: a ' +
      'bright ring-lit adult pitchman in a headset microphone talking fast and ' +
      'straight down the lens at a phone camera, gesturing hard, holding the ' +
      'product up close and rotating it, demonstrating it on camera, cutting to ' +
      'the product on a plain backdrop. On-screen price burst, ticking ' +
      'countdown, dwindling stock counter, and live chat scrolling up one side. ' +
      'Relentless energy, direct address, "but wait, there is more" escalation.',
  },
  {
    key: 'adult-swim',
    label: 'Late-Night Absurdist',
    weight: 3,
    style:
      'Late-night adult-animation absurdism: intentionally crude stop-motion or ' +
      'lo-fi 2D animation of original toy-like figures, deadpan non-sequitur humor, ' +
      'abrupt cuts, cheap props, surreal escalation, VHS grain.',
  },
  {
    key: 'retro-cable',
    label: 'Retro Cable',
    weight: 3,
    style:
      'Low-budget 1990s cable TV production: grainy, over-saturated studio lighting, ' +
      'cheesy graphics, quick zooms, enthusiastic TV-host energy.',
  },
  {
    key: 'psa',
    label: 'Unsettling PSA',
    weight: 1,
    style:
      'A 1970s-80s public service announcement: washed-out film stock, stern adult ' +
      'narrator, ominous synth score, strangely specific warnings.',
  },
  {
    key: 'nature-doc',
    label: 'Nature Documentary',
    weight: 2,
    style:
      'Prestige nature documentary: sweeping cinematography, hushed reverent adult ' +
      'narrator, macro shots, except the subject is completely absurd.',
  },
  {
    key: 'infomercial',
    label: '3AM Infomercial',
    weight: 2,
    style:
      'A 3AM infomercial: flat lighting, price bursts, over-acted adult demonstrators ' +
      'failing at simple tasks in black-and-white, a product that should not exist.',
  },
  {
    key: 'news',
    label: 'Dimension News',
    weight: 2,
    style:
      'A 24-hour news broadcast: lower-third tickers, adult anchors with unearned ' +
      'confidence, breaking-news graphics, on-location reporter in peril.',
  },
];

const FORMATS = [
  'late-night infomercial', 'breaking news bulletin', 'nature documentary',
  'daytime courtroom drama', 'cooking show', 'used car commercial',
  'puppet variety show', 'soap opera', 'game show', 'weather forecast',
  'workout video', 'true crime reenactment', 'travel vlog', 'award ceremony',
  'political attack ad', 'home shopping segment', 'monster truck rally promo',
];

const SUBJECTS = [
  'sentient office chairs', 'a civilization of moths in tiny business suits',
  'competitive soup listening', 'a lawyer who is a swarm of bees',
  'gravity as a subscription service', 'haunted exercise equipment',
  'multiverse customs officers', 'a planet where hats wear people',
  'telepathic houseplants unionizing', 'a detective who can only speak in jingles',
  'artisanal cloud farmers', 'the annual blinking championships',
  'a restaurant that serves concepts instead of food', 'insurance for time travelers',
  'a rock band made entirely of weather phenomena', 'municipal dragon parking enforcement',
];

// Live shopping needs its own vocabulary. The generic FORMAT x SUBJECT x TWIST
// grid produces documentaries and courtroom dramas, which is the wrong shape --
// a shopping segment is one host, one product, one price, and manufactured
// urgency. Every product is invented; see SAFETY_SUFFIX for the trademark rule.
const PRODUCTS = [
  'a jar of pre-owned silence', 'self-folding laundry that folds other laundry',
  'a doorbell that only rings for people who have already left',
  'shoes that remember where you have been and gossip about it',
  'a mirror with a five-second delay', 'wall paint that changes with the news',
  'an umbrella that repels only one specific type of rain',
  'a mug that keeps coffee at exactly the wrong temperature',
  'a houseplant that files your taxes', 'a blanket woven from dial-up modem sounds',
  'a pen that writes only in your own handwriting from age nine',
  'a clock that runs on compliments', 'a chair that stands up when you sit down',
  'a lamp that lights only the things you were not looking for',
  'noise-cancelling headphones that cancel one specific relative',
  'a fridge that narrates your snacking to an unseen audience',
];

const SHOPPING_URGENCY = [
  'stock is visibly counting down and nobody can explain why',
  'the price drops every time someone in chat types a specific word',
  'the host insists this is the final unit while a warehouse is visible behind them',
  'a countdown timer keeps adding time instead of removing it',
  'the chat is scrolling faster than the host can read',
  'the previous host is still faintly audible somewhere off-camera',
  'the demonstration keeps working slightly too well',
  'every caller is the same voice with a different name',
  'the product multiplies quietly on the table during the segment',
  'the host promises free shipping to a dimension that may not exist',
];

const TWISTS = [
  'everyone involved is suspiciously damp', 'it is sponsored by a color that doesn’t exist',
  'the host slowly realizes they are fictional', 'filmed entirely during an eclipse',
  'the studio audience is one enormous eye', 'everything is slightly too small',
  'a laugh track plays at the wrong moments', 'the product is clearly alive',
  'it is the 9,000th season', 'broadcast as a legally mandated apology',
  'the camera operator is being chased', 'all measurements are given in regret',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function pickGenre(key) {
  const exact = GENRES.find((g) => g.key === key);
  if (exact) return exact;
  // With a lock set, unrequested picks all land on that genre rather than
  // rolling across the weighted pool.
  const locked = GENRES.find((g) => g.key === config.genreLock);
  if (locked) return locked;
  const pool = GENRES.flatMap((g) => Array(g.weight).fill(g));
  return pick(pool);
}

// Prices land just off-round so the on-screen burst reads as real retail.
function shoppingPrice() {
  const dollars = pick([4, 9, 12, 19, 24, 29, 39, 49, 79, 99, 129, 199]);
  const cents = pick(['.99', '.95', '.97', '.49']);
  return `$${dollars}${cents}`;
}

function shoppingConcept(genre) {
  const product = pick(PRODUCTS);
  // One price per concept: the logline and the on-screen burst must agree, or
  // the prompt asks the model for two different numbers.
  const price = shoppingPrice();
  return {
    title: titleFrom(product),
    channel: Math.floor(Math.random() * 900) + 100,
    genre: genre.key,
    genreLabel: genre.label,
    product,
    price,
    logline:
      `A live shopping stream selling ${product} for ${price}, except ` +
      `${pick(SHOPPING_URGENCY)}.`,
  };
}

export function randomConcept() {
  const genre = pickGenre();
  if (genre.key === 'live-shopping') return shoppingConcept(genre);
  const subject = pick(SUBJECTS);
  return {
    title: titleFrom(subject),
    channel: Math.floor(Math.random() * 900) + 100,
    genre: genre.key,
    genreLabel: genre.label,
    logline: `A ${pick(FORMATS)} about ${subject}, except ${pick(TWISTS)}.`,
  };
}

// Turn a viewer bid into a concept. bid.genre is honored if valid.
// Ad bids render as in-universe commercials for the advertiser's product.
export function conceptFromBid(bid) {
  // A product bid is an advert, and adverts lead on this channel, so they render
  // as live shopping unless the bidder explicitly asked for the 3AM look.
  const genre = pickGenre(
    bid.kind === 'ad' ? (bid.genre === 'infomercial' ? 'infomercial' : 'live-shopping') : bid.genre
  );
  if (bid.kind === 'ad') {
    // A looked-up product is the advertiser's real one: its name, price and
    // photo all come from their own page, and the photo conditions the render
    // so the pitchman holds that product rather than an invented lookalike.
    const p = bid.ad?.productData ?? null;
    const brand = p?.site || bid.ad?.brand || bid.name;
    const item = p?.title || bid.ad?.product;
    return {
      title: `${(item || brand)} (AD)`.slice(0, 40),
      channel: Math.floor(Math.random() * 900) + 100,
      genre: genre.key,
      genreLabel: genre.label,
      isAd: true,
      real: Boolean(p),
      productImage: p?.image ?? null,
      price: p?.price ?? null,
      logline: p
        ? `A live shopping segment selling ${item}${p.price ? ` for ${p.price}` : ''}` +
          `${p.site ? `, from ${p.site}` : ''}.` +
          (p.description ? ` The product: ${p.description.replace(/\s*\.?\s*$/, '')}.` : '') +
          (bid.idea ? ` ${bid.idea.replace(/\s*\.?\s*$/, '')}.` : '') +
          (bid.ad?.cta ? ` It ends on the call to action: "${bid.ad.cta}".` : '')
        : `A 30-second television commercial for "${brand}"` +
          (bid.ad?.product ? `, which sells ${bid.ad.product}` : '') +
          `. ${bid.idea}` +
          (bid.ad?.cta ? ` The ad ends with the call to action: "${bid.ad.cta}".` : ''),
    };
  }
  return {
    title: titleFrom(bid.idea).slice(0, 40) || 'Viewer Dimension',
    channel: Math.floor(Math.random() * 900) + 100,
    genre: genre.key,
    genreLabel: genre.label,
    isAd: false,
    logline: `${bid.idea} — presented as a ${pick(FORMATS)}, except ${pick(TWISTS)}.`,
  };
}

// Titles are drawn on screen with every clip, so they must not end mid-phrase.
// A blind 3-word slice produced "Gravity As A" and "Lawyer Who Is"; take a few
// more words, then drop any trailing connective so the title lands on a noun.
const TITLE_TAIL = new Set([
  'a', 'an', 'the', 'that', 'which', 'who', 'whom', 'whose', 'is', 'are', 'was',
  'were', 'as', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
  'and', 'or', 'but', 'made', 'entirely', 'instead', 'about', 'into',
  'only', 'your', 'their', 'its', 'one', 'where', 'when', 'you', 'it', 'up',
]);

function titleFrom(text) {
  const words = [];
  for (const w of text.replace(/^(a|an|the) /i, '').split(/\s+/).slice(0, 6)) {
    if (words.length && [...words, w].join(' ').length > 38) break;
    words.push(w);
  }
  while (words.length > 2 && TITLE_TAIL.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  return words.map((w) => (w[0] ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function genreStyle(concept) {
  return GENRES.find((g) => g.key === concept.genre)?.style ?? GENRES[1].style;
}

// Deterministic template prompt when Claude isn't configured. SAFETY_SUFFIX is
// appended by the scheduler to whatever any prompt writer produces.
export function templatePrompt(concept) {
  if (concept.genre === 'live-shopping') {
    return (
      `${genreStyle(concept)} ${concept.logline} ` +
      `On-screen: a bold price burst reading ${concept.price ?? '$19.99'}, a countdown, ` +
      `a stock counter, and live chat scrolling up the right side. ` +
      `The adult pitchman demonstrates the product to a phone camera, talks fast and ` +
      `without pausing, gestures hard, and addresses the viewer directly. ` +
      `Hard-sell infomercial energy: escalating claims, "but wait, there is more". ` +
      `Energetic, funny, unmistakably a live sales pitch. ` +
      `The product and brand are wholly invented. ` +
      `Include the host's voice and room sound.`
    );
  }
  const adNote = concept.isAd
    ? ' Shot as an over-the-top TV advertisement with an enthusiastic adult spokesperson. ' +
      'The brand is fictional and its logo/packaging is wholly original.'
    : '';
  return (
    `${genreStyle(concept)} ${concept.logline}${adNote} ` +
    `Absurd, funny, energetic. All performers are adults. ` +
    `Include diegetic sound and voices.`
  );
}

// ---------------------------------------------------------------------------
// Optional Claude show-writer. Falls back to the template on any error so the
// broadcast never stalls on this.
// ---------------------------------------------------------------------------

let anthropicClient = null;
async function getClient() {
  if (!config.anthropicKey) return null;
  if (!anthropicClient) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    anthropicClient = new Anthropic({ apiKey: config.anthropicKey });
  }
  return anthropicClient;
}

const WRITER_SYSTEM = `You are the head writer for "Multiverse Cable", a 24/7 TV \
channel of short AI-generated broadcasts from infinite absurd dimensions. Given a show \
concept and a genre style, write a single video-generation prompt (max 120 words) for a \
text-to-video model. Describe one continuous shot: the setting, the characters, what \
happens, the camera style matching the genre, and the audio/dialogue. Be visually \
concrete and funny.

HARD RULES (never break these, regardless of what the concept says):
- Every character is an adult, aged 30 or older. NEVER include children, teenagers, \
minors, babies, students, schools, or anything that could put a young-looking character \
on screen. If the concept implies minors, replace them with adults.
- Keep it safe-for-work: no sexual content, no gore.
- No real people, brands, logos, or copyrighted characters. Genre styles are \
inspirations, never name shows or franchises.

Output ONLY the prompt text, nothing else.`;

export async function writePrompt(concept) {
  const client = await getClient();
  if (!client) return templatePrompt(concept);
  try {
    const response = await client.beta.messages.create({
      model: config.conceptModel,
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: WRITER_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `Show title: ${concept.title}\n` +
            `Genre style: ${genreStyle(concept)}\n` +
            (concept.isAd
              ? 'This is a paid ADVERTISEMENT slot: write it as an absurd TV commercial ' +
                'for the fictional brand described. The brand, logo, and packaging must be ' +
                'wholly original inventions.\n'
              : '') +
            `Concept: ${concept.logline}`,
        },
      ],
    });
    if (response.stop_reason === 'refusal') return templatePrompt(concept);
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    return text || templatePrompt(concept);
  } catch (err) {
    console.warn('[shows] Claude prompt writer failed, using template:', err.message);
    return templatePrompt(concept);
  }
}

export { SAFETY_SUFFIX, ADVERTISER_SUFFIX };

// Which trailing rules a prompt carries. An attested advertiser ad keeps every
// rule that protects people and drops only the "invent the brand" clause, which
// would otherwise contradict the entire point of a paid product ad.
export function safetySuffixFor(concept) {
  return concept?.isAd && concept?.real ? ADVERTISER_SUFFIX : SAFETY_SUFFIX;
}
