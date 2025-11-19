const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

exports.handler = async (event) => {
    const sig = event.headers['stripe-signature'];
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body);

    let evt;
    try {
        evt = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    if (evt.type === 'checkout.session.completed') {
        const session = evt.data.object;
        const email = session.customer_details?.email || session.customer_email;
        const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 50 });

        const list = items.data.map(li => `• ${li.quantity} × ${li.description} — £${(li.amount_total/100).toFixed(2)}`).join('<br>');
        const total = (session.amount_total/100).toFixed(2);

        try {
            await resend.emails.send({
                from: 'Clarity <sales@clarity-clothing.com>',
                to: email,                                // customer
                bcc: 'sales@clarity-clothing.com',        // hidden copy to you
                reply_to: 'sales@clarity-clothing.com',
                subject: `Thanks for your order — #${session.id.slice(-8)}`,
                html: `<h2>Thanks for your purchase!</h2>
         <p>${list}</p>
         <p><strong>Total paid:</strong> £${total}</p>`
            });
        } catch (e) {
            console.error('Email send failed:', e);
        }
    }

    return { statusCode: 200, body: 'ok' };
};