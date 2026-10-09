// Authentication: verification-based registration flow, login, logout,
// forgot/reset password, profile. All password rules: min 8 chars, letter + number.
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { wrapRouter } = require('../asyncHandler');
const { sendMail } = require('../mailer');
const { generateToken, hashToken, tokenEquals } = require('../tokens');
const { requireLogin } = require('../auth');

const router = express.Router();

// Strict per-IP limiter just for login attempts.
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts — please wait a minute and try again.',
});

// Generous limiter for the other auth endpoints (signup / verify / forgot-password).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests — please try again later.',
});

const GENERIC_SIGNUP_MSG = 'If this email is registered, check your inbox for next steps.';
const GENERIC_FORGOT_MSG = 'If an account exists for this email, a reset link has been sent.';

function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function passwordProblems(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw))
    return 'Password must contain at least one letter and one number.';
  return null;
}

async function createEmailToken(userId, purpose, hours) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  await db.run(
    'INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    userId,
    hashToken(token),
    purpose,
    expiresAt,
    db.now()
  );
  return token;
}

// Look up a single-use token row; returns {row} or {error}.
async function lookupToken(presented, purpose) {
  if (!presented || typeof presented !== 'string') return { error: 'Invalid or expired link.' };
  const candidates = await db.all(
    'SELECT t.*, u.email, u.name, u.status, u.password_hash FROM email_tokens t JOIN users u ON u.id = t.user_id WHERE t.purpose = ? AND t.used_at IS NULL AND t.expires_at > ?',
    purpose,
    db.now()
  );
  for (const row of candidates) {
    if (tokenEquals(row.token_hash, presented)) return { row };
  }
  return { error: 'Invalid or expired link. Please request a new one.' };
}

// ---------- Signup: name + email ----------
router.get('/signup', async (req, res) => {
  if (res.locals.currentUser) return res.redirect('/dashboard');
  res.render('auth/signup', { title: 'Create account — Earn With Ali Bhai' });
});

router.post('/signup', authLimiter, async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 120);
  const email = (req.body.email || '').trim().toLowerCase().slice(0, 160);
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) {
    req.flash('error', 'Please enter your full name and a valid email address.');
    return res.redirect('/signup');
  }
  const existing = await db.get('SELECT id FROM users WHERE email = ?', email);
  if (existing) {
    // No account enumeration: same message either way.
    req.flash('success', GENERIC_SIGNUP_MSG);
    return res.redirect('/signup');
  }
  const info = await db.run(
    "INSERT INTO users (name, email, status, created_at) VALUES (?, ?, 'pending_verification', ?)",
    name,
    email,
    db.now()
  );
  const token = await createEmailToken(info.lastInsertRowid, 'verify', 24);
  const link = `${baseUrl(req)}/verify/${token}`;
  try {
    const html = await req.app.renderViewAsync('emails/verify', { name, link });
    await sendMail({
      to: email,
      subject: 'Verify your email — Earn With Ali Bhai',
      html,
      text: `Assalam-o-Alaikum ${name},\n\nPlease verify your email to continue creating your account:\n${link}\n\nThis link expires in 24 hours.\n\n— Team Earn With Ali Bhai`,
    });
  } catch (err) {
    console.error('verification mail failed:', err.message);
  }
  req.flash('success', 'Please check your inbox — a verification link is on its way.');
  res.redirect('/signup');
});

// ---------- Verify email → leads to set-password ----------
router.get('/verify/:token', authLimiter, async (req, res) => {
  const { row, error } = await lookupToken(req.params.token, 'verify');
  if (error) {
    return res.status(400).render('auth/verify-result', {
      title: 'Verification failed',
      ok: false,
      message: error,
    });
  }
  await db.run('UPDATE email_tokens SET used_at = ? WHERE id = ?', db.now(), row.id);
  await db.run("UPDATE users SET status = 'email_verified' WHERE id = ?", row.user_id);
  const next = await createEmailToken(row.user_id, 'set_password', 24);
  req.flash('success', 'Email verified. Now set your password to finish creating your account.');
  res.redirect(`/set-password/${next}`);
});

// ---------- Set password (first time) ----------
router.get('/set-password/:token', async (req, res) => {
  const { row, error } = await lookupToken(req.params.token, 'set_password');
  if (error) {
    return res.status(400).render('auth/verify-result', {
      title: 'Link expired',
      ok: false,
      message: error,
    });
  }
  res.render('auth/set-password', { title: 'Set your password', token: req.params.token, name: row.name });
});

router.post('/set-password/:token', async (req, res) => {
  const { row, error } = await lookupToken(req.params.token, 'set_password');
  if (error) {
    return res.status(400).render('auth/verify-result', { title: 'Link expired', ok: false, message: error });
  }
  const pw = req.body.password || '';
  const pw2 = req.body.password_confirm || '';
  const problem = passwordProblems(pw);
  if (problem || pw !== pw2) {
    req.flash('error', problem || 'Passwords do not match.');
    return res.redirect(`/set-password/${req.params.token}`);
  }
  const hash = await bcrypt.hash(pw, 12);
  let role = 'student';
  if (process.env.ADMIN_EMAIL && row.email.toLowerCase() === process.env.ADMIN_EMAIL.toLowerCase()) {
    role = 'admin'; // bootstrap: the configured owner becomes admin
  }
  await db.run("UPDATE users SET password_hash = ?, status = 'active', role = ? WHERE id = ?", hash, role, row.user_id);
  await db.run('UPDATE email_tokens SET used_at = ? WHERE id = ?', db.now(), row.id);
  // One-time tokens for this user should not be reusable.
  await db.run(
    "UPDATE email_tokens SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND purpose = 'set_password' AND id <> ?",
    db.now(),
    row.user_id,
    row.id
  );
  req.flash('success', 'Account ready — please log in.');
  res.redirect('/login');
});

