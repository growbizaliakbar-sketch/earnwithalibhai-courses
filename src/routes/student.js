// Student area: dashboard, my courses, learn (course overview + lesson player),
// progress tracking. Enrollment is admin-assigned; lessons are visible only to
// enrolled users (or anyone for free-preview lessons).
'use strict';

const express = require('express');
const db = require('../db');
const { wrapRouter } = require('../asyncHandler');
const { requireLogin } = require('../auth');

const router = express.Router();

// Shared helper: full course tree + enrollment/progress for a user.
async function getCourseTree(courseId, userId) {
  const modules = await db.all('SELECT * FROM modules WHERE course_id = ? ORDER BY position, id', courseId);
  const lessonIds = [];
  for (const m of modules) {
    m.lessons = await db.all('SELECT * FROM lessons WHERE module_id = ? ORDER BY position, id', m.id);
    for (const l of m.lessons) lessonIds.push(l.id);
  }
  const total = lessonIds.length;
  let completed = 0;
  const completedSet = new Set();
  if (userId && total) {
    const rows = await db.all(
      `SELECT lesson_id FROM lesson_progress WHERE user_id = ? AND lesson_id IN (${lessonIds.map(() => '?').join(',')})`,
      userId,
      ...lessonIds
    );
    for (const r of rows) completedSet.add(r.lesson_id);
    completed = completedSet.size;
  }
  return { modules, total, completed, completedSet, pct: total ? Math.round((completed / total) * 100) : 0 };
}

async function isEnrolled(userId, courseId) {
  if (!userId) return false;
  return Boolean(await db.get('SELECT 1 FROM enrollments WHERE user_id = ? AND course_id = ?', userId, courseId));
}

async function canAccessLesson(user, course, lesson) {
  if (user && user.role === 'admin') return true;
  if (lesson.is_free_preview) return true;
  if (user && await isEnrolled(user.id, course.id)) return true;
  return false;
}

router.get('/dashboard', requireLogin, async (req, res) => {
  const user = res.locals.currentUser;
  const courses = await db.all(
    `SELECT c.*, e.created_at AS enrolled_at FROM courses c
     JOIN enrollments e ON e.course_id = c.id
     WHERE e.user_id = ? ORDER BY e.created_at DESC`,
    user.id
  );
  const cards = [];
  let completedLessons = 0;
  for (const c of courses) {
    const tree = await getCourseTree(c.id, user.id);
    completedLessons += tree.completed;
    cards.push({ course: c, pct: tree.pct, completed: tree.completed, total: tree.total });
  }
  const avg = cards.length ? Math.round(cards.reduce((s, x) => s + x.pct, 0) / cards.length) : 0;

  // Continue learning: most recent incomplete lesson across enrolled courses.
  let continueCard = null;
  for (const { course } of cards) {
    const modules = await db.all('SELECT id FROM modules WHERE course_id = ? ORDER BY position, id', course.id);
    outer: for (const m of modules) {
      const lessons = await db.all('SELECT * FROM lessons WHERE module_id = ? ORDER BY position, id', m.id);
      for (const l of lessons) {
        const done = await db.get('SELECT 1 FROM lesson_progress WHERE user_id = ? AND lesson_id = ?', user.id, l.id);
        if (!done) {
          continueCard = { course, lesson: l };
          break outer;
        }
      }
    }
    if (continueCard) break;
  }

  res.renderStudent('student/dashboard', {
    title: 'Dashboard — Earn With Ali Bhai',
    activeNav: 'dashboard',
    user,
    cards,
    avg,
    completedLessons,
    continueCard,
  });
});

router.get('/my-courses', requireLogin, async (req, res) => {
  const user = res.locals.currentUser;
  const courses = await db.all(
    `SELECT c.* FROM courses c JOIN enrollments e ON e.course_id = c.id
     WHERE e.user_id = ? ORDER BY e.created_at DESC`,
    user.id
  );
  const cards = [];
  for (const c of courses) {
    const tree = await getCourseTree(c.id, user.id);
    cards.push({ course: c, pct: tree.pct, completed: tree.completed, total: tree.total });
  }
  res.renderStudent('student/my-courses', { title: 'My Courses — Earn With Ali Bhai', activeNav: 'my-courses', cards });
});

