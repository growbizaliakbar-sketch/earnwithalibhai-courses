// Auth middleware: attach user to request, guard routes.
// NOTE: admin routes render 404 (not 403) for non-admins — existence is hidden.
'use strict';

const db = require('./db');

async function loadUser(req, res, next) {
  res.locals.currentUser = null;
  if (req.session && req.session.userId) {
    const user = await db.get(
      'SELECT id, name, email, role, status FROM users WHERE id = ?',
      req.session.userId
    );
    if (user) {
      // If the account was disabled mid-session, kill the session.
      if (user.status === 'disabled') {
        req.session.destroy(() => {});
        return next();
      }
      res.locals.currentUser = user;
    } else {
      delete req.session.userId;
    }
  }
  next();
}

function requireLogin(req, res, next) {
  if (!res.locals.currentUser) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  const user = res.locals.currentUser;
  if (!user || user.role !== 'admin') {
    return res.status(404).render('public/404', {
      title: 'Page not found',
      heading: 'Page not found',
      message: 'The page you are looking for does not exist.',
    });
  }
  next();
}

module.exports = { loadUser, requireLogin, requireAdmin };
