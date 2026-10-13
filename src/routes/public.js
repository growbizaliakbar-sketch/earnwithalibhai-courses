// Public pages: home, about, courses, course detail, contact, privacy, terms.
'use strict';

const express = require('express');
const db = require('../db');
const { wrapRouter } = require('../asyncHandler');
const { sendMail, smtpConfigured } = require('../mailer');

const router = express.Router();

router.get('/', async (req, res) => {
  const featured = await db.all(
    "SELECT c.*, (SELECT COUNT(*) FROM modules m JOIN lessons l ON l.module_id = m.id WHERE m.course_id = c.id) AS lesson_count, (SELECT COALESCE(SUM(l.duration_seconds),0) FROM modules m JOIN lessons l ON l.module_id = m.id WHERE m.course_id = c.id) AS total_seconds FROM courses c WHERE c.status = 'published' ORDER BY c.created_at DESC LIMIT 6"
  );
  const categories = db
    .all(
      "SELECT category AS name, COUNT(*) AS course_count FROM courses WHERE status = 'published' AND category <> '' GROUP BY category ORDER BY course_count DESC LIMIT 8"
    );
  const stats = {
    students: 300,
    courses: (await db.get("SELECT COUNT(*) AS n FROM courses WHERE status='published'")).n,
    lessons: (await db.get('SELECT COUNT(*) AS n FROM lessons')).n,
  };
  res.render('public/home', { title: 'Earn With Ali Bhai — Learn real skills. Grow with barakah.', featured, categories, stats });
});

router.get('/about', async (req, res) => {
  res.render('public/about', { title: 'About — Earn With Ali Bhai' });
});

router.get('/courses', async (req, res) => {
  const q = (req.query.q || '').trim();
  const cat = (req.query.category || '').trim();
  const where = ["c.status = 'published'"];
  const params = [];
  if (q) {
    where.push('(c.title LIKE ? OR c.short_description LIKE ? OR c.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (cat) {
    where.push('c.category = ?');
    params.push(cat);
  }
  const courses = await db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM modules m JOIN lessons l ON l.module_id = m.id WHERE m.course_id = c.id) AS lesson_count,
     (SELECT COALESCE(SUM(l.duration_seconds),0) FROM modules m JOIN lessons l ON l.module_id = m.id WHERE m.course_id = c.id) AS total_seconds
     FROM courses c WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC`,
    ...params
  );
  const categories = (
    await db.all(
      "SELECT DISTINCT category AS name FROM courses WHERE status = 'published' AND category <> '' ORDER BY category"
    )
  ).map((r) => r.name);
  res.render('public/courses', { title: 'Courses — Earn With Ali Bhai', courses, categories, q, selectedCategory: cat });
});

router.get('/courses/:slug', async (req, res) => {
  const course = await db.get("SELECT * FROM courses WHERE slug = ? AND status = 'published'", req.params.slug);
  if (!course) {
    return res.status(404).render('public/404', {
      title: 'Course not found',
      heading: 'Course not found',
      message: 'This course may not be published yet, or the link is wrong.',
    });
  }
  const modules = await db.all('SELECT * FROM modules WHERE course_id = ? ORDER BY position, id', course.id);
  for (const m of modules) {
    m.lessons = await db.all(
      'SELECT id, title, duration_seconds, is_free_preview, position FROM lessons WHERE module_id = ? ORDER BY position, id',
      m.id
    );
  }
  const lessonCount = modules.reduce((n, m) => n + m.lessons.length, 0);
  res.render('public/course-detail', {
    title: `${course.title} — Earn With Ali Bhai`,
    course,
    modules,
    lessonCount,
  });
});

router.get('/contact', async (req, res) => {
  res.render('public/contact', { title: 'Contact — Earn With Ali Bhai' });
});

router.post('/contact', async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 120);
  const email = (req.body.email || '').trim().slice(0, 160);
  const message = (req.body.message || '').trim().slice(0, 5000);
  if (!name || !email || !message || !/^\S+@\S+\.\S+$/.test(email)) {
    req.flash('error', 'Please fill in your name, a valid email and your message.');
    return res.redirect('/contact');
  }
  await db.run(
    'INSERT INTO contact_messages (name, email, message, created_at) VALUES (?, ?, ?, ?)',
    name,
    email,
    message,
    db.now()
  );
  // Notify the site owner when SMTP is available (best-effort, never blocks).
  if (smtpConfigured() && process.env.ADMIN_EMAIL) {
    try {
      await sendMail({
        to: process.env.ADMIN_EMAIL,
        subject: `New contact message from ${name}`,
        html: `<p><strong>Name:</strong> ${escapeHtml(name)}</p><p><strong>Email:</strong> ${escapeHtml(email)}</p><p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
        text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
      });
    } catch (err) {
      console.error('contact notify mail failed:', err.message);
    }
  }
  req.flash('success', 'Message received — thank you. We will get back to you soon, in shaa Allah.');
  res.redirect('/contact');
});

router.get('/privacy', async (req, res) => {
  res.render('public/privacy', { title: 'Privacy Policy — Earn With Ali Bhai' });
});

router.get('/terms', async (req, res) => {
  res.render('public/terms', { title: 'Terms & Conditions — Earn With Ali Bhai' });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = wrapRouter(router);
