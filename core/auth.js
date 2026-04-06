/**
 * JWT authentication using only Node.js built-in `crypto`.
 * Supports full accounts (email + password) and anonymous guest accounts.
 *
 * Token payload: { uid, isGuest, iat, exp }
 */

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

const JWT_SECRET     = process.env.JWT_SECRET     || 'change-me-in-production';
const TOKEN_TTL_SECS = Number(process.env.TOKEN_TTL_SECS) || 60 * 60 * 24 * 30; // 30 days

// ---------------------------------------------------------------------------
// Password helpers (scrypt — safe, no external deps)
// ---------------------------------------------------------------------------

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key  = await scryptAsync(password, salt, 64);
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

  return { token: issueToken(uid, false), uid, isGuest: false };
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
  return { uid: _id, ...rest };
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

export function apiError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
