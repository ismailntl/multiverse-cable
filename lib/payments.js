import { config } from './config.js';
import * as db from './store-adapter.js';

// ---------------------------------------------------------------------------
// Stripe Checkout for credit packs.
//
// With STRIPE_SECRET_KEY set: real Checkout Sessions, credits granted only by
// the webhook (checkout.session.completed) after signature verification.
//
// Demo mode (no key) hands out credits for free, so it must be opted into
// explicitly with ALLOW_DEMO_CREDITS=1 and is refused on a public origin. It
// used to be the automatic fallback, which meant a missing or rotated key
// silently turned the credit system into a free faucet.
// ---------------------------------------------------------------------------

export const stripeEnabled = () => Boolean(config.stripeKey);

let stripeClient = null;
async function getStripe() {
  if (!config.stripeKey) return null;
  if (!stripeClient) {
    const { default: Stripe } = await import('stripe');
    stripeClient = new Stripe(config.stripeKey);
  }
  return stripeClient;
}

export function findPack(id) {
  return config.creditPacks.find((p) => p.id === id) ?? null;
}

export async function createCheckout(user, pack) {
  const stripe = await getStripe();

  if (!stripe) {
    if (!config.allowDemoCredits) {
      throw new Error('payments are not configured — STRIPE_SECRET_KEY is unset');
    }
    // Demo mode: no payment processor configured yet.
    const ref = `demo-${Date.now()}-${user.id}`;
    await db.adjustCredits(user.id, pack.credits, 'purchase', ref);
    return {
      demo: true,
      credits: pack.credits,
      message: `DEMO MODE — no payment taken. ${pack.credits} credits added. Set STRIPE_SECRET_KEY for real checkout.`,
    };
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    client_reference_id: user.id,
    customer_email: user.email,
    metadata: { userId: user.id, packId: pack.id, credits: String(pack.credits) },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: pack.priceCents,
          product_data: {
            name: `Multiverse Cable — ${pack.credits} credits`,
            description: 'Broadcast credits for programming channels and ads.',
          },
        },
      },
    ],
    success_url: `${config.publicUrl}/?purchase=success`,
    cancel_url: `${config.publicUrl}/?purchase=cancelled`,
  });

  return { demo: false, url: session.url };
}

// Raw body + signature header required for verification.
export async function handleWebhook(rawBody, signature) {
  const stripe = await getStripe();
  if (!stripe) throw new Error('stripe not configured');
  if (!config.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not set');

  const event = stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') return { ignored: 'unpaid' };
    // Idempotency: Stripe retries webhooks, so never double-credit a session
    if (await db.hasProcessedPayment(session.id)) return { ignored: 'duplicate' };
    const userId = session.metadata?.userId ?? session.client_reference_id;
    const credits = parseInt(session.metadata?.credits ?? '0', 10);
    if (!userId || !credits) return { ignored: 'missing metadata' };
    const balance = await db.adjustCredits(userId, credits, 'purchase', session.id);
    if (balance === null) {
      // Unknown user or a constraint refusal — surface it instead of 200-ing
      throw new Error(`could not credit ${credits} to ${userId}`);
    }
    return { credited: credits, userId, balance };
  }

  return { ignored: event.type };
}
