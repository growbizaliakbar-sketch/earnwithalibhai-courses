// Admin area (/admin/*). requireAdmin renders 404 for non-admins — existence hidden.
// Course management: CRUD courses, modules, lessons (file upload or external URL),
// user management: status, role, enrollments.
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const storage = require('../storage');
const { wrapRouter } = require('../asyncHandler');
const { requireAdmin } = require('../auth');
const { readOutbox, smtpConfigured } = require('../mailer');

const router = express.Router();
router.use(requireAdmin);

// ---------- Multer: thumbnails + videos ----------
// Local mode: files land on disk (uploads/thumbs, uploads/videos) under random names.
// R2 mode (STORAGE_BACKEND=r2): files are held in memory, then pushed to R2 by
// persistThumb()/persistVideo() after the form validates.
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime'];
const VIDEO_EXTS = ['.mp4', '.webm', '.mov'];
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const USE_R2 = storage.backend === 'r2';
const USE_INLINE = storage.backend === 'inline';
// R2 and inline modes hold uploads in memory; persistThumb()/persistVideo()
// push them to the backend after the form validates.
const USE_MEMORY = USE_R2 || USE_INLINE;
// Inline mode: video files are not accepted at all — lessons use the
// "External video URL" field (e.g. YouTube unlisted) instead.
const INLINE_VIDEO_MSG = 'Direct video upload is disabled on this hosting — paste a YouTube (unlisted) link in "External video URL" instead.';

function storageFor(dir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, crypto.randomUUID() + ext);
    },
  });
}

function fileFilter(allowedMimes, allowedExts) {
  return (req, file, cb) => {
    // NOTE: the client-supplied mimetype is not trustworthy (some clients send
    // application/octet-stream), so we validate by file extension. Uploads are
    // stored under random names and served with our own extension->mime map.
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (allowedExts.includes(ext)) return cb(null, true);
    cb(new Error('Invalid file type.'));
  };
}

function videoFileFilter(req, file, cb) {
  if (USE_INLINE) return cb(new Error(INLINE_VIDEO_MSG));
  return fileFilter(VIDEO_MIMES, VIDEO_EXTS)(req, file, cb);
}

const uploadThumb = multer({
  storage: USE_MEMORY ? multer.memoryStorage() : storageFor(db.THUMBS_DIR),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter(IMAGE_MIMES, IMAGE_EXTS),
}).single('thumbnail');

const uploadVideo = multer({
  storage: USE_MEMORY ? multer.memoryStorage() : storageFor(db.VIDEOS_DIR),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
  fileFilter: videoFileFilter,
}).single('video');

// Persist an uploaded file to the active storage backend.
// Returns the value to store in the DB: bare filename (local), full R2 key /
// public URL (r2), or data: URI (inline). Thumbnails are stored as their
// PUBLIC URL in r2 mode so pages can serve them straight from R2.
function uploadExt(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  return ext || '.bin';
}

// Keep the database lean in inline mode: thumbnails are stored as data: URIs
// (base64 inflates ~33%), so cap them at 2 MB.
const INLINE_THUMB_MAX = 2 * 1024 * 1024;

async function persistThumb(file) {
  const key = `thumbs/${crypto.randomUUID()}${uploadExt(file)}`;
  if (USE_INLINE) {
    if (file.buffer.length > INLINE_THUMB_MAX) {
      throw new Error('Thumbnail must be under 2 MB on this hosting — please compress the image and try again.');
    }
    return storage.saveUpload(file.buffer, key, file.mimetype);
  }
  if (USE_R2) {
    await storage.saveUpload(file.buffer, key, file.mimetype);
    return storage.getPublicUrl(key);
  }
  return path.basename(file.path); // already on disk via diskStorage
}

async function persistVideo(file) {
  if (USE_INLINE) throw new Error(INLINE_VIDEO_MSG); // defensive: fileFilter already blocks
  const key = `videos/${crypto.randomUUID()}${uploadExt(file)}`;
  if (USE_R2) {
    await storage.saveUpload(file.buffer, key, file.mimetype);
    return key;
  }
  return path.basename(file.path); // already on disk via diskStorage
}

// Discard an upload that failed validation. In r2/inline mode nothing was
// persisted yet (memory buffer), so this is a no-op; in local mode remove the file.
async function discardUpload(kind, file) {
  if (!file || USE_MEMORY) return;
  await storage.deleteFile(`${kind === 'thumb' ? 'thumbs' : 'videos'}/${path.basename(file.path)}`);
}

