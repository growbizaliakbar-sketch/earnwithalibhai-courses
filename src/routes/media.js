// Media: protected video streaming + public thumbnails.
// uploads/ is NEVER exposed as static files — all access goes through here.
//
// Three backends (see src/storage.js):
//   local  — Range/206 streaming from disk (original behavior).
//   r2     — after the SAME access check, 302 redirect to a short-lived (5 min)
//            signed R2 URL. Thumbnails in r2 mode are stored as public URLs and
//            redirect straight to R2.
//   inline — thumbnails are stored as data: URIs in the DB and decoded here;
//            lesson videos come from the external_video_url field (e.g.
//            YouTube) and redirect after the access check, same as other modes.
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const storage = require('../storage');
const { wrapRouter } = require('../asyncHandler');
const { canAccessLesson } = require('./student');

const router = express.Router();

const VIDEO_MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };

router.get('/media/video/:lessonId', async (req, res) => {
  const user = res.locals.currentUser; // may be null (free previews allowed logged-out)
  const lesson = await db.get(
    `SELECT l.*, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = ?`,
    req.params.lessonId
  );
  if (!lesson) return res.status(404).send('Not found');
  const course = await db.get('SELECT * FROM courses WHERE id = ?', lesson.course_id);
  if (!course) return res.status(404).send('Not found');

  if (!(await canAccessLesson(user, course, lesson))) {
    // Deliberately 404 for non-preview content: do not reveal existence.
    return res.status(user ? 404 : 401).send(user ? 'Not found' : 'Login required');
  }

  // External video URL (e.g. YouTube embed): redirect after the access check.
  if (lesson.external_video_url && !lesson.video_path) {
    return res.redirect(302, lesson.external_video_url);
  }
  if (!lesson.video_path) return res.status(404).send('No video for this lesson');

  // R2 mode: signed URL issued ONLY after the access check above.
  if (storage.backend === 'r2') {
    let url;
    try {
      url = await storage.getSignedUrl(lesson.video_path, 300);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[media] signed URL failed:', err && err.message ? err.message : err);
      return res.status(502).send('Video temporarily unavailable. Please try again.');
    }
    return res.redirect(302, url);
  }

  // Local mode: stream from disk with Range support.
  const filePath = path.join(db.VIDEOS_DIR, path.basename(lesson.video_path));
  if (!filePath.startsWith(db.VIDEOS_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).send('Video file missing');
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = VIDEO_MIME[ext] || 'video/mp4';
  const total = stat.size;
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) return res.status(416).send('Invalid range');
    let start = m[1] === '' ? 0 : parseInt(m[1], 10);
    let end = m[2] === '' ? total - 1 : parseInt(m[2], 10);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).send('Range not satisfiable');
    }
    end = Math.min(end, total - 1);
    res.status(206);
    res.set({
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.set({
      'Accept-Ranges': 'bytes',
      'Content-Length': total,
      'Content-Type': mime,
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

const THUMB_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif' };

router.get('/media/thumb/:courseId', async (req, res) => {
  const course = await db.get('SELECT thumbnail_path FROM courses WHERE id = ?', req.params.courseId);
  if (!course || !course.thumbnail_path) return res.status(404).send('No thumbnail');
  // Inline mode stores the data: URI itself — decode and serve it.
  const dataUri = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(course.thumbnail_path);
  if (dataUri) {
    const mime = dataUri[1] || 'application/octet-stream';
    const buf = dataUri[2] ? Buffer.from(dataUri[3], 'base64') : Buffer.from(decodeURIComponent(dataUri[3]));
    res.set('Content-Type', mime);
    res.set('Content-Length', buf.length);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(buf);
  }
  // R2 mode stores the public thumbnail URL at upload time — serve it directly.
  if (/^https?:\/\//i.test(course.thumbnail_path)) {
    return res.redirect(302, course.thumbnail_path);
  }
  const filePath = path.join(db.THUMBS_DIR, path.basename(course.thumbnail_path));
  if (!filePath.startsWith(db.THUMBS_DIR) || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const ext = path.extname(filePath).toLowerCase();
  res.set('Content-Type', THUMB_MIME[ext] || 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(filePath).pipe(res);
});

module.exports = wrapRouter(router);
