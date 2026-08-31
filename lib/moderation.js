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

export const SAFETY_SUFFIX =
  ' IMPORTANT: every character shown or mentioned is an adult aged 30 or older. ' +
  'Absolutely no children, teenagers, minors, babies, students, or school-age ' +
  'characters anywhere in the video, in any form. No sexual content. No real people.' +
  ORIGINALITY_SUFFIX;

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
  return null;
}

// Synchronous, zero-dependency layer. Returns {allowed, reason}.
export function hardCheck(text) {
  const minor = findTerm(text, MINORS) ?? findRoot(text);
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
