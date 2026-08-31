import { config } from './config.js';
import { SAFETY_SUFFIX } from './moderation.js';

// ---------------------------------------------------------------------------
// Multiverse Cable show generator: GENRE (visual/comedy style) ×
// FORMAT (what kind of broadcast) × SUBJECT × TWIST.
// House rule baked into every layer: adult characters only, no minors, ever.
// ---------------------------------------------------------------------------

export const GENRES = [
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
  const pool = GENRES.flatMap((g) => Array(g.weight).fill(g));
  return pick(pool);
}

export function randomConcept() {
  const genre = pickGenre();
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
  const genre = pickGenre(bid.kind === 'ad' ? 'infomercial' : bid.genre);
  if (bid.kind === 'ad') {
    const brand = bid.ad?.brand || bid.name;
    return {
      title: `${brand} (AD)`.slice(0, 40),
      channel: Math.floor(Math.random() * 900) + 100,
      genre: genre.key,
      genreLabel: genre.label,
      isAd: true,
      logline:
        `A 30-second television commercial for "${brand}"` +
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
]);

function titleFrom(text) {
  const words = text.replace(/^(a|an|the) /i, '').split(/\s+/).slice(0, 5);
  while (words.length > 2 && TITLE_TAIL.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  return words
    .map((w) => (w[0] ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .slice(0, 40);
}

function genreStyle(concept) {
  return GENRES.find((g) => g.key === concept.genre)?.style ?? GENRES[1].style;
}

// Deterministic template prompt when Claude isn't configured. SAFETY_SUFFIX is
// appended by the scheduler to whatever any prompt writer produces.
export function templatePrompt(concept) {
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

export { SAFETY_SUFFIX };
