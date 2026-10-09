// Storage abstraction for uploads (thumbnails + lesson videos).
//
// Backends (STORAGE_BACKEND):
//   local (default) — files on disk under uploads/videos + uploads/thumbs,
//                     exactly the original behavior. Zero config.
//   r2              — Cloudflare R2 (S3-compatible) object storage for stateless
//                     hosting (e.g. Render free tier, no persistent disk).
//   inline          — small files (thumbnails) are stored as data: URIs right
//                     in the database; zero external services. Lesson videos
//                     must use the "External video URL" field (e.g. YouTube
//                     unlisted) because video files are not accepted in this
//                     mode. Ideal for Render free tier with no extra accounts.
//
// Keys look like "videos/<uuid>.mp4" / "thumbs/<uuid>.jpg". In local mode the
// DB keeps storing the bare filename (backward compatible); in r2 mode the DB
// stores the full key for videos and the PUBLIC URL for thumbnails; in inline
// mode the DB stores the data: URI itself.
//
// Never logs credentials. All R2 config errors name the missing env vars.
'use strict';

const fs = require('fs');
const path = require('path');

const backend =
  process.env.STORAGE_BACKEND === 'r2' ? 'r2' : process.env.STORAGE_BACKEND === 'inline' ? 'inline' : 'local';

function localDirFor(key) {
  const db = require('./db');
  if (String(key).startsWith('thumbs/')) return db.THUMBS_DIR;
  return db.VIDEOS_DIR; // 'videos/...' or a legacy bare video filename
}

function r2Config() {
  const missing = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    throw new Error(
      `R2 storage is not configured — missing env vars: ${missing.join(', ')}. ` +
        'See .env.example for the full list.'
    );
  }
  return {
    endpoint: process.env.R2_ENDPOINT,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
  };
}

let s3 = null;
function getS3() {
  if (s3) return s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  const cfg = r2Config(); // throws a clear error when misconfigured
  s3 = new S3Client({
    region: 'auto',
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return s3;
}

// Strip an R2 public URL back to its object key (for deletes of replaced files).
function keyFromPublicUrl(maybeUrl) {
  if (!/^https?:\/\//i.test(maybeUrl)) return maybeUrl;
  const base = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  if (base && maybeUrl.startsWith(base + '/')) return maybeUrl.slice(base.length + 1);
  return null; // not one of ours — do not touch
}

async function saveUpload(buffer, key, contentType) {
  if (backend === 'inline') {
    // Store small files directly in the DB as a data: URI. Callers must only
    // use this for thumbnails/small assets — never for video files.
    const mime = contentType || 'application/octet-stream';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  }
  if (backend === 'r2') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const cfg = r2Config();
    await getS3().send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
      })
    );
    return key;
  }
  const dir = localDirFor(key);
  const name = path.basename(key);
  fs.writeFileSync(path.join(dir, name), buffer);
  return name; // local DB values stay bare filenames, as before
}

async function deleteFile(key) {
  if (!key) return;
  if (backend === 'inline') return; // data lives in the DB row; deleted with it
  if (backend === 'r2') {
    const objKey = keyFromPublicUrl(key);
    if (!objKey) return;
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await getS3().send(
        new DeleteObjectCommand({ Bucket: r2Config().bucket, Key: objKey })
      );
    } catch (err) {
      // Best-effort: a missing object is not fatal for admin deletes.
      // eslint-disable-next-line no-console
      console.error('[storage] R2 delete failed:', err && err.message ? err.message : err);
    }
    return;
  }
  const p = path.join(localDirFor(key), path.basename(key));
  const dir = localDirFor(key);
  if (p.startsWith(dir) && fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
    } catch (_) {}
  }
}

// Public (unsigned) URL for a key — used for thumbnails in r2/inline mode.
function getPublicUrl(key) {
  if (backend === 'inline') {
    // Inline mode stores the data: URI itself — serve it as-is.
    return /^data:/i.test(key || '') ? key : null;
  }
  if (backend !== 'r2') return null;
  const base = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  if (!base) {
    throw new Error('R2_PUBLIC_URL is not set — it is required for thumbnails with STORAGE_BACKEND=r2.');
  }
  return `${base}/${key}`;
}

// Short-lived signed URL for private objects (lesson videos). Call ONLY after
// the access check (enrolled / free preview / admin) has passed.
async function getSignedUrl(key, expiresSeconds = 300) {
  if (backend === 'inline') {
    throw new Error('getSignedUrl is not available with STORAGE_BACKEND=inline — use an external video URL.');
  }
  if (backend !== 'r2') {
    throw new Error('getSignedUrl is only available with STORAGE_BACKEND=r2.');
  }
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl: presign } = require('@aws-sdk/s3-request-presigner');
  return presign(
    getS3(),
    new GetObjectCommand({ Bucket: r2Config().bucket, Key: key }),
    { expiresIn: expiresSeconds }
  );
}

module.exports = { backend, saveUpload, deleteFile, getPublicUrl, getSignedUrl };
