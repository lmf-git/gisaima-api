/**
 * Outbound email via Mailgun's HTTP API (no SMTP, no extra deps — uses the
 * global fetch in Node 18+). Configured through the Heroku Mailgun addon's
 * env vars:
 *
 *   MAILGUN_API_KEY   — addon-provided private API key
 *   MAILGUN_DOMAIN    — addon-provided sending domain
 *   EMAIL_FROM        — optional "Name <addr>" override (defaults to postmaster@domain)
 *   MAILGUN_API_BASE  — optional region base (EU: https://api.eu.mailgun.net)
 *
 * If Mailgun isn't configured (e.g. local dev), we log what we *would* have
 * sent and return without throwing, so flows stay testable without a provider.
 */

const MAILGUN_API_KEY  = process.env.MAILGUN_API_KEY;
const MAILGUN_DOMAIN   = process.env.MAILGUN_DOMAIN;
const MAILGUN_API_BASE = process.env.MAILGUN_API_BASE || 'https://api.mailgun.net';
const EMAIL_FROM       = process.env.EMAIL_FROM
  || (MAILGUN_DOMAIN ? `Gisaima <postmaster@${MAILGUN_DOMAIN}>` : 'Gisaima <no-reply@localhost>');

export function mailConfigured() {
  return !!(MAILGUN_API_KEY && MAILGUN_DOMAIN);
}

export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) {
    console.warn(`[mail] Mailgun not configured — would send to ${to}: "${subject}"\n${text || html || ''}`);
    return { delivered: false, devLogged: true };
  }

  const form = new URLSearchParams();
  form.set('from', EMAIL_FROM);
  form.set('to', to);
  form.set('subject', subject);
  if (text) form.set('text', text);
  if (html) form.set('html', html);

  const res = await fetch(`${MAILGUN_API_BASE}/v3/${MAILGUN_DOMAIN}/messages`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64'),
    },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`mailgun send failed (${res.status}): ${detail}`);
  }
  return { delivered: true };
}
