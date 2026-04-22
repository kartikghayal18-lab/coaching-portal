const { Pool: PgPool } = require('pg');
const { Pool: NeonPool, neonConfig } = require('@neondatabase/serverless');
const ws = require('ws');
const bcrypt = require('bcryptjs');
require('dotenv').config({ quiet: true });

let pool = null;

neonConfig.webSocketConstructor = ws;

function normalizeDatabaseUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value || value.includes('postgresql://neondb_owner:npg_edQsbt84TxCB@ep-damp-tooth-a16l7mg4-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require')) {
  console.error("❌ DATABASE_URL missing or invalid");
  return null; // crash मत कर
}

  const url = new URL(value);
  if (!url.searchParams.has('sslmode')) {
    url.searchParams.set('sslmode', 'require');
  }

  const sslMode = url.searchParams.get('sslmode');
  if (['prefer', 'require', 'verify-ca'].includes(sslMode) && !url.searchParams.has('uselibpqcompat')) {
    url.searchParams.set('uselibpqcompat', 'true');
  }

  return url.toString();
}

function getPool() {
  if (!pool) {
    const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL);
    const hostname = new URL(connectionString).hostname || '';
    const PoolImpl = hostname.includes('.neon.tech') ? NeonPool : PgPool;

    pool = new PoolImpl({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    });
  }

  return pool;
}

