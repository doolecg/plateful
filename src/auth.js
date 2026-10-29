import crypto from 'node:crypto';
import { db } from './db.js';

// Cookie names from before the rename to Plateful, kept so nobody gets signed out
const COOKIE = 'larder_session';
const YEAR = 365 * 24 * 3600;

export function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}

function pinMatches(pin, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(pin, salt, 32));
}

export const validPin = (pin) => typeof pin === 'string' && /^\d{4,8}$/.test(pin);

// A 4-digit PIN is only safe with a brake on guessing: 5 misses locks that profile for a minute
const misses = new Map();

export function checkPin(profile, pin) {
  const m = misses.get(profile.id);
  if (m && m.count >= 5 && Date.now() - m.at < 60_000) {
    return { error: 'Too many wrong PINs. Try again in a minute.' };
  }
  if (validPin(pin) && pinMatches(pin, profile.pin_hash)) {
    misses.delete(profile.id);
    return { ok: true };
  }
  const count = m && Date.now() - m.at < 60_000 ? m.count + 1 : 1;
  misses.set(profile.id, { count, at: Date.now() });
  return { error: 'Wrong PIN.' };
}

// Over HTTPS (a cloud install behind Caddy) cookies are marked Secure
const cookie = (res, name, value, maxAge) => res.append('Set-Cookie',
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${res.req.secure ? '; Secure' : ''}`);

export function startSession(res, profileId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, profile_id) VALUES (?, ?)').run(token, profileId);
  cookie(res, COOKIE, token, YEAR);
}

/* Household password: set PLATEFUL_PASSWORD when Plateful is reachable from the internet. Without it,
   PINs are the only lock, which is fine behind Tailscale or a home router but not on the open web. */
const HOUSE = process.env.PLATEFUL_PASSWORD || '';
const HOUSE_COOKIE = 'larder_house';
const houseToken = HOUSE && crypto.createHmac('sha256', HOUSE).update('larder household').digest('hex');
export const houseLocked = Boolean(HOUSE);

export function hasHouse(req) {
  if (!HOUSE) return true;
  const m = new RegExp(`(?:^|;\\s*)${HOUSE_COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || '');
  return Boolean(m) && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(houseToken));
}

export function requireHouse(req, res, next) {
  if (hasHouse(req)) return next();
  res.status(401).json({ error: 'Enter the household password.', locked: true });
}

// Ten wrong passwords from one address locks it out for ten minutes
const houseMisses = new Map();
export function unlockHouse(req, res) {
  const now = Date.now();
  const m = houseMisses.get(req.ip);
  if (m && m.count >= 10 && now - m.at < 600_000) return res.status(429).json({ error: 'Too many wrong passwords. Try again in ten minutes.' });
  const given = Buffer.from(String(req.body.password ?? ''));
  const want = Buffer.from(HOUSE);
  if (HOUSE && given.length === want.length && crypto.timingSafeEqual(given, want)) {
    houseMisses.delete(req.ip);
    cookie(res, HOUSE_COOKIE, houseToken, YEAR);
    return res.json({ ok: true });
  }
  houseMisses.set(req.ip, { count: m && now - m.at < 600_000 ? m.count + 1 : 1, at: now });
  res.status(403).json({ error: 'Wrong password.' });
}

function tokenFrom(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || '');
  return m && m[1];
}

export function endSession(req, res) {
  const token = tokenFrom(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  cookie(res, COOKIE, '', 0);
}

// Sets req.profile, or answers 401 so the app shows the profile picker
export function requireProfile(req, res, next) {
  const token = tokenFrom(req);
  const profile = token && db.prepare(`SELECT p.id, p.name FROM sessions s JOIN profiles p ON p.id = s.profile_id
                                       WHERE s.token = ? AND p.pin_hash IS NOT NULL`).get(token);
  if (!profile) return res.status(401).json({ error: 'Pick a profile.', signedOut: true });
  req.profile = profile;
  next();
}
