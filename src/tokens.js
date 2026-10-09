// Secure one-time token helpers: 32 random bytes, sha256 hex storage,
// constant-time comparison on lookup.
'use strict';

const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function tokenEquals(storedHash, presentedToken) {
  const presentedHash = hashToken(presentedToken);
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(presentedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { generateToken, hashToken, tokenEquals };
