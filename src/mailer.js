// Mailer: sends via SMTP when configured, otherwise falls back to a dev outbox.
// Dev mode: appends {to, subject, html, text, at} to data/mail-outbox.json
// and logs a clear [MAIL] line to the console. The admin /admin/settings page
// exposes the outbox ONLY while SMTP is not configured (for local testing).
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

const OUTBOX_PATH = path.join(db.DATA_DIR, 'mail-outbox.json');

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST);
}

function fromAddress() {
  return process.env.MAIL_FROM || 'Earn With Ali Bhai <no-reply@earnwithalibhai.com>';
}

function readOutbox() {
  try {
    if (!fs.existsSync(OUTBOX_PATH)) return [];
    const raw = fs.readFileSync(OUTBOX_PATH, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function writeOutbox(entry) {
  const box = readOutbox();
  box.push(entry);
  fs.writeFileSync(OUTBOX_PATH, JSON.stringify(box, null, 2), 'utf8');
}

async function sendMail({ to, subject, html, text }) {
  if (smtpConfigured()) {
    // Lazy-require so nodemailer isn't a hard runtime dependency in dev.
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth:
        process.env.SMTP_USER || process.env.SMTP_PASS
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
    });
    await transporter.sendMail({ from: fromAddress(), to, subject, html, text });
    return { delivered: true, mode: 'smtp' };
  }

  const entry = { to, subject, html, text, at: new Date().toISOString() };
  writeOutbox(entry);
  // eslint-disable-next-line no-console
  console.log(
    `[MAIL] (dev outbox) to=${to} subject=${subject} -> ${path.relative(path.join(__dirname, '..'), OUTBOX_PATH)}`
  );
  return { delivered: false, mode: 'outbox' };
}

module.exports = { sendMail, smtpConfigured, readOutbox, OUTBOX_PATH };
