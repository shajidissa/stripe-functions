// netlify/functions/stripe-webhook.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

exports.handler = async (event) => {
    // Stripe requires the raw body for signature verification
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

        // Customer email
        const email = session.customer_details?.email || session.customer_email || null;

        // Short order reference like CL-ABC12 (last 5 chars)
        const orderNumber = `CL-${session.id.slice(-5).toUpperCase()}`;

        // Get line items
        const items = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });

        // Compute money bits
        const shippingAmount =
            session.total_details?.amount_shipping ??
            session.shipping_cost?.amount_total ??
            0;

        const subtotal = session.amount_subtotal ?? (session.amount_total - shippingAmount);
        const total = session.amount_total;

        // Try to show the user-friendly shipping rate name
        let shippingLabel = 'Shipping';
        try {
            const rateId = session.shipping_cost?.shipping_rate;
            if (rateId) {
                const rate = await stripe.shippingRates.retrieve(rateId);
                if (rate?.display_name) shippingLabel = rate.display_name;
            }
        } catch {
            /* ignore and fall back */
        }

        // Format money
        const fmt = v => `£${(v / 100).toFixed(2)}`;

        // Build item rows (no images)
        const linesHtml = items.data.map(li => {
            const desc = li.description || 'Item';
            return `<tr>
        <td style="padding:8px 0;">${desc}</td>
        <td style="padding:8px 0; text-align:center;">${li.quantity}</td>
        <td style="padding:8px 0; text-align:right;">${fmt(li.amount_total)}</td>
      </tr>`;
        }).join('');

        // Address
        const addr = session.customer_details?.address || {};
        const name = session.customer_details?.name || '';
        const addressHtml = [name, addr.line1, addr.line2,
            [addr.city, addr.postal_code].filter(Boolean).join(' '),
            addr.state, addr.country].filter(Boolean).join('<br/>');

        // Send the email (no images, no “view order” button)
        if (email) {
            try {
                await resend.emails.send({
                    from: 'Clarity <sales@clarity-clothing.com>',
                    to: email,
                    cc: 'sales@clarity-clothing.com',
                    reply_to: 'sales@clarity-clothing.com',
                    subject: `Clarity order ${orderNumber} confirmed`,
                    html: `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:Inter,Arial,sans-serif;background:#f6f7f9;padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;padding:24px;">
        <tr>
          <td style="text-align:center;padding-bottom:8px;">
            <div style="font-weight:700;font-size:22px;">CLARITY</div>
            <div style="color:#7a7d86;font-size:12px;letter-spacing:.08em;">wear your truth</div>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 0 20px 0;">
            <div style="font-size:18px;font-weight:700;margin-bottom:6px;">Thanks for your purchase!</div>
            <div style="color:#4b4f58;">Order reference: <strong>${orderNumber}</strong></div>
          </td>
        </tr>
        <tr>
          <td>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;border-bottom:1px solid #eee;">
              <tr>
                <th align="left" style="padding:12px 0;color:#7a7d86;font-weight:600;">Item</th>
                <th align="center" style="padding:12px 0;color:#7a7d86;font-weight:600;">Qty</th>
                <th align="right" style="padding:12px 0;color:#7a7d86;font-weight:600;">Total</th>
              </tr>
              ${linesHtml}
            </table>
          </td>
        </tr>
        <tr>
          <td>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
              <tr>
                <td style="color:#7a7d86;">Subtotal</td>
                <td align="right">${fmt(subtotal)}</td>
              </tr>
              <tr>
                <td style="color:#7a7d86;">${shippingLabel}</td>
                <td align="right">${fmt(shippingAmount)}</td>
              </tr>
              <tr>
                <td style="padding-top:8px;font-weight:700;">Total paid</td>
                <td align="right" style="padding-top:8px;font-weight:700;">${fmt(total)}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding-top:16px;">
            <div style="color:#7a7d86;font-size:13px;margin-bottom:6px;">Shipping to</div>
            <div style="line-height:1.5">${addressHtml || '—'}</div>
          </td>
        </tr>
        <tr>
          <td style="padding-top:16px;color:#7a7d86;font-size:12px;">
            Questions? Reply to this email or contact <a href="mailto:sales@clarity-clothing.com">sales@clarity-clothing.com</a>.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`
                });
            } catch (e) {
                console.error('Email send failed:', e);
            }
        }
    }

    // Always acknowledge
    return { statusCode: 200, body: 'ok' };
};