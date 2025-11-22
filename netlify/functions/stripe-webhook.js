// netlify/functions/stripe-webhook.js
// Sends a polished order confirmation email via Resend when Stripe Checkout completes.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Where the “View your order” button points:
const SITE_URL =
    process.env.SITE_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    'https://clarity-shop.netlify.app';

exports.handler = async (event) => {
    const sig = event.headers['stripe-signature'];
    const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : Buffer.from(event.body || '');

    let evt;
    try {
        evt = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return { statusCode: 400, body: `Webhook Error: ${err.message}` };
    }

    // Only handle the event you need
    if (evt.type !== 'checkout.session.completed') {
        return { statusCode: 200, body: 'Ignored' };
    }

    try {
        const session = await stripe.checkout.sessions.retrieve(evt.data.object.id, {
            expand: [
                'line_items.data.price.product',
                'shipping_cost.shipping_rate',
                'payment_intent',
                'customer_details'
            ],
        });

        // Derive order reference (short + friendly) – stays consistent with your create-checkout
        const orderRef =
            session.client_reference_id ||
            session.metadata?.order_ref ||
            session.metadata?.order_number ||
            `CL-${String(session.id).slice(-8).toUpperCase()}`;

        const email = session.customer_details?.email || session.customer_email || null;

        // Pull line items with product images if present
        const lineItems = session.line_items?.data || [];
        const currency = (session.currency || 'gbp').toUpperCase();

        const fmt = (pennies) => `£${(Number(pennies || 0) / 100).toFixed(2)}`;
        const esc = (s) =>
            String(s ?? '')
                .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        // Row HTML for each item
        const itemRowsHtml = lineItems.map((li) => {
            const name = li.description || li.price?.product?.name || 'Item';
            const qty = li.quantity || 1;
            // Prefer line total; fallback to unit*qty
            const lineTotal = li.amount_total ?? (qty * (li.price?.unit_amount ?? 0));
            const img = li.price?.product?.images?.[0] || null;

            return `
        <tr>
          <td style="padding:10px 0; vertical-align:top; width:48px;">
            ${img ? `<img src="${esc(img)}" width="48" height="48" style="border-radius:6px; display:block; object-fit:cover;" alt="">` : ''}
          </td>
          <td style="padding:10px 12px 10px 8px; vertical-align:top; color:#111827; font:14px/20px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
            ${esc(name)}
            ${li.price?.product?.metadata?.base_id ? `<div style="color:#6B7280; font-size:12px;">SKU: ${esc(li.price.product.metadata.base_id)}</div>` : ''}
          </td>
          <td align="center" style="padding:10px 8px; vertical-align:top; color:#374151; font:14px/20px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif; white-space:nowrap;">
            × ${qty}
          </td>
          <td align="right" style="padding:10px 0; vertical-align:top; color:#111827; font:14px/20px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif; white-space:nowrap;">
            ${fmt(lineTotal)}
          </td>
        </tr>
      `;
        }).join('');

        // Totals
        const subtotal   = session.amount_subtotal ?? 0;
        const shipping   = session.shipping_cost?.amount_total ?? 0;
        const tax        = session.total_details?.amount_tax ?? 0;
        const discount   = session.total_details?.amount_discount ?? 0;
        const grandTotal = session.amount_total ?? 0;

        const shipMethod = session.shipping_cost?.shipping_rate?.display_name || 'Shipping';
        const shipAddr = session.customer_details?.address || {};
        const addrHtml = [
            session.customer_details?.name,
            [shipAddr.line1, shipAddr.line2].filter(Boolean).join(', '),
            [shipAddr.city, shipAddr.postal_code].filter(Boolean).join(' '),
            shipAddr.state,
            shipAddr.country
        ].filter(Boolean).map(esc).join('<br>');

        const orderUrl = `${SITE_URL.replace(/\/$/, '')}/success.html?session_id=${encodeURIComponent(session.id)}`;

        // Preheader (hidden preview text)
        const preheader = `Your order ${orderRef} is confirmed. Total ${fmt(grandTotal)}.`;

        // Build a clean HTML email (responsive-friendly, inline styles)
        const html = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width">
    <title>Order ${esc(orderRef)} confirmed</title>
  </head>
  <body style="margin:0; padding:0; background:#F6F9FC;">
    <span style="display:none!important; opacity:0; visibility:hidden; mso-hide:all; font-size:1px; line-height:1px; max-height:0; max-width:0;">
      ${esc(preheader)}
    </span>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td align="center" style="padding:28px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:620px;">
            <!-- Brand -->
            <tr>
              <td align="center" style="padding-bottom:12px;">
                <div style="font:700 22px/28px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif; letter-spacing:0.1em;">
                  CLARITY
                </div>
                <div style="color:#6B7280; font:12px/16px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
                  wear your truth
                </div>
              </td>
            </tr>

            <!-- Card -->
            <tr>
              <td style="background:#FFFFFF; border:1px solid #E5E7EB; border-radius:12px; padding:20px;">
                <table role="presentation" width="100%">
                  <tr>
                    <td style="padding-bottom:10px;">
                      <div style="display:flex; align-items:center; gap:10px;">
                        <span style="display:inline-block; width:36px; height:36px; border-radius:999px; background:#ECFDF5; color:#166534; font:700 18px/36px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif; text-align:center;">✓</span>
                        <div>
                          <div style="font:700 18px/22px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">Thanks for your purchase!</div>
                          <div style="color:#6B7280; font:14px/20px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">We’ve emailed your receipt and will notify you when it ships.</div>
                        </div>
                      </div>
                    </td>
                  </tr>

                  <!-- Order reference -->
                  <tr>
                    <td style="padding:6px 0 14px; color:#111827; font:14px/20px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
                      <strong>Order reference:</strong> ${esc(orderRef)}
                    </td>
                  </tr>

                  <!-- Items -->
                  <tr>
                    <td>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #F3F4F6; border-bottom:1px solid #F3F4F6;">
                        ${itemRowsHtml || `
                          <tr><td style="padding:14px 0; color:#6B7280; font:14px/20px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
                            Your items will be shown on your receipt.
                          </td></tr>
                        `}
                      </table>
                    </td>
                  </tr>

                  <!-- Totals -->
                  <tr>
                    <td style="padding-top:12px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="color:#111827; font:14px/20px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
                        <tr>
                          <td>Subtotal</td>
                          <td align="right">${fmt(subtotal)}</td>
                        </tr>
                        <tr>
                          <td>${esc(shipMethod)}</td>
                          <td align="right">${fmt(shipping)}</td>
                        </tr>
                        ${tax ? `<tr><td>Tax</td><td align="right">${fmt(tax)}</td></tr>` : ''}
                        ${discount ? `<tr><td>Discounts</td><td align="right">- ${fmt(discount)}</td></tr>` : ''}
                        <tr>
                          <td style="padding-top:8px; font-weight:700;">Total paid</td>
                          <td align="right" style="padding-top:8px; font-weight:800;">${fmt(grandTotal)}</td>
                        </tr>
                      </table>
                    </td>
                  </tr>

                  <!-- Shipping address -->
                  ${addrHtml ? `
                  <tr>
                    <td style="padding-top:14px; color:#111827; font:14px/20px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
                      <div style="font-weight:600; margin-bottom:4px;">Shipping to</div>
                      <div style="color:#374151;">${addrHtml}</div>
                    </td>
                  </tr>` : ''}

                  <!-- Button -->
                  <tr>
                    <td align="center" style="padding:18px 0 6px;">
                      <a href="${orderUrl}"
                         style="display:inline-block; background:#111827; color:#FFFFFF; text-decoration:none; padding:12px 20px; border-radius:8px; font:600 14px/20px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
                         View your order
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td align="center" style="padding:14px 8px; color:#6B7280; font:12px/18px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
                Questions? Reply to this email or contact <a href="mailto:sales@clarity-clothing.com" style="color:#111827; text-decoration:none;">sales@clarity-clothing.com</a><br>
                &copy; ${new Date().getFullYear()} Clarity
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
    `.trim();

        // Plain-text fallback for deliverability
        const text = [
            `Thanks for your purchase!`,
            `Order reference: ${orderRef}`,
            '',
            ...lineItems.map(li => {
                const name = li.description || li.price?.product?.name || 'Item';
                const qty  = li.quantity || 1;
                const total = li.amount_total ?? (qty * (li.price?.unit_amount ?? 0));
                return `• ${qty} × ${name} — ${fmt(total)}`;
            }),
            '',
            `Subtotal: ${fmt(subtotal)}`,
            `${shipMethod}: ${fmt(shipping)}`,
            ...(tax ? [`Tax: ${fmt(tax)}`] : []),
            ...(discount ? [`Discounts: -${fmt(discount)}`] : []),
            `Total paid: ${fmt(grandTotal)}`,
            '',
            `View your order: ${orderUrl}`,
            '',
            `If you have any questions, reply to this email.`
        ].join('\n');

        if (email) {
            try {
                await resend.emails.send({
                    from: 'Clarity <sales@clarity-clothing.com>',
                    to: email,
                    cc: 'sales@clarity-clothing.com',
                    reply_to: 'sales@clarity-clothing.com',
                    subject: `Thanks for your order — #${orderRef}`,
                    html,
                    text
                });
            } catch (e) {
                console.error('Email send failed:', {
                    name: e?.name,
                    message: e?.message,
                    status: e?.status,
                    data: e?.response?.data
                });
            }
        }

        return { statusCode: 200, body: 'ok' };
    } catch (err) {
        console.error('stripe-webhook handler error:', err);
        return { statusCode: 500, body: 'Internal Error' };
    }
};