// Seed CLI.
//   node src/seed.js make-admin you@example.com Secret123   — create or promote an admin (sets password)
//   node src/seed.js make-admin                             — promote ADMIN_EMAIL to admin (no password change)
//   node src/seed.js demo                                  — create demo courses (clearly demo-labeled)
'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const db = require('./db');
const storage = require('./storage');
const { OUTBOX_PATH } = require('./mailer');

async function makeAdmin() {
  const emailArg = (process.argv[3] || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.argv[4];
  if (!emailArg) {
    console.error('Usage: node src/seed.js make-admin <email> [password]');
    console.error('   or set ADMIN_EMAIL in .env and run: node src/seed.js make-admin');
    process.exit(1);
  }
  let user = await db.get('SELECT * FROM users WHERE email = ?', emailArg);
  if (!user) {
    if (!password) {
      console.error('No user with that email exists. Provide a password to create one:');
      console.error('  node src/seed.js make-admin <email> <password>');
      process.exit(1);
    }
    const hash = await bcrypt.hash(password, 12);
    const info = await db.run(
      "INSERT INTO users (name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
      emailArg.split('@')[0],
      emailArg,
      hash,
      db.now()
    );
    console.log(`Created admin user ${emailArg} (id ${info.lastInsertRowid}).`);
  } else {
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      await db.run("UPDATE users SET password_hash = ?, role = 'admin', status = 'active' WHERE id = ?", hash, user.id);
      console.log(`Promoted ${emailArg} to admin and set a new password.`);
    } else {
      await db.run("UPDATE users SET role = 'admin' WHERE id = ?", user.id);
      console.log(`Promoted ${emailArg} to admin (password unchanged).`);
    }
  }
}

function makeSampleVideo(outPath) {
  return new Promise((resolve) => {
    // 5-second 640x360 test pattern with a tone — clearly a placeholder.
    execFile(
      'ffmpeg',
      [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x360:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', outPath,
      ],
      { timeout: 60000 },
      (err) => resolve(!err && fs.existsSync(outPath))
    );
  });
}

async function demo() {
  const existing = await db.get("SELECT id FROM courses WHERE slug = 'demo-digital-skills-starter'");
  if (existing) {
    console.log('Demo course already exists — skipping. Delete it from the admin panel to re-seed.');
    return;
  }
  const t = db.now();
  const c1 = (
    await db.run(
      `INSERT INTO courses (title, slug, description, short_description, category, price, status, created_at, updated_at)
       VALUES (?, 'demo-digital-skills-starter', ?, ?, ?, ?, 'published', ?, ?)`,
      'Digital Skills Starter (DEMO)',
      'This is a DEMO course created by the seed script so you can see how the platform works. Delete it from the admin panel when you add your real courses.\n\nIt shows how modules, lessons, free previews and video lessons appear to students.',
      'A demo course showing how lessons, modules and free previews look.',
      'Demo',
      'Free',
      t,
      t
    )
  ).lastInsertRowid;

  const m1 = (
    await db.run('INSERT INTO modules (course_id, title, position, created_at) VALUES (?, ?, 0, ?)', c1, 'Getting Started', t)
  ).lastInsertRowid;
  const m2 = (
    await db.run('INSERT INTO modules (course_id, title, position, created_at) VALUES (?, ?, 1, ?)', c1, 'Your First Skills', t)
  ).lastInsertRowid;

  // Demo video: generate a 5s sample, then persist via the storage backend
  // (local disk in dev; R2 in production mode).
  const tmpSample = path.join(os.tmpdir(), `eabh-demo-sample-${Date.now()}.mp4`);
  const haveVideo = await makeSampleVideo(tmpSample);
  let videoName = null;
  if (haveVideo) {
    try {
      videoName = await storage.saveUpload(fs.readFileSync(tmpSample), 'videos/demo-sample.mp4', 'video/mp4');
    } catch (err) {
      console.error('demo video upload failed (continuing without video):', err.message);
    } finally {
      fs.unlink(tmpSample, () => {});
    }
  }

  await db.run(
    'INSERT INTO lessons (module_id, title, description, video_path, duration_seconds, position, is_free_preview, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?)',
    m1,
    'Welcome — watch this first (FREE PREVIEW)',
    'A free preview lesson. Anyone can watch this without an account, so new visitors can taste the course.',
    videoName,
    haveVideo ? 5 : 0,
    t
  );
  await db.run(
    'INSERT INTO lessons (module_id, title, description, position, is_free_preview, created_at) VALUES (?, ?, ?, 1, 0, ?)',
    m1,
    'How this course works',
    'A text-only lesson (no video attached) showing that lessons can also carry written material.',
    t
  );
  await db.run(
    'INSERT INTO lessons (module_id, title, description, video_path, duration_seconds, position, is_free_preview, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)',
    m2,
    'Skill one: the mindset of consistency',
    'Consistency beats intensity. Small daily progress, with tawakkul, compounds into real skill.',
    videoName,
    haveVideo ? 5 : 0,
    t
  );
  await db.run(
    'INSERT INTO lessons (module_id, title, description, external_video_url, position, is_free_preview, created_at) VALUES (?, ?, ?, ?, 1, 0, ?)',
    m2,
    'External video example',
    'Lessons can also embed an external video URL instead of an uploaded file.',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    t
  );

  await db.run(
    `INSERT INTO courses (title, slug, description, short_description, category, price, status, created_at, updated_at)
     VALUES ('Freelancing Foundations (DEMO DRAFT)', 'demo-freelancing-foundations-draft', 'A draft demo course. Drafts are invisible to students until you publish them.', 'Draft demo — invisible until published.', 'Demo', 'Free', 'draft', ?, ?)`,
    t,
    t
  );

  console.log('Demo content created:');
  console.log('  - Published: "Digital Skills Starter (DEMO)" (2 modules, 4 lessons, 1 free preview)');
  console.log('  - Draft: "Freelancing Foundations (DEMO DRAFT)"');
  console.log(`  - Dev mail outbox: ${OUTBOX_PATH}`);
  console.log('Delete the demo courses from the admin panel once you add real courses.');
}

(async () => {
  const cmd = process.argv[2];
  try {
    if (cmd === 'make-admin') await makeAdmin();
    else if (cmd === 'demo') await demo();
    else {
      console.error('Usage: node src/seed.js <make-admin|demo>');
      process.exit(1);
    }
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    try {
      await db.close();
    } catch (_) {}
  }
})();
