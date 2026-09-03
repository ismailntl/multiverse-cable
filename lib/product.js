import dns from 'node:dns/promises';
import net from 'node:net';

// ---------------------------------------------------------------------------
// Product lookup for paid ad slots.
//
// An advertiser pastes a link to what they're selling. We fetch the page, pull
// out its name, price and product image, and hand the image to the generator so
// the pitchman holds the actual product instead of an invented one.
//
// This fetches a URL chosen by an untrusted user from inside our network, so it
// is written defensively: scheme allow-list, DNS resolved and checked against
// private ranges before connecting, redirects followed manually with the same
// check each hop, and hard caps on time and body size.
// ---------------------------------------------------------------------------

const MAX_BYTES = 1_500_000; // plenty for a product page's <head>
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;

// RFC1918, loopback, link-local, CGNAT, and the cloud metadata address.
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // includes 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    // IPv4-mapped (::ffff:10.0.0.1) must be checked as IPv4
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateAddress(m[1]);
    return false;
  }
  return true; // unparseable: refuse
}

async function assertPublicHost(hostname) {
  // A literal IP skips DNS entirely
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('refusing to fetch a private address');
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('could not resolve that host');
  }
  if (!addrs.length) throw new Error('could not resolve that host');
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error('refusing to fetch a private address');
  }
}

async function safeFetch(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('that does not look like a link');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http and https links work');

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(url.hostname);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual', // each hop gets its own private-address check
        signal: ctl.signal,
        headers: {
          // Some storefronts serve a stub to unknown agents
          'user-agent': 'Mozilla/5.0 (compatible; MultiverseCableBot/1.0; +https://multiversecable.com)',
          accept: 'text/html,application/xhtml+xml',
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    if (!res.ok) throw new Error(`that link returned ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) throw new Error('that link is not a web page');

    // Read with a hard cap rather than trusting content-length
    const reader = res.body?.getReader();
    if (!reader) throw new Error('that link returned nothing');
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { await reader.cancel(); break; }
      chunks.push(value);
    }
    return { html: Buffer.concat(chunks).toString('utf8'), finalUrl: url.toString() };
  }
  throw new Error('that link redirected too many times');
}

const decode = (s) =>
  String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();

function meta(html, ...names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']|` +
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`,
      'i'
    );
    const m = html.match(re);
    if (m) {
      const v = decode(m[1] ?? m[2]);
      if (v) return v;
    }
  }
  return null;
}

// schema.org Product in JSON-LD is the most reliable source of a real price.
function fromJsonLd(html) {
  const out = {};
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    for (const node of [].concat(data, data?.['@graph'] ?? [])) {
      if (!node || typeof node !== 'object') continue;
      const t = [].concat(node['@type'] ?? []).map(String);
      if (!t.some((x) => x.toLowerCase() === 'product')) continue;
      out.title = out.title ?? (typeof node.name === 'string' ? node.name : null);
      out.description = out.description ?? (typeof node.description === 'string' ? node.description : null);
      const img = Array.isArray(node.image) ? node.image[0] : node.image;
      out.image = out.image ?? (typeof img === 'string' ? img : img?.url ?? null);
      const offer = [].concat(node.offers ?? [])[0];
      if (offer && out.price == null && offer.price != null) {
        out.price = String(offer.price);
        out.currency = offer.priceCurrency ?? null;
      }
    }
  }
  return out;
}

function absolutise(src, base) {
  if (!src) return null;
  try { return new URL(src, base).toString(); } catch { return null; }
}

function formatPrice(price, currency) {
  if (price == null) return null;
  const n = Number(String(price).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const sym = { USD: '$', GBP: '£', EUR: '€', CAD: 'CA$', AUD: 'A$' }[String(currency || 'USD').toUpperCase()] ?? '$';
  return `${sym}${n.toFixed(2)}`;
}

// Look up a product page and return what an ad needs from it.
export async function lookupProduct(rawUrl) {
  const { html, finalUrl } = await safeFetch(rawUrl);
  const ld = fromJsonLd(html);

  const title =
    ld.title ?? meta(html, 'og:title', 'twitter:title') ??
    decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]) ?? null;
  const image = absolutise(
    ld.image ?? meta(html, 'og:image', 'og:image:url', 'twitter:image'),
    finalUrl
  );
  const description =
    ld.description ?? meta(html, 'og:description', 'description', 'twitter:description') ?? null;
  const price =
    formatPrice(ld.price, ld.currency) ??
    formatPrice(meta(html, 'product:price:amount', 'og:price:amount'),
                meta(html, 'product:price:currency', 'og:price:currency'));

  if (!title && !image) throw new Error('could not find a product on that page');

  return {
    url: finalUrl,
    site: meta(html, 'og:site_name') ?? new URL(finalUrl).hostname.replace(/^www\./, ''),
    title: title ? title.slice(0, 120) : null,
    description: description ? description.slice(0, 400) : null,
    image,
    price,
  };
}

export const _internals = { isPrivateAddress, formatPrice, meta, fromJsonLd };
