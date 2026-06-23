/**
 * Outbound email via Mailtrap SMTP (nodemailer). The Heroku Mailtrap addon
 * provisions SMTP credentials — the management/API token it also exposes is NOT
 * accepted by Mailtrap's HTTP send API, so SMTP is the reliable path.
 *
 * Env vars. The Heroku Mailtrap addon provisions MAILTRAP_HOST / MAILTRAP_PORT /
 * MAILTRAP_USER_NAME / MAILTRAP_PASSWORD; we read those first and fall back to
 * the MAILTRAP_SMTP_* names so either can be set by hand. (Sandbox shown as
 * defaults.)
 *
 *   MAILTRAP_HOST / MAILTRAP_SMTP_HOST — SMTP host (default sandbox.smtp.mailtrap.io)
 *   MAILTRAP_PORT / MAILTRAP_SMTP_PORT — 465 (TLS), or 587 / 2525 (STARTTLS). Default 2525.
 *   MAILTRAP_USER_NAME / MAILTRAP_SMTP_USER — SMTP username (required)
 *   MAILTRAP_PASSWORD  / MAILTRAP_SMTP_PASS — SMTP password (required)
 *   EMAIL_FROM         — optional "Name <addr>" (or bare "addr") sender.
 *                        For live sending the address must be on a domain you've
 *                        verified in Mailtrap; the sandbox accepts anything.
 *
 * If no SMTP credentials are configured (e.g. local dev) we log what we *would*
 * have sent and return without throwing, so flows stay testable.
 */

import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.MAILTRAP_HOST || process.env.MAILTRAP_SMTP_HOST || 'sandbox.smtp.mailtrap.io';
const SMTP_PORT = Number(process.env.MAILTRAP_PORT || process.env.MAILTRAP_SMTP_PORT || 2525);
const SMTP_USER = process.env.MAILTRAP_USER_NAME || process.env.MAILTRAP_SMTP_USER;
const SMTP_PASS = process.env.MAILTRAP_PASSWORD || process.env.MAILTRAP_SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Gisaima <hello@demomailtrap.co>';

export function mailConfigured() {
  return !!(SMTP_USER && SMTP_PASS);
}

// Lazily build a single reusable transport so we don't open a connection (or
// throw on missing creds) at import time.
let _transport;
function _getTransport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,      // 465 = implicit TLS; 587/2525 = STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return _transport;
}

export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) {
    console.warn(`[mail] Mailtrap SMTP not configured — would send to ${to}: "${subject}"\n${text || html || ''}`);
    return { delivered: false, devLogged: true };
  }

  const info = await _getTransport().sendMail({
    from: EMAIL_FROM,
    to,
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
  });
  return { delivered: true, messageId: info.messageId };
}
