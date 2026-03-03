const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
require('dotenv').config({ quiet: true });

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'coaching.db');
const db = new sqlite3.Database(dbPath);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function ensureColumn(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  const exists = columns.some((item) => item.name === column);
  if (!exists) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function initDb() {
  const adminUsername = (process.env.ADMIN_USERNAME || 'Scc@coaching').trim();
  const adminPassword = (process.env.ADMIN_PASSWORD || 'Scc@8208').trim();
  const adminForceReset = String(process.env.ADMIN_FORCE_RESET || 'true').toLowerCase() === 'true';

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('admin', 'student')),
      roll_no TEXT UNIQUE,
      name TEXT,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('users', 'standard', `TEXT CHECK(standard IN ('11th', '12th'))`);
  await ensureColumn('users', 'course', `TEXT CHECK(course IN ('jee', 'neet'))`);

  await run(`
    CREATE TABLE IF NOT EXISTS test_papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      upload_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      uploaded_by INTEGER NOT NULL,
      FOREIGN KEY(student_id) REFERENCES users(id),
      FOREIGN KEY(uploaded_by) REFERENCES users(id)
    )
  `);

  await ensureColumn('test_papers', 'storage_type', `TEXT NOT NULL DEFAULT 'local'`);
  await ensureColumn('test_papers', 'storage_key', `TEXT`);
  await ensureColumn('test_papers', 'public_url', `TEXT`);
  await ensureColumn('test_papers', 'content_type', `TEXT`);
  await ensureColumn('test_papers', 'size_bytes', `INTEGER`);

  await run(`UPDATE test_papers SET storage_type = COALESCE(NULLIF(storage_type, ''), 'local')`);
  await run(`UPDATE test_papers SET storage_key = COALESCE(storage_key, stored_name)`);

  await run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      attendance_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('present', 'absent', 'late')),
      notes TEXT,
      marked_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(student_id) REFERENCES users(id),
      FOREIGN KEY(marked_by) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      due_date TEXT,
      payment_date TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'paid', 'overdue')),
      notes TEXT,
      added_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(student_id) REFERENCES users(id),
      FOREIGN KEY(added_by) REFERENCES users(id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS batch_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      standard TEXT NOT NULL CHECK(standard IN ('11th', '12th')),
      course TEXT NOT NULL CHECK(course IN ('jee', 'neet')),
      title TEXT NOT NULL,
      resource_url TEXT NOT NULL,
      description TEXT,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(created_by) REFERENCES users(id)
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_users_group ON users(role, standard, course)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance(student_id, attendance_date)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_test_papers_storage ON test_papers(storage_type, storage_key)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_batch_notes_group ON batch_notes(standard, course, created_at DESC)`);

  const admin = await get(`SELECT id, name FROM users WHERE role = 'admin' LIMIT 1`);
  if (!admin) {
    const hash = await bcrypt.hash(adminPassword, 10);
    await run(
      `INSERT INTO users (role, roll_no, name, password_hash) VALUES ('admin', NULL, ?, ?)`,
      [adminUsername, hash]
    );
  } else if (adminForceReset) {
    const hash = await bcrypt.hash(adminPassword, 10);
    await run(`UPDATE users SET name = ?, password_hash = ? WHERE id = ?`, [adminUsername, hash, admin.id]);
  } else if (!admin.name) {
    await run(`UPDATE users SET name = ? WHERE id = ?`, [adminUsername, admin.id]);
  }
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb,
};
