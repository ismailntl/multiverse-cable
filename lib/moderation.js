import { config } from './config.js';
import { copyrightCheck, ORIGINALITY_SUFFIX } from './copyright.js';

// ---------------------------------------------------------------------------
// Content guardrails. Non-negotiable house rule: NOTHING involving minors can
// ever be generated. Defense in depth:
//   1. hard keyword block at bid intake (works with zero API keys)
//   2. optional Claude moderation gate (when ANTHROPIC_API_KEY is set)
//   3. re-moderation right before generation (bids are re-checked)
//   4. SAFETY_SUFFIX appended to EVERY prompt sent to ANY backend
//   5. minors-related terms in the GPU worker's negative prompt (worker.py)
// The keyword list is deliberately over-broad — false positives are fine,
// false negatives are not.
// ---------------------------------------------------------------------------

// The rules that hold no matter who is paying or what they attest to.
const ABSOLUTE_SUFFIX =
  ' IMPORTANT: every character shown or mentioned is an adult aged 30 or older. ' +
  'Absolutely no children, teenagers, minors, babies, students, or school-age ' +
  'characters anywhere in the video, in any form. No sexual content. No real people.';

export const SAFETY_SUFFIX = ABSOLUTE_SUFFIX + ORIGINALITY_SUFFIX;

// A paid advertiser showing their OWN product is the single case where the
// originality rule cannot apply -- the whole point is their real product and
// branding. Everything protecting people is unchanged; only the "invent the
// brand" clause is lifted, and only for a submission carrying an ownership
// attestation that a human then reviews. Someone else's characters are still
// out, which is why trademarked-character detection still runs on these.
export const ADVERTISER_SUFFIX =
  ABSOLUTE_SUFFIX +
  ' This is a paid advertisement that the advertiser has confirmed they own or ' +
  'are authorised to run. Show their product and branding as supplied. Do not ' +
  'introduce any OTHER real brand, logo, franchise, or existing fictional ' +
  'character alongside it.';

const MINORS = [
  'child', 'children', 'kid', 'kids', 'kiddo', 'toddler', 'baby', 'babies',
  'infant', 'newborn', 'minor', 'minors', 'underage', 'under-age', 'preteen',
  'pre-teen', 'tween', 'teen', 'teens', 'teenager', 'teenagers', 'adolescent',
  'juvenile', 'youngster', 'youth', 'boy', 'boys', 'girl', 'girls',
  'schoolboy', 'schoolgirl', 'schoolchild', 'daycare', 'kindergarten',
  'kindergartner', 'preschool', 'preschooler', 'elementary school',
  'middle school', 'high school', 'playground', 'loli', 'shota', 'son',
  'daughter', 'niece', 'nephew', 'grandchild', 'grandson', 'granddaughter',
];

// Plain profanity / slurs. Chat is public and unauthenticated, so this is a
// separate list from the sexual-content terms below: "sex" on its own was not
// caught by "sexual"/"sexy", and neither was ordinary swearing.
const PROFANITY = [
  'shit', 'shite', 'bullshit', 'fuck', 'fucking', 'fucker', 'motherfucker',
  'cunt', 'bitch', 'bastard', 'asshole', 'arsehole', 'dick', 'cock', 'prick',
  'pussy', 'twat', 'wanker', 'slut', 'whore', 'faggot', 'fag', 'nigger',
  'nigga', 'retard', 'retarded', 'spic', 'chink', 'kike', 'tranny',
  'sex', 'boobs', 'tits', 'titties', 'penis', 'vagina', 'anal', 'blowjob',
  'handjob', 'cum', 'jizz', 'orgasm', 'masturbate', 'dildo',
];

const OTHER_BLOCKED = [
  // sexual content of any kind (it's a public TV channel)
  'nude', 'naked', 'nsfw', 'porn', 'sexual', 'sexy', 'erotic', 'hentai',
  'fetish', 'onlyfans', 'strip club', 'stripper',
  // extreme violence / gore
  'gore', 'beheading', 'dismember', 'torture', 'rape', 'suicide', 'self-harm',
  // hate / slur-adjacent catchalls handled by phrasing check
  'nazi', 'kkk', 'lynch',
];

