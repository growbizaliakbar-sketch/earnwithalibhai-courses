# Earn With Ali Bhai — Course Platform

A complete, production-ready course platform: public site, verification-based
auth, student dashboard with progress tracking, admin course management,
protected video streaming, and email. **"Learn real skills. Grow with barakah."**

Stack: Node.js 24, Express 4, EJS, built-in `node:sqlite` (no native deps),
`bcryptjs`, `express-session` (custom SQLite store), `multer`, `nodemailer`,
`helmet`, `express-rate-limit`. No frontend build step.

## Quick start

```bash
npm install
cp .env.example .env   # then edit .env (at least ADMIN_EMAIL + SESSION_SECRET)
npm start
```

Open http://localhost:3000. Health check: http://localhost:3000/healthz → `ok`.

## Create your admin account

```bash
node src/seed.js make-admin you@example.com YourStrongPassword123
```

- If the email already exists, it is promoted to admin (password is also reset when you pass one).
- Or set `ADMIN_EMAIL` in `.env` first: the first user who completes the
  **sign-up → verify → set-password** flow with that email is auto-promoted to admin.
- Admin panel: http://localhost:3000/admin (hidden from normal users; non-admins get a 404).

## Load demo content (optional)

```bash
npm run seed   # == node src/seed.js demo
```

Creates a published demo course ("Digital Skills Starter (DEMO)", 2 modules,
4 lessons, 1 free preview — with a 5-second ffmpeg sample video if `ffmpeg`
is installed) and one draft demo course. Delete them from the admin panel when
you add real courses.

## Upload your first course (admin walkthrough)

1. Log in as admin → open **/admin**.
2. **＋ New Course** → fill title, short + full description, category, price label
   (e.g. `Free`), choose **Published**, upload a thumbnail (image ≤ 5MB) → **Create course**.
3. You're taken to **Manage course**. **Add a module** (e.g. "Getting Started").
4. Click **＋ Add lesson** under the module → title, description, then either:
   - upload a video file (mp4/webm/mov, ≤ 1GB), or
   - paste an **external video URL** (e.g. a YouTube *embed* URL).
   - Tick **Free preview** if anyone should watch it without an account.
5. Repeat for more modules/lessons. Reorder with ↑ ↓.
6. **Users** → open a student → **Enroll in a course** → select the course.
7. As the student: **Dashboard → My Courses → course → Start course** — progress,
   "Mark as complete", and Continue-learning all work immediately.

## Gmail SMTP setup (real emails in production)

1. In your Google account, enable 2-Step Verification.
2. Create an **App Password**: Google Account → Security → App passwords
   (16-character code).
3. In `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=you@gmail.com
   SMTP_PASS=xxxx xxxx xxxx xxxx
   MAIL_FROM=Earn With Ali Bhai <you@gmail.com>
   BASE_URL=https://yourdomain.com
   ```
4. Restart. Without SMTP the app uses **dev outbox mode**: emails go to
   `data/mail-outbox.json` (+ console `[MAIL]` lines), viewable at
   **/admin → Settings**.

## Replacing brand assets

All in `public/images/` — just overwrite the files (keep the names):

| File | Used as |
|---|---|
| `logo.svg` | Navbar, auth pages, footer, emails |
| `founder.jpg` | **Founder section** (home + about) and course instructor card — his **real professional photo** (in use) |
| `founder-placeholder.svg` | Unused placeholder kept on disk (superseded by `founder.jpg`) |
| `favicon.svg` | Browser tab icon |

Testimonial names/quotes on the home page are placeholders marked "editable" —
replace them in `views/public/home.ejs` with real student feedback.

## Production mode: stateless hosting (Render free tier + Turso + R2, $0)

The app runs in **two modes**, picked automatically from env vars — local dev
needs zero config:

| Mode | Database | Uploads | When |
|---|---|---|---|
| **Local** (default) | SQLite file `data/app.db` | Disk `uploads/` | `TURSO_DATABASE_URL` unset |
| **Production** | Turso (libSQL) | Cloudflare R2 | `TURSO_DATABASE_URL` set and/or `STORAGE_BACKEND=r2` |

Setup for production mode:

1. **Turso database** (free tier): https://turso.tech → create database →
   `turso db create eabh-courses`, then `turso db tokens create eabh-courses`.
   Set `TURSO_DATABASE_URL=libsql://...` and `TURSO_AUTH_TOKEN=...`. The app
   creates the full schema itself on first boot.
2. **Cloudflare R2** (free tier: 10 GB storage): dash.cloudflare.com → R2 →
   Create bucket (e.g. `eabh-uploads`) → Manage API tokens → create token with
   **Object Read & Write**. Set `STORAGE_BACKEND=r2`, `R2_ENDPOINT`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
3. **Thumbnails**: R2 → bucket Settings → allow public access via the
   `r2.dev` subdomain (or a custom domain) → set `R2_PUBLIC_URL` to it.
   Thumbnails are stored as public URLs; lesson videos stay private and are
   served via short-lived (5-minute) signed URLs issued **only after** the
   enrollment/free-preview/admin access check.
4. **Render** (free web service): New → Web Service → point at this repo →
   Build: `npm install`, Start: `npm start`. Add all env vars above plus
   `SESSION_SECRET`, `BASE_URL=https://<your>.onrender.com`, `ADMIN_EMAIL`,
   `TRUST_PROXY=1`, `COOKIE_SECURE=1`, and the `SMTP_*` Gmail settings.
   Free services sleep after inactivity (cold start ~30s) — fine for starting out.

Local behavior is 100% unchanged: `npm install && npm start` with an empty
production section in `.env` runs exactly as before.

## Production checklist

- [ ] `SESSION_SECRET` set to a long random value
- [ ] `BASE_URL=https://yourdomain.com`, `COOKIE_SECURE=1`, `TRUST_PROXY=1` (if behind a proxy)
- [ ] `ADMIN_EMAIL` set
- [ ] SMTP configured (Gmail App Password) and a test signup email received
- [ ] Demo courses deleted from the admin panel
- [ ] Back up `data/app.db` and `uploads/` regularly (Docker: mount volumes)
- [ ] Run behind HTTPS (reverse proxy or platform TLS)

## Docker

```bash
docker build -t eabh-courses .
docker run -d -p 3000:3000 \
  -v eabh-data:/app/data -v eabh-uploads:/app/uploads \
  --env-file .env --name eabh eabh-courses
```

## Project layout

```
src/server.js        bootstrap, sessions, rate limits, error handlers
src/db.js            dual-mode DB: local node:sqlite or Turso/libSQL (async helpers)
src/storage.js       upload abstraction: local disk or Cloudflare R2 (S3 API)
src/asyncHandler.js  Express 4 async-error wrapper for routes/middleware
src/sessionStore.js  express-session store on SQLite
src/mailer.js        SMTP or dev-outbox mailer
src/auth.js          loadUser / requireLogin / requireAdmin
src/tokens.js        secure token generation + hashing
src/routes/          public, auth, student, admin, media
src/seed.js          make-admin / demo CLI
views/               EJS templates (public, auth, student, admin, emails)
public/              CSS design system, JS, images, favicon
data/ uploads/      runtime dirs (gitignored)
```

## Security notes

- bcrypt (12 rounds); single-use expiring email tokens stored as sha256 hashes.
- Admin routes return **404** (not 403) for non-admins — existence is hidden.
- Videos are never served statically; uploads get random filenames.
- helmet CSP, rate limits on auth endpoints, httpOnly SameSite session cookies.
- `.env`, `data/`, `uploads/` are gitignored — never commit secrets.
