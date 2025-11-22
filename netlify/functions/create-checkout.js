// netlify/functions/create-checkout.js
// Secure Stripe Checkout creator for a static site (Netlify Functions).
// - Uses server-side catalog so browser can't tamper prices
// - Adds a short human order reference (orderRef) and stores it in Stripe
// - Mirrors CORS with retrieve-session.js
// - Supports Stripe-managed shipping rates + free shipping threshold

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ---- CORS (keep in sync with retrieve-session.js)
const ALLOWED_ORIGINS = [
    'http://localhost:63342',
    'http://127.0.0.1:63342',
    'http://localhost:8888',
    'https://stripe-functions-clarity.netlify.app',
    'https://shajidissa.github.io'
];

const pickAllowedOrigin = (o) => (ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0]);
const corsHeaders = (origin, reqHdrs = '') => ({
    'Access-Control-Allow-Origin': pickAllowedOrigin(origin),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': reqHdrs || 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method'
});

// ---- Base URL used for redirects (overridable in Netlify env)
const SITE_URL =
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    'https://stripe-functions-clarity.netlify.app';

// ---- Server truth (GBP, pence)
const CURRENCY = 'gbp';
const CATALOG = {
    '1': { name: 'Classic Black Hoodie', unit_amount: 4999 },
    '2': { name: 'Neon Green Hoodie',    unit_amount: 5499 },
    '3': { name: 'Vintage Red Hoodie',   unit_amount: 5299 },
    '4': { name: 'Minimal White Hoodie', unit_amount: 4799 },
    '5': { name: 'Camo Hoodie',          unit_amount: 5999 },
    '6': { name: 'Tie-Dye Hoodie',       unit_amount: 5699 }
};

// ---- Shipping rates (Stripe IDs from your dashboard)
const SR_UK_STANDARD    = process.env.SR_UK_STANDARD    || 'shr_1SUsLiAGUzM7chQm6CvosZka';
const SR_UK_EXPRESS     = process.env.SR_UK_EXPRESS     || 'shr_1SUsMLAGUzM7chQmiyjUWL39';
const SR_EU_TRACKED     = process.env.SR_EU_TRACKED     || 'shr_1SUsMrAGUzM7chQmmmpTwpeC';
const SR_INTL_STANDARD  = process.env.SR_INTL_STANDARD  || 'shr_1SUsNKAGUzM7chQm28i4xKAK';
const FREE_SHIP_THRESHOLD_PENCE = parseInt(process.env.FREE_SHIP_THRESHOLD_PENCE || '0', 10);

// ---- Helpers
const isLocalOrigin = (o) => {
    try { const u = new URL(o); return u.hostname === 'localhost' || u.hostname === '127.0.0.1'; }
    catch { return false; }
};

const normalizeBasePath = (p) => {
    if (!p) return '';
    return ('/' + String(p).replace(/^\/+/, '')).replace(/\/+$/, '');
};

const absolutizeImage = (base, img) => {
    if (!img) return undefined;
    if (/^https?:\/\//i.test(img)) return img;
    return `${base.replace(/\/$/, '')}/${String(img).replace(/^\//, '')}`;
};

// Simple short order reference (e.g., CL-9F2K4B)
const makeOrderRef = () =>
    'CL-' + Math.random().toString(36).slice(-6).toUpperCase();

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

        const cleanBase = normalizeBasePath(basePath);
        const base = isLocalOrigin(origin) && cleanBase ? `${origin}${cleanBase}` : SITE_URL;

        const orderRef = makeOrderRef();

        // Build Stripe line_items from server truth
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

        // Shipping options: always offer the set; free option appears automatically when subtotal >= threshold
        const shipping_options = [
            { shipping_rate: SR_UK_STANDARD },
            { shipping_rate: SR_UK_EXPRESS },
            { shipping_rate: SR_EU_TRACKED },
            { shipping_rate: SR_INTL_STANDARD }
        ];

        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            client_reference_id: orderRef,               // <-- orderRef visible in Dashboard & webhooks
            line_items,
            allow_promotion_codes: true,

            billing_address_collection: 'required',
            shipping_address_collection: { allowed_countries: ['GB', 'IE', 'FR', 'DE', 'NL', 'ES', 'IT'] },
            shipping_options,

            metadata: {
                order_ref: orderRef,                       // <-- stored in metadata too
                cart: JSON.stringify(items.map(({ id, quantity, size, color }) => ({ id, quantity, size, color })))
            },

            success_url: `${base}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url:  `${base}/cancel.html`
        });

        // Optional: if you want to use the threshold entirely on client UI you can pass it back here
        const payload = { sessionId: session.id, url: session.url, orderRef };
        return {
            statusCode: 200,
            headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
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