const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const ROOT_DIR = path.join(__dirname, '..');
const LOCAL_PAPER_DIR = process.env.LOCAL_PAPER_DIR
  ? path.resolve(process.env.LOCAL_PAPER_DIR)
  : path.join(ROOT_DIR, 'papers');

const modeFromEnv = (process.env.FILE_STORAGE_MODE || '').trim().toLowerCase();
const storageMode = modeFromEnv || (process.env.S3_BUCKET_NAME ? 's3' : 'local');

const s3Config = {
  bucket: process.env.S3_BUCKET_NAME,
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'false').toLowerCase() === 'true',
  signedUrlTtlSeconds: Number(process.env.S3_SIGNED_URL_TTL_SECONDS || 600),
};

const s3PublicBaseUrl = (process.env.S3_PUBLIC_BASE_URL || '').trim();
let s3Client = null;

function sanitizeFileName(name) {
  return String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 180);
}

function quoteFileName(name) {
  return String(name || 'file').replace(/"/g, '');
}

function ensureLocalDir() {
  if (!fs.existsSync(LOCAL_PAPER_DIR)) {
    fs.mkdirSync(LOCAL_PAPER_DIR, { recursive: true });
  }
}

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: s3Config.region,
      endpoint: s3Config.endpoint || undefined,
      forcePathStyle: s3Config.forcePathStyle,
      credentials: {
        accessKeyId: s3Config.accessKeyId,
        secretAccessKey: s3Config.secretAccessKey,
      },
    });
  }
  return s3Client;
}

function validateS3Config() {
  const missing = [];
  if (!s3Config.bucket) missing.push('S3_BUCKET_NAME');
  if (!s3Config.accessKeyId) missing.push('S3_ACCESS_KEY_ID');
  if (!s3Config.secretAccessKey) missing.push('S3_SECRET_ACCESS_KEY');
  if (!s3Config.endpoint) missing.push('S3_ENDPOINT');
  if (missing.length) {
    throw new Error(`S3 mode enabled but missing env vars: ${missing.join(', ')}`);
  }
}

function initStorage() {
  if (storageMode === 's3') {
    validateS3Config();
    return;
  }

  if (!['local', 's3'].includes(storageMode)) {
    throw new Error(`Unsupported FILE_STORAGE_MODE: ${storageMode}`);
  }

  if (process.env.VERCEL) {
    throw new Error('Vercel deployments require FILE_STORAGE_MODE=s3 because local uploaded files are not persistent.');
  }

  ensureLocalDir();
}

function getStorageMode() {
  return storageMode;
}

async function uploadPaperFile(file) {
  const safeOriginal = sanitizeFileName(file.originalname);

  if (storageMode === 's3') {
    const key = `papers/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${crypto.randomUUID()}_${safeOriginal}`;

    await getS3Client().send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype || 'application/octet-stream',
      })
    );

    const publicUrl = s3PublicBaseUrl ? `${s3PublicBaseUrl.replace(/\/$/, '')}/${key}` : null;

    return {
      storedName: key,
      storageType: 's3',
      storageKey: key,
      publicUrl,
      contentType: file.mimetype || null,
      sizeBytes: file.size || null,
    };
  }

  ensureLocalDir();
  const fileName = `${Date.now()}_${safeOriginal}`;
  const localPath = path.join(LOCAL_PAPER_DIR, fileName);
  await fs.promises.writeFile(localPath, file.buffer);

  return {
    storedName: fileName,
    storageType: 'local',
    storageKey: fileName,
    publicUrl: null,
    contentType: file.mimetype || null,
    sizeBytes: file.size || null,
  };
}

async function uploadGeneratedFile({ buffer, fileName, contentType = 'application/octet-stream', folder = 'generated' }) {
  const safeOriginal = sanitizeFileName(fileName);

  if (storageMode === 's3') {
    const key = `${folder}/${new Date().toISOString().slice(0, 10)}/${Date.now()}_${crypto.randomUUID()}_${safeOriginal}`;

    await getS3Client().send(
      new PutObjectCommand({
        Bucket: s3Config.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );

    const publicUrl = s3PublicBaseUrl
      ? `${s3PublicBaseUrl.replace(/\/$/, '')}/${key}`
      : await getSignedUrl(
        getS3Client(),
        new GetObjectCommand({
          Bucket: s3Config.bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${quoteFileName(safeOriginal)}"`,
          ResponseContentType: contentType,
        }),
        { expiresIn: s3Config.signedUrlTtlSeconds }
      );

    return {
      storedName: key,
      storageType: 's3',
      storageKey: key,
      publicUrl,
      contentType,
      sizeBytes: buffer.length,
    };
  }

  ensureLocalDir();
  const fileNameWithPrefix = `${Date.now()}_${safeOriginal}`;
  const localPath = path.join(LOCAL_PAPER_DIR, fileNameWithPrefix);
  await fs.promises.writeFile(localPath, buffer);

  return {
    storedName: fileNameWithPrefix,
    storageType: 'local',
    storageKey: fileNameWithPrefix,
    publicUrl: null,
    contentType,
    sizeBytes: buffer.length,
  };
}

function resolveStorageType(paper) {
  return paper.storage_type || 'local';
}

function resolveStorageKey(paper) {
  return paper.storage_key || paper.stored_name;
}

async function getSignedPaperUrl(paper, dispositionType) {
  const key = resolveStorageKey(paper);
  if (!key) return null;

  const command = new GetObjectCommand({
    Bucket: s3Config.bucket,
    Key: key,
    ResponseContentDisposition: `${dispositionType}; filename="${quoteFileName(paper.original_name)}"`,
    ResponseContentType: paper.content_type || undefined,
  });

  return getSignedUrl(getS3Client(), command, {
    expiresIn: s3Config.signedUrlTtlSeconds,
  });
}

async function getPaperAccess(paper, dispositionType) {
  const storageType = resolveStorageType(paper);

  if (storageType === 's3') {
    const signedUrl = await getSignedPaperUrl(paper, dispositionType);
    return { type: 'redirect', url: signedUrl };
  }

  if (process.env.VERCEL) {
    return null;
  }

  const fileName = resolveStorageKey(paper);
  const filePath = path.join(LOCAL_PAPER_DIR, fileName);
  return { type: 'local', filePath };
}

async function deleteStoredPaper(paper) {
  const storageType = resolveStorageType(paper);
  const storageKey = resolveStorageKey(paper);
  if (!storageKey) return;

  if (storageType === 's3') {
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: s3Config.bucket,
        Key: storageKey,
      })
    );
    return;
  }

  if (process.env.VERCEL) {
    return;
  }

  const filePath = path.join(LOCAL_PAPER_DIR, storageKey);
  if (fs.existsSync(filePath)) {
    await fs.promises.unlink(filePath);
  }
}

module.exports = {
  initStorage,
  getStorageMode,
  uploadPaperFile,
  uploadGeneratedFile,
  getPaperAccess,
  deleteStoredPaper,
};