// Substring roots — catch irregular plurals, compounds, and coinages the word
// list can't enumerate ("grandchildren", "kiddies", "schoolchildren",
// "childlike", "teenaged"). Deliberately aggressive: on this rule we accept
// false positives to guarantee no false negatives.
const MINOR_ROOTS = [
  'child', 'kiddi', 'kiddo', 'kiddy', 'toddler', 'infant', 'newborn',
  'teenag', 'preteen', 'pre-teen', 'underage', 'under-age', 'minorage',
  'schoolboy', 'schoolgirl', 'schoolkid', 'preschool', 'kindergar',
  'daycare', 'nursery school', 'juvenile', 'adolescen', 'youngster',
  'loli', 'shota', 'grandkid', 'stepson', 'stepdaughter',
];

const AGE_PATTERN = /\b(1?[0-9]|1[0-7])[\s-]*(y\/?o|yo|yr|yrs|year[\s-]*olds?)\b/i;

function findRoot(text) {
  const flat = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  return MINOR_ROOTS.find((r) => flat.includes(r)) ?? null;
}

// Crude singularizer so "toddlers"/"babies"/"kiddies" match "toddler"/"baby".
function singular(word) {
  if (word.length > 3 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 3 && (word.endsWith('ses') || word.endsWith('xes') || word.endsWith('ches') || word.endsWith('shes')))
    return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .flatMap((w) => [w, singular(w)]);
}

function findTerm(text, terms) {
  const words = new Set(normalize(text));
  const phrase = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  for (const term of terms) {
    const clean = term.replace(/[^a-z0-9]+/g, ' ').trim();
    if (clean.includes(' ')) {
      if (phrase.includes(` ${clean} `)) return term; // multi-word term
    } else if (words.has(clean) || words.has(singular(clean))) {
      return term;
    }
  }

  // Spaced-out evasion ("f u c k", "s-h-i-t"). Only compact when the text
  // actually looks like separated single characters — blanket compaction would
  // invent matches inside innocent phrases ("class exam" -> "classexam").
  if (/(?:\b[a-z0-9][^a-z0-9]+){3,}[a-z0-9]\b/i.test(text)) {
    const squashed = text.toLowerCase().replace(/[^a-z0-9]+/g, '');
    for (const term of terms) {
      const bare = term.replace(/[^a-z0-9]+/g, '');
      if (bare.length >= 4 && squashed.includes(bare)) return term;
    }
  }
  return null;
}

// Synchronous, zero-dependency layer. Returns {allowed, reason}.
// Non-English terms. The keyword lists were English-only, so "niño", "enfant",
// "дети" and "儿童" all sailed straight through to a public channel. This is a
// floor, not exhaustive for any language — the Claude gate below reasons across
// languages properly, so keep ANTHROPIC_API_KEY set in production.
const MINORS_INTL = [
  'nino', 'ninos', 'nina', 'ninas', 'niño', 'niños', 'niña', 'menor', 'menores',
  'bebe', 'crianca', 'criança', 'infantil', 'adolescente', 'colegiala',
  'enfant', 'enfants', 'fillette', 'garcon', 'garçon', 'mineur', 'mineure',
  'kind', 'kinder', 'maedchen', 'mädchen', 'junge', 'minderjaehrig', 'minderjährig',
  'bambino', 'bambina', 'bambini', 'minorenne',
  'rebenok', 'deti', 'devochka', 'malchik',
  'ребенок', 'ребёнок', 'дети', 'детьми', 'девочка', 'мальчик', 'несовершеннолет',
  'طفل', 'أطفال', 'اطفال', 'قاصر', 'مراهق',
  'bacha', 'bachcha', 'ladki', 'ladka', 'नाबालिग', 'बच्चा', 'बच्चे',
  '儿童', '小孩', '未成年', '女孩', '男孩', '子供', '未成年者', '少女', '少年',
  '아동', '어린이', '미성년',
  'kinderen', 'meisje', 'jongen', 'barn', 'flicka', 'pojke',
  'dziecko', 'dzieci', 'nieletni', 'cocuk', 'çocuk', 'ergen',
];

