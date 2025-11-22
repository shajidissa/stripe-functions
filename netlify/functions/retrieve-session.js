// netlify/functions/retrieve-session.js
// Returns a trimmed view of the Checkout Session for the success page UI.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const sessionId = event.queryStringParameters.session_id;
    if (!sessionId) {
        return { statusCode: 400, body: 'Missing session_id' };
    }

    try {
        // Expand line items and shipping rate so we can show label + amount.
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ['line_items.data.price.product', 'shipping_cost.shipping_rate'],
        });

        const orderNumber = session.metadata?.order_number || session.id;
        const currency = (session.currency || 'gbp').toUpperCase();

        // Shipping details
        const shippingAmount = session.shipping_cost?.amount_total || 0;
        const shippingLabel =
            session.shipping_cost?.shipping_rate?.display_name ||
            session.shipping_cost?.shipping_rate?.id ||
            (shippingAmount > 0 ? 'Shipping' : 'Free Shipping');

        // Build a clean items array
        const items = (session.line_items?.data || []).map((li) => ({
            name: li.description || li.price?.product?.name || 'Item',
            quantity: li.quantity || 1,
            unit_amount: li.price?.unit_amount || 0,
            amount_total: li.amount_total || 0,
            // Try to pass back a product image if available
            image:
                (li.price?.product?.images && li.price.product.images[0]) ||
                undefined,
        }));

        const payload = {
            orderRef: orderNumber,
            currency,
            subtotal: session.amount_subtotal || 0,
            shipping: {
                label: shippingLabel,
                amount: shippingAmount,
            },
            total: session.amount_total || 0,
            items,
        };

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        };
    } catch (err) {
        console.error('retrieve-session error:', err);
        return { statusCode: 500, body: 'Failed to retrieve session' };
    }
};