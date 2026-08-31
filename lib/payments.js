import { config } from './config.js';
import { store } from './store.js';

// ---------------------------------------------------------------------------
// Stripe Checkout for credit packs.
//
// With STRIPE_SECRET_KEY set: real Checkout Sessions, credits granted only by
// the webhook (checkout.session.completed) after signature verification.
// Without a key: demo mode — the "buy" call grants credits immediately and
// says so, so the whole flow is testable before Stripe is wired up.
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
    // Demo mode: no payment processor configured yet.
    const ref = `demo-${Date.now()}-${user.id}`;
    store.adjustCredits(user.id, pack.credits, 'purchase', ref);
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
    if (store.hasProcessedPayment(session.id)) return { ignored: 'duplicate' };
    const userId = session.metadata?.userId ?? session.client_reference_id;
    const credits = parseInt(session.metadata?.credits ?? '0', 10);
    if (!userId || !credits) return { ignored: 'missing metadata' };
    store.adjustCredits(userId, credits, 'purchase', session.id);
    return { credited: credits, userId };
  }

  return { ignored: event.type };
}
