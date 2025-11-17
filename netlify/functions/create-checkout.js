// netlify/functions/create-checkout.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- CORS: local + deployed ---
const ALLOWED_ORIGINS = [
    'http://localhost:63342',
    'https://clarity-shop.netlify.app'
];
const corsHeaders = (origin) => ({
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
});

// --- Redirect base (defaults to your live site) ---
const SITE_URL =
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    'https://clarity-shop.netlify.app';

// --- Secure server-side catalog (GBP, pence) ---
const CURRENCY = 'gbp';
const CATALOG = {
    "1": { name: "Classic Black Hoodie", unit_amount: 4999 },
    "2": { name: "Neon Green Hoodie",    unit_amount: 5499 },
    "3": { name: "Vintage Red Hoodie",   unit_amount: 5299 },
    "4": { name: "Minimal White Hoodie", unit_amount: 4799 },
    "5": { name: "Camo Hoodie",          unit_amount: 5999 },
    "6": { name: "Tie-Dye Hoodie",       unit_amount: 5699 }
};

function devBaseFromReferer(event, origin) {
    try {
        const ref = new URL(event.headers.referer || '');
        if (origin && ref.origin === origin) {
            // e.g. /clarity-shop/cart.html -> "clarity-shop"
            const firstSegment = ref.pathname.split('/').filter(Boolean)[0];
            if (firstSegment) return `${origin}/${firstSegment}`;
        }
    } catch (_) {}
    return null;
}

exports.handler = async (event) => {
    const origin = event.headers.origin || '';

    // Preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(origin) };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: corsHeaders(origin), body: 'Method Not Allowed' };
    }

    try {
        const { items } = JSON.parse(event.body || '{}');
        if (!Array.isArray(items) || items.length === 0) {
            return { statusCode: 400, headers: corsHeaders(origin), body: 'No items in request.' };
        }

        // Build Stripe line_items from server truth
        const line_items = items.map((it) => {
            const id = String(it.id);
            const qty = Math.max(1, parseInt(it.quantity || 1, 10));
            const product = CATALOG[id];
            if (!product) throw new Error(`Unknown product id: ${id}`);

            return {
                price_data: {
                    currency: CURRENCY,
                    product_data: { name: product.name },
                    unit_amount: product.unit_amount
                },
                quantity: qty
            };
        });

        const base =
            origin.startsWith('http://localhost')
                ? (devBaseFromReferer(event, origin) || SITE_URL)
                : SITE_URL;

        // 👇 session is defined IN this try block
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items,
            allow_promotion_codes: true,
            billing_address_collection: 'required',
            shipping_address_collection: { allowed_countries: ['GB', 'IE', 'FR', 'DE', 'NL', 'ES', 'IT'] },
            metadata: {
                cart: JSON.stringify(items.map(({ id, quantity, size, color }) => ({ id, quantity, size, color })))
            },
            success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url:  `${base}/cancel.html`
        });

        // ✅ Return from inside the try, where `session` is in scope
        return {
            statusCode: 200,
            headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: session.id, url: session.url })
        };

    } catch (err) {
        console.error('Stripe Checkout Error:', err);
        return {
            statusCode: 500,
            headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
            // temporary: surface the message to help debug
            body: JSON.stringify({ error: err.message })
        };
    }
};