// ---------- Helpers ----------
function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'course';
}

async function uniqueSlug(base, excludeId) {
  let slug = slugify(base);
  let n = 1;
  while (await db.get('SELECT id FROM courses WHERE slug = ? AND id <> ?', slug, excludeId || -1)) {
    slug = `${slugify(base)}-${++n}`;
  }
  return slug;
}

// Try ffprobe for duration (optional; silently skip if unavailable).
function probeDuration(filePath) {
  return new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      execFile(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
        { timeout: 15000 },
        (err, stdout) => {
          if (err) return resolve(0);
          const s = Math.round(parseFloat(stdout.trim()));
          resolve(Number.isFinite(s) && s > 0 ? s : 0);
        }
      );
    } catch (_) {
      resolve(0);
    }
  });
}

function deleteFileIfExists(dir, storedName) {
  // Legacy helper kept for local-disk cleanup; prefers the storage abstraction.
  // (dir is ignored — storage routes by key prefix.)
  return storage.deleteFile(storedName);
}

// Probe video duration from an uploaded file. In r2/inline mode the upload only
// exists as a memory buffer, so spill it to a temp file for ffprobe.
async function probeDurationFor(file) {
  if (!file) return 0;
  if (!USE_MEMORY) return probeDuration(file.path);
  const tmp = path.join(os.tmpdir(), `eabh-probe-${crypto.randomUUID()}${uploadExt(file)}`);
  try {
    fs.writeFileSync(tmp, file.buffer);
    return await probeDuration(tmp);
  } finally {
    fs.unlink(tmp, () => {});
  }
}

// ---------- Dashboard ----------
router.get('/', async (req, res) => {
  const stats = {
    users: (await db.get('SELECT COUNT(*) AS n FROM users')).n,
    activeStudents: (await db.get("SELECT COUNT(*) AS n FROM users WHERE role='student' AND status='active'")).n,
    courses: (await db.get('SELECT COUNT(*) AS n FROM courses')).n,
    lessons: (await db.get('SELECT COUNT(*) AS n FROM lessons')).n,
    enrollments: (await db.get('SELECT COUNT(*) AS n FROM enrollments')).n,
  };
  const recentUsers = await db.all('SELECT id, name, email, role, status, created_at FROM users ORDER BY id DESC LIMIT 8');
  const recentContacts = await db.all('SELECT * FROM contact_messages ORDER BY id DESC LIMIT 5');
  const recentCourses = await db.all(
    `SELECT c.*, (SELECT COUNT(*) FROM modules m JOIN lessons l ON l.module_id=m.id WHERE m.course_id=c.id) AS lesson_count,
            (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) AS student_count
     FROM courses c ORDER BY c.updated_at DESC LIMIT 5`
  );
  res.renderAdmin('admin/dashboard', { title: 'Admin — Dashboard', stats, recentUsers, recentContacts, recentCourses });
});

// ---------- Users ----------
router.get('/users', async (req, res) => {
  const q = (req.query.q || '').trim();
  const params = [];
  let where = '1=1';
  if (q) {
    where = '(name LIKE ? OR email LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  const users = await db.all(
    `SELECT u.*, (SELECT COUNT(*) FROM enrollments e WHERE e.user_id = u.id) AS course_count
     FROM users u WHERE ${where} ORDER BY u.id DESC LIMIT 200`,
    ...params
  );
  res.renderAdmin('admin/users', { title: 'Admin — Users', users, q });
});

router.get('/users/:id', async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!user) return res.status(404).render('public/404', { title: 'Not found', heading: 'User not found', message: '' });
  const enrollments = await db.all(
    `SELECT c.id, c.title, c.slug, e.created_at FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = ? ORDER BY e.created_at DESC`,
    user.id
  );
  const allCourses = await db.all('SELECT id, title FROM courses ORDER BY title');
  res.renderAdmin('admin/user-detail', { title: `Admin — ${user.name}`, user, enrollments, allCourses });
});

