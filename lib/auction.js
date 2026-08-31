import { config } from './config.js';
import { store } from './store.js';

// ---------------------------------------------------------------------------
// Slot auction.
//
// Without a window, the first bid to land starts generating and a higher bid
// arriving 5s later is already too late — we'd have burned GPU time on a clip
// that just got outbid. So bids collect inside a timed window; when it closes
// the highest bid wins and ONLY THEN do we generate. Losing bids stay queued
// (credits still held) and compete in the next window, so a big spender takes
// the next slot and everyone else shifts down rather than being dropped.
//
// The window is short (default 45s) so a bidder isn't waiting long, and it
// only runs while bids are actually pending — an idle channel never waits.
// ---------------------------------------------------------------------------

let auction = null; // { opensAt, closesAt }

export function openIfNeeded() {
  if (auction) return auction;
  if (!store.topPendingBid()) return null;
  const now = Date.now();
  auction = { opensAt: now, closesAt: now + config.auctionWindowSec * 1000 };
  return auction;
}

// Extend a closing window slightly when a late bid lands, so the last second
// isn't a sniping contest (same idea as eBay's anti-snipe extension).
export function noteBid() {
  const a = openIfNeeded();
  if (!a) return null;
  const left = a.closesAt - Date.now();
  const min = config.auctionAntiSnipeSec * 1000;
  if (left < min) a.closesAt = Date.now() + min;
  return a;
}

export function closed() {
  return auction !== null && Date.now() >= auction.closesAt;
}

// The winning bid once the window has closed; null while bidding is still open.
export function takeWinner() {
  if (!closed()) return null;
  auction = null;
  return store.topPendingBid() ?? null;
}

export function status() {
  const pending = store.state.bids.filter((b) => b.status === 'pending');
  const leader = pending.sort((a, b) => b.amount - a.amount || a.createdAt - b.createdAt)[0] ?? null;
  return {
    open: !!auction,
    closesAt: auction?.closesAt ?? null,
    msLeft: auction ? Math.max(0, auction.closesAt - Date.now()) : null,
    windowSec: config.auctionWindowSec,
    queued: pending.length,
    leader: leader
      ? {
          name: leader.name,
          amount: leader.amount,
          idea: leader.idea,
          kind: leader.kind,
          durationSec: leader.durationSec,
        }
      : null,
    // What it takes to outbid the current leader right now
    toBeat: leader ? leader.amount + 1 : config.minBidCredits,
  };
}

export function reset() {
  auction = null;
}
