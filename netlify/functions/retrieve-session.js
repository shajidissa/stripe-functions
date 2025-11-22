// netlify/functions/create-checkout.js
// Secure Stripe Checkout creator with:
// - Server-side catalog
// - Stripe-managed shipping rates (via env)
// - Order number correlation (client_reference_id + metadata on Session/PI)
// - Local dev subfolder via `basePath`
// - Country-aware shipping option selection (Netlify geo headers with fallbacks)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// --- CORS: local dev + your live front-ends ---
const ALLOWED_ORIGINS = [
    'http://localhost:63342',
    'http://127.0.0.1:63342',
    'http://localhost:8888',
    'https://stripe-functions-clarity.netlify.app',
    'https://shajidissa.github.io'
];
const pickAllowedOrigin = (o) => ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0];
const corsHeaders = (origin, reqHdrs = '') => ({
    'Access-Control-Allow-Origin': pickAllowedOrigin(origin),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': reqHdrs || 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method'
});

// --- Success/cancel base URL ---
const SITE_URL =
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    'https://stripe-functions-clarity.netlify.app';

// --- Server-side catalog (GBP, pence) ---
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
    return ('/' + String(basePath).replace(/^\/+/, '')).replace(/\/+$/, '');
}
function absolutizeImage(base, img) {
    if (!img) return undefined;
    if (/^https?:\/\//i.test(img)) return img;
    return `${base.replace(/\/$/, '')}/${String(img).replace(/^\//, '')}`;
}
function newOrderNumber() {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const rand = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(2,7);
    return `CL-${date}-${rand}`;
}

// Best-effort country detection (Netlify geo → Cloudflare → custom hint)
// Returns a 2-letter ISO country code or null.
function detectCountry(event, hintCountry) {
    // Netlify: x-nf-geo: '{"country":"GB","city":"…","subdivision":"…"}'
    const geo = event.headers['x-nf-geo'];
    if (geo) {
        try {
            const parsed = JSON.parse(geo);
            if (parsed && typeof parsed.country === 'string' && parsed.country.length === 2) {
                return parsed.country.toUpperCase();
            }
        } catch {}
    }

    // Common CDN headers if fronted by Cloudflare/other proxies
    const cf = event.headers['cf-ipcountry'] || event.headers['x-country'] || event.headers['x-country-code'];
    if (cf && typeof cf === 'string' && cf.length === 2) {
        return cf.toUpperCase();
    }

    // Optional client hint
    if (hintCountry && typeof hintCountry === 'string' && hintCountry.length === 2) {
        return hintCountry.toUpperCase();
    }

    return null;
}

// Small EU set (extend as needed)
const EU_SET = new Set(['IE','FR','DE','NL','ES','IT','BE','LU','PT','PL','SE','DK','FI','AT','CZ','HU','RO','BG','HR','GR','SI','SK','LV','LT','EE','CY','MT']);

exports.handler = async (event) => {
    const origin  = event.headers.origin || event.headers.Origin || '';
    const reqHdrs = event.headers['access-control-request-headers'] || event.headers['Access-Control-Request-Headers'] || '';

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(origin, reqHdrs) };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: corsHeaders(origin), body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const { items, basePath, hintCountry } = body;

        if (!Array.isArray(items) || items.length === 0) {
            return { statusCode: 400, headers: corsHeaders(origin), body: 'No items in request.' };
        }

        const cleanBase = normalizeBasePath(basePath);
        const base = (isLocalOrigin(origin) && cleanBase) ? `${origin}${cleanBase}` : SITE_URL;

        // Build line_items from server truth
        const line_items = items.map((it) => {
            const id  = String(it.id);
            const qty = Math.max(1, parseInt(it.quantity || 1, 10));
            const product = CATALOG[id];
            if (!product) throw new Error(`Unknown product id: ${id}`);

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

        // Subtotal in pence (for free UK shipping threshold)
        const subtotalPence = line_items.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0);
        const FREE_THRESH = parseInt(process.env.FREE_SHIP_THRESHOLD_PENCE || '0', 10);

        // --- Country-aware shipping option selection ---
        const country = detectCountry(event, hintCountry); // e.g., 'GB', 'DE', 'US', or null in dev
        const shipping_options = [];

        // Helper to push only if env var is present
        const pushRate = (envKey) => {
            const id = process.env[envKey];
            if (id) shipping_options.push({ shipping_rate: id });
        };

        if (!country) {
            // Unknown (dev): show everything so you can still test
            // (Stripe will still validate address & taxes)
            if (FREE_THRESH > 0 && subtotalPence >= FREE_THRESH) pushRate('SHIP_FREE_UK');
            pushRate('SHIP_UK_STANDARD');
            pushRate('SHIP_UK_EXPRESS');
            pushRate('SHIP_EU');
            pushRate('SHIP_INTL');
        } else if (country === 'GB') {
            if (FREE_THRESH > 0 && subtotalPence >= FREE_THRESH) pushRate('SHIP_FREE_UK');
            pushRate('SHIP_UK_STANDARD');
            pushRate('SHIP_UK_EXPRESS');
        } else if (EU_SET.has(country)) {
            pushRate('SHIP_EU');        // single EU tracked option
        } else {
            pushRate('SHIP_INTL');      // everyone else
        }

        // --- Create an order number & attach everywhere ---
        const orderNumber = newOrderNumber();

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items,

            client_reference_id: orderNumber,
            metadata: {
                order_number: orderNumber,
                cart: JSON.stringify(items.map(({ id, quantity, size, color }) => ({ id, quantity, size, color })))
            },
            payment_intent_data: {
                metadata: { order_number: orderNumber }
            },

            // Keep your original small allowed list here (expand later if you wish)
            billing_address_collection: 'required',
            shipping_address_collection: { allowed_countries: ['GB', 'IE', 'FR', 'DE', 'NL', 'ES', 'IT'] },
            shipping_options,
            automatic_tax: { enabled: true },

            allow_promotion_codes: true,
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