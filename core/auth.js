/**
 * JWT authentication using only Node.js built-in `crypto`.
 * Supports full accounts (email + password) and anonymous guest accounts.
 *
 * Token payload: { uid, isGuest, iat, exp }
 */

import { createHmac, randomBytes, scrypt as scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sendMail } from './mail.js';

const scrpt = promisify(scryptSync);

const JWT_SECRET     = process.env.JWT_SECRET     || 'change-me-in-production';
const TOKEN_TTL_SECS = 60 * 60 * 24 * 30; // 30 days
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // passwordless sign-in link validity

// ---------------------------------------------------------------------------
// Password helpers (scrypt — safe, no external deps)
// ---------------------------------------------------------------------------

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key  = await scrypt(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const hashBuf = Buffer.from(hash, 'hex');
  const derived = /** @type {Buffer} */ (await scryptAsync(password, salt, 64));
  return timingSafeEqual(hashBuf, derived);
}

// ---------------------------------------------------------------------------
// JWT (HS256, no external deps)
// ---------------------------------------------------------------------------

export function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body   = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig    = createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token) return null;
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;
    const expected = createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Issue a token for a user (full or guest) */
export function issueToken(uid, isGuest = false) {
  const now = Math.floor(Date.now() / 1000);
  return signToken({ uid, isGuest, iat: now, exp: now + TOKEN_TTL_SECS });
}

/** Generate a random guest user ID */
export function guestId() {
  return `guest_${randomBytes(8).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Request auth extractor
// ---------------------------------------------------------------------------

/** Extract and verify the Bearer token from a request's Authorization header. */
export function getAuth(req) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  return verifyToken(token);
}

// ---------------------------------------------------------------------------
// Auth route handlers
// ---------------------------------------------------------------------------

const GUEST_ADJECTIVES = ['Swift', 'Bold', 'Brave', 'Clever', 'Fierce', 'Nimble', 'Silent', 'Steely'];
const GUEST_NOUNS      = ['Archer', 'Knight', 'Mage', 'Scout', 'Warrior', 'Ranger', 'Rogue', 'Paladin'];

function randomGuestName() {
  const adj  = GUEST_ADJECTIVES[Math.floor(Math.random() * GUEST_ADJECTIVES.length)];
  const noun = GUEST_NOUNS[Math.floor(Math.random() * GUEST_NOUNS.length)];
  const num  = Math.floor(Math.random() * 9000) + 1000;
  return `${adj}${noun}${num}`;
}

/** POST /auth/guest  — create an anonymous guest account */
export async function handleGuestLogin(db, _req, _body) {
  const uid         = guestId();
  const displayName = randomGuestName();
  await db.collection('users').insertOne({
    _id: uid,
    displayName,
    isGuest: true,
    created: Date.now()
  });
  return { token: issueToken(uid, true), uid, isGuest: true, displayName };
}

/** POST /auth/register  — create a full account (optionally converts a guest) */
export async function handleRegister(db, _req, body) {
  const { email, password, displayName, guestToken } = body;
  if (!email || !password) throw apiError(400, 'email and password required');
  if (password.length < 6) throw apiError(400, 'password must be at least 6 characters');

  const existing = await db.collection('users').findOne({ email });
  if (existing) throw apiError(409, 'email already registered');

  const passwordHash = await hashPassword(password);
  let uid;

  if (guestToken) {
    const guest = verifyToken(guestToken);
    if (!guest?.isGuest) throw apiError(400, 'invalid guest token');
    uid = guest.uid;
    await db.collection('users').updateOne(
      { _id: uid },
      { $set: { email, passwordHash, displayName: displayName || email.split('@')[0], isGuest: false } }
    );
  } else {
    uid = `user_${randomBytes(8).toString('hex')}`;
    await db.collection('users').insertOne({
      _id: uid,
      email,
      passwordHash,
      displayName: displayName || email.split('@')[0],
      isGuest: false,
      created: Date.now()
    });
  }

  return {
    token: issueToken(uid, false), uid, isGuest: false,
    email, displayName: displayName || email.split('@')[0]
  };
}

/** POST /auth/login */
export async function handleLogin(db, _req, body) {
  const { email, password } = body;
  if (!email || !password) throw apiError(400, 'email and password required');

  const user = await db.collection('users').findOne({ email });
  if (!user || !user.passwordHash) throw apiError(401, 'invalid credentials');

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw apiError(401, 'invalid credentials');

  return { token: issueToken(user._id, false), uid: user._id, isGuest: false, displayName: user.displayName };
}

/** UTC calendar-day stamp, e.g. '2026-06-02'. */
function _dayStamp(d) { return new Date(d).toISOString().slice(0, 10); }

/** GET /auth/me */
export async function handleMe(db, req) {
  const auth = getAuth(req);
  if (!auth) throw apiError(401, 'not authenticated');
  const user = await db.collection('users').findOne(
    { _id: auth.uid },
    { projection: { passwordHash: 0 } }
  );
  if (!user) throw apiError(404, 'user not found');
  const { _id, ...rest } = user;

  // Nudge guests to convert to a real account once per calendar day they return.
  // `lastConversionPrompt` on the user doc is the durable record (survives any
  // localStorage loss); we stamp it the first time /auth/me is hit on a new day.
  let promptConversion = false;
  if (user.isGuest) {
    const last = user.lastConversionPrompt ? _dayStamp(user.lastConversionPrompt) : null;
    if (last !== _dayStamp(Date.now())) {
      promptConversion = true;
      await db.collection('users').updateOne(
        { _id }, { $set: { lastConversionPrompt: new Date() } }
      );
    }
  }

  return { uid: _id, ...rest, promptConversion };
}

// ---------------------------------------------------------------------------
// Passwordless email sign-in (magic link)
// ---------------------------------------------------------------------------

function _normEmail(e) { return String(e || '').trim().toLowerCase(); }
function _validEmail(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }

/**
 * POST /auth/email/request — issue a one-time sign-in link and email it.
 *
 * Works for sign-up, log-in, AND guest conversion (pass `guestToken`): the same
 * email may map to at most one account, so a guest converting to an
 * already-registered email is rejected up front. We always 200 on a valid email
 * shape so the endpoint can't be used to probe which addresses exist (except the
 * deliberate conflict signal during conversion, which is the caller's own data).
 */
export async function requestEmailLogin(db, req, body) {
  const email = _normEmail(body.email);
  if (!_validEmail(email)) throw apiError(400, 'a valid email is required');

  let purpose  = 'login';
  let guestUid = null;
  if (body.guestToken) {
    const guest = verifyToken(body.guestToken);
    if (!guest?.isGuest) throw apiError(400, 'invalid guest token');
    guestUid = guest.uid;
    purpose  = 'convert';
  }

  if (purpose === 'convert') {
    const clash = await db.collection('users').findOne({ email });
    if (clash && clash._id !== guestUid) throw apiError(409, 'that email is already registered');
  }

  const token = randomBytes(32).toString('hex');
  await db.collection('magic_links').insertOne({
    _id: token, email, purpose, guestUid,
    createdAt: new Date(), expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
  });

  // Link points at the WEB app (the browser origin that called us), not the API.
  const base = process.env.APP_BASE_URL || req.headers?.origin || '';
  const link = `${base}/login/verify?token=${token}`;
  try {
    await sendMail({
      to: email,
      subject: 'Your Gisaima sign-in link',
      text: `Sign in to Gisaima:\n\n${link}\n\nThis link expires in 15 minutes. `
          + `If you didn't request it, you can safely ignore this email.`,
      html: `<p>Sign in to Gisaima:</p>`
          + `<p><a href="${link}">Sign in</a></p>`
          + `<p style="color:#888;font-size:13px">This link expires in 15 minutes. `
          + `If you didn't request it, you can safely ignore this email.</p>`,
    });
  } catch (err) {
    console.error('[auth] magic-link email failed:', err.message);
    throw apiError(502, 'could not send the sign-in email — please try again');
  }

  return { success: true };
}

