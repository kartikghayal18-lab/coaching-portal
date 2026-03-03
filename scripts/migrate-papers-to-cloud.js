#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { initDb, db, all, run } = require('../src/db');
const { initStorage, getStorageMode, uploadPaperFile } = require('../src/storage');

const LOCAL_PAPER_DIR = process.env.LOCAL_PAPER_DIR
  ? path.resolve(process.env.LOCAL_PAPER_DIR)
  : path.join(__dirname, '..', 'papers');
const deleteLocal = process.argv.includes('--delete-local');

function mimeFromName(name = '') {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

async function migrate() {
  initStorage();

  if (getStorageMode() !== 's3') {
    throw new Error('Set FILE_STORAGE_MODE=s3 in .env before running migration.');
  }

  await initDb();

  const rows = await all(`
    SELECT id, original_name, stored_name, storage_type, storage_key, content_type
    FROM test_papers
    WHERE COALESCE(storage_type, 'local') = 'local'
    ORDER BY id ASC
  `);

  if (!rows.length) {
    console.log('No local files found for migration.');
    return;
  }

  let migrated = 0;
  let missing = 0;
  let failed = 0;

  for (const row of rows) {
    const localFileName = row.storage_key || row.stored_name;
    const localPath = path.join(LOCAL_PAPER_DIR, localFileName || '');

    if (!localFileName || !fs.existsSync(localPath)) {
      missing += 1;
      console.log(`Skipping id=${row.id} (file missing): ${localFileName}`);
      continue;
    }

    try {
      const buffer = await fs.promises.readFile(localPath);
      const uploaded = await uploadPaperFile({
        originalname: row.original_name || path.basename(localPath),
        mimetype: row.content_type || mimeFromName(row.original_name || localFileName),
        buffer,
        size: buffer.length,
      });

      await run(
        `UPDATE test_papers
         SET storage_type = ?, storage_key = ?, public_url = ?, content_type = ?, size_bytes = ?, stored_name = ?
         WHERE id = ?`,
        [
          uploaded.storageType,
          uploaded.storageKey,
          uploaded.publicUrl,
          uploaded.contentType,
          uploaded.sizeBytes,
          uploaded.storedName,
          row.id,
        ]
      );

      if (deleteLocal) {
        await fs.promises.unlink(localPath);
      }

      migrated += 1;
      console.log(`Migrated id=${row.id} -> ${uploaded.storageKey}`);
    } catch (err) {
      failed += 1;
      console.error(`Failed id=${row.id}:`, err.message);
    }
  }

  console.log('--- Migration Summary ---');
  console.log(`Migrated: ${migrated}`);
  console.log(`Missing local files: ${missing}`);
  console.log(`Failed: ${failed}`);
  console.log(`Delete local flag: ${deleteLocal ? 'enabled' : 'disabled'}`);
}

migrate()
  .then(() => db.close())
  .catch((err) => {
    console.error('Migration failed:', err.message);
    db.close(() => process.exit(1));
  });
