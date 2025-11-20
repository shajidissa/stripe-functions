const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const ALLOWED_ORIGINS = [
    'http://localhost:63342',
    'https://stripe-functions-clarity.netlify.app'
];
const cors = (origin) => ({
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
});

exports.handler = async (event) => {
    const origin = event.headers.origin || '';
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: cors(origin) };
    }
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers: cors(origin), body: 'Method Not Allowed' };
    }

    try {
        const id = (event.queryStringParameters || {}).session_id;
        if (!id) return { statusCode: 400, headers: cors(origin), body: 'Missing session_id' };

        const session = await stripe.checkout.sessions.retrieve(id, {
            expand: ['line_items.data.price.product', 'customer_details', 'shipping_details']
        });

        return {
            statusCode: 200,
            headers: { ...cors(origin), 'Content-Type': 'application/json' },
            body: JSON.stringify(session)
        };
    } catch (err) {
        console.error('retrieve-session error:', err);
        return {
            statusCode: 500,
            headers: { ...cors(origin), 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: err.message })
        };
    }
};