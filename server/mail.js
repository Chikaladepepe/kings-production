'use strict';
/* ============================================================================
   Mailer — a side-channel for emails the engine stores in the `emails` table.
   - Always logs the mail (including an absolute reset link) to the console.
   - If SMTP_* env vars are set, attempts real delivery through nodemailer
     (declared as an optional dependency — the app runs without it).
   The dev mailbox in the Admin Panel remains the primary inbox regardless.
   ============================================================================ */
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

  return {
    deliver(email) {
      const url = absoluteLink(email.link);
      console.log(`[mail:${email.action}] To: ${email.to} | ${email.subject} | ${url || '(no link)'}`);
      if (transporter && email.to) {
        transporter.sendMail({
          from: transporter.options.auth ? transporter.options.auth.user : 'no-reply@kingsproduction.local',
          to: email.to,
          subject: email.subject,
          text: email.body + (url ? '\n\n' + url : ''),
        }).then(() => console.log(`[mail] delivered to ${email.to}`))
          .catch(e => console.warn('[mail] SMTP send failed:', e.message));
      }
      return url;
    },
  };
}

module.exports = { createMailer };