/**
 * POST /auth/email/verify — consume a sign-in link and return an auth token.
 * Single-use: the link record is deleted before anything else. Creates the
 * account on first sign-in, upgrades the guest in place on conversion.
 */
export async function verifyEmailLogin(db, _req, body) {
  const token = String(body.token || '');
  if (!token) throw apiError(400, 'token required');

  const rec = await db.collection('magic_links').findOne({ _id: token });
  if (!rec) throw apiError(400, 'this sign-in link is invalid or has already been used');
  await db.collection('magic_links').deleteOne({ _id: token });        // single use
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) {
    throw apiError(400, 'this sign-in link has expired — request a new one');
  }

  const email = rec.email;
  let uid, displayName;

  if (rec.purpose === 'convert' && rec.guestUid) {
    const clash = await db.collection('users').findOne({ email });
    if (clash && clash._id !== rec.guestUid) throw apiError(409, 'that email is already registered');
    const guest = await db.collection('users').findOne({ _id: rec.guestUid });
    uid = rec.guestUid;
    displayName = guest?.displayName || email.split('@')[0];
    await db.collection('users').updateOne(
      { _id: uid },
      { $set: { email, isGuest: false, passwordless: true, displayName } }
    );
  } else {
    const existing = await db.collection('users').findOne({ email });
    if (existing) {
      uid = existing._id;
      displayName = existing.displayName || email.split('@')[0];
      if (existing.isGuest) await db.collection('users').updateOne({ _id: uid }, { $set: { isGuest: false } });
    } else {
      uid = `user_${randomBytes(8).toString('hex')}`;
      displayName = email.split('@')[0];
      await db.collection('users').insertOne({
        _id: uid, email, displayName, isGuest: false, passwordless: true, created: Date.now(),
      });
    }
  }

  return { token: issueToken(uid, false), uid, isGuest: false, email, displayName };
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

export function apiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