// ---------- Login ----------
router.get('/login', async (req, res) => {
  if (res.locals.currentUser) return res.redirect('/dashboard');
  res.render('auth/login', { title: 'Log in — Earn With Ali Bhai' });
});

router.post('/login', loginLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const fail = (msg) => {
    req.flash('error', msg);
    return res.redirect('/login');
  };
  const user = await db.get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !user.password_hash) return fail('Invalid email or password.');
  if (user.status === 'disabled') return fail('This account is disabled. Please contact support.');
  if (user.status === 'pending_verification' || user.status === 'email_verified')
    return fail('Please verify your email and set your password before logging in.');
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return fail('Invalid email or password.');
  req.session.regenerate(async (err) => {
    if (err) return fail('Could not start a session. Please try again.');
    req.session.userId = user.id;
    await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', db.now(), user.id);
    const returnTo = req.session.returnTo;
    delete req.session.returnTo;
    req.session.save(() => {
      req.flash('success', `Welcome back, ${user.name.split(' ')[0]}!`);
      res.redirect(returnTo && returnTo.startsWith('/') ? returnTo : '/dashboard');
    });
  });
});

// ---------- Logout ----------
router.post('/logout', async (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('eabh.sid');
    res.redirect('/');
  });
});

// ---------- Forgot password ----------
router.get('/forgot-password', async (req, res) => {
  res.render('auth/forgot-password', { title: 'Forgot password — Earn With Ali Bhai' });
});

router.post('/forgot-password', authLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const user = email ? await db.get('SELECT * FROM users WHERE email = ?', email) : null;
  if (user && user.status === 'active') {
    // Invalidate older reset tokens, issue a fresh 1-hour token.
    await db.run("UPDATE email_tokens SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND purpose = 'reset'", db.now(), user.id);
    const token = await createEmailToken(user.id, 'reset', 1);
    const link = `${baseUrl(req)}/reset-password/${token}`;
    try {
      const html = await req.app.renderViewAsync('emails/reset', { name: user.name, link });
      await sendMail({
        to: user.email,
        subject: 'Reset your password — Earn With Ali Bhai',
        html,
        text: `Assalam-o-Alaikum ${user.name},\n\nReset your password here:\n${link}\n\nThis link expires in 1 hour. If you did not request this, ignore this email.\n\n— Team Earn With Ali Bhai`,
      });
    } catch (err) {
      console.error('reset mail failed:', err.message);
    }
  }
  req.flash('success', GENERIC_FORGOT_MSG);
  res.redirect('/forgot-password');
});

// ---------- Reset password ----------
router.get('/reset-password/:token', async (req, res) => {
  const { error } = await lookupToken(req.params.token, 'reset');
  if (error) {
    return res.status(400).render('auth/verify-result', { title: 'Link expired', ok: false, message: error });
  }
  res.render('auth/reset-password', { title: 'Reset password', token: req.params.token });
});

router.post('/reset-password/:token', async (req, res) => {
  const { row, error } = await lookupToken(req.params.token, 'reset');
  if (error) {
    return res.status(400).render('auth/verify-result', { title: 'Link expired', ok: false, message: error });
  }
  const pw = req.body.password || '';
  const pw2 = req.body.password_confirm || '';
  const problem = passwordProblems(pw);
  if (problem || pw !== pw2) {
    req.flash('error', problem || 'Passwords do not match.');
    return res.redirect(`/reset-password/${req.params.token}`);
  }
  const hash = await bcrypt.hash(pw, 12);
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, row.user_id);
  // Invalidate ALL reset tokens for this user (single-use, session hijack safety).
  await db.run("UPDATE email_tokens SET used_at = COALESCE(used_at, ?) WHERE user_id = ? AND purpose = 'reset'", db.now(), row.user_id);
  req.flash('success', 'Password updated — please log in with your new password.');
  res.redirect('/login');
});

// ---------- Profile ----------
router.get('/profile', requireLogin, async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', res.locals.currentUser.id);
  const enrollCount = (await db.get('SELECT COUNT(*) AS n FROM enrollments WHERE user_id = ?', user.id)).n;
  res.renderStudent('auth/profile', { title: 'Your profile', activeNav: 'profile', user, enrollCount });
});

router.post('/profile', requireLogin, async (req, res) => {
  const uid = res.locals.currentUser.id;
  const name = (req.body.name || '').trim().slice(0, 120);
  if (!name) {
    req.flash('error', 'Name cannot be empty.');
    return res.redirect('/profile');
  }
  await db.run('UPDATE users SET name = ? WHERE id = ?', name, uid);

  const cur = req.body.current_password || '';
  const nw = req.body.new_password || '';
  const nw2 = req.body.new_password_confirm || '';
  if (cur || nw || nw2) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', uid);
    const ok = await bcrypt.compare(cur, user.password_hash || '');
    const problem = passwordProblems(nw);
    if (!ok) req.flash('error', 'Current password is incorrect — name saved, password unchanged.');
    else if (problem || nw !== nw2) req.flash('error', `${problem || 'New passwords do not match.'} Name was saved.`);
    else {
      const hash = await bcrypt.hash(nw, 12);
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, uid);
      req.flash('success', 'Profile and password updated.');
      return res.redirect('/profile');
    }
    return res.redirect('/profile');
  }
  req.flash('success', 'Profile updated.');
  res.redirect('/profile');
});

module.exports = wrapRouter(router);