function convertPlaceholders(sql) {
  let output = '';
  let paramIndex = 1;
  let inSingleQuote = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];

    if (char === '\'') {
      output += char;

      if (inSingleQuote && sql[i + 1] === '\'') {
        output += sql[i + 1];
        i += 1;
        continue;
      }

      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && char === '?') {
      output += `$${paramIndex}`;
      paramIndex += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function needsReturningId(query) {
  return /^\s*INSERT\s+INTO\b/i.test(query) && !/\bRETURNING\b/i.test(query);
}

function prepareQuery(query) {
  const converted = convertPlaceholders(query);

  if (!needsReturningId(converted)) {
    return converted;
  }

  return converted.replace(/;\s*$/, '') + ' RETURNING id';
}

async function execute(query, params = [], client = null) {
  const runner = client || getPool();
  const text = prepareQuery(query);
  const res = await runner.query(text, params);

  return {
    rows: res.rows,
    rowCount: res.rowCount,
    lastID: res.rows?.[0]?.id ?? null,
  };
}

async function run(query, params = []) {
  return execute(query, params);
}

async function get(query, params = []) {
  const res = await execute(query, params);
  return res.rows[0];
}

async function all(query, params = []) {
  const res = await execute(query, params);
  return res.rows;
}

async function withTransaction(handler) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const scoped = {
      run: (query, params = []) => execute(query, params, client),
      get: async (query, params = []) => {
        const res = await execute(query, params, client);
        return res.rows[0];
      },
      all: async (query, params = []) => {
        const res = await execute(query, params, client);
        return res.rows;
      },
    };
    const result = await handler(scoped);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ensureColumn(table, column, definition) {
  await run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
}

function normalizeBatchName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function getLegacyBatchName(standard, course) {
  const safeStandard = String(standard || '').trim();
  const safeCourse = String(course || '').trim().toUpperCase();

  if (safeStandard && safeCourse) return `${safeStandard} - ${safeCourse}`;
  if (safeStandard) return safeStandard;
  if (safeCourse) return safeCourse;
  return '';
}

async function createSubscriptionPlansTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price_inr DOUBLE PRECISION NOT NULL DEFAULT 0,
      max_students INTEGER,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function seedSubscriptionPlans() {
  const existingPlans = await get(`SELECT COUNT(*)::int AS total FROM subscription_plans`);
  if (Number(existingPlans?.total || 0) > 0) {
    return;
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
    await run(
      `INSERT INTO subscription_plans (code, name, price_inr, max_students, description, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [plan.code, plan.name, plan.price, plan.maxStudents, plan.description]
    );
  }
}

async function createCoachingClassesTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS coaching_classes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      brand_name TEXT,
      logo_url TEXT,
      theme_primary TEXT,
      theme_background TEXT,
      theme_surface TEXT,
      contact_email TEXT,
      custom_plan_name TEXT,
      custom_max_students INTEGER,
      subscription_plan_id INTEGER,
      subscription_status TEXT NOT NULL DEFAULT 'active',
      subscription_started_at TEXT,
      subscription_ends_at TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('coaching_classes', 'brand_name', 'TEXT');
  await ensureColumn('coaching_classes', 'logo_url', 'TEXT');
  await ensureColumn('coaching_classes', 'theme_primary', 'TEXT');
  await ensureColumn('coaching_classes', 'theme_background', 'TEXT');
  await ensureColumn('coaching_classes', 'theme_surface', 'TEXT');
  await ensureColumn('coaching_classes', 'contact_email', 'TEXT');
  await ensureColumn('coaching_classes', 'custom_plan_name', 'TEXT');
  await ensureColumn('coaching_classes', 'custom_max_students', 'INTEGER');
  await ensureColumn('coaching_classes', 'subscription_plan_id', 'INTEGER');
  await ensureColumn('coaching_classes', 'subscription_status', `TEXT NOT NULL DEFAULT 'active'`);
  await ensureColumn('coaching_classes', 'subscription_started_at', 'TEXT');
  await ensureColumn('coaching_classes', 'subscription_ends_at', 'TEXT');

  await run(`
    UPDATE coaching_classes
    SET brand_name = COALESCE(NULLIF(brand_name, ''), name)
    WHERE brand_name IS NULL OR brand_name = ''
  `);
}

async function getBasicPlanId() {
  const plan = await get(`SELECT id FROM subscription_plans WHERE code = 'basic' LIMIT 1`);
  return plan?.id || null;
}

async function ensureLegacyCoaching() {
  const existing = await get(`SELECT id, name, slug FROM coaching_classes WHERE slug = 'legacy-coaching' LIMIT 1`);
  if (existing) return existing;

  const basicPlanId = await getBasicPlanId();
  const result = await run(
    `INSERT INTO coaching_classes (
      name, slug, brand_name, subscription_plan_id, subscription_status, subscription_started_at
    ) VALUES (?, ?, ?, ?, 'active', CURRENT_DATE::text)`,
    ['Legacy Coaching', 'legacy-coaching', 'Legacy Coaching', basicPlanId]
  );

  return { id: result.lastID, name: 'Legacy Coaching', slug: 'legacy-coaching' };
}

async function createBatchesTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS batches (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      name TEXT,
      normalized_name TEXT,
      standard TEXT,
      course TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      completed_at TIMESTAMP,
      is_retention_batch INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('batches', 'coaching_id', 'INTEGER');
  await ensureColumn('batches', 'normalized_name', 'TEXT');
  await ensureColumn('batches', 'standard', 'TEXT');
  await ensureColumn('batches', 'course', 'TEXT');
  await ensureColumn('batches', 'status', `TEXT NOT NULL DEFAULT 'active'`);
  await ensureColumn('batches', 'completed_at', 'TIMESTAMP');
  await ensureColumn('batches', 'is_retention_batch', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('batches', 'created_by', 'INTEGER');
}

async function createUsersTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      role TEXT NOT NULL DEFAULT 'student',
      is_owner INTEGER NOT NULL DEFAULT 0,
      username TEXT,
      roll_no TEXT,
      name TEXT,
      batch_id INTEGER,
      standard TEXT,
      course TEXT,
      contact_phone TEXT,
      email TEXT,
      password_hash TEXT NOT NULL,
      password_display TEXT,
      is_retained_record INTEGER NOT NULL DEFAULT 0,
      retention_source_batch_id INTEGER,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      password_changed_at TIMESTAMP,
      terms_accepted_at TIMESTAMP,
      privacy_accepted_at TIMESTAMP,
      saas_accepted_at TIMESTAMP,
      legal_accepted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('users', 'coaching_id', 'INTEGER');
  await ensureColumn('users', 'is_owner', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'batch_id', 'INTEGER');
  await ensureColumn('users', 'contact_phone', 'TEXT');
  await ensureColumn('users', 'email', 'TEXT');
  await ensureColumn('users', 'is_retained_record', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'retention_source_batch_id', 'INTEGER');
  await ensureColumn('users', 'password_display', 'TEXT');
  await ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'password_changed_at', 'TIMESTAMP');
  await ensureColumn('users', 'terms_accepted_at', 'TIMESTAMP');
  await ensureColumn('users', 'privacy_accepted_at', 'TIMESTAMP');
  await ensureColumn('users', 'saas_accepted_at', 'TIMESTAMP');
  await ensureColumn('users', 'legal_accepted_at', 'TIMESTAMP');
}

async function createTestPapersTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS test_papers (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      student_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      uploaded_by INTEGER,
      storage_type TEXT NOT NULL DEFAULT 'local',
      storage_key TEXT,
      public_url TEXT,
      content_type TEXT,
      size_bytes INTEGER,
      marks_obtained DOUBLE PRECISION,
      max_marks DOUBLE PRECISION,
      test_label TEXT,
      paper_type TEXT NOT NULL DEFAULT 'general',
      answer_request_id INTEGER
    )
  `);

  await ensureColumn('test_papers', 'coaching_id', 'INTEGER');
  await ensureColumn('test_papers', 'uploaded_by', 'INTEGER');
  await ensureColumn('test_papers', 'storage_type', `TEXT NOT NULL DEFAULT 'local'`);
  await ensureColumn('test_papers', 'storage_key', 'TEXT');
  await ensureColumn('test_papers', 'public_url', 'TEXT');
  await ensureColumn('test_papers', 'content_type', 'TEXT');
  await ensureColumn('test_papers', 'size_bytes', 'INTEGER');
  await ensureColumn('test_papers', 'marks_obtained', 'DOUBLE PRECISION');
  await ensureColumn('test_papers', 'max_marks', 'DOUBLE PRECISION');
  await ensureColumn('test_papers', 'test_label', 'TEXT');
  await ensureColumn('test_papers', 'paper_type', `TEXT NOT NULL DEFAULT 'general'`);
  await ensureColumn('test_papers', 'answer_request_id', 'INTEGER');
}

async function createAttendanceTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      student_id INTEGER NOT NULL,
      attendance_date TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT,
      marked_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('attendance', 'coaching_id', 'INTEGER');
  await ensureColumn('attendance', 'notes', 'TEXT');
  await ensureColumn('attendance', 'marked_by', 'INTEGER');
  await ensureColumn('attendance', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
}

async function createFeesTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS fees (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      student_id INTEGER NOT NULL,
      amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      due_date TEXT,
      payment_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      added_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('fees', 'coaching_id', 'INTEGER');
  await ensureColumn('fees', 'due_date', 'TEXT');
  await ensureColumn('fees', 'payment_date', 'TEXT');
  await ensureColumn('fees', 'notes', 'TEXT');
  await ensureColumn('fees', 'added_by', 'INTEGER');
  await ensureColumn('fees', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
}

async function createBatchNotesTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS batch_notes (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      batch_id INTEGER,
      standard TEXT,
      course TEXT,
      title TEXT NOT NULL,
      resource_url TEXT NOT NULL,
      description TEXT,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('batch_notes', 'coaching_id', 'INTEGER');
  await ensureColumn('batch_notes', 'batch_id', 'INTEGER');
  await ensureColumn('batch_notes', 'standard', 'TEXT');
  await ensureColumn('batch_notes', 'course', 'TEXT');
  await ensureColumn('batch_notes', 'description', 'TEXT');
  await ensureColumn('batch_notes', 'created_by', 'INTEGER');
  await ensureColumn('batch_notes', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
}

async function createAnswerUploadRequestsTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS answer_upload_requests (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER NOT NULL,
      batch_id INTEGER,
      standard TEXT,
      course TEXT,
      title TEXT NOT NULL,
      description TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('answer_upload_requests', 'coaching_id', 'INTEGER');
  await ensureColumn('answer_upload_requests', 'batch_id', 'INTEGER');
  await ensureColumn('answer_upload_requests', 'standard', 'TEXT');
  await ensureColumn('answer_upload_requests', 'course', 'TEXT');
  await ensureColumn('answer_upload_requests', 'description', 'TEXT');
  await ensureColumn('answer_upload_requests', 'created_by', 'INTEGER');
  await ensureColumn('answer_upload_requests', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
}

async function createTrialRequestsTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS trial_requests (
      id SERIAL PRIMARY KEY,
      class_name TEXT NOT NULL,
      applicant_name TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      email TEXT NOT NULL,
      whatsapp_number TEXT NOT NULL,
      logo_url TEXT,
      student_requirement INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      owner_notes TEXT,
      reviewed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('trial_requests', 'class_name', 'TEXT');
  await ensureColumn('trial_requests', 'applicant_name', 'TEXT');
  await ensureColumn('trial_requests', 'contact_phone', 'TEXT');
  await ensureColumn('trial_requests', 'email', 'TEXT');
  await ensureColumn('trial_requests', 'whatsapp_number', 'TEXT');
  await ensureColumn('trial_requests', 'logo_url', 'TEXT');
  await ensureColumn('trial_requests', 'student_requirement', 'INTEGER');
  await ensureColumn('trial_requests', 'status', `TEXT NOT NULL DEFAULT 'pending'`);
  await ensureColumn('trial_requests', 'owner_notes', 'TEXT');
  await ensureColumn('trial_requests', 'reviewed_at', 'TIMESTAMP');
  await ensureColumn('trial_requests', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
}

async function createAuditLogsTable() {
  await run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      actor_user_id INTEGER,
      actor_role TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      details_json TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await ensureColumn('audit_logs', 'coaching_id', 'INTEGER');
  await ensureColumn('audit_logs', 'actor_user_id', 'INTEGER');
  await ensureColumn('audit_logs', 'actor_role', 'TEXT');
  await ensureColumn('audit_logs', 'action', `TEXT NOT NULL DEFAULT 'unknown'`);
  await ensureColumn('audit_logs', 'target_type', 'TEXT');
  await ensureColumn('audit_logs', 'target_id', 'INTEGER');
  await ensureColumn('audit_logs', 'details_json', 'TEXT');
  await ensureColumn('audit_logs', 'ip_address', 'TEXT');
  await ensureColumn('audit_logs', 'user_agent', 'TEXT');
  await ensureColumn('audit_logs', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
}

async function backfillTenantScopes() {
  const legacyUserCount = await get(
    `SELECT COUNT(*)::int AS total
     FROM users
     WHERE COALESCE(is_owner, 0) = 0 AND coaching_id IS NULL`
  );

  let legacyCoaching = null;
  if (Number(legacyUserCount?.total || 0) > 0) {
    legacyCoaching = await ensureLegacyCoaching();
    await run(`UPDATE users SET coaching_id = ? WHERE COALESCE(is_owner, 0) = 0 AND coaching_id IS NULL`, [legacyCoaching.id]);
  }

  await run(`UPDATE users SET is_owner = COALESCE(is_owner, 0)`);
  await run(`UPDATE users SET role = COALESCE(NULLIF(role, ''), 'student')`);
  await run(`UPDATE users SET name = COALESCE(NULLIF(name, ''), username, roll_no, 'User')`);
  await run(`UPDATE batches SET normalized_name = COALESCE(NULLIF(normalized_name, ''), LOWER(REGEXP_REPLACE(TRIM(COALESCE(name, '')), '\\s+', ' ', 'g')))`);

  if (!legacyCoaching) {
    const orphanPapers = await get(`SELECT COUNT(*)::int AS total FROM test_papers WHERE coaching_id IS NULL`);
    const orphanAttendance = await get(`SELECT COUNT(*)::int AS total FROM attendance WHERE coaching_id IS NULL`);
    const orphanFees = await get(`SELECT COUNT(*)::int AS total FROM fees WHERE coaching_id IS NULL`);
    const orphanNotes = await get(`SELECT COUNT(*)::int AS total FROM batch_notes WHERE coaching_id IS NULL`);
    const orphanRequests = await get(`SELECT COUNT(*)::int AS total FROM answer_upload_requests WHERE coaching_id IS NULL`);

    if (
      Number(orphanPapers?.total || 0) > 0
      || Number(orphanAttendance?.total || 0) > 0
      || Number(orphanFees?.total || 0) > 0
      || Number(orphanNotes?.total || 0) > 0
      || Number(orphanRequests?.total || 0) > 0
    ) {
      legacyCoaching = await ensureLegacyCoaching();
    }
  }

  await run(`
    UPDATE test_papers tp
    SET coaching_id = u.coaching_id
    FROM users u
    WHERE tp.student_id = u.id AND tp.coaching_id IS NULL
  `);

  await run(`
    UPDATE attendance a
    SET coaching_id = u.coaching_id
    FROM users u
    WHERE a.student_id = u.id AND a.coaching_id IS NULL
  `);

  await run(`
    UPDATE fees f
    SET coaching_id = u.coaching_id
    FROM users u
    WHERE f.student_id = u.id AND f.coaching_id IS NULL
  `);

  if (legacyCoaching) {
    await run(`UPDATE batches SET coaching_id = ? WHERE coaching_id IS NULL`, [legacyCoaching.id]);
    await run(`
      UPDATE batch_notes bn
      SET coaching_id = COALESCE(
        (SELECT coaching_id FROM users u WHERE u.id = bn.created_by),
        ?
      )
      WHERE bn.coaching_id IS NULL
    `, [legacyCoaching.id]);

    await run(`
      UPDATE answer_upload_requests ar
      SET coaching_id = COALESCE(
        (SELECT coaching_id FROM users u WHERE u.id = ar.created_by),
        ?
      )
      WHERE ar.coaching_id IS NULL
    `, [legacyCoaching.id]);
  }
}

async function ensureBatchRow(coachingId, name, standard = null, course = null, createdBy = null) {
  const normalizedName = normalizeBatchName(name);
  if (!normalizedName) return null;

  const existing = await get(
    `SELECT id, standard, course
     FROM batches
     WHERE coaching_id = ? AND normalized_name = ?
     LIMIT 1`,
    [coachingId, normalizedName]
  );

  if (existing) {
    if ((!existing.standard && standard) || (!existing.course && course)) {
      await run(
        `UPDATE batches
         SET standard = COALESCE(standard, ?),
             course = COALESCE(course, ?)
         WHERE id = ?`,
        [standard || null, course || null, existing.id]
      );
    }
    return existing.id;
  }

  const result = await run(
    `INSERT INTO batches (coaching_id, name, normalized_name, standard, course, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [coachingId, name, normalizedName, standard || null, course || null, createdBy || null]
  );

  return result.lastID;
}

async function backfillBatchRelations() {
  const students = await all(
    `SELECT id, coaching_id, batch_id, standard, course
     FROM users
     WHERE role = 'student' AND coaching_id IS NOT NULL`
  );

  for (const student of students) {
    if (student.batch_id) continue;
    const batchName = getLegacyBatchName(student.standard, student.course);
    if (!batchName) continue;
    const batchId = await ensureBatchRow(student.coaching_id, batchName, student.standard, student.course, null);
    await run(`UPDATE users SET batch_id = ? WHERE id = ?`, [batchId, student.id]);
  }

  const notes = await all(
    `SELECT id, coaching_id, batch_id, standard, course, created_by
     FROM batch_notes
     WHERE coaching_id IS NOT NULL`
  );

  for (const note of notes) {
    if (note.batch_id) continue;
    const batchName = getLegacyBatchName(note.standard, note.course);
    if (!batchName) continue;
    const batchId = await ensureBatchRow(note.coaching_id, batchName, note.standard, note.course, note.created_by);
    await run(`UPDATE batch_notes SET batch_id = ? WHERE id = ?`, [batchId, note.id]);
  }

  const requests = await all(
    `SELECT id, coaching_id, batch_id, standard, course, created_by
     FROM answer_upload_requests
     WHERE coaching_id IS NOT NULL`
  );

  for (const request of requests) {
    if (request.batch_id) continue;
    const batchName = getLegacyBatchName(request.standard, request.course);
    if (!batchName) continue;
    const batchId = await ensureBatchRow(request.coaching_id, batchName, request.standard, request.course, request.created_by);
    await run(`UPDATE answer_upload_requests SET batch_id = ? WHERE id = ?`, [batchId, request.id]);
  }
}

async function ensureIndexes() {
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_plans_code ON subscription_plans(code)`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_coaching_slug ON coaching_classes(slug)`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_owner_username ON users(username) WHERE is_owner = 1`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_coaching_username ON users(coaching_id, username) WHERE username IS NOT NULL AND is_owner = 0`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_coaching_roll ON users(coaching_id, roll_no) WHERE roll_no IS NOT NULL`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_coaching_name ON batches(coaching_id, normalized_name)`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_retention_per_coaching ON batches(coaching_id) WHERE is_retention_batch = 1`);
  await run(`CREATE INDEX IF NOT EXISTS idx_users_batch ON users(coaching_id, role, batch_id, roll_no)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_test_papers_coaching_student ON test_papers(coaching_id, student_id, upload_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_test_papers_answer_request ON test_papers(coaching_id, answer_request_id, student_id, upload_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance(coaching_id, student_id, attendance_date)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_fees_student_created ON fees(coaching_id, student_id, created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_batch_notes_batch ON batch_notes(coaching_id, batch_id, created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_answer_requests_batch_dates ON answer_upload_requests(coaching_id, batch_id, starts_at DESC, ends_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_trial_requests_status_created ON trial_requests(status, created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_trial_requests_email_status ON trial_requests(email, status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_coaching_created ON audit_logs(coaching_id, created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON audit_logs(actor_user_id, created_at DESC)`);
}

async function ensureOwnerAccount(adminUsername, adminPassword, adminForceReset) {
  const owner = await get(`SELECT id, username FROM users WHERE is_owner = 1 LIMIT 1`);
  const hash = await bcrypt.hash(adminPassword, 10);

  if (!owner) {
    await run(
      `INSERT INTO users (
        coaching_id, role, is_owner, username, roll_no, name, batch_id, standard, course, password_hash
      ) VALUES (NULL, 'admin', 1, ?, NULL, ?, NULL, NULL, NULL, ?)`,
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

async function clearStudentPasswordDisplay() {
  await run(
    `UPDATE users
     SET password_display = NULL
     WHERE role = 'student' AND password_display IS NOT NULL`
  );
}

async function initDb() {
  const adminUsername = (process.env.ADMIN_USERNAME || 'kartiiik001').trim();
  const adminPassword = (process.env.ADMIN_PASSWORD || 'Ga7BU8cZ').trim();
  const adminForceReset = String(process.env.ADMIN_FORCE_RESET || 'true').toLowerCase() === 'true';

  await createSubscriptionPlansTable();
  await seedSubscriptionPlans();
  await createCoachingClassesTable();
  await createBatchesTable();
  await createUsersTable();
  await createTestPapersTable();
  await createAttendanceTable();
  await createFeesTable();
  await createBatchNotesTable();
  await createAnswerUploadRequestsTable();
  await createTrialRequestsTable();
  await createAuditLogsTable();
  await backfillTenantScopes();
  await backfillBatchRelations();
  await ensureIndexes();
  await ensureOwnerAccount(adminUsername, adminPassword, adminForceReset);
  await clearStudentPasswordDisplay();

  console.log('PostgreSQL connected and schema ready');
}

module.exports = {
  run,
  get,
  all,
  initDb,
  withTransaction,
};