router.get('/learn/:slug', requireLogin, async (req, res) => {
  const user = res.locals.currentUser;
  const course = await db.get("SELECT * FROM courses WHERE slug = ? AND status = 'published'", req.params.slug);
  if (!course) {
    return res.status(404).render('public/404', {
      title: 'Course not found',
      heading: 'Course not found',
      message: 'This course is not available.',
    });
  }
  const enrolled = user.role === 'admin' || await isEnrolled(user.id, course.id);
  const tree = await getCourseTree(course.id, enrolled ? user.id : null);

  // Find the "start/continue" lesson: first incomplete, else first lesson.
  let resume = null;
  if (enrolled) {
    outer: for (const m of tree.modules) {
      for (const l of m.lessons) {
        if (!tree.completedSet.has(l.id)) {
          resume = l;
          break outer;
        }
      }
    }
    if (!resume && tree.total) resume = tree.modules[0].lessons[0];
  }

  res.render('student/learn-overview', {
    title: `${course.title} — Learn`,
    course,
    modules: tree.modules,
    total: tree.total,
    completed: tree.completed,
    pct: tree.pct,
    completedSet: tree.completedSet,
    enrolled,
    resume,
  });
});

router.get('/learn/:slug/l/:lessonId', requireLogin, async (req, res) => {
  const user = res.locals.currentUser;
  const course = await db.get("SELECT * FROM courses WHERE slug = ? AND status = 'published'", req.params.slug);
  if (!course) return res.status(404).render('public/404', { title: 'Not found', heading: 'Not found', message: 'Course not available.' });
  const lesson = await db.get(
    `SELECT l.*, m.title AS module_title FROM lessons l JOIN modules m ON m.id = l.module_id
     WHERE l.id = ? AND m.course_id = ?`,
    req.params.lessonId,
    course.id
  );
  if (!lesson) return res.status(404).render('public/404', { title: 'Not found', heading: 'Lesson not found', message: 'This lesson does not exist in this course.' });
  if (!await canAccessLesson(user, course, lesson)) {
    req.flash('error', 'You do not have access to this lesson yet. Course access is assigned by the admin.');
    return res.redirect(`/learn/${course.slug}`);
  }
  const tree = await getCourseTree(course.id, user.id);

  // Flat ordered lesson list for prev/next navigation.
  const flat = [];
  for (const m of tree.modules) for (const l of m.lessons) flat.push(l);
  const idx = flat.findIndex((l) => l.id === lesson.id);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;
  const done = tree.completedSet.has(lesson.id);

  res.render('student/lesson', {
    title: `${lesson.title} — ${course.title}`,
    course,
    lesson,
    modules: tree.modules,
    completedSet: tree.completedSet,
    pct: tree.pct,
    prev,
    next,
    done,
  });
});

router.post('/learn/:slug/l/:lessonId/complete', requireLogin, async (req, res) => {
  const user = res.locals.currentUser;
  const course = await db.get("SELECT * FROM courses WHERE slug = ? AND status = 'published'", req.params.slug);
  if (!course) return res.status(404).send('Not found');
  const lesson = await db.get(
    'SELECT l.* FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = ? AND m.course_id = ?',
    req.params.lessonId,
    course.id
  );
  if (!lesson) return res.status(404).send('Not found');
  if (!await canAccessLesson(user, course, lesson)) return res.status(403).send('Forbidden');
  await db.run(
    `INSERT INTO lesson_progress (user_id, lesson_id, completed_at, last_position)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(user_id, lesson_id) DO UPDATE SET completed_at = excluded.completed_at`,
    user.id,
    lesson.id,
    db.now()
  );
  req.flash('success', 'Lesson marked complete. MashaAllah, keep going!');
  res.redirect(`/learn/${course.slug}/l/${lesson.id}`);
});

module.exports = wrapRouter(router);
module.exports.canAccessLesson = canAccessLesson;
module.exports.isEnrolled = isEnrolled;
module.exports.getCourseTree = getCourseTree;