router.post('/users/:id/status', async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!user) return res.status(404).send('Not found');
  const status = req.body.status;
  if (!['active', 'disabled'].includes(status)) return res.status(400).send('Bad status');
  if (user.id === res.locals.currentUser.id) {
    req.flash('error', 'You cannot disable your own account.');
    return res.redirect(`/admin/users/${user.id}`);
  }
  await db.run('UPDATE users SET status = ? WHERE id = ?', status, user.id);
  req.flash('success', `${user.email} is now ${status}.`);
  res.redirect(`/admin/users/${user.id}`);
});

router.post('/users/:id/role', async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!user) return res.status(404).send('Not found');
  const role = req.body.role;
  if (!['student', 'admin'].includes(role)) return res.status(400).send('Bad role');
  if (user.id === res.locals.currentUser.id) {
    req.flash('error', 'You cannot change your own role.');
    return res.redirect(`/admin/users/${user.id}`);
  }
  await db.run('UPDATE users SET role = ? WHERE id = ?', role, user.id);
  req.flash('success', `${user.email} role set to ${role}.`);
  res.redirect(`/admin/users/${user.id}`);
});

router.post('/users/:id/enroll', async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  const course = await db.get('SELECT * FROM courses WHERE id = ?', req.body.course_id);
  if (!user || !course) return res.status(404).send('Not found');
  await db.run(
    'INSERT INTO enrollments (user_id, course_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id, course_id) DO NOTHING',
    user.id,
    course.id,
    db.now()
  );
  req.flash('success', `Enrolled ${user.email} in "${course.title}".`);
  res.redirect(`/admin/users/${user.id}`);
});

router.post('/users/:id/unenroll', async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!user) return res.status(404).send('Not found');
  await db.run('DELETE FROM enrollments WHERE user_id = ? AND course_id = ?', user.id, req.body.course_id);
  req.flash('success', 'Enrollment removed.');
  res.redirect(`/admin/users/${user.id}`);
});

// ---------- Courses ----------
router.get('/courses', async (req, res) => {
  const courses = await db.all(
    `SELECT c.*,
       (SELECT COUNT(*) FROM modules m JOIN lessons l ON l.module_id = m.id WHERE m.course_id = c.id) AS lesson_count,
       (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS student_count
     FROM courses c ORDER BY c.updated_at DESC`
  );
  res.renderAdmin('admin/courses', { title: 'Admin — Courses', courses });
});

router.get('/courses/new', async (req, res) => {
  res.renderAdmin('admin/course-form', { title: 'Admin — New course', course: null, formAction: '/admin/courses' });
});

