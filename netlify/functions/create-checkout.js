const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ✅ add the origins you’ll call from (your local server + your Netlify site)
const ALLOWED_ORIGINS = [
    'http://localhost:63342',             // your local origin (JetBrains/WebStorm)
    'https://clarity-shop.netlify.app'       // your deployed site
];
const corsHeaders = (origin) => ({
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
});

// Keep your existing SITE_URL logic; for Option B either:
//  - leave SITE_URL = your Netlify domain (stripe will redirect to your deployed success/cancel)
//  - OR temporarily set SITE_URL = http://localhost:63342 in Netlify env if you want Stripe to return to local pages during dev.
const SITE_URL =
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    'http://localhost:8888';

exports.handler = async (event) => {
    const origin = event.headers.origin || '';

    // ✅ preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(origin) };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: corsHeaders(origin), body: 'Method Not Allowed' };
    }

    try {
        // ... your existing body parsing + line_items + session creation ...

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
            body: JSON.stringify({ error: 'Failed to create Stripe Checkout session.' })
        };
    }
};