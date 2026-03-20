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

async function tableExists(name) {
  const row = await get(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name]
  );
  return Boolean(row);
}

async function ensureColumn(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  const exists = columns.some((item) => item.name === column);
  if (!exists) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function createSubscriptionPlansTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price_inr REAL NOT NULL DEFAULT 0,
      max_students INTEGER,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('subscription_plans', 'max_students', `INTEGER`);
}

async function seedSubscriptionPlans() {
  const legacyPremiumPlan = await get(`SELECT id, name FROM subscription_plans WHERE code = 'pro' LIMIT 1`);
  const premiumPlan = await get(`SELECT id FROM subscription_plans WHERE code = 'premium' LIMIT 1`);

  if (legacyPremiumPlan && !premiumPlan) {
    await run(
      `UPDATE subscription_plans
       SET code = 'premium',
           name = CASE WHEN name = 'Pro' THEN 'Premium' ELSE name END
       WHERE id = ?`,
      [legacyPremiumPlan.id]
    );
  }

  const plans = [
    {
      code: 'basic',
      name: 'Basic',
      price: 999,
      maxStudents: 500,
      description: 'Small coaching setup with essential features',
    },
    {
      code: 'mid',
      name: 'Mid',
      price: 1999,
      maxStudents: 1500,
      description: 'Growing coaching with more students and operations',
    },
    {
      code: 'premium',
      name: 'Premium',
      price: 3499,
      maxStudents: 5000,
      description: 'Large coaching with full access and priority support',
    },
  ];

  for (const plan of plans) {
    const existing = await get(`SELECT id, name, max_students FROM subscription_plans WHERE code = ?`, [plan.code]);
    if (!existing) {
      await run(
        `INSERT INTO subscription_plans (code, name, price_inr, max_students, description, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [plan.code, plan.name, plan.price, plan.maxStudents, plan.description]
      );
      continue;
    }

    if (existing.name !== plan.name && ['Basic', 'Mid', 'Pro', 'Premium'].includes(existing.name)) {
      await run(`UPDATE subscription_plans SET name = ? WHERE id = ?`, [plan.name, existing.id]);
    }

    if (existing.max_students === null && plan.maxStudents !== null) {
      await run(`UPDATE subscription_plans SET max_students = ? WHERE id = ?`, [plan.maxStudents, existing.id]);
    }
  }
}

async function createCoachingClassesTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS coaching_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      brand_name TEXT,
      logo_url TEXT,
      theme_primary TEXT,
      theme_background TEXT,
      theme_surface TEXT,
      contact_email TEXT,
      subscription_plan_id INTEGER,
      subscription_status TEXT NOT NULL DEFAULT 'active' CHECK(subscription_status IN ('trial', 'active', 'suspended', 'cancelled')),
      subscription_started_at TEXT,
      subscription_ends_at TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(subscription_plan_id) REFERENCES subscription_plans(id)
    )
  `);

  await ensureColumn('coaching_classes', 'brand_name', `TEXT`);
  await ensureColumn('coaching_classes', 'logo_url', `TEXT`);
  await ensureColumn('coaching_classes', 'theme_primary', `TEXT`);
  await ensureColumn('coaching_classes', 'theme_background', `TEXT`);
  await ensureColumn('coaching_classes', 'theme_surface', `TEXT`);

  await run(`
    UPDATE coaching_classes
    SET brand_name = COALESCE(NULLIF(brand_name, ''), name)
    WHERE brand_name IS NULL OR brand_name = ''
  `);
}

async function getBasicPlanId() {
  const basicPlan = await get(`SELECT id FROM subscription_plans WHERE code = 'basic' LIMIT 1`);
  return basicPlan ? basicPlan.id : null;
}

async function ensureLegacyCoaching() {
  const existing = await get(`SELECT * FROM coaching_classes WHERE slug = 'legacy-coaching' LIMIT 1`);
  if (existing) return existing;

  const basicPlanId = await getBasicPlanId();
  const result = await run(
    `INSERT INTO coaching_classes (
      name, slug, subscription_plan_id, subscription_status, subscription_started_at
    ) VALUES (?, ?, ?, 'active', DATE('now'))`,
    ['Legacy Coaching', 'legacy-coaching', basicPlanId]
  );

  return get(`SELECT * FROM coaching_classes WHERE id = ?`, [result.lastID]);
}

async function createUsersTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coaching_id INTEGER,
      role TEXT NOT NULL CHECK(role IN ('admin', 'student')),
      is_owner INTEGER NOT NULL DEFAULT 0,
      username TEXT,
      roll_no TEXT,
      name TEXT,
      standard TEXT CHECK(standard IN ('11th', '12th')),
      course TEXT CHECK(course IN ('jee', 'neet')),
      contact_phone TEXT,
      email TEXT,
      password_hash TEXT NOT NULL,
      password_display TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(coaching_id) REFERENCES coaching_classes(id)
    )
  `);

  await ensureColumn('users', 'contact_phone', `TEXT`);
  await ensureColumn('users', 'email', `TEXT`);
  await ensureColumn('users', 'password_display', `TEXT`);

  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_owner_username ON users(username) WHERE is_owner = 1`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_coaching_username ON users(coaching_id, username) WHERE username IS NOT NULL AND is_owner = 0`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_coaching_roll ON users(coaching_id, roll_no) WHERE roll_no IS NOT NULL`);
  await run(`CREATE INDEX IF NOT EXISTS idx_users_group ON users(coaching_id, role, standard, course)`);
}

async function migrateLegacyUsers(adminUsername) {
  const hasUsersTable = await tableExists('users');
  if (!hasUsersTable) {
    await createUsersTable();
    return;
  }

  const columns = await all(`PRAGMA table_info(users)`);
  const alreadyMultiTenant = columns.some((item) => item.name === 'coaching_id')
    && columns.some((item) => item.name === 'username')
    && columns.some((item) => item.name === 'is_owner');

  if (alreadyMultiTenant) {
    await createUsersTable();
    return;
  }

  const legacyTableName = 'users_legacy_migration';
  const legacyExists = await tableExists(legacyTableName);
  if (!legacyExists) {
    await run(`ALTER TABLE users RENAME TO ${legacyTableName}`);
  }

  await createUsersTable();

  const legacyCoaching = await ensureLegacyCoaching();
  const legacyUsers = await all(`SELECT * FROM ${legacyTableName} ORDER BY id ASC`);
  let ownerCreated = false;
  let legacyAdminHash = null;

  for (const user of legacyUsers) {
    if (user.role === 'admin' && !ownerCreated) {
      await run(
        `INSERT INTO users (
          id, coaching_id, role, is_owner, username, roll_no, name, standard, course, password_hash, created_at
        ) VALUES (?, NULL, 'admin', 1, ?, NULL, ?, NULL, NULL, ?, ?)`,
        [user.id, adminUsername, user.name || 'Owner', user.password_hash, user.created_at]
      );
      ownerCreated = true;
      legacyAdminHash = user.password_hash;
      continue;
    }

    if (user.role === 'admin') {
      await run(
        `INSERT INTO users (
          id, coaching_id, role, is_owner, username, roll_no, name, standard, course, password_hash, created_at
        ) VALUES (?, ?, 'admin', 0, ?, NULL, ?, NULL, NULL, ?, ?)`,
        [
          user.id,
          legacyCoaching.id,
          `legacy-admin-${user.id}`,
          user.name || `Legacy Admin ${user.id}`,
          user.password_hash,
          user.created_at,
        ]
      );
      if (!legacyAdminHash) legacyAdminHash = user.password_hash;
      continue;
    }

    await run(
      `INSERT INTO users (
        id, coaching_id, role, is_owner, username, roll_no, name, standard, course, password_hash, created_at
      ) VALUES (?, ?, 'student', 0, NULL, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        legacyCoaching.id,
        user.roll_no,
        user.name,
        user.standard || null,
        user.course || null,
        user.password_hash,
        user.created_at,
      ]
    );
  }

  if (legacyAdminHash) {
    const legacyPortalAdmin = await get(
      `SELECT id FROM users WHERE coaching_id = ? AND role = 'admin' AND is_owner = 0 LIMIT 1`,
      [legacyCoaching.id]
    );

    if (!legacyPortalAdmin) {
      await run(
        `INSERT INTO users (
          coaching_id, role, is_owner, username, roll_no, name, standard, course, password_hash
        ) VALUES (?, 'admin', 0, ?, NULL, ?, NULL, NULL, ?)`,
        [legacyCoaching.id, 'legacy-admin', 'Legacy Coaching Admin', legacyAdminHash]
      );
    }
  }
}

async function ensureTenantScopedTables() {
  await run(`
    CREATE TABLE IF NOT EXISTS test_papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coaching_id INTEGER,
      student_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      upload_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      uploaded_by INTEGER NOT NULL,
      storage_type TEXT NOT NULL DEFAULT 'local',
      storage_key TEXT,
      public_url TEXT,
      content_type TEXT,
      size_bytes INTEGER,
      marks_obtained REAL,
      max_marks REAL,
      test_label TEXT,
      paper_type TEXT NOT NULL DEFAULT 'general' CHECK(paper_type IN ('general', 'answer_submission')),
      answer_request_id INTEGER,
      FOREIGN KEY(coaching_id) REFERENCES coaching_classes(id),
      FOREIGN KEY(student_id) REFERENCES users(id),
      FOREIGN KEY(uploaded_by) REFERENCES users(id)
    )
  `);

  await ensureColumn('test_papers', 'coaching_id', `INTEGER`);
  await ensureColumn('test_papers', 'storage_type', `TEXT NOT NULL DEFAULT 'local'`);
  await ensureColumn('test_papers', 'storage_key', `TEXT`);
  await ensureColumn('test_papers', 'public_url', `TEXT`);
  await ensureColumn('test_papers', 'content_type', `TEXT`);
  await ensureColumn('test_papers', 'size_bytes', `INTEGER`);
  await ensureColumn('test_papers', 'marks_obtained', `REAL`);
  await ensureColumn('test_papers', 'max_marks', `REAL`);
  await ensureColumn('test_papers', 'test_label', `TEXT`);
  await ensureColumn('test_papers', 'paper_type', `TEXT NOT NULL DEFAULT 'general'`);
  await ensureColumn('test_papers', 'answer_request_id', `INTEGER`);
  await run(`UPDATE test_papers SET paper_type = COALESCE(NULLIF(paper_type, ''), 'general')`);

  await run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coaching_id INTEGER,
      student_id INTEGER NOT NULL,
      attendance_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('present', 'absent', 'late')),
      notes TEXT,
      marked_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(coaching_id) REFERENCES coaching_classes(id),
      FOREIGN KEY(student_id) REFERENCES users(id),
      FOREIGN KEY(marked_by) REFERENCES users(id)
    )
  `);
  await ensureColumn('attendance', 'coaching_id', `INTEGER`);

  await run(`
    CREATE TABLE IF NOT EXISTS fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coaching_id INTEGER,
      student_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      due_date TEXT,
      payment_date TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'paid', 'overdue')),
      notes TEXT,
      added_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(coaching_id) REFERENCES coaching_classes(id),
      FOREIGN KEY(student_id) REFERENCES users(id),
      FOREIGN KEY(added_by) REFERENCES users(id)
    )
  `);
  await ensureColumn('fees', 'coaching_id', `INTEGER`);

  await run(`
    CREATE TABLE IF NOT EXISTS batch_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coaching_id INTEGER,
      standard TEXT NOT NULL CHECK(standard IN ('11th', '12th')),
      course TEXT NOT NULL CHECK(course IN ('jee', 'neet')),
      title TEXT NOT NULL,
      resource_url TEXT NOT NULL,
      description TEXT,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(coaching_id) REFERENCES coaching_classes(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    )
  `);
  await ensureColumn('batch_notes', 'coaching_id', `INTEGER`);

  await run(`
    CREATE TABLE IF NOT EXISTS answer_upload_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coaching_id INTEGER NOT NULL,
      standard TEXT NOT NULL CHECK(standard IN ('11th', '12th')),
      course TEXT NOT NULL CHECK(course IN ('jee', 'neet')),
      title TEXT NOT NULL,
      description TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(coaching_id) REFERENCES coaching_classes(id),
      FOREIGN KEY(created_by) REFERENCES users(id)
    )
  `);
}