router.post('/courses', async (req, res) => {
  uploadThumb(req, res, async (err) => {
    if (err) {
      req.flash('error', `Thumbnail upload failed: ${err.message}`);
      return res.redirect('/admin/courses/new');
    }
    const b = req.body;
    const title = (b.title || '').trim().slice(0, 160);
    if (!title) {
      req.flash('error', 'Course title is required.');
      return res.redirect('/admin/courses/new');
    }
    const slug = await uniqueSlug((b.slug || '').trim() || title);
    const t = db.now();
    const info = await db.run(
      `INSERT INTO courses (title, slug, description, short_description, category, price, thumbnail_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      title,
      slug,
      (b.description || '').slice(0, 20000),
      (b.short_description || '').slice(0, 300),
      (b.category || '').trim().slice(0, 80),
      (b.price || 'Free').trim().slice(0, 40) || 'Free',
      req.file ? await persistThumb(req.file) : null,
      b.status === 'published' ? 'published' : 'draft',
      t,
      t
    );
    req.flash('success', `Course "${title}" created. Now add modules and lessons.`);
    res.redirect(`/admin/courses/${info.lastInsertRowid}/manage`);
  });
});

router.get('/courses/:id/edit', async (req, res) => {
  const course = await db.get('SELECT * FROM courses WHERE id = ?', req.params.id);
  if (!course) return res.status(404).render('public/404', { title: 'Not found', heading: 'Course not found', message: '' });
  res.renderAdmin('admin/course-form', { title: 'Admin — Edit course', course, formAction: `/admin/courses/${course.id}` });
});

router.post('/courses/:id', async (req, res) => {
  const course = await db.get('SELECT * FROM courses WHERE id = ?', req.params.id);
  if (!course) return res.status(404).send('Not found');
  uploadThumb(req, res, async (err) => {
    if (err) {
      req.flash('error', `Thumbnail upload failed: ${err.message}`);
      return res.redirect(`/admin/courses/${course.id}/edit`);
    }
    const b = req.body;
    const title = (b.title || '').trim().slice(0, 160);
    if (!title) {
      req.flash('error', 'Course title is required.');
      return res.redirect(`/admin/courses/${course.id}/edit`);
    }
    const slug = await uniqueSlug((b.slug || '').trim() || title, course.id);
    let thumb = course.thumbnail_path;
    if (req.file) {
      await storage.deleteFile(course.thumbnail_path);
      thumb = await persistThumb(req.file);
    }
    await db.run(
      `UPDATE courses SET title=?, slug=?, description=?, short_description=?, category=?, price=?, thumbnail_path=?, status=?, updated_at=? WHERE id=?`,
      title,
      slug,
      (b.description || '').slice(0, 20000),
      (b.short_description || '').slice(0, 300),
      (b.category || '').trim().slice(0, 80),
      (b.price || 'Free').trim().slice(0, 40) || 'Free',
      thumb,
      b.status === 'published' ? 'published' : 'draft',
      db.now(),
      course.id
    );
    req.flash('success', 'Course updated.');
    res.redirect(`/admin/courses/${course.id}/manage`);
  });
});

router.post('/courses/:id/delete', async (req, res) => {
  const course = await db.get('SELECT * FROM courses WHERE id = ?', req.params.id);
  if (!course) return res.status(404).send('Not found');
  // Delete associated video + thumbnail files.
  const videos = await db.all(
    'SELECT l.video_path FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = ?',
    course.id
  );
  for (const v of videos) await storage.deleteFile(v.video_path);
  await storage.deleteFile(course.thumbnail_path);
  await db.run('DELETE FROM courses WHERE id = ?', course.id);
  req.flash('success', `Course "${course.title}" deleted.`);
  res.redirect('/admin/courses');
});

// ---------- Course manage: modules + lessons ----------
router.get('/courses/:id/manage', async (req, res) => {
  const course = await db.get('SELECT * FROM courses WHERE id = ?', req.params.id);
  if (!course) return res.status(404).render('public/404', { title: 'Not found', heading: 'Course not found', message: '' });
  const modules = await db.all('SELECT * FROM modules WHERE course_id = ? ORDER BY position, id', course.id);
  for (const m of modules) {
    m.lessons = await db.all('SELECT * FROM lessons WHERE module_id = ? ORDER BY position, id', m.id);
  }
  res.renderAdmin('admin/course-manage', { title: `Admin — Manage ${course.title}`, course, modules });
});

router.post('/courses/:id/modules', async (req, res) => {
  const course = await db.get('SELECT * FROM courses WHERE id = ?', req.params.id);
  if (!course) return res.status(404).send('Not found');
  const title = (req.body.title || '').trim().slice(0, 160);
  if (!title) {
    req.flash('error', 'Module title is required.');
    return res.redirect(`/admin/courses/${course.id}/manage`);
  }
  const maxPos = (await db.get('SELECT COALESCE(MAX(position), -1) AS m FROM modules WHERE course_id = ?', course.id)).m;
  await db.run('INSERT INTO modules (course_id, title, position, created_at) VALUES (?, ?, ?, ?)', course.id, title, maxPos + 1, db.now());
  await db.run('UPDATE courses SET updated_at = ? WHERE id = ?', db.now(), course.id);
  req.flash('success', `Module "${title}" added.`);
  res.redirect(`/admin/courses/${course.id}/manage`);
});

router.post('/modules/:moduleId/edit', async (req, res) => {
  const mod = await db.get('SELECT * FROM modules WHERE id = ?', req.params.moduleId);
  if (!mod) return res.status(404).send('Not found');
  const title = (req.body.title || '').trim().slice(0, 160);
  if (!title) {
    req.flash('error', 'Module title is required.');
    return res.redirect(`/admin/courses/${mod.course_id}/manage`);
  }
  await db.run('UPDATE modules SET title = ? WHERE id = ?', title, mod.id);
  await db.run('UPDATE courses SET updated_at = ? WHERE id = ?', db.now(), mod.course_id);
  req.flash('success', 'Module renamed.');
  res.redirect(`/admin/courses/${mod.course_id}/manage`);
});

router.post('/modules/:moduleId/delete', async (req, res) => {
  const mod = await db.get('SELECT * FROM modules WHERE id = ?', req.params.moduleId);
  if (!mod) return res.status(404).send('Not found');
  const lessons = await db.all('SELECT video_path FROM lessons WHERE module_id = ?', mod.id);
  for (const l of lessons) await storage.deleteFile(l.video_path);
  await db.run('DELETE FROM modules WHERE id = ?', mod.id);
  await db.run('UPDATE courses SET updated_at = ? WHERE id = ?', db.now(), mod.course_id);
  req.flash('success', 'Module and its lessons deleted.');
  res.redirect(`/admin/courses/${mod.course_id}/manage`);
});

router.post('/modules/:moduleId/move', async (req, res) => {
  const mod = await db.get('SELECT * FROM modules WHERE id = ?', req.params.moduleId);
  if (!mod) return res.status(404).send('Not found');
  const dir = req.body.dir === 'down' ? 1 : -1;
  const sib = await db.get(
    'SELECT * FROM modules WHERE course_id = ? AND position = ?',
    mod.course_id,
    mod.position + dir
  );
  if (sib) {
    await db.run('UPDATE modules SET position = ? WHERE id = ?', mod.position + dir, mod.id);
    await db.run('UPDATE modules SET position = ? WHERE id = ?', mod.position, sib.id);
  }
  res.redirect(`/admin/courses/${mod.course_id}/manage`);
});

// ---------- Lessons ----------
router.get('/lessons/new', async (req, res) => {
  const mod = await db.get('SELECT m.*, c.title AS course_title FROM modules m JOIN courses c ON c.id = m.course_id WHERE m.id = ?', req.query.module);
  if (!mod) return res.status(404).render('public/404', { title: 'Not found', heading: 'Module not found', message: '' });
  res.renderAdmin('admin/lesson-form', {
    title: 'Admin — New lesson',
    lesson: null,
    mod,
    formAction: '/admin/lessons',
    inlineVideo: USE_INLINE,
  });
});

router.post('/lessons', async (req, res) => {
  uploadVideo(req, res, async (err) => {
    if (err) {
      req.flash('error', `Video upload failed: ${err.message}`);
      return res.redirect(`/admin/lessons/new?module=${encodeURIComponent(req.body.module_id || '')}`);
    }
    const mod = await db.get('SELECT * FROM modules WHERE id = ?', req.body.module_id);
    if (!mod) {
      if (req.file) await discardUpload('video', req.file);
      return res.status(404).send('Module not found');
    }
    const title = (req.body.title || '').trim().slice(0, 200);
    if (!title) {
      if (req.file) await discardUpload('video', req.file);
      req.flash('error', 'Lesson title is required.');
      return res.redirect(`/admin/lessons/new?module=${mod.id}`);
    }
    const externalUrl = (req.body.external_video_url || '').trim().slice(0, 500);
    let duration = 0;
    if (req.file) duration = await probeDurationFor(req.file);
    const maxPos = (await db.get('SELECT COALESCE(MAX(position), -1) AS m FROM lessons WHERE module_id = ?', mod.id)).m;
    await db.run(
      `INSERT INTO lessons (module_id, title, description, video_path, external_video_url, duration_seconds, position, is_free_preview, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mod.id,
      title,
      (req.body.description || '').slice(0, 20000),
      req.file ? await persistVideo(req.file) : null,
      externalUrl || null,
      duration,
      maxPos + 1,
      req.body.is_free_preview ? 1 : 0,
      db.now()
    );
    await db.run('UPDATE courses SET updated_at = ? WHERE id = ?', db.now(), mod.course_id);
    req.flash('success', `Lesson "${title}" added.`);
    res.redirect(`/admin/courses/${mod.course_id}/manage`);
  });
});

router.get('/lessons/:id/edit', async (req, res) => {
  const lesson = await db.get(
    'SELECT l.*, m.course_id, c.title AS course_title, m.title AS module_title FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id WHERE l.id = ?',
    req.params.id
  );
  if (!lesson) return res.status(404).render('public/404', { title: 'Not found', heading: 'Lesson not found', message: '' });
  res.renderAdmin('admin/lesson-form', {
    title: 'Admin — Edit lesson',
    lesson,
    mod: null,
    formAction: `/admin/lessons/${lesson.id}`,
    inlineVideo: USE_INLINE,
  });
});

router.post('/lessons/:id', async (req, res) => {
  const lesson = await db.get('SELECT l.*, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = ?', req.params.id);
  if (!lesson) return res.status(404).send('Not found');
  uploadVideo(req, res, async (err) => {
    if (err) {
      req.flash('error', `Video upload failed: ${err.message}`);
      return res.redirect(`/admin/lessons/${lesson.id}/edit`);
    }
    const title = (req.body.title || '').trim().slice(0, 200);
    if (!title) {
      if (req.file) await discardUpload('video', req.file);
      req.flash('error', 'Lesson title is required.');
      return res.redirect(`/admin/lessons/${lesson.id}/edit`);
    }
    const externalUrl = (req.body.external_video_url || '').trim().slice(0, 500);
    let videoPath = lesson.video_path;
    let duration = lesson.duration_seconds;
    if (req.file) {
      await storage.deleteFile(lesson.video_path);
      videoPath = await persistVideo(req.file);
      duration = await probeDurationFor(req.file);
    }
    await db.run(
      'UPDATE lessons SET title = ?, description = ?, video_path = ?, external_video_url = ?, duration_seconds = ?, is_free_preview = ? WHERE id = ?',
      title,
      (req.body.description || '').slice(0, 20000),
      videoPath,
      externalUrl || null,
      duration,
      req.body.is_free_preview ? 1 : 0,
      lesson.id
    );
    await db.run('UPDATE courses SET updated_at = ? WHERE id = ?', db.now(), lesson.course_id);
    req.flash('success', 'Lesson updated.');
    res.redirect(`/admin/courses/${lesson.course_id}/manage`);
  });
});

router.post('/lessons/:id/delete', async (req, res) => {
  const lesson = await db.get('SELECT l.*, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = ?', req.params.id);
  if (!lesson) return res.status(404).send('Not found');
  await storage.deleteFile(lesson.video_path);
  await db.run('DELETE FROM lessons WHERE id = ?', lesson.id);
  await db.run('UPDATE courses SET updated_at = ? WHERE id = ?', db.now(), lesson.course_id);
  req.flash('success', `Lesson "${lesson.title}" deleted.`);
  res.redirect(`/admin/courses/${lesson.course_id}/manage`);
});

router.post('/lessons/:id/move', async (req, res) => {
  const lesson = await db.get('SELECT l.*, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = ?', req.params.id);
  if (!lesson) return res.status(404).send('Not found');
  const dir = req.body.dir === 'down' ? 1 : -1;
  const sib = await db.get('SELECT * FROM lessons WHERE module_id = ? AND position = ?', lesson.module_id, lesson.position + dir);
  if (sib) {
    await db.run('UPDATE lessons SET position = ? WHERE id = ?', lesson.position + dir, lesson.id);
    await db.run('UPDATE lessons SET position = ? WHERE id = ?', lesson.position, sib.id);
  }
  res.redirect(`/admin/courses/${lesson.course_id}/manage`);
});

// ---------- Settings / env status + dev outbox ----------
router.get('/settings', async (req, res) => {
  const cfg = {
    baseUrl: process.env.BASE_URL || '(not set — falls back to request host)',
    adminEmail: process.env.ADMIN_EMAIL ? 'set' : '(not set)',
    smtp: smtpConfigured() ? `configured (${process.env.SMTP_HOST})` : '(not configured — dev outbox mode)',
    sessionSecret: process.env.SESSION_SECRET ? 'set' : '(not set — insecure default in use)',
    cookieSecure: process.env.COOKIE_SECURE || 'auto',
    port: process.env.PORT || '3000',
    nodeEnv: process.env.NODE_ENV || 'development',
    database: db.mode === 'turso' ? 'Turso (libSQL) — production mode' : 'SQLite file (data/app.db) — local mode',
    storage:
      storage.backend === 'r2'
        ? `Cloudflare R2 (bucket: ${process.env.R2_BUCKET || '(not set)'})`
        : storage.backend === 'inline'
          ? 'Inline (thumbnails stored in database; lesson videos via external URL) — Render free mode'
          : 'Local disk (uploads/) — local mode',
  };
  const outbox = smtpConfigured() ? [] : readOutbox().slice(-50).reverse();
  res.renderAdmin('admin/settings', { title: 'Admin — Settings', cfg, outbox, smtp: smtpConfigured() });
});

module.exports = wrapRouter(router);