const PROFANITY_INTL = [
  'puta', 'puto', 'mierda', 'joder', 'pendejo', 'cabron', 'cabrón', 'verga',
  'merde', 'putain', 'salope', 'connard', 'encule', 'enculé',
  'scheisse', 'scheiße', 'fotze', 'hurensohn', 'schlampe',
  'cazzo', 'stronzo', 'troia', 'puttana',
  'caralho', 'porra', 'buceta',
  'blyat', 'suka', 'pizdec', 'блядь', 'сука', 'пизд', 'ебат', 'хуй',
  'chutiya', 'madarchod', 'behenchod', 'randi',
  'orospu', 'amcik', 'amcık', 'piç',
  'kurwa', 'chuj', 'pierdol',
  'كس', 'شرموط', 'عاهرة',
  '操你', '傻逼', '婊子', 'くそ', 'ちんこ', '씨발', '개새끼',
];

// Scripts that don't separate words with spaces (CJK) and Arabic never tokenise
// the way findTerm() expects, and accented forms miss too. Match non-ASCII
// terms as plain substrings — unambiguous there, unlike English where "sex"
// hides inside "class exam".
function intlHit(text, terms) {
  const lower = String(text).toLowerCase();
  return terms.find((t) => lower.includes(t.toLowerCase())) ?? null;
}

export function hardCheck(text) {
  const minor = findTerm(text, MINORS) ?? findRoot(text) ?? intlHit(text, MINORS_INTL);
  if (minor) {
    return { allowed: false, reason: `content involving minors is never allowed (matched: "${minor}")` };
  }
  if (AGE_PATTERN.test(text)) {
    return { allowed: false, reason: 'content referencing ages under 18 is never allowed' };
  }
  const other = findTerm(text, OTHER_BLOCKED);
  if (other) {
    return { allowed: false, reason: `blocked content (matched: "${other}")` };
  }
  const swear = findTerm(text, PROFANITY) ?? intlHit(text, PROFANITY_INTL);
  if (swear) {
    return { allowed: false, reason: 'keep it clean — that word is not allowed' };
  }
  // Copyright / right-of-publicity screen
  const ip = copyrightCheck(text);
  if (!ip.allowed) return ip;
  return { allowed: true, reason: null };
}

// Optional second layer: Claude moderation gate. Catches phrasings the keyword
// list can't. Fail-safe design: keyword layer already ran and must pass first;
// if the API call itself errors we log and defer to the keyword verdict.
let anthropicClient = null;

const MOD_SYSTEM = `You are a strict content moderator for a public AI-video TV channel. \
Given a viewer-submitted show idea, answer with exactly one word: ALLOW or BLOCK.

BLOCK if the idea involves, references, or implies ANY of the following, however indirectly:
- minors of any kind: children, teenagers, babies, students, school settings, \
family roles implying kids, age references under 18, or any wording engineered to \
get young-looking characters on screen. This is the most important rule. When in \
doubt about age, BLOCK.
- sexual or suggestive content, nudity, fetish content
- graphic violence, gore, self-harm
- real people (living or dead), real brands or logos
- hate, harassment, or slurs
- copyrighted characters, franchises, studios, or trademarked brands (e.g. asking \
for a specific cartoon character, movie universe, or a real company's product), or \
requests to imitate a named artist, studio, or existing show

Otherwise ALLOW. Absurd, surreal, adult-swim-style comedy is fine. Answer with one word only.`;

export async function moderate(text) {
  const hard = hardCheck(text);
  if (!hard.allowed) return hard;
  if (!config.anthropicKey) return hard;

  try {
    if (!anthropicClient) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      anthropicClient = new Anthropic({ apiKey: config.anthropicKey });
    }
    const response = await anthropicClient.messages.create({
      model: config.conceptModel,
      max_tokens: 16,
      system: MOD_SYSTEM,
      messages: [{ role: 'user', content: `Show idea: ${text.slice(0, 500)}` }],
    });
    const verdict = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim()
      .toUpperCase();
    // Anything other than an explicit ALLOW (including a refusal stop) blocks.
    if (!verdict.startsWith('ALLOW')) {
      return { allowed: false, reason: 'rejected by content moderation' };
    }
    return { allowed: true, reason: null };
  } catch (err) {
    console.warn('[moderation] Claude gate errored, keyword verdict stands:', err.message);
    return hard;
  }
}
