'use strict';
/* ============================================================================
   Mailer — a side-channel for emails the engine stores in the `emails` table.
   - Always logs the mail (including an absolute link) to the console.
   - If SMTP_* env vars are set, attempts real delivery through nodemailer
     (declared as an optional dependency — the app runs without it).
   - Emails are rendered as branded HTML (dark + gold, crown logo, CTA button)
     with a plain-text fallback for clients that only show text.
   The dev mailbox in the Admin Panel remains the primary inbox regardless.
   ============================================================================ */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* Per-purpose eyebrow + button label for the CTA. */
const ACTION_META = {
  verify: { eyebrow: 'Confirm your email', btn: 'Verify my email' },
  registercode: { eyebrow: 'Sign-up code', btn: 'Continue registration' },
  reset: { eyebrow: 'Security', btn: 'Reset my password' },
  receipt: { eyebrow: 'Your receipt', btn: 'View my licenses' },
  ticket: { eyebrow: 'Support', btn: 'Open my ticket' },
  default: { eyebrow: 'Kings Production', btn: 'Open Kings Production' },
};
const CROWN_SVG = '<svg viewBox="0 0 24 24" width="46" height="46" fill="#d4af37" xmlns="http://www.w3.org/2000/svg"><path d="M4 16.5V10l4.2 3.6L12 6.5l3.8 7.1L20 10v6.5a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 16.5Z"/><rect x="5.2" y="19" width="13.6" height="1.8" rx="0.9"/></svg>';
function emailHtml({ subject, body, url, action } = {}) {
  const m = ACTION_META[action] || ACTION_META.default;
  const text = escHtml(body).replace(/\n/g, '<br>');
  const btn = url ? `<a href="${escHtml(url)}" style="display:inline-block;background:#d4af37;color:#101014;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;text-decoration:none;padding:13px 28px;border-radius:10px;margin-top:24px;">${escHtml(m.btn)}</a>` : '';
  return `<!doctype html>
<html><body style="margin:0;padding:0;background-color:#0b0b0e;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0b0e;">
<tr><td align="center" style="padding:36px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
<tr><td align="center" style="padding:0 0 24px;">
  ${CROWN_SVG}
  <div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;font-weight:700;color:#ffffff;letter-spacing:2px;margin-top:10px;">KINGS <span style="color:#d4af37;">PRODUCTION</span></div>
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#7c7c88;letter-spacing:4px;margin-top:6px;">WHERE EXCELLENCE MEETS INNOVATION</div>
</td></tr>
<tr><td style="background-color:#131318;border:1px solid #2b2b35;border-radius:16px;padding:34px 36px;">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#d4af37;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">${escHtml(m.eyebrow)}</div>
  <div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;color:#ffffff;font-weight:700;margin:0 0 16px;">${escHtml(subject)}</div>
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.75;color:#c9c9d2;">${text}</div>
  ${btn}
</td></tr>
<tr><td align="center" style="padding:28px 16px 0;">
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6f6f7a;line-height:1.7;">You received this email because you have an account on kingsproduction.cc.<br>&copy; ${new Date().getFullYear()} Kings Production &middot; Premium Roblox Development Studio</div>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function createMailer({ baseUrl, smtp } = {}) {
  const root = String(baseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  let transporter = null;
  if (smtp && smtp.host) {
    try {
      const nodemailer = require('nodemailer'); // optional
      transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port || 587,
        secure: !!(smtp.secure),
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      });
    } catch (e) {
      console.warn('[mail] nodemailer unavailable — falling back to mailbox + console only:', e.message);
    }
  }

  function absoluteLink(link) {
    if (!link) return null;
    if (/^https?:\/\//.test(link)) return link;
    return root + '/' + String(link).replace(/^#\/?/, '#/');
  }

  const fromAddr = (smtp && smtp.from) || (transporter && transporter.options.auth && transporter.options.auth.user) || 'no-reply@kingsproduction.local';

  return {
    deliver(email) {
      const url = absoluteLink(email.link);
      console.log(`[mail:${email.action}] To: ${email.to} | from ${fromAddr} | ${email.subject} | ${url || '(no link)'}`);
      if (transporter && email.to) {
        transporter.sendMail({
          from: { name: 'Kings Production', address: fromAddr },
          to: email.to,
          subject: email.subject,
          text: email.body + (url ? '\n\n' + url : ''),
          html: emailHtml({ subject: email.subject, body: email.body, url, action: email.action }),
        }).then(() => console.log(`[mail] delivered to ${email.to}`))
          .catch(e => console.warn('[mail] SMTP send failed:', e.message));
      }
      return url;
    },
  };
}

module.exports = { createMailer, emailHtml };