async function backfillTenantScopes() {
  const legacyCoaching = await ensureLegacyCoaching();

  await run(`UPDATE test_papers SET storage_type = COALESCE(NULLIF(storage_type, ''), 'local')`);
  await run(`UPDATE test_papers SET storage_key = COALESCE(storage_key, stored_name)`);

  await run(`
    UPDATE test_papers
    SET coaching_id = (
      SELECT coaching_id FROM users WHERE users.id = test_papers.student_id
    )
    WHERE coaching_id IS NULL
  `);

  await run(`
    UPDATE attendance
    SET coaching_id = (
      SELECT coaching_id FROM users WHERE users.id = attendance.student_id
    )
    WHERE coaching_id IS NULL
  `);

  await run(`
    UPDATE fees
    SET coaching_id = (
      SELECT coaching_id FROM users WHERE users.id = fees.student_id
    )
    WHERE coaching_id IS NULL
  `);

  await run(`
    UPDATE batch_notes
    SET coaching_id = COALESCE(
      (SELECT coaching_id FROM users WHERE users.id = batch_notes.created_by),
      ?
    )
    WHERE coaching_id IS NULL
  `, [legacyCoaching.id]);
}

async function ensureIndexes() {
  await run(`CREATE INDEX IF NOT EXISTS idx_test_papers_storage ON test_papers(storage_type, storage_key)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_test_papers_coaching_student ON test_papers(coaching_id, student_id, upload_date)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_test_papers_answer_request ON test_papers(coaching_id, answer_request_id, student_id, upload_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance(coaching_id, student_id, attendance_date)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_fees_student_created ON fees(coaching_id, student_id, created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_batch_notes_group ON batch_notes(coaching_id, standard, course, created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_answer_requests_group_dates ON answer_upload_requests(coaching_id, standard, course, starts_at DESC, ends_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_coaching_slug ON coaching_classes(slug)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_coaching_subscription_status ON coaching_classes(subscription_status, subscription_plan_id)`);
}

