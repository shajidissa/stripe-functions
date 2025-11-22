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
        console.error('Webhook signature verification failed:', err.message);
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    if (evt.type === 'checkout.session.completed') {
        const session = evt.data.object;

        // Prefer the friendly order number we set at session creation
        const orderNumber =
            session.client_reference_id ||
            session.metadata?.order_number ||
            (session.id ? session.id.slice(-8) : 'ORDER');

        const email =
            session.customer_details?.email ||
            session.customer_email ||
            '';

        // Pull line items for the email summary
        let items;
        try {
            items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 50 });
        } catch (e) {
            console.error('List line items failed:', e);
            items = { data: [] };
        }

        const list = items.data.map(li => {
            const qty = li.quantity || 1;
            const desc = li.description || 'Item';
            const lineTotal = (li.amount_total / 100).toFixed(2);
            return `• ${qty} × ${desc} — £${lineTotal}`;
        }).join('<br>');

        const total = (session.amount_total / 100).toFixed(2);

        // Send email to customer
        if (email) {
            try {
                await resend.emails.send({
                    from: 'Clarity <sales@clarity-clothing.com>',
                    to: email,
                    cc: 'sales@clarity-clothing.com',
                    reply_to: 'sales@clarity-clothing.com',
                    subject: `Thanks for your order — #${orderNumber}`,
                    html: `
            <h2>Thanks for your purchase!</h2>
            <p><strong>Order #${orderNumber}</strong></p>
            <p>${list || 'Your items will be shown on your receipt.'}</p>
            <p><strong>Total paid:</strong> £${total}</p>
            <p>We’ll email you when your order ships.</p>
          `
                });
            } catch (e) {
                console.error('Email send failed:', e);
            }
        }

        // Optional: send a separate internal email (uncomment if you don't want CC above)
        // try {
        //   await resend.emails.send({
        //     from: 'Clarity <sales@clarity-clothing.com>',
        //     to: 'sales@clarity-clothing.com',
        //     subject: `New order — #${orderNumber}`,
        //     html: `<p>Order #${orderNumber}</p><p>${list}</p><p>Total: £${total}</p>`
        //   });
        // } catch (e) { console.error('Internal email failed:', e); }
    }

    return { statusCode: 200, body: 'ok' };
};