const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, audit } = require('./db');

const COOKIE = 'collectai_session';

/* ------------------------------------------------------------------ */
/* Brute-force protection                                              */
/* ------------------------------------------------------------------ */

// Two counters: one per email, one per IP. The email counter stops someone
// grinding a known account; the IP counter stops someone spraying many
// accounts from one place. Both decay on their own.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL = 6;
const MAX_PER_IP = 20;

function bucket(key) {
  const now = Date.now();
  const b = attempts.get(key);
  if (!b || now > b.resetAt) {
    const fresh = { count: 0, resetAt: now + WINDOW_MS };
    attempts.set(key, fresh);
    return fresh;
  }
  return b;
}

function checkThrottle(email, ip) {
  const e = bucket('e:' + String(email || '').toLowerCase());
  const i = bucket('i:' + ip);
  if (e.count >= MAX_PER_EMAIL || i.count >= MAX_PER_IP) {
    const waitMs = Math.max(e.resetAt, i.resetAt) - Date.now();
    return Math.max(1, Math.ceil(waitMs / 60000));
  }
  return 0;
}

function recordFailure(email, ip) {
  bucket('e:' + String(email || '').toLowerCase()).count++;
  bucket('i:' + ip).count++;
}

function clearFailures(email, ip) {
  attempts.delete('e:' + String(email || '').toLowerCase());
  attempts.delete('i:' + ip);
}

// Keep the map from growing without bound on a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
}, WINDOW_MS).unref();

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET must be set to a long random string.');
  return s;
}

function bootstrapAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('No users exist and ADMIN_EMAIL / ADMIN_PASSWORD are not set. Nobody can sign in.');
    return;
  }
  db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?,?,?,?)')
    .run(email.toLowerCase(), 'Administrator', bcrypt.hashSync(password, 10), 'admin');
  console.log(`Created the first administrator: ${email}`);
}

function login(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(String(email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) return null;
  audit(user.id, 'user', 'auth.login', 'user', user.id, '');
  return {
    token: jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, secret(), { expiresIn: '12h' }),
    user: { id: user.id, email: user.email, role: user.role, name: user.name },
  };
}

function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Sign in to continue.' });
  try {
    req.user = jwt.verify(token, secret());
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Sign in again.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your role does not have access to this.' });
    }
    next();
  };
}

module.exports = {
  COOKIE, bootstrapAdmin, login, requireAuth, requireRole,
  checkThrottle, recordFailure, clearFailures,
  hash: (p) => bcrypt.hashSync(p, 10),
};
