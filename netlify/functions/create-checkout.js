// netlify/functions/create-checkout.js
// Secure Stripe Checkout creator for a static site (Netlify Functions).
// Uses a server-side catalog so browser can't tamper prices.
// Redirects back to a subfolder in dev via client-sent `basePath`.
// Adds variant info (size/color) + image to Stripe line items.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- CORS: local dev + deployed site ---
const ALLOWED_ORIGINS = [
    'http://localhost:63342',
    'http://127.0.0.1:63342',
    'http://localhost:8888',           // if you ever use `netlify dev`
    'https://astonishing-empanada-8e5445.netlify.app'
];
const corsHeaders = (origin) => ({
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
});

// --- Where success/cancel should land by default (overridable via env) ---
const SITE_URL =
    process.env.SITE_URL ||             // e.g. set to http://localhost:63342/clarity-shop in dev if you prefer
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    'https://astonishing-empanada-8e5445.netlify.app';

// --- Server-side catalog (GBP, pence) matching your products.json ---
const CURRENCY = 'gbp';
const CATALOG = {
    "1": { name: "Classic Black Hoodie", unit_amount: 4999 },
    "2": { name: "Neon Green Hoodie",    unit_amount: 5499 },
    "3": { name: "Vintage Red Hoodie",   unit_amount: 5299 },
    "4": { name: "Minimal White Hoodie", unit_amount: 4799 },
    "5": { name: "Camo Hoodie",          unit_amount: 5999 },
    "6": { name: "Tie-Dye Hoodie",       unit_amount: 5699 }
};

// --- Helpers ---
function isLocalOrigin(origin) {
    try {
        const u = new URL(origin);
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch { return false; }
}
function normalizeBasePath(basePath) {
    if (!basePath) return '';
    // Ensure leading slash, remove trailing slashes
    return ('/' + String(basePath).replace(/^\/+/, '')).replace(/\/+$/, '');
}
// Ensure Stripe gets an absolute HTTPS image URL
function absolutizeImage(base, img) {
    if (!img) return undefined;
    if (/^https?:\/\//i.test(img)) return img;
    return `${base.replace(/\/$/, '')}/${String(img).replace(/^\//, '')}`;
}

exports.handler = async (event) => {
    const origin = event.headers.origin || '';

    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(origin) };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: corsHeaders(origin), body: 'Method Not Allowed' };
    }

    try {
        const { items, basePath } = JSON.parse(event.body || '{}');
        if (!Array.isArray(items) || items.length === 0) {
            return { statusCode: 400, headers: corsHeaders(origin), body: 'No items in request.' };
        }

        // For localhost calls, use client-sent basePath (e.g. "/clarity-shop")
        const cleanBase = normalizeBasePath(basePath);
        const base = isLocalOrigin(origin) && cleanBase
            ? `${origin}${cleanBase}`                 // e.g. http://localhost:63342/clarity-shop
            : SITE_URL;                               // e.g. https://astonishing-empanada-8e5445.netlify.app

        // Build Stripe line_items from server-side truth (ignore client prices)
        const line_items = items.map((it) => {
            const id  = String(it.id);
            const qty = Math.max(1, parseInt(it.quantity || 1, 10));
            const product = CATALOG[id];
            if (!product) throw new Error(`Unknown product id: ${id}`);

            // Build display name with variant details, e.g. "Neon Green Hoodie — M / Neon Green"
            const suffix = [it.size, it.color].filter(Boolean).join(' / ');
            const displayName = suffix ? `${product.name} — ${suffix}` : product.name;

            // Absolute product image for Stripe (if provided from client cart)
            const imageUrl = absolutizeImage(base, it.image || (it.images && it.images[0]));

            return {
                price_data: {
                    currency: CURRENCY,
                    product_data: {
                        name: displayName,
                        ...(imageUrl ? { images: [imageUrl] } : {}),
                        metadata: {
                            base_id: id,
                            size: it.size || '',
                            color: it.color || ''
                        }
                    },
                    unit_amount: product.unit_amount
                },
                quantity: qty
            };
        });

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items,
            allow_promotion_codes: true,

            // Physical goods → collect addresses (adjust as needed)
            billing_address_collection: 'required',
            shipping_address_collection: { allowed_countries: ['GB', 'IE', 'FR', 'DE', 'NL', 'ES', 'IT'] },
            // If/when you use Stripe-managed Shipping Rates, add:
            // shipping_options: [{ shipping_rate: 'shr_XXXX' }],

            // Optional: store cart context (variant info) for fulfillment/webhooks
            metadata: {
                cart: JSON.stringify(
                    items.map(({ id, quantity, size, color }) => ({ id, quantity, size, color }))
                )
            },

            success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url:  `${base}/cancel.html`
        });

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
            // In dev, surfacing the message helps; remove for prod if you prefer
            body: JSON.stringify({ error: err.message })
        };
    }
};