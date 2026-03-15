const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
require('dotenv').config({ quiet: true });

const { initDb, run, get, all } = require('./db');
const { initStorage, getStorageMode, uploadPaperFile, getPaperAccess, deleteStoredPaper } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;
const VALID_STANDARDS = new Set(['11th', '12th']);
const VALID_COURSES = new Set(['jee', 'neet']);
const OWNER_SECTIONS = new Set(['overview', 'plans', 'coachings']);
const ADMIN_SECTIONS = new Set(['overview', 'attendance', 'students', 'fees', 'papers', 'notes']);
const ALLOWED_UPLOAD_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only PDF, JPG, JPEG, and PNG files are allowed'));
  },
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'coaching-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 },
  })
);
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

function renderWithMessage(res, view, data = {}) {
  const flash = data.flash || null;
  return res.render(view, { ...data, flash });
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  return next();
}

function requireOwner(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (!req.session.user.isOwner) return res.status(403).send('Forbidden');
  return next();
}

function requireCoachingAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.isOwner || req.session.user.role !== 'admin') return res.status(403).send('Forbidden');
  return next();
}

function requireStudent(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role !== 'student') return res.status(403).send('Forbidden');
  return next();
}

function getOwnerSection(input) {
  const section = (input || '').trim();
  return OWNER_SECTIONS.has(section) ? section : 'overview';
}

function getAdminSection(input) {
  const section = (input || '').trim();
  return ADMIN_SECTIONS.has(section) ? section : 'overview';
}

function toStudentGroups(students) {
  return {
    '11th-jee': students.filter((s) => s.standard === '11th' && s.course === 'jee'),
    '11th-neet': students.filter((s) => s.standard === '11th' && s.course === 'neet'),
    '12th-jee': students.filter((s) => s.standard === '12th' && s.course === 'jee'),
    '12th-neet': students.filter((s) => s.standard === '12th' && s.course === 'neet'),
    unassigned: students.filter((s) => !s.standard || !s.course),
  };
}

function parseAbsentees(input) {
  return new Set(
    (input || '')
      .split(/[\n,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function parsePaperMetaFromFileName(originalName) {
  const base = path.parse(originalName).name.trim();
  const parts = base.split(/[_-]+/).map((v) => v.trim()).filter(Boolean);
  const rollNo = parts[0] || base;

  let marksObtained = null;
  let maxMarks = null;
  let testLabel = '';

  if (parts.length >= 2 && /^\d+(\.\d+)?$/.test(parts[1])) {
    marksObtained = Number(parts[1]);
  }

  if (parts.length >= 3 && /^\d+(\.\d+)?$/.test(parts[2])) {
    maxMarks = Number(parts[2]);
  } else if (marksObtained !== null) {
    maxMarks = 100;
  }

  if (parts.length > 3) {
    testLabel = parts.slice(3).join(' ');
  }

  return {
    rollNo,
    marksObtained,
    maxMarks,
    testLabel: testLabel || null,
  };
}

function groupAttendanceByDate(rows) {
  return rows.reduce((acc, row) => {
    const key = row.attendance_date;
    if (!acc[key]) acc[key] = [];
    acc[key].push(row);
    return acc;
  }, {});
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function slugify(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function buildPortalUrl(req, slug) {
  return `${req.protocol}://${req.get('host')}/login?coaching=${encodeURIComponent(slug)}`;
}

function parseDateOnly(value) {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateLabel(value) {
  const parsed = parseDateOnly(value);
  if (!parsed) return value || '-';

  return parsed.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function getStudentLimitValue(coaching) {
  if (coaching?.max_students === null || coaching?.max_students === undefined || coaching?.max_students === '') {
    return null;
  }

  const parsed = Number(coaching.max_students);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getStudentUsage(count, coaching) {
  const limit = getStudentLimitValue(coaching);
  return {
    count,
    limit,
    remaining: limit === null ? null : Math.max(limit - count, 0),
    atLimit: limit !== null && count >= limit,
  };
}

function getSubscriptionState(coaching) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const status = coaching?.subscription_status || 'active';
  const endsAt = parseDateOnly(coaching?.subscription_ends_at);
  const endsAtLabel = coaching?.subscription_ends_at ? formatDateLabel(coaching.subscription_ends_at) : null;
  const daysUntilEnd = endsAt ? Math.round((endsAt.getTime() - today.getTime()) / 86400000) : null;

  let accessBlocked = !['active', 'trial'].includes(status);
  let reason = accessBlocked ? status : null;

  if (!accessBlocked && endsAt && daysUntilEnd < 0) {
    accessBlocked = true;
    reason = 'expired';
  }

  let notice = null;
  if (!accessBlocked && endsAt && daysUntilEnd !== null && daysUntilEnd >= 0 && daysUntilEnd <= 2) {
    if (daysUntilEnd === 0) {
      notice = `Your subscription ends today (${endsAtLabel}). Renew now to avoid interruption.`;
    } else if (daysUntilEnd === 1) {
      notice = `Your subscription ends tomorrow (${endsAtLabel}). Renew to continue without interruption.`;
    } else {
      notice = `Your subscription ends in 2 days (${endsAtLabel}). Renew early to avoid interruption.`;
    }
  }

  let blockedTitle = 'Subscription inactive';
  let blockedMessage = 'Your coaching subscription is inactive. Renew to continue using the portal.';

  if (reason === 'suspended') {
    blockedTitle = 'Subscription suspended';
    blockedMessage = 'Your coaching account is suspended. Renew or reactivate the subscription to continue.';
  } else if (reason === 'cancelled') {
    blockedTitle = 'Subscription cancelled';
    blockedMessage = 'This coaching subscription has been cancelled. Renew it to restore portal access.';
  } else if (reason === 'expired') {
    blockedTitle = 'Subscription expired';
    blockedMessage = `Your subscription ended on ${endsAtLabel}. Renew to continue using the portal.`;
  }

  return {
    status,
    endsAt: coaching?.subscription_ends_at || null,
    endsAtLabel,
    daysUntilEnd,
    notice,
    accessBlocked,
    reason,
    blockedTitle,
    blockedMessage,
  };
}

async function getCoachingBySlug(slug) {
  if (!slug) return null;

  return get(
    `SELECT cc.*, sp.code AS plan_code, sp.name AS plan_name, sp.price_inr, sp.max_students
     FROM coaching_classes cc
     LEFT JOIN subscription_plans sp ON sp.id = cc.subscription_plan_id
     WHERE cc.slug = ?`,
    [slug]
  );
}

async function getCoachingContextById(id) {
  return get(
    `SELECT cc.*, sp.code AS plan_code, sp.name AS plan_name, sp.price_inr, sp.max_students
     FROM coaching_classes cc
     LEFT JOIN subscription_plans sp ON sp.id = cc.subscription_plan_id
     WHERE cc.id = ?`,
    [id]
  );
}

function buildSessionUser(user, coaching = null) {
  return {
    id: user.id,
    role: user.is_owner ? 'owner' : user.role,
    isOwner: Boolean(user.is_owner),
    coachingId: user.coaching_id || null,
    coachingName: coaching?.name || null,
    coachingSlug: coaching?.slug || null,
    coachingPlan: coaching?.plan_name || null,
    coachingPlanCode: coaching?.plan_code || null,
    coachingPlanMaxStudents: getStudentLimitValue(coaching),
    coachingSubscriptionStatus: coaching?.subscription_status || null,
    coachingSubscriptionEndsAt: coaching?.subscription_ends_at || null,
    username: user.username || null,
    rollNo: user.roll_no || null,
    name: user.name || null,
    standard: user.standard || null,
    course: user.course || null,
  };
}

async function renderLoginPage(req, res, flash = null) {
  const coachingHint = (req.query.coaching || req.body?.coachingSlug || '').trim().toLowerCase();
  const coaching = coachingHint ? await getCoachingBySlug(coachingHint) : null;
  const nextFlash = flash || req.session?.flash || null;
  if (req.session) req.session.flash = null;

  return renderWithMessage(res, 'auth-login', {
    flash: nextFlash,
    coaching,
    coachingHint,
  });
}

async function getPaperForUser(id, sessionUser) {
  const paper = await get(
    `SELECT tp.*, u.roll_no, u.coaching_id AS student_coaching_id
     FROM test_papers tp
     JOIN users u ON u.id = tp.student_id
     WHERE tp.id = ?`,
    [id]
  );

  if (!paper) return null;
  if (sessionUser.isOwner) return null;
  if (sessionUser.role === 'admin' && paper.coaching_id === sessionUser.coachingId) return paper;
  if (sessionUser.role === 'student' && paper.student_id === sessionUser.id && paper.coaching_id === sessionUser.coachingId) return paper;
  return null;
}

app.use(async (req, res, next) => {
  if (!req.session?.user || req.session.user.isOwner) return next();

  const coaching = await getCoachingContextById(req.session.user.coachingId);
  if (!coaching) {
    req.session.destroy(() => res.redirect('/login'));
    return;
  }

  const subscriptionState = getSubscriptionState(coaching);
  req.currentCoaching = coaching;
  req.subscriptionState = subscriptionState;
  req.session.user = {
    ...req.session.user,
    coachingName: coaching.name,
    coachingSlug: coaching.slug,
    coachingPlan: coaching.plan_name || null,
    coachingPlanCode: coaching.plan_code || null,
    coachingPlanMaxStudents: getStudentLimitValue(coaching),
    coachingSubscriptionStatus: coaching.subscription_status,
    coachingSubscriptionEndsAt: coaching.subscription_ends_at || null,
  };

  if (!subscriptionState.accessBlocked) {
    if (req.path === '/subscription-status') {
      return res.redirect('/');
    }
    return next();
  }

  if (req.session.user.role === 'student') {
    if (req.path === '/subscription-status' || req.path === '/logout') return next();
    return res.redirect('/subscription-status');
  }

  if (req.session.user.role === 'admin') {
    if (req.path === '/logout') return next();
    if (req.method === 'GET' && req.path === '/admin/dashboard') return next();
    return res.redirect('/admin/dashboard');
  }

  return next();
});

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.isOwner) return res.redirect('/owner/dashboard');
  if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');
  return res.redirect('/student/dashboard');
});

app.get('/login', async (req, res) => {
  if (req.session.user) return res.redirect('/');
  return renderLoginPage(req, res);
});

app.post('/login', async (req, res) => {
  const role = (req.body.role || '').trim();
  const username = (req.body.username || '').trim();
  const submittedPassword = req.body.password || '';
  const password =
    role === 'student' && !submittedPassword.trim()
      ? username
      : submittedPassword;
  const coachingSlug = (req.body.coachingSlug || '').trim().toLowerCase();

  let user = null;
  let coaching = null;

  if (role === 'owner') {
    user = await get(
      `SELECT * FROM users WHERE is_owner = 1 AND username = ? LIMIT 1`,
      [username]
    );
  } else if (role === 'admin' || role === 'student') {
    coaching = await getCoachingBySlug(coachingSlug);

    if (!coaching) {
      return renderLoginPage(req, res, { type: 'error', text: 'Invalid coaching code' });
    }

    if (role === 'admin') {
      user = await get(
        `SELECT * FROM users
         WHERE coaching_id = ? AND role = 'admin' AND is_owner = 0 AND username = ?
         LIMIT 1`,
        [coaching.id, username]
      );
    } else {
      user = await get(
        `SELECT * FROM users
         WHERE coaching_id = ? AND role = 'student' AND roll_no = ?
         LIMIT 1`,
        [coaching.id, username]
      );
    }
  }

  if (!user) {
    return renderLoginPage(req, res, { type: 'error', text: 'Invalid credentials' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return renderLoginPage(req, res, { type: 'error', text: 'Invalid credentials' });
  }

  req.session.user = buildSessionUser(user, coaching);

  if (!req.session.user.isOwner && coaching) {
    const subscriptionState = getSubscriptionState(coaching);
    if (subscriptionState.accessBlocked) {
      if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');
      return res.redirect('/subscription-status');
    }
  }

  if (req.session.user.isOwner) return res.redirect('/owner/dashboard');
  if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');
  return res.redirect('/student/dashboard');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/subscription-status', requireAuth, async (req, res) => {
  if (req.session.user.isOwner) return res.redirect('/owner/dashboard');
  if (req.session.user.role === 'admin') return res.redirect('/admin/dashboard');

  const coaching = req.currentCoaching || await getCoachingContextById(req.session.user.coachingId);
  const subscriptionState = req.subscriptionState || getSubscriptionState(coaching);
  if (!subscriptionState.accessBlocked) return res.redirect('/student/dashboard');

  return renderWithMessage(res, 'subscription-status', {
    user: req.session.user,
    coaching,
    subscriptionState,
  });
});

app.get('/owner/dashboard', requireOwner, async (req, res) => {
  const activeSection = getOwnerSection(req.query.section);

  const plans = await all(
    `SELECT id, code, name, price_inr, max_students, description, is_active
     FROM subscription_plans
     ORDER BY CASE code WHEN 'basic' THEN 1 WHEN 'mid' THEN 2 WHEN 'premium' THEN 3 ELSE 99 END`
  );

  const coachings = await all(
    `SELECT
       cc.id,
       cc.name,
       cc.slug,
       cc.contact_email,
       cc.subscription_status,
       cc.subscription_started_at,
       cc.subscription_ends_at,
       sp.name AS plan_name,
       sp.code AS plan_code,
       sp.price_inr,
       sp.max_students,
       admin.username AS admin_username,
       admin.name AS admin_name,
       (
         SELECT COUNT(*) FROM users u
         WHERE u.coaching_id = cc.id AND u.role = 'student'
       ) AS student_count
     FROM coaching_classes cc
     LEFT JOIN subscription_plans sp ON sp.id = cc.subscription_plan_id
     LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.role = 'admin' AND admin.is_owner = 0
     GROUP BY cc.id
     ORDER BY cc.created_at DESC`
  );

  const totals = await get(
    `SELECT
       COUNT(*) AS total_coachings,
       SUM(CASE WHEN subscription_status IN ('active', 'trial') THEN 1 ELSE 0 END) AS active_coachings
     FROM coaching_classes`
  );

  const students = await get(`SELECT COUNT(*) AS total_students FROM users WHERE role = 'student'`);
  const expiringSoon = coachings.filter((item) => {
    const subscriptionState = getSubscriptionState(item);
    return !subscriptionState.accessBlocked && Boolean(subscriptionState.notice);
  }).length;
  const estimatedRevenue = coachings
    .filter((item) => ['active', 'trial'].includes(item.subscription_status))
    .reduce((sum, item) => sum + Number(item.price_inr || 0), 0);

  renderWithMessage(res, 'owner-dashboard', {
    user: req.session.user,
    activeSection,
    plans,
    coachings: coachings.map((coaching) => ({
      ...coaching,
      portal_url: buildPortalUrl(req, coaching.slug),
      subscriptionState: getSubscriptionState(coaching),
      studentUsage: getStudentUsage(Number(coaching.student_count || 0), coaching),
    })),
    stats: {
      totalCoachings: Number(totals?.total_coachings || 0),
      activeCoachings: Number(totals?.active_coachings || 0),
      totalStudents: Number(students?.total_students || 0),
      estimatedRevenue,
      expiringSoon,
    },
    flash: req.session.flash,
  });
  req.session.flash = null;
});

app.post('/owner/plans/:id', requireOwner, async (req, res) => {
  const planId = Number(req.params.id);
  const price = Number(req.body.priceInr);
  const maxStudentsInput = (req.body.maxStudents || '').trim();
  const maxStudents = maxStudentsInput === '' ? null : Number(maxStudentsInput);
  const description = (req.body.description || '').trim();

  if (!Number.isFinite(price) || price < 0) {
    req.session.flash = { type: 'error', text: 'Plan price must be a valid number' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  if (maxStudents !== null && (!Number.isInteger(maxStudents) || maxStudents <= 0)) {
    req.session.flash = { type: 'error', text: 'Student limit must be a positive whole number or blank for unlimited' };
    return res.redirect('/owner/dashboard?section=plans');
  }

  await run(
    `UPDATE subscription_plans SET price_inr = ?, max_students = ?, description = ? WHERE id = ?`,
    [price, maxStudents, description, planId]
  );

  req.session.flash = { type: 'success', text: 'Plan pricing updated' };
  return res.redirect('/owner/dashboard?section=plans');
});

app.post('/owner/coachings', requireOwner, async (req, res) => {
  const name = (req.body.name || '').trim();
  const slug = slugify(req.body.slug || name);
  const contactEmail = (req.body.contactEmail || '').trim() || null;
  const adminUsername = (req.body.adminUsername || '').trim();
  const adminName = (req.body.adminName || '').trim() || 'Coaching Admin';
  const adminPassword = (req.body.adminPassword || '').trim();
  const planId = Number(req.body.planId);
  const subscriptionStatus = (req.body.subscriptionStatus || 'active').trim();
  const subscriptionStartedAt = req.body.subscriptionStartedAt || null;
  const subscriptionEndsAt = req.body.subscriptionEndsAt || null;

  if (!name || !slug || !adminUsername || !adminPassword) {
    req.session.flash = { type: 'error', text: 'Coaching name, slug, admin username, and admin password are required' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  const existingSlug = await get(`SELECT id FROM coaching_classes WHERE slug = ?`, [slug]);
  if (existingSlug) {
    req.session.flash = { type: 'error', text: 'Coaching code already exists' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  const plan = await get(`SELECT id FROM subscription_plans WHERE id = ?`, [planId]);
  if (!plan) {
    req.session.flash = { type: 'error', text: 'Select a valid subscription plan' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  const coachingInsert = await run(
    `INSERT INTO coaching_classes (
      name, slug, contact_email, subscription_plan_id, subscription_status, subscription_started_at, subscription_ends_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, slug, contactEmail, planId, subscriptionStatus, subscriptionStartedAt, subscriptionEndsAt]
  );

  const coachingId = coachingInsert.lastID;
  const passwordHash = await bcrypt.hash(adminPassword, 10);

  await run(
    `INSERT INTO users (
      coaching_id, role, is_owner, username, roll_no, name, standard, course, password_hash
    ) VALUES (?, 'admin', 0, ?, NULL, ?, NULL, NULL, ?)`,
    [coachingId, adminUsername, adminName, passwordHash]
  );

  req.session.flash = {
    type: 'success',
    text: `Coaching created. Portal URL: ${slug}`,
  };
  return res.redirect('/owner/dashboard?section=coachings');
});

app.post('/owner/coachings/:id/subscription', requireOwner, async (req, res) => {
  const coachingId = Number(req.params.id);
  const planId = Number(req.body.planId);
  const subscriptionStatus = (req.body.subscriptionStatus || 'active').trim();
  const subscriptionStartedAt = req.body.subscriptionStartedAt || null;
  const subscriptionEndsAt = req.body.subscriptionEndsAt || null;

  const plan = await get(`SELECT id FROM subscription_plans WHERE id = ?`, [planId]);
  if (!plan) {
    req.session.flash = { type: 'error', text: 'Select a valid subscription plan' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  await run(
    `UPDATE coaching_classes
     SET subscription_plan_id = ?, subscription_status = ?, subscription_started_at = ?, subscription_ends_at = ?
     WHERE id = ?`,
    [planId, subscriptionStatus, subscriptionStartedAt, subscriptionEndsAt, coachingId]
  );

  req.session.flash = { type: 'success', text: 'Coaching subscription updated' };
  return res.redirect('/owner/dashboard?section=coachings');
});

app.get('/admin/dashboard', requireCoachingAdmin, async (req, res) => {
  const subscriptionState = req.subscriptionState || getSubscriptionState(req.currentCoaching);
  const activeSection = subscriptionState.accessBlocked ? 'overview' : getAdminSection(req.query.section);
  const attendanceDateFilter = (req.query.attendanceDate || '').trim();
  const coachingId = req.session.user.coachingId;
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);

  const students = await all(
    `SELECT id, roll_no, name, standard, course, created_at
     FROM users
     WHERE role = 'student' AND coaching_id = ?
     ORDER BY standard DESC, course ASC, roll_no ASC`,
    [coachingId]
  );

  const papers = await all(
    `SELECT
       tp.id,
       tp.original_name,
       tp.stored_name,
       tp.upload_date,
       tp.storage_type,
       tp.storage_key,
       tp.size_bytes,
       tp.marks_obtained,
       tp.max_marks,
       tp.test_label,
       u.roll_no,
       u.name,
       u.standard,
       u.course
     FROM test_papers tp
     JOIN users u ON u.id = tp.student_id
     WHERE tp.coaching_id = ?
     ORDER BY tp.upload_date DESC
     LIMIT 150`,
    [coachingId]
  );

  let attendanceSql = `
    SELECT a.id, a.attendance_date, a.status, a.notes, u.roll_no, u.name, u.standard, u.course
    FROM attendance a
    JOIN users u ON u.id = a.student_id
    WHERE a.coaching_id = ?
  `;
  const attendanceParams = [coachingId];
  if (attendanceDateFilter) {
    attendanceSql += ` AND a.attendance_date = ? `;
    attendanceParams.push(attendanceDateFilter);
  }
  attendanceSql += ` ORDER BY a.attendance_date DESC, a.id DESC LIMIT 300 `;
  const attendance = await all(attendanceSql, attendanceParams);

  const attendanceDates = await all(
    `SELECT DISTINCT attendance_date
     FROM attendance
     WHERE coaching_id = ?
     ORDER BY attendance_date DESC
     LIMIT 90`,
    [coachingId]
  );

  const fees = await all(
    `SELECT f.id, f.amount, f.due_date, f.payment_date, f.status, f.notes, u.roll_no, u.name, u.standard, u.course
     FROM fees f
     JOIN users u ON u.id = f.student_id
     WHERE f.coaching_id = ?
     ORDER BY f.created_at DESC
     LIMIT 150`,
    [coachingId]
  );

  const notes = await all(
    `SELECT id, standard, course, title, resource_url, description, created_at
     FROM batch_notes
     WHERE coaching_id = ?
     ORDER BY created_at DESC
     LIMIT 150`,
    [coachingId]
  );

  const stats = {
    totalStudents: students.length,
    totalPapers: papers.length,
    pendingFees: fees.filter((item) => item.status === 'pending' || item.status === 'overdue').length,
    absentEntries: attendance.filter((item) => item.status === 'absent').length,
    notesCount: notes.length,
  };
  const studentUsage = getStudentUsage(students.length, coaching);

  renderWithMessage(res, 'admin-dashboard', {
    user: req.session.user,
    coaching,
    subscriptionState,
    subscriptionNotice: subscriptionState.notice,
    students,
    studentGroups: toStudentGroups(students),
    studentUsage,
    papers,
    attendance,
    attendanceByDate: groupAttendanceByDate(attendance),
    attendanceDates,
    attendanceDateFilter,
    fees,
    notes,
    stats,
    activeSection,
    storageMode: getStorageMode(),
    flash: req.session.flash,
  });
  req.session.flash = null;
});

app.post('/admin/students', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const rollNo = (req.body.rollNo || '').trim();
  const name = (req.body.name || '').trim() || rollNo;
  const submittedPassword = (req.body.password || '').trim();
  const password = submittedPassword || rollNo;
  const standard = (req.body.standard || '').trim();
  const course = (req.body.course || '').trim().toLowerCase();

  if (!rollNo) {
    req.session.flash = { type: 'error', text: 'Roll number is required' };
    return res.redirect('/admin/dashboard?section=students');
  }

  if (!VALID_STANDARDS.has(standard) || !VALID_COURSES.has(course)) {
    req.session.flash = { type: 'error', text: 'Please select valid standard and course' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const existing = await get(
    `SELECT id FROM users WHERE coaching_id = ? AND roll_no = ? LIMIT 1`,
    [coachingId, rollNo]
  );
  if (existing) {
    req.session.flash = { type: 'error', text: 'Roll number already exists in this coaching' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const currentStudents = await get(
    `SELECT COUNT(*) AS total_students FROM users WHERE coaching_id = ? AND role = 'student'`,
    [coachingId]
  );
  const studentUsage = getStudentUsage(Number(currentStudents?.total_students || 0), coaching);
  if (studentUsage.atLimit) {
    req.session.flash = {
      type: 'error',
      text: `Student limit reached for the ${coaching?.plan_name || 'current'} plan. Upgrade or increase the plan limit to add more students.`,
    };
    return res.redirect('/admin/dashboard?section=students');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await run(
    `INSERT INTO users (
      coaching_id, role, is_owner, username, roll_no, name, standard, course, password_hash
    ) VALUES (?, 'student', 0, NULL, ?, ?, ?, ?, ?)`,
    [coachingId, rollNo, name, standard, course, passwordHash]
  );

  req.session.flash = {
    type: 'success',
    text: submittedPassword
      ? `Student ${rollNo} created with a custom password`
      : `Student ${rollNo} created. Default password is the roll number`,
  };
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/students/:id/reset-password', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const studentId = Number(req.params.id);
  const student = await get(
    `SELECT id, roll_no
     FROM users
     WHERE id = ? AND coaching_id = ? AND role = 'student'`,
    [studentId, coachingId]
  );

  if (!student) {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const passwordHash = await bcrypt.hash(student.roll_no, 10);
  await run(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, studentId]);

  req.session.flash = {
    type: 'success',
    text: `Password reset for ${student.roll_no}. Student can now use roll number as password`,
  };
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/students/:id/delete', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const studentId = Number(req.params.id);

  const student = await get(
    `SELECT id, roll_no FROM users WHERE id = ? AND coaching_id = ? AND role = 'student'`,
    [studentId, coachingId]
  );
  if (!student) {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const files = await all(
    `SELECT stored_name, storage_type, storage_key, public_url, content_type
     FROM test_papers
     WHERE coaching_id = ? AND student_id = ?`,
    [coachingId, studentId]
  );

  await run(`DELETE FROM attendance WHERE coaching_id = ? AND student_id = ?`, [coachingId, studentId]);
  await run(`DELETE FROM fees WHERE coaching_id = ? AND student_id = ?`, [coachingId, studentId]);
  await run(`DELETE FROM test_papers WHERE coaching_id = ? AND student_id = ?`, [coachingId, studentId]);
  await run(`DELETE FROM users WHERE id = ? AND coaching_id = ?`, [studentId, coachingId]);

  for (const file of files) {
    try {
      await deleteStoredPaper(file);
    } catch (err) {
      console.error('Failed deleting stored paper', err);
    }
  }

  req.session.flash = { type: 'success', text: `Student ${student.roll_no} deleted successfully` };
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/upload-papers', requireCoachingAdmin, upload.array('papers', 100), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const files = req.files || [];

  if (!files.length) {
    req.session.flash = { type: 'error', text: 'No files uploaded' };
    return res.redirect('/admin/dashboard?section=papers');
  }

  const report = { assigned: 0, skipped: 0, failed: 0 };

  for (const file of files) {
    const paperMeta = parsePaperMetaFromFileName(file.originalname);
    const student = await get(
      `SELECT id FROM users WHERE coaching_id = ? AND role = 'student' AND roll_no = ?`,
      [coachingId, paperMeta.rollNo]
    );

    if (!student) {
      report.skipped += 1;
      continue;
    }

    try {
      const stored = await uploadPaperFile(file);
      await run(
        `INSERT INTO test_papers (
          coaching_id, student_id, original_name, stored_name, uploaded_by,
          storage_type, storage_key, public_url, content_type, size_bytes,
          marks_obtained, max_marks, test_label
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          coachingId,
          student.id,
          file.originalname,
          stored.storedName,
          req.session.user.id,
          stored.storageType,
          stored.storageKey,
          stored.publicUrl,
          stored.contentType,
          stored.sizeBytes,
          paperMeta.marksObtained,
          paperMeta.maxMarks,
          paperMeta.testLabel,
        ]
      );
      report.assigned += 1;
    } catch (err) {
      console.error('Upload failed for', file.originalname, err);
      report.failed += 1;
    }
  }

  req.session.flash = {
    type: report.failed ? 'error' : 'success',
    text: `Upload complete. Assigned: ${report.assigned}, Skipped: ${report.skipped}, Failed: ${report.failed}`,
  };
  return res.redirect('/admin/dashboard?section=papers');
});

app.post('/admin/attendance', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const rollNo = (req.body.rollNo || '').trim();
  const attendanceDate = req.body.attendanceDate;
  const status = req.body.status;
  const notes = (req.body.notes || '').trim();

  const student = await get(
    `SELECT id FROM users WHERE coaching_id = ? AND role = 'student' AND roll_no = ?`,
    [coachingId, rollNo]
  );
  if (!student) {
    req.session.flash = { type: 'error', text: 'Student roll number not found' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const existing = await get(
    `SELECT id FROM attendance WHERE coaching_id = ? AND student_id = ? AND attendance_date = ? LIMIT 1`,
    [coachingId, student.id, attendanceDate]
  );

  if (existing) {
    await run(
      `UPDATE attendance SET status = ?, notes = ?, marked_by = ? WHERE id = ?`,
      [status, notes, req.session.user.id, existing.id]
    );
  } else {
    await run(
      `INSERT INTO attendance (coaching_id, student_id, attendance_date, status, notes, marked_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [coachingId, student.id, attendanceDate, status, notes, req.session.user.id]
    );
  }

  req.session.flash = { type: 'success', text: 'Attendance saved' };
  return res.redirect(`/admin/dashboard?section=attendance&attendanceDate=${encodeURIComponent(attendanceDate)}`);
});

app.post('/admin/attendance-bulk', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const standard = (req.body.standard || '').trim();
  const course = (req.body.course || '').trim().toLowerCase();
  const attendanceDate = req.body.attendanceDate;
  const notes = (req.body.notes || '').trim();

  if (!VALID_STANDARDS.has(standard) || !VALID_COURSES.has(course)) {
    req.session.flash = { type: 'error', text: 'Please select valid standard and course' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  if (!attendanceDate) {
    req.session.flash = { type: 'error', text: 'Attendance date is required' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const students = await all(
    `SELECT id, roll_no
     FROM users
     WHERE coaching_id = ? AND role = 'student' AND standard = ? AND course = ?
     ORDER BY roll_no ASC`,
    [coachingId, standard, course]
  );

  if (!students.length) {
    req.session.flash = { type: 'error', text: 'No students found in selected group' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const absentees = parseAbsentees(req.body.absentRollNos);
  let absentCount = 0;
  let presentCount = 0;

  for (const student of students) {
    const nextStatus = absentees.has(student.roll_no) ? 'absent' : 'present';
    if (nextStatus === 'absent') absentCount += 1;
    else presentCount += 1;

    const existing = await get(
      `SELECT id FROM attendance WHERE coaching_id = ? AND student_id = ? AND attendance_date = ? LIMIT 1`,
      [coachingId, student.id, attendanceDate]
    );

    if (existing) {
      await run(
        `UPDATE attendance SET status = ?, notes = ?, marked_by = ? WHERE id = ?`,
        [nextStatus, notes, req.session.user.id, existing.id]
      );
    } else {
      await run(
        `INSERT INTO attendance (coaching_id, student_id, attendance_date, status, notes, marked_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [coachingId, student.id, attendanceDate, nextStatus, notes, req.session.user.id]
      );
    }
  }

  req.session.flash = {
    type: 'success',
    text: `Attendance saved. Present: ${presentCount}, Absent: ${absentCount}`,
  };
  return res.redirect(`/admin/dashboard?section=attendance&attendanceDate=${encodeURIComponent(attendanceDate)}`);
});

app.post('/admin/fees', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const rollNo = (req.body.rollNo || '').trim();
  const amount = Number(req.body.amount);
  const dueDate = req.body.dueDate || null;
  const paymentDate = req.body.paymentDate || null;
  const status = req.body.status;
  const notes = (req.body.notes || '').trim();

  const student = await get(
    `SELECT id FROM users WHERE coaching_id = ? AND role = 'student' AND roll_no = ?`,
    [coachingId, rollNo]
  );
  if (!student) {
    req.session.flash = { type: 'error', text: 'Student roll number not found' };
    return res.redirect('/admin/dashboard?section=fees');
  }

  await run(
    `INSERT INTO fees (coaching_id, student_id, amount, due_date, payment_date, status, notes, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [coachingId, student.id, amount, dueDate, paymentDate, status, notes, req.session.user.id]
  );

  req.session.flash = { type: 'success', text: 'Fee record added' };
  return res.redirect('/admin/dashboard?section=fees');
});

app.post('/admin/notes', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const standard = (req.body.standard || '').trim();
  const course = (req.body.course || '').trim().toLowerCase();
  const title = (req.body.title || '').trim();
  const resourceUrl = (req.body.resourceUrl || '').trim();
  const description = (req.body.description || '').trim();

  if (!VALID_STANDARDS.has(standard) || !VALID_COURSES.has(course)) {
    req.session.flash = { type: 'error', text: 'Please select valid standard and course for note' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  if (!title || !resourceUrl || !isValidHttpUrl(resourceUrl)) {
    req.session.flash = { type: 'error', text: 'Valid title and URL are required' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  await run(
    `INSERT INTO batch_notes (coaching_id, standard, course, title, resource_url, description, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [coachingId, standard, course, title, resourceUrl, description, req.session.user.id]
  );

  req.session.flash = { type: 'success', text: 'Batch note published' };
  return res.redirect('/admin/dashboard?section=notes');
});

app.get('/student/dashboard', requireStudent, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const subscriptionState = req.subscriptionState || getSubscriptionState(coaching);
  const profile = await get(
    `SELECT id, roll_no, name, standard, course
     FROM users
     WHERE id = ? AND coaching_id = ? AND role = 'student'`,
    [req.session.user.id, coachingId]
  );

  const papers = await all(
    `SELECT id, original_name, stored_name, upload_date, storage_type, storage_key, content_type, marks_obtained, max_marks, test_label
     FROM test_papers
     WHERE coaching_id = ? AND student_id = ?
     ORDER BY upload_date DESC`,
    [coachingId, req.session.user.id]
  );

  const attendance = await all(
    `SELECT attendance_date, status, notes
     FROM attendance
     WHERE coaching_id = ? AND student_id = ?
     ORDER BY attendance_date DESC, id DESC`,
    [coachingId, req.session.user.id]
  );

  const fees = await all(
    `SELECT amount, due_date, payment_date, status, notes
     FROM fees
     WHERE coaching_id = ? AND student_id = ?
     ORDER BY created_at DESC`,
    [coachingId, req.session.user.id]
  );

  const notes = profile?.standard && profile?.course
    ? await all(
      `SELECT title, resource_url, description, created_at
       FROM batch_notes
       WHERE coaching_id = ? AND standard = ? AND course = ?
       ORDER BY created_at DESC`,
      [coachingId, profile.standard, profile.course]
    )
    : [];

  const attendanceSummary = await get(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_count,
       SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent_count,
       SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late_count
     FROM attendance
     WHERE coaching_id = ? AND student_id = ?`,
    [coachingId, req.session.user.id]
  );

  const feeSummary = await get(
    `SELECT
       COUNT(*) AS total_fees,
       SUM(CASE WHEN status IN ('pending', 'overdue') THEN 1 ELSE 0 END) AS pending_count,
       SUM(CASE WHEN status IN ('pending', 'overdue') THEN amount ELSE 0 END) AS pending_amount
     FROM fees
     WHERE coaching_id = ? AND student_id = ?`,
    [coachingId, req.session.user.id]
  );

  const totalAttendance = Number(attendanceSummary?.total || 0);
  const presentCount = Number(attendanceSummary?.present_count || 0);
  const attendancePercent = totalAttendance
    ? ((presentCount / totalAttendance) * 100).toFixed(1)
    : '0.0';

  const markedPapers = papers
    .filter((paper) => paper.marks_obtained !== null && paper.max_marks !== null && Number(paper.max_marks) > 0)
    .slice()
    .reverse();
  const totalMarksObtained = markedPapers.reduce((sum, paper) => sum + Number(paper.marks_obtained || 0), 0);
  const totalMaxMarks = markedPapers.reduce((sum, paper) => sum + Number(paper.max_marks || 0), 0);
  const marksPercent = totalMaxMarks
    ? ((totalMarksObtained / totalMaxMarks) * 100).toFixed(1)
    : '0.0';
  const progressSeries = markedPapers.map((paper, index) => ({
    label: paper.test_label || path.parse(paper.original_name).name,
    marks: Number(paper.marks_obtained),
    max: Number(paper.max_marks),
    percent: Number(((Number(paper.marks_obtained) / Number(paper.max_marks)) * 100).toFixed(1)),
    testNo: index + 1,
  }));

  renderWithMessage(res, 'student-dashboard', {
    user: req.session.user,
    coaching,
    subscriptionState,
    subscriptionNotice: subscriptionState.notice,
    profile,
    papers,
    attendance,
    fees,
    notes,
    attendanceSummary: {
      total: totalAttendance,
      presentCount,
      absentCount: Number(attendanceSummary?.absent_count || 0),
      lateCount: Number(attendanceSummary?.late_count || 0),
      attendancePercent,
    },
    feeSummary: {
      totalFees: Number(feeSummary?.total_fees || 0),
      pendingCount: Number(feeSummary?.pending_count || 0),
      pendingAmount: Number(feeSummary?.pending_amount || 0),
    },
    marksSummary: {
      testsCount: markedPapers.length,
      totalMarksObtained,
      totalMaxMarks,
      marksPercent,
    },
    progressSeries,
    flash: req.session.flash,
  });
  req.session.flash = null;
});

app.get('/papers/:id/view', requireAuth, async (req, res) => {
  const paper = await getPaperForUser(req.params.id, req.session.user);
  if (!paper) return res.status(404).send('Paper not found');

  const access = await getPaperAccess(paper, 'inline');
  if (access.type === 'redirect') return res.redirect(access.url);
  if (!fs.existsSync(access.filePath)) return res.status(404).send('File not available');

  res.setHeader('Content-Disposition', `inline; filename="${paper.original_name}"`);
  return res.sendFile(access.filePath);
});

app.get('/papers/:id/download', requireAuth, async (req, res) => {
  const paper = await getPaperForUser(req.params.id, req.session.user);
  if (!paper) return res.status(404).send('Paper not found');

  const access = await getPaperAccess(paper, 'attachment');
  if (access.type === 'redirect') return res.redirect(access.url);
  if (!fs.existsSync(access.filePath)) return res.status(404).send('File not available');

  return res.download(access.filePath, paper.original_name);
});

app.use((err, req, res, next) => {
  console.error(err);

  if (req.session?.user?.isOwner) {
    req.session.flash = { type: 'error', text: err.message || 'Server error' };
    return res.redirect('/owner/dashboard');
  }

  if (req.session?.user?.role === 'admin') {
    req.session.flash = { type: 'error', text: err.message || 'Server error' };
    return res.redirect('/admin/dashboard');
  }

  if (req.session) {
    req.session.flash = { type: 'error', text: err.message || 'Server error' };
  }
  return res.redirect('/login');
});

Promise.resolve()
  .then(() => {
    initStorage();
    return initDb();
  })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server started on http://localhost:${PORT}`);
      console.log(`File storage mode: ${getStorageMode()}`);
    });
  })
  .catch((err) => {
    console.error('Startup failed', err);
    process.exit(1);
  });
