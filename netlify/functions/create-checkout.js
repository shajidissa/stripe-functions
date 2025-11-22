// netlify/functions/create-checkout.js
// Secure Stripe Checkout creator with Stripe-managed shipping rates.
// - Server-side catalog (browser can't tamper prices)
// - Local dev subfolder via client-sent `basePath` (e.g. "/clarity-shop")
// - Variant info (size/color) + image on Stripe line items
// - Shipping rates from Stripe (env vars SHIP_*) + optional free UK threshold

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- CORS: local dev + your live front-ends ---
const ALLOWED_ORIGINS = [
    'http://localhost:63342',
    'http://127.0.0.1:63342',
    'http://localhost:8888',                    // if you use `netlify dev`
    'https://clarity-shop.netlify.app',         // storefront
    'https://shajidissa.github.io',             // GitHub Pages (if used)
    'https://stripe-functions-clarity.netlify.app' // functions site (if calling same-origin)
];
const pickAllowedOrigin = (o) => ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0];
const corsHeaders = (origin, reqHdrs = '') => ({
    'Access-Control-Allow-Origin': pickAllowedOrigin(origin),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': reqHdrs || 'content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method'
});

// --- Where success/cancel should land by default (overridable via env) ---
const SITE_URL =
    process.env.SITE_URL ||                     // set to https://clarity-shop.netlify.app in env
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    'https://clarity-shop.netlify.app';

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
    try { const u = new URL(origin); return u.hostname === 'localhost' || u.hostname === '127.0.0.1'; }
    catch { return false; }
}
function normalizeBasePath(basePath) {
    if (!basePath) return '';
    // ensure leading slash, strip trailing
    return ('/' + String(basePath).replace(/^\/+/, '')).replace(/\/+$/, '');
}
function absolutizeImage(base, img) {
    if (!img) return undefined;
    if (/^https?:\/\//i.test(img)) return img;
    return `${base.replace(/\/$/, '')}/${String(img).replace(/^\//, '')}`;
}

exports.handler = async (event) => {
    const origin  = event.headers.origin || event.headers.Origin || '';
    const reqHdrs = event.headers['access-control-request-headers'] || event.headers['Access-Control-Request-Headers'] || '';

    // CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(origin, reqHdrs) };
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
        const base = (isLocalOrigin(origin) && cleanBase) ? `${origin}${cleanBase}` : SITE_URL;

        // Build Stripe line_items from server truth (ignore client prices)
        const line_items = items.map((it) => {
            const id  = String(it.id);
            const qty = Math.max(1, parseInt(it.quantity || 1, 10));
            const product = CATALOG[id];
            if (!product) throw new Error(`Unknown product id: ${id}`);

            // Add variant details to the product name
            const suffix = [it.size, it.color].filter(Boolean).join(' / ');
            const displayName = suffix ? `${product.name} — ${suffix}` : product.name;

            const imageUrl = absolutizeImage(base, it.image || (it.images && it.images[0]));

            return {
                price_data: {
                    currency: CURRENCY,
                    product_data: {
                        name: displayName,
                        ...(imageUrl ? { images: [imageUrl] } : {}),
                        metadata: { base_id: id, size: it.size || '', color: it.color || '' }
                    },
                    unit_amount: product.unit_amount
                },
                quantity: qty
            };
        });

        // ---- Stripe-managed shipping options ----
        // Env vars to set in Netlify:
        // SHIP_UK_STANDARD, SHIP_UK_EXPRESS, SHIP_EU, SHIP_INTL
        // Optional: SHIP_FREE_UK and FREE_SHIP_THRESHOLD_PENCE (e.g., 7500 for £75)
        const subtotalPence = line_items.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0);
        const FREE_THRESH = parseInt(process.env.FREE_SHIP_THRESHOLD_PENCE || '0', 10);

        const shipping_options = [];
        if (FREE_THRESH > 0 && subtotalPence >= FREE_THRESH && process.env.SHIP_FREE_UK) {
            shipping_options.push({ shipping_rate: process.env.SHIP_FREE_UK }); // shows to all; name it clearly as "(UK) Free"
        }
        if (process.env.SHIP_UK_STANDARD) shipping_options.push({ shipping_rate: process.env.SHIP_UK_STANDARD });
        if (process.env.SHIP_UK_EXPRESS)  shipping_options.push({ shipping_rate: process.env.SHIP_UK_EXPRESS });
        if (process.env.SHIP_EU)          shipping_options.push({ shipping_rate: process.env.SHIP_EU });
        if (process.env.SHIP_INTL)        shipping_options.push({ shipping_rate: process.env.SHIP_INTL });

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items,

            // Collect addresses so Stripe can present shipping options & compute tax
            billing_address_collection: 'required',
            shipping_address_collection: {
                // GB + full EU list (trim if you ship to fewer)
                allowed_countries: [
                    'GB', 'IE', 'FR', 'DE', 'NL', 'ES', 'IT'
                ]
            },
            shipping_options,                 // your Stripe shipping rates
            automatic_tax: { enabled: true }, // taxes on items + shipping

            allow_promotion_codes: true,

            // Keep cart context for webhooks/fulfilment
            metadata: {
                cart: JSON.stringify(items.map(({ id, quantity, size, color }) => ({ id, quantity, size, color })))
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
            body: JSON.stringify({ error: err.message })
        };
    }
};