// netlify/functions/retrieve-session.js
// Returns a sanitized Checkout Session for the success page.
// - Provides `orderRef` (from client_reference_id/metadata.order_ref)
// - Expands line items (+ product images), tax, shipping
// - CORS mirrors create-checkout.js

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Keep in sync with create-checkout.js
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': reqHdrs || 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method'
});

exports.handler = async (event) => {
    const origin  = event.headers.origin || event.headers.Origin || '';
    const reqHdrs = event.headers['access-control-request-headers'] || event.headers['Access-Control-Request-Headers'] || '';

    // Preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(origin, reqHdrs) };
    }
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers: corsHeaders(origin), body: 'Method Not Allowed' };
    }

    const sessionId = (event.queryStringParameters && event.queryStringParameters.session_id) || '';
    if (!sessionId) {
        return { statusCode: 400, headers: corsHeaders(origin), body: JSON.stringify({ error: 'Missing session_id' }) };
    }

    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: [
                'line_items.data.price.product',
                'total_details',
                'payment_intent',
                'shipping_cost.shipping_rate'
            ]
        });

        // <<< orderRef is what the UI should show >>>
        const orderRef =
            session.client_reference_id ||
            session.metadata?.order_ref ||
            `CL-${String(session.id).slice(-8).toUpperCase()}`;

        const items = (session.line_items?.data || []).map((li) => ({
            description: li.description,
            quantity: li.quantity,
            unit_amount: li.price?.unit_amount ?? null,
            amount_total: li.amount_total,
            currency: li.currency || session.currency,
            image: li.price?.product?.images?.[0] || null
        }));

        const shipping = {
            amount_total: session.shipping_cost?.amount_total ?? 0,
            rate_name: session.shipping_cost?.shipping_rate?.display_name || null
        };

        const totals = {
            currency : session.currency,
            subtotal : session.amount_subtotal ?? null,
            shipping : shipping.amount_total,
            tax      : session.total_details?.amount_tax ?? 0,
            discount : session.total_details?.amount_discount ?? 0,
            total    : session.amount_total ?? null
        };

        const payload = {
            orderRef,                              // <-- here
            sessionId: session.id,
            paymentIntentId: session.payment_intent?.id || null,
            email: session.customer_details?.email || null,
            shipping_address: session.customer_details?.address || null,
            shipping,
            items,
            totals
        };

        return {
            statusCode: 200,
            headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        };
    } catch (err) {
        console.error('retrieve-session error:', err);
        return {
            statusCode: 500,
            headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: err.message })
        };
    }
};