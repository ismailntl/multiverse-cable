// ---------------------------------------------------------------------------
// Copyright / DMCA risk controls.
//
// We can't make infringement impossible, but we can make it very unlikely:
//   1. block prompts naming real franchises, characters, brands, and people
//   2. block "in the style of <artist/studio>" constructions
//   3. append an ORIGINALITY_SUFFIX to every prompt sent to any backend
//   4. only source found-footage from public-domain collections
//   5. ship a takedown path (POST /api/dmca) + policy page, and keep the
//      prompt + provenance on every clip so takedowns are actionable
// Genre styles in shows.js describe *techniques* (stop-motion, VHS grain),
// never named shows — that's deliberate, keep it that way.
// ---------------------------------------------------------------------------

export const ORIGINALITY_SUFFIX =
  ' All characters, logos, products, and settings must be wholly original ' +
  'inventions. Do not depict or imitate any real person, celebrity, public ' +
  'figure, existing fictional character, trademarked brand, logo, or ' +
  'copyrighted work. No recognizable text or wordmarks.';

// Franchises / characters most likely to be requested by name.
const FRANCHISES = [
  'mickey mouse', 'minnie mouse', 'donald duck', 'goofy', 'disney', 'pixar',
  'marvel', 'spider-man', 'spiderman', 'iron man', 'captain america', 'hulk',
  'thor', 'avengers', 'batman', 'superman', 'wonder woman', 'joker', 'dc comics',
  'star wars', 'darth vader', 'yoda', 'jedi', 'star trek', 'pokemon', 'pikachu',
  'nintendo', 'mario', 'luigi', 'zelda', 'sonic the hedgehog', 'minecraft',
  'roblox', 'fortnite', 'simpsons', 'homer simpson', 'family guy', 'south park',
  'rick and morty', 'futurama', 'spongebob', 'scooby doo', 'looney tunes',
  'bugs bunny', 'tom and jerry', 'hello kitty', 'barbie', 'lego', 'transformers',
  'harry potter', 'hogwarts', 'lord of the rings', 'gandalf', 'game of thrones',
  'breaking bad', 'stranger things', 'squid game', 'anime character',
  'dragon ball', 'goku', 'naruto', 'one piece', 'sailor moon', 'studio ghibli',
  'totoro', 'adult swim', 'robot chicken', 'aqua teen', 'cartoon network',
  'nickelodeon', 'hbo', 'netflix', 'hasbro', 'mattel',
];

// Brands whose logos/trade dress a model might reproduce.
const BRANDS = [
  'coca cola', 'coca-cola', 'pepsi', 'mcdonalds', "mcdonald's", 'burger king',
  'starbucks', 'nike', 'adidas', 'apple inc', 'iphone', 'samsung', 'google',
  'microsoft', 'amazon prime', 'tesla', 'ferrari', 'lamborghini', 'rolex',
  'gucci', 'louis vuitton', 'supreme brand', 'red bull', 'monster energy',
];

// Real-person catch-alls. A full celebrity list is impossible, so we pair a
// short high-risk list with a structural check for "as <Name>" / "played by".
const REAL_PEOPLE = [
  'elon musk', 'donald trump', 'joe biden', 'barack obama', 'taylor swift',
  'kanye', 'kim kardashian', 'beyonce', 'drake the rapper', 'mrbeast',
  'oprah', 'tom cruise', 'keanu reeves', 'morgan freeman', 'the rock',
  'dwayne johnson', 'putin', 'zelensky', 'king charles', 'pope francis',
];

const STYLE_OF = /\b(in the style of|styled after|looks? like|imitating|parody of|cosplay(?:ing)? as|dressed as)\s+[a-z]/i;
const CELEBRITY_HINT = /\b(celebrity|celebrities|famous (?:actor|actress|singer|rapper|politician|person)|real person|public figure)\b/i;

function flat(text) {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

function hit(text, terms) {
  const f = flat(text);
  return terms.find((t) => f.includes(` ${t.replace(/[^a-z0-9]+/g, ' ').trim()} `)) ?? null;
}

// Returns {allowed, reason}. Called on bid intake alongside the safety checks.
export function copyrightCheck(text) {
  const franchise = hit(text, FRANCHISES);
  if (franchise) {
    return {
      allowed: false,
      reason: `we can't generate copyrighted characters or franchises (matched: "${franchise}") — describe an original character instead`,
    };
  }
  const brand = hit(text, BRANDS);
  if (brand) {
    return {
      allowed: false,
      reason: `we can't generate real brands or trademarks (matched: "${brand}") — invent a fake brand instead`,
    };
  }
  const person = hit(text, REAL_PEOPLE);
  if (person) {
    return {
      allowed: false,
      reason: `we can't depict real people (matched: "${person}") — use an original character instead`,
    };
  }
  if (CELEBRITY_HINT.test(text)) {
    return { allowed: false, reason: "we can't depict real or famous people — use an original character instead" };
  }
  if (STYLE_OF.test(text)) {
    return {
      allowed: false,
      reason: "we can't imitate a specific artist, studio, or existing work — describe the visual style directly (e.g. 'grainy stop-motion') instead",
    };
  }
  return { allowed: true, reason: null };
}