async function ensureOwnerAccount(adminUsername, adminPassword, adminForceReset) {
  const owner = await get(`SELECT id, password_hash FROM users WHERE is_owner = 1 LIMIT 1`);
  const hash = await bcrypt.hash(adminPassword, 10);

  if (!owner) {
    await run(
      `INSERT INTO users (
        coaching_id, role, is_owner, username, roll_no, name, standard, course, password_hash
      ) VALUES (NULL, 'admin', 1, ?, NULL, ?, NULL, NULL, ?)`,
      [adminUsername, 'Owner', hash]
    );
    return;
  }

  if (adminForceReset) {
    await run(`UPDATE users SET username = ?, name = ?, password_hash = ? WHERE id = ?`, [
      adminUsername,
      'Owner',
      hash,
      owner.id,
    ]);
    return;
  }

  await run(`UPDATE users SET username = COALESCE(username, ?), name = COALESCE(name, 'Owner') WHERE id = ?`, [
    adminUsername,
    owner.id,
  ]);
}

async function syncStudentPasswordDisplay() {
  const students = await all(
    `SELECT id, roll_no, password_hash, password_display
     FROM users
     WHERE role = 'student'`
  );

  for (const student of students) {
    if (student.password_display || !student.roll_no) continue;

    const matchesRollNo = await bcrypt.compare(student.roll_no, student.password_hash);
    if (!matchesRollNo) continue;

    await run(`UPDATE users SET password_display = ? WHERE id = ?`, [student.roll_no, student.id]);
  }
}

async function initDb() {
  const adminUsername = (process.env.ADMIN_USERNAME || 'kartik001').trim();
  const adminPassword = (process.env.ADMIN_PASSWORD || 'Ga7BU8cZ').trim();
  const adminForceReset = String(process.env.ADMIN_FORCE_RESET || 'true').toLowerCase() === 'true';

  await createSubscriptionPlansTable();
  await seedSubscriptionPlans();
  await createCoachingClassesTable();
  await migrateLegacyUsers(adminUsername);
  await ensureTenantScopedTables();
  await backfillTenantScopes();
  await ensureIndexes();
  await ensureOwnerAccount(adminUsername, adminPassword, adminForceReset);
  await syncStudentPasswordDisplay();
}

module.exports = {
  db,
  run,
  get,
  all,
  initDb,
};
