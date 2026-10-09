// App bootstrap: middleware, sessions, rate limits, route mounting, error handlers.
'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const session = require('express-session');

const db = require('./db');
const SQLiteStore = require('./sessionStore');
const { ah } = require('./asyncHandler');
const { loadUser } = require('./auth');

const app = express();
const PORT = Number(process.env.PORT || 3000);

if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

// ---------- Security headers ----------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        mediaSrc: ["'self'", 'https:'],
        frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
  })
);

// ---------- Views ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Render an EJS view to a string (used for email HTML bodies).
app.renderViewAsync = (view, data = {}) =>
  new Promise((resolve, reject) => {
    app.render(view, { ...data, currentUser: null, flash: null }, (err, html) => {
      if (err) return reject(err);
      resolve(html);
    });
  });

// ---------- Body parsing & static ----------
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d', index: false }));
// NOTE: uploads/ is intentionally NOT served statically — videos go through /media.

// ---------- Sessions ----------
const sessionSecret = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
if (!process.env.SESSION_SECRET) {
  // eslint-disable-next-line no-console
  console.warn('[WARN] SESSION_SECRET not set — using insecure dev default. Set it in production.');
}
const baseUrl = process.env.BASE_URL || '';
const cookieSecure =
  process.env.COOKIE_SECURE === '1' || baseUrl.toLowerCase().startsWith('https://');

app.use(
  session({
    name: 'eabh.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: cookieSecure,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    },
    store: new SQLiteStore(),
  })
);

// ---------- Tiny flash helper (session-based) ----------
app.use((req, res, next) => {
  req.flash = (type, msg) => {
    if (!req.session) return;
    req.session.flash = req.session.flash || {};
    req.session.flash[type] = req.session.flash[type] || [];
    req.session.flash[type].push(msg);
  };
  res.locals.flash = null;
  if (req.session && req.session.flash) {
    res.locals.flash = req.session.flash;
    delete req.session.flash;
  }
  next();
});

app.use(ah(loadUser));

// Admin layout helper: renders a view inside views/admin/layout.ejs.
app.use((req, res, next) => {
  res.renderAdmin = (view, data = {}) => {
    app.render(view, { ...res.locals, ...data }, (err, html) => {
      if (err) return next(err);
      res.render('admin/layout', { ...res.locals, ...data, body: html });
    });
  };
  // Student layout helper: renders a view inside views/student/layout.ejs (sidebar).
  res.renderStudent = (view, data = {}) => {
    app.render(view, { ...res.locals, ...data }, (err, html) => {
      if (err) return next(err);
      res.render('student/layout', { ...res.locals, ...data, body: html });
    });
  };
  next();
});

// ---------- Routes ----------
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.use('/', require('./routes/public'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/student'));
app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/media'));

// 404 handler (public).
app.use((req, res) => {
  res.status(404).render('public/404', {
    title: 'Page not found',
    heading: 'Page not found',
    message: 'The page you are looking for does not exist.',
  });
});

// Error handler: log server-side, generic page to the client.
app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('[ERROR]', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).render('public/404', {
    title: 'Something went wrong',
    heading: 'Something went wrong',
    message: 'An unexpected error occurred. Please try again later.',
  });
});

// Prune expired sessions every 30 minutes.
const sessionStore = new SQLiteStore();
setInterval(() => {
  sessionStore.prune().catch(() => {});
}, 30 * 60 * 1000).unref();

// ---------- Start (only after the database schema is ready) ----------
db.ready.then(
  () => {
    const server = app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`[Earn With Ali Bhai] Listening on http://localhost:${PORT}`);
      // eslint-disable-next-line no-console
      console.log(`[db] mode=${db.mode}${db.mode === 'turso' ? ' (Turso/libSQL)' : ' (local SQLite file)'}`);
      if (!process.env.ADMIN_EMAIL) {
        // eslint-disable-next-line no-console
        console.log('[hint] Set ADMIN_EMAIL in .env, then run: node src/seed.js make-admin <your-email> <password>');
      } else {
        // eslint-disable-next-line no-console
        console.log(`[hint] Admin email: ${process.env.ADMIN_EMAIL} — create it with: node src/seed.js make-admin`);
      }
    });

    function shutdown(signal) {
      // eslint-disable-next-line no-console
      console.log(`[${signal}] Shutting down gracefully…`);
      server.close(() => {
        db.close()
          .catch(() => {})
          .finally(() => process.exit(0));
      });
      setTimeout(() => process.exit(1), 8000).unref();
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  },
  (err) => {
    // Clear, credential-free message — no stack dump.
    // eslint-disable-next-line no-console
    console.error('[DB] ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }
);

module.exports = app;
