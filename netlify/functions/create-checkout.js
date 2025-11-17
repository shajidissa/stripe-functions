// This line imports the Stripe library and immediately initializes it
// using the secret key stored in Netlify's environment variables.
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Netlify's standard function handler
exports.handler = async (event) => {
    // Only allow POST requests, as they contain the cart data
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // The items array is sent from your static site's JavaScript.
        const { cartItems } = JSON.parse(event.body);

        // Map your custom cart format to Stripe's required line_items format
        const line_items = cartItems.map(item => ({
            price_data: {
                currency: 'gbp',
                product_data: {
                    name: item.name,
                    // You can also add images or descriptions here
                },
                // Stripe requires the price in the smallest currency unit (pence).
                unit_amount: item.priceInPence,
            },
            quantity: item.quantity,
        }));

        // Create the secure Stripe Checkout session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: line_items,
            mode: 'payment',
            // **IMPORTANT:** Replace these URLs with your actual GitHub Pages URLs
            success_url: `https://shajidissa.github.io/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://shajidissa.github.io/cancel`,
        });

        // Send the session ID back to your static site to trigger the redirect
        return {
            statusCode: 200,
            body: JSON.stringify({ sessionId: session.id }),
        };

    } catch (error) {
        console.error('Stripe Checkout Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to create Stripe Checkout session.' }),
        };
    }
};