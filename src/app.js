const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
require('dotenv').config({ quiet: true });

const { initDb, run, get, all, withTransaction } = require('./db');
const { initStorage, getStorageMode, uploadPaperFile, getPaperAccess, deleteStoredPaper } = require('./storage');

const app = express();
function resolvePort(value) {
  const raw = String(value || '').trim();
  if (!raw) return 3000;

  if (/^\d+$/.test(raw)) {
    const numericPort = Number(raw);
    if (Number.isInteger(numericPort) && numericPort > 0 && numericPort < 65536) {
      return numericPort;
    }
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
    return parsed;
  }

  return 3000;
}

const PORT = resolvePort(process.env.PORT);
const OWNER_SECTIONS = new Set(['overview', 'plans', 'coachings']);
const ADMIN_SECTIONS = new Set(['overview', 'attendance', 'students', 'fees', 'papers', 'notes']);
const ALLOWED_UPLOAD_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/jpg']);
const ANSWER_UPLOAD_WINDOW_HOURS = 24;
const DEFAULT_THEME = {
  brand: '#1769aa',
  background: '#f3f6fb',
  surface: '#ffffff',
};

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
  if (!req.session.user) return res.redirect('/owner/login');
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

function formatLegacyBatchLabel(standard, course) {
  const safeStandard = String(standard || '').trim();
  const safeCourse = String(course || '').trim().toUpperCase();

  if (safeStandard && safeCourse) return `${safeStandard} - ${safeCourse}`;
  if (safeStandard) return safeStandard;
  if (safeCourse) return safeCourse;
  return '';
}

function getBatchLabel(item) {
  return String(item?.batch_name || '').trim()
    || formatLegacyBatchLabel(item?.standard, item?.course)
    || 'Unassigned';
}

function normalizeBatchName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
}

function toStudentBatchGroups(students, batches = []) {
  const batchOrder = new Map(batches.map((batch, index) => [String(batch.id), index]));
  const groups = new Map();

  students.forEach((student) => {
    const key = student.batch_id ? `batch-${student.batch_id}` : 'unassigned';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: getBatchLabel(student),
        students: [],
        order: student.batch_id ? batchOrder.get(String(student.batch_id)) ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER,
        isUnassigned: !student.batch_id,
      });
    }

    groups.get(key).students.push(student);
  });

  return Array.from(groups.values()).sort((a, b) => {
    if (a.isUnassigned !== b.isUnassigned) return a.isUnassigned ? 1 : -1;
    if (a.order !== b.order) return a.order - b.order;
    return a.label.localeCompare(b.label, 'en', { numeric: true, sensitivity: 'base' });
  });
}

function toBatchSummaries(students, batches = []) {
  const counts = new Map();
  students.forEach((student) => {
    const key = student.batch_id ? String(student.batch_id) : 'unassigned';
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const summaries = batches.map((batch) => ({
    ...batch,
    count: counts.get(String(batch.id)) || 0,
  }));

  if (counts.get('unassigned')) {
    summaries.push({
      id: null,
      name: 'Unassigned',
      count: counts.get('unassigned'),
      isUnassigned: true,
    });
  }

  return summaries;
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

async function getBatchesForCoaching(coachingId) {
  return all(
    `SELECT id, name, normalized_name, standard, course, created_at
     FROM batches
     WHERE coaching_id = ?
     ORDER BY LOWER(name) ASC, id ASC`,
    [coachingId]
  );
}

async function getBatchForCoaching(coachingId, batchId) {
  return get(
    `SELECT id, coaching_id, name, normalized_name, standard, course
     FROM batches
     WHERE coaching_id = ? AND id = ?
     LIMIT 1`,
    [coachingId, batchId]
  );
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

function parseDateTimeLocal(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateTimeLabel(value) {
  const parsed = parseDateTimeLocal(value);
  if (!parsed) return value || '-';

  return parsed.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function toDateTimeLocalInput(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function addHours(date, hours) {
  return new Date(date.getTime() + (hours * 60 * 60 * 1000));
}

function parseOptionalNumber(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
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

function normalizeHexColor(value, fallback) {
  const input = String(value || '').trim();
  if (!input) return fallback;

  const normalized = input.startsWith('#') ? input : `#${input}`;
  if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(normalized)) {
    return fallback;
  }

  if (normalized.length === 4) {
    return `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`.toLowerCase();
  }

  return normalized.toLowerCase();
}

function hexToRgb(hex) {
  const safeHex = normalizeHexColor(hex, DEFAULT_THEME.brand).slice(1);
  return {
    r: Number.parseInt(safeHex.slice(0, 2), 16),
    g: Number.parseInt(safeHex.slice(2, 4), 16),
    b: Number.parseInt(safeHex.slice(4, 6), 16),
  };
}

function rgbaFromHex(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function darkenHex(hex, amount = 22) {
  const { r, g, b } = hexToRgb(hex);
  const next = [r, g, b]
    .map((value) => Math.max(0, Math.min(255, value - amount)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `#${next}`;
}

function buildBranding(coaching = null) {
  const themePrimary = normalizeHexColor(coaching?.theme_primary, DEFAULT_THEME.brand);
  const themeBackground = normalizeHexColor(coaching?.theme_background, DEFAULT_THEME.background);
  const themeSurface = normalizeHexColor(coaching?.theme_surface, DEFAULT_THEME.surface);
  const brandName = String(coaching?.brand_name || coaching?.name || 'Coaching Classes Portal').trim();

  return {
    brandName,
    coachingName: coaching?.name || brandName,
    logoUrl: String(coaching?.logo_url || '').trim(),
    themePrimary,
    themeBackground,
    themeSurface,
    cssVars: [
      `--brand:${themePrimary}`,
      `--brand-dark:${darkenHex(themePrimary, 26)}`,
      `--bg:${themeBackground}`,
      `--card:${themeSurface}`,
      `--line:${rgbaFromHex(themePrimary, 0.14)}`,
      `--bg-accent-a:${rgbaFromHex(themePrimary, 0.18)}`,
      `--bg-accent-b:${rgbaFromHex(themePrimary, 0.08)}`,
      `--surface-glow:${rgbaFromHex(themePrimary, 0.1)}`,
      `--shadow:0 12px 30px ${rgbaFromHex(themePrimary, 0.08)}`,
    ].join(';'),
  };
}

function buildProgressSummaryFromPapers(papers) {
  const markedPapers = (papers || [])
    .filter((paper) => paper.marks_obtained !== null && paper.max_marks !== null && Number(paper.max_marks) > 0)
    .slice()
    .reverse();

  const totalMarksObtained = markedPapers.reduce((sum, paper) => sum + Number(paper.marks_obtained || 0), 0);
  const totalMaxMarks = markedPapers.reduce((sum, paper) => sum + Number(paper.max_marks || 0), 0);
  const marksPercent = totalMaxMarks
    ? ((totalMarksObtained / totalMaxMarks) * 100).toFixed(1)
    : '0.0';

  const progressSeries = markedPapers.map((paper, index) => ({
    label: paper.test_label || path.parse(paper.original_name || 'Test').name,
    marks: Number(paper.marks_obtained),
    max: Number(paper.max_marks),
    percent: Number(((Number(paper.marks_obtained) / Number(paper.max_marks)) * 100).toFixed(1)),
    testNo: index + 1,
  }));

  return {
    markedPapers,
    progressSeries,
    marksSummary: {
      testsCount: markedPapers.length,
      totalMarksObtained,
      totalMaxMarks,
      marksPercent,
    },
  };
}

function getAnswerRequestState(request) {
  const now = new Date();
  const startsAt = parseDateTimeLocal(request.starts_at);
  const endsAt = parseDateTimeLocal(request.ends_at);
  const startsAtLabel = formatDateTimeLabel(request.starts_at);
  const endsAtLabel = formatDateTimeLabel(request.ends_at);
  const remainingMs = endsAt ? endsAt.getTime() - now.getTime() : null;
  const remainingHours = remainingMs !== null ? Math.max(0, Math.round((remainingMs / 3600000) * 10) / 10) : null;

  let phase = 'expired';
  if (startsAt && now < startsAt) phase = 'upcoming';
  else if (startsAt && endsAt && now >= startsAt && now <= endsAt) phase = 'active';

  return {
    phase,
    startsAt,
    endsAt,
    startsAtLabel,
    endsAtLabel,
    isUpcoming: phase === 'upcoming',
    isActive: phase === 'active',
    isExpired: phase === 'expired',
    remainingHours,
  };
}

async function buildAnswerRequestSummaries(coachingId, requests) {
  const summaries = [];

  for (const request of requests) {
    const targetStudents = request.batch_id
      ? await all(
        `SELECT u.id, u.roll_no, u.name, u.contact_phone, u.email, u.batch_id, b.name AS batch_name
         FROM users u
         LEFT JOIN batches b ON b.id = u.batch_id
         WHERE u.coaching_id = ? AND u.role = 'student' AND u.batch_id = ?
         ORDER BY u.roll_no ASC`,
        [coachingId, request.batch_id]
      )
      : await all(
        `SELECT id, roll_no, name, contact_phone, email, batch_id
         FROM users
         WHERE coaching_id = ? AND role = 'student' AND standard = ? AND course = ?
         ORDER BY roll_no ASC`,
        [coachingId, request.standard, request.course]
      );

    const submissions = await all(
      `SELECT tp.id, tp.student_id, tp.upload_date, tp.original_name, tp.test_label, tp.content_type,
              uploader.name AS uploaded_by_name, uploader.role AS uploaded_by_role
       FROM test_papers tp
       LEFT JOIN users uploader ON uploader.id = tp.uploaded_by
       WHERE tp.coaching_id = ? AND tp.answer_request_id = ?
       ORDER BY tp.upload_date DESC`,
      [coachingId, request.id]
    );

    const latestSubmissionByStudent = new Map();
    submissions.forEach((submission) => {
      if (!latestSubmissionByStudent.has(submission.student_id)) {
        latestSubmissionByStudent.set(submission.student_id, submission);
      }
    });

    const uploadedStudents = [];
    const pendingStudents = [];

    for (const student of targetStudents) {
      const submission = latestSubmissionByStudent.get(student.id);
      if (submission) {
        uploadedStudents.push({
          ...student,
          submission,
        });
      } else {
        pendingStudents.push(student);
      }
    }

    summaries.push({
      ...request,
      batch_name: request.batch_name || formatLegacyBatchLabel(request.standard, request.course) || null,
      state: getAnswerRequestState(request),
      totalStudents: targetStudents.length,
      uploadedCount: uploadedStudents.length,
      pendingCount: pendingStudents.length,
      uploadedStudents,
      pendingStudents,
    });
  }

  return summaries;
}

async function findRecentDuplicatePaper({
  coachingId,
  studentId,
  originalName,
  testLabel,
  marksObtained,
  maxMarks,
  uploadedBy,
  answerRequestId = null,
}) {
  if (answerRequestId === null) {
    return get(
      `SELECT id
       FROM test_papers
       WHERE coaching_id = ?
         AND student_id = ?
         AND uploaded_by = ?
         AND answer_request_id IS NULL
        AND original_name = ?
        AND COALESCE(test_label, '') = COALESCE(?, '')
        AND COALESCE(marks_obtained, -999999) = COALESCE(?, -999999)
        AND COALESCE(max_marks, -999999) = COALESCE(?, -999999)
        AND upload_date >= CURRENT_TIMESTAMP - INTERVAL '20 seconds'
       ORDER BY upload_date DESC, id DESC
       LIMIT 1`,
      [coachingId, studentId, uploadedBy, originalName, testLabel || null, marksObtained, maxMarks]
    );
  }

  return get(
    `SELECT id
     FROM test_papers
     WHERE coaching_id = ?
       AND student_id = ?
       AND uploaded_by = ?
       AND answer_request_id = ?
       AND original_name = ?
       AND COALESCE(test_label, '') = COALESCE(?, '')
       AND COALESCE(marks_obtained, -999999) = COALESCE(?, -999999)
       AND COALESCE(max_marks, -999999) = COALESCE(?, -999999)
       AND upload_date >= CURRENT_TIMESTAMP - INTERVAL '20 seconds'
     ORDER BY upload_date DESC, id DESC
     LIMIT 1`,
    [coachingId, studentId, uploadedBy, answerRequestId, originalName, testLabel || null, marksObtained, maxMarks]
  );
}

async function deletePaperRecord(paper) {
  await run(`DELETE FROM test_papers WHERE id = ?`, [paper.id]);
  try {
    await deleteStoredPaper(paper);
  } catch (error) {
    console.error('Failed deleting stored paper asset', error);
  }
}

async function savePaperUpload({
  coachingId,
  studentId,
  file,
  uploadedBy,
  testLabel,
  marksObtained,
  maxMarks,
  answerRequestId = null,
}) {
  const duplicate = await findRecentDuplicatePaper({
    coachingId,
    studentId,
    originalName: file.originalname,
    testLabel,
    marksObtained,
    maxMarks,
    uploadedBy,
    answerRequestId,
  });

  if (duplicate) {
    return { status: 'duplicate', paperId: duplicate.id };
  }

  const stored = await uploadPaperFile(file);

  if (answerRequestId !== null) {
    const existing = await get(
      `SELECT id, stored_name, storage_type, storage_key, public_url, content_type
       FROM test_papers
       WHERE coaching_id = ? AND student_id = ? AND answer_request_id = ?
       ORDER BY upload_date DESC, id DESC
       LIMIT 1`,
      [coachingId, studentId, answerRequestId]
    );

    if (existing) {
      await run(
        `UPDATE test_papers
         SET original_name = ?, stored_name = ?, uploaded_by = ?,
             storage_type = ?, storage_key = ?, public_url = ?, content_type = ?, size_bytes = ?,
             marks_obtained = ?, max_marks = ?, test_label = ?, paper_type = 'answer_submission',
             upload_date = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          file.originalname,
          stored.storedName,
          uploadedBy,
          stored.storageType,
          stored.storageKey,
          stored.publicUrl,
          stored.contentType,
          stored.sizeBytes,
          marksObtained,
          maxMarks,
          testLabel || file.originalname,
          existing.id,
        ]
      );

      if (existing.storage_key !== stored.storageKey || existing.storage_type !== stored.storageType) {
        try {
          await deleteStoredPaper(existing);
        } catch (error) {
          console.error('Failed deleting replaced answer submission asset', error);
        }
      }

      return { status: 'replaced', paperId: existing.id };
    }
  }

  const result = await run(
    `INSERT INTO test_papers (
      coaching_id, student_id, original_name, stored_name, uploaded_by,
      storage_type, storage_key, public_url, content_type, size_bytes,
      marks_obtained, max_marks, test_label, paper_type, answer_request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      coachingId,
      studentId,
      file.originalname,
      stored.storedName,
      uploadedBy,
      stored.storageType,
      stored.storageKey,
      stored.publicUrl,
      stored.contentType,
      stored.sizeBytes,
      marksObtained,
      maxMarks,
      testLabel || file.originalname,
      answerRequestId !== null ? 'answer_submission' : 'general',
      answerRequestId,
    ]
  );

  return { status: 'inserted', paperId: result.lastID };
}

async function getPaperForDelete(id, sessionUser) {
  const paper = await get(
    `SELECT tp.*, u.coaching_id AS student_coaching_id
     FROM test_papers tp
     JOIN users u ON u.id = tp.student_id
     WHERE tp.id = ?`,
    [id]
  );

  if (!paper) return null;
  if (sessionUser.isOwner) return null;

  if (sessionUser.role === 'admin' && paper.coaching_id === sessionUser.coachingId) {
    return paper;
  }

  if (
    sessionUser.role === 'student' &&
    paper.student_id === sessionUser.id &&
    paper.coaching_id === sessionUser.coachingId &&
    paper.uploaded_by === sessionUser.id
  ) {
    return paper;
  }

  return null;
}

async function cleanupDuplicateAnswerSubmissions() {
  const duplicateGroups = await all(
    `SELECT coaching_id, student_id, answer_request_id, COUNT(*) AS duplicate_count
     FROM test_papers
     WHERE answer_request_id IS NOT NULL
     GROUP BY coaching_id, student_id, answer_request_id
     HAVING COUNT(*) > 1`
  );

  for (const group of duplicateGroups) {
    const rows = await all(
      `SELECT id, stored_name, storage_type, storage_key, public_url, content_type
       FROM test_papers
       WHERE coaching_id = ? AND student_id = ? AND answer_request_id = ?
       ORDER BY upload_date DESC, id DESC`,
      [group.coaching_id, group.student_id, group.answer_request_id]
    );

    const [, ...duplicates] = rows;
    for (const paper of duplicates) {
      await deletePaperRecord(paper);
    }
  }
}

async function getStudentDashboardPayload(coachingId, studentId) {
  const profile = await get(
    `SELECT u.id, u.roll_no, u.name, u.batch_id, u.standard, u.course, u.contact_phone, u.email,
            b.name AS batch_name
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id
     WHERE u.id = ? AND u.coaching_id = ? AND u.role = 'student'`,
    [studentId, coachingId]
  );

  const papers = await all(
    `SELECT tp.id, tp.original_name, tp.stored_name, tp.upload_date, tp.storage_type, tp.storage_key, tp.content_type,
            tp.marks_obtained, tp.max_marks, tp.test_label, tp.paper_type, tp.answer_request_id, tp.uploaded_by AS uploaded_by_id,
            uploader.name AS uploaded_by_name, uploader.role AS uploaded_by_role
     FROM test_papers tp
     LEFT JOIN users uploader ON uploader.id = tp.uploaded_by
     WHERE tp.coaching_id = ? AND tp.student_id = ?
     ORDER BY tp.upload_date DESC`,
    [coachingId, studentId]
  );

  const attendance = await all(
    `SELECT attendance_date, status, notes
     FROM attendance
     WHERE coaching_id = ? AND student_id = ?
     ORDER BY attendance_date DESC, id DESC`,
    [coachingId, studentId]
  );

  const fees = await all(
    `SELECT amount, due_date, payment_date, status, notes
     FROM fees
     WHERE coaching_id = ? AND student_id = ?
     ORDER BY created_at DESC`,
    [coachingId, studentId]
  );

  const notes = profile?.batch_id
    ? await all(
      `SELECT bn.title, bn.resource_url, bn.description, bn.created_at, bn.batch_id, b.name AS batch_name
       FROM batch_notes bn
       LEFT JOIN batches b ON b.id = bn.batch_id
       WHERE bn.coaching_id = ? AND bn.batch_id = ?
       ORDER BY bn.created_at DESC`,
      [coachingId, profile.batch_id]
    )
    : profile?.standard || profile?.course
      ? await all(
        `SELECT title, resource_url, description, created_at, batch_id
         FROM batch_notes
         WHERE coaching_id = ?
           AND COALESCE(standard, '') = COALESCE(?, '')
           AND COALESCE(course, '') = COALESCE(?, '')
         ORDER BY created_at DESC`,
        [coachingId, profile.standard || null, profile.course || null]
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
    [coachingId, studentId]
  );

  const feeSummary = await get(
    `SELECT
       COUNT(*) AS total_fees,
       SUM(CASE WHEN status IN ('pending', 'overdue') THEN 1 ELSE 0 END) AS pending_count,
       SUM(CASE WHEN status IN ('pending', 'overdue') THEN amount ELSE 0 END) AS pending_amount
     FROM fees
     WHERE coaching_id = ? AND student_id = ?`,
    [coachingId, studentId]
  );

  const totalAttendance = Number(attendanceSummary?.total || 0);
  const presentCount = Number(attendanceSummary?.present_count || 0);
  const attendancePercent = totalAttendance
    ? ((presentCount / totalAttendance) * 100).toFixed(1)
    : '0.0';

  const { progressSeries, marksSummary } = buildProgressSummaryFromPapers(papers);

  return {
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
    marksSummary,
    progressSeries,
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
    batchId: user.batch_id || null,
    batchName: user.batch_name || formatLegacyBatchLabel(user.standard, user.course) || null,
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
    branding: buildBranding(coaching),
  });
}

async function renderOwnerLoginPage(req, res, flash = null) {
  const nextFlash = flash || req.session?.flash || null;
  if (req.session) req.session.flash = null;

  return renderWithMessage(res, 'owner-login', {
    flash: nextFlash,
  });
}

async function deleteCoachingData(coachingId) {
  const papers = await all(
    `SELECT stored_name, storage_type, storage_key, public_url, content_type
     FROM test_papers
     WHERE coaching_id = ?`,
    [coachingId]
  );

  await withTransaction(async (tx) => {
    await tx.run(`DELETE FROM attendance WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM fees WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM batch_notes WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM answer_upload_requests WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM test_papers WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM users WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM batches WHERE coaching_id = ?`, [coachingId]);
    await tx.run(`DELETE FROM coaching_classes WHERE id = ?`, [coachingId]);
  });

  for (const paper of papers) {
    try {
      await deleteStoredPaper(paper);
    } catch (error) {
      console.error('Failed deleting coaching paper asset', error);
    }
  }
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

app.get('/owner/login', async (req, res) => {
  if (req.session.user?.isOwner) return res.redirect('/owner/dashboard');
  if (req.session.user) return res.redirect('/');
  return renderOwnerLoginPage(req, res);
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

  if (role === 'admin' || role === 'student') {
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

  if (!['admin', 'student'].includes(role)) {
    return renderLoginPage(req, res, { type: 'error', text: 'Select a valid login type' });
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

app.post('/owner/login', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  const user = await get(
    `SELECT * FROM users WHERE is_owner = 1 AND username = ? LIMIT 1`,
    [username]
  );

  if (!user) {
    return renderOwnerLoginPage(req, res, { type: 'error', text: 'Invalid owner credentials' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return renderOwnerLoginPage(req, res, { type: 'error', text: 'Invalid owner credentials' });
  }

  req.session.user = buildSessionUser(user);
  return res.redirect('/owner/dashboard');
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
    branding: buildBranding(coaching),
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
       cc.brand_name,
       cc.logo_url,
       cc.theme_primary,
       cc.theme_background,
       cc.theme_surface,
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
     GROUP BY
       cc.id,
       sp.id,
       sp.name,
       sp.code,
       sp.price_inr,
       sp.max_students,
       admin.id,
       admin.username,
       admin.name
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
      name, brand_name, slug, contact_email, subscription_plan_id, subscription_status, subscription_started_at, subscription_ends_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, name, slug, contactEmail, planId, subscriptionStatus, subscriptionStartedAt, subscriptionEndsAt]
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

app.post('/owner/coachings/:id/branding', requireOwner, async (req, res) => {
  const coachingId = Number(req.params.id);
  const coaching = await get(`SELECT id FROM coaching_classes WHERE id = ? LIMIT 1`, [coachingId]);
  if (!coaching) {
    req.session.flash = { type: 'error', text: 'Coaching not found' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  const name = (req.body.name || '').trim();
  const brandName = (req.body.brandName || '').trim() || name;
  const logoUrl = (req.body.logoUrl || '').trim();
  const contactEmail = (req.body.contactEmail || '').trim();
  const themePrimary = normalizeHexColor(req.body.themePrimary, DEFAULT_THEME.brand);
  const themeBackground = normalizeHexColor(req.body.themeBackground, DEFAULT_THEME.background);
  const themeSurface = normalizeHexColor(req.body.themeSurface, DEFAULT_THEME.surface);

  if (!name) {
    req.session.flash = { type: 'error', text: 'Coaching name is required for branding' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  if (logoUrl && !isValidHttpUrl(logoUrl)) {
    req.session.flash = { type: 'error', text: 'Logo URL must be a valid http/https link' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  await run(
    `UPDATE coaching_classes
     SET name = ?, brand_name = ?, logo_url = ?, contact_email = ?, theme_primary = ?, theme_background = ?, theme_surface = ?
     WHERE id = ?`,
    [name, brandName, logoUrl || null, contactEmail || null, themePrimary, themeBackground, themeSurface, coachingId]
  );

  req.session.flash = { type: 'success', text: 'Branding updated for coaching portal' };
  return res.redirect('/owner/dashboard?section=coachings');
});

app.post('/owner/coachings/:id/delete', requireOwner, async (req, res) => {
  const coachingId = Number(req.params.id);
  const coaching = await get(`SELECT id, name FROM coaching_classes WHERE id = ? LIMIT 1`, [coachingId]);
  if (!coaching) {
    req.session.flash = { type: 'error', text: 'Coaching not found' };
    return res.redirect('/owner/dashboard?section=coachings');
  }

  await deleteCoachingData(coachingId);

  req.session.flash = {
    type: 'success',
    text: `${coaching.name} deleted permanently with all students, notes, papers, attendance, and fees data.`,
  };
  return res.redirect('/owner/dashboard?section=coachings');
});

app.get('/admin/dashboard', requireCoachingAdmin, async (req, res) => {
  const subscriptionState = req.subscriptionState || getSubscriptionState(req.currentCoaching);
  const activeSection = subscriptionState.accessBlocked ? 'overview' : getAdminSection(req.query.section);
  const attendanceDateFilter = (req.query.attendanceDate || '').trim();
  const coachingId = req.session.user.coachingId;
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const batches = await getBatchesForCoaching(coachingId);

  const students = await all(
    `SELECT u.id, u.roll_no, u.name, u.batch_id, u.standard, u.course, u.contact_phone, u.email, u.password_display, u.created_at,
            b.name AS batch_name
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id
     WHERE u.role = 'student' AND u.coaching_id = ?
     ORDER BY COALESCE(b.name, ''), u.roll_no ASC`,
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
       tp.paper_type,
       tp.answer_request_id,
       u.roll_no,
       u.name,
       u.batch_id,
       u.standard,
       u.course,
       b.name AS batch_name,
       uploader.name AS uploaded_by_name,
       uploader.role AS uploaded_by_role
     FROM test_papers tp
     JOIN users u ON u.id = tp.student_id
     LEFT JOIN batches b ON b.id = u.batch_id
     LEFT JOIN users uploader ON uploader.id = tp.uploaded_by
     WHERE tp.coaching_id = ?
     ORDER BY tp.upload_date DESC
     LIMIT 250`,
    [coachingId]
  );

  let attendanceSql = `
    SELECT a.id, a.attendance_date, a.status, a.notes, u.roll_no, u.name, u.batch_id, u.standard, u.course, b.name AS batch_name
    FROM attendance a
    JOIN users u ON u.id = a.student_id
    LEFT JOIN batches b ON b.id = u.batch_id
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
    `SELECT f.id, f.amount, f.due_date, f.payment_date, f.status, f.notes, u.roll_no, u.name, u.batch_id, u.standard, u.course, b.name AS batch_name
     FROM fees f
     JOIN users u ON u.id = f.student_id
     LEFT JOIN batches b ON b.id = u.batch_id
     WHERE f.coaching_id = ?
     ORDER BY f.created_at DESC
     LIMIT 150`,
    [coachingId]
  );

  const notes = await all(
    `SELECT bn.id, bn.batch_id, bn.standard, bn.course, bn.title, bn.resource_url, bn.description, bn.created_at,
            b.name AS batch_name
     FROM batch_notes bn
     LEFT JOIN batches b ON b.id = bn.batch_id
     WHERE bn.coaching_id = ?
     ORDER BY bn.created_at DESC
     LIMIT 150`,
    [coachingId]
  );

  const answerRequests = await all(
    `SELECT ar.id, ar.batch_id, ar.standard, ar.course, ar.title, ar.description, ar.starts_at, ar.ends_at, ar.created_at,
            b.name AS batch_name
     FROM answer_upload_requests ar
     LEFT JOIN batches b ON b.id = ar.batch_id
     WHERE ar.coaching_id = ?
     ORDER BY ar.created_at DESC
     LIMIT 20`,
    [coachingId]
  );

  const answerRequestSummaries = await buildAnswerRequestSummaries(coachingId, answerRequests);

  const paperStats = await all(
    `SELECT
       student_id,
       COUNT(*) AS paper_count,
       MAX(upload_date) AS last_upload,
       MAX(CASE WHEN marks_obtained IS NOT NULL AND max_marks IS NOT NULL AND max_marks > 0 THEN upload_date END) AS latest_marked_upload
     FROM test_papers
     WHERE coaching_id = ?
     GROUP BY student_id`,
    [coachingId]
  );

  const latestMarkedPapers = await all(
    `SELECT student_id, marks_obtained, max_marks, upload_date, test_label, original_name
     FROM test_papers
     WHERE coaching_id = ? AND marks_obtained IS NOT NULL AND max_marks IS NOT NULL AND max_marks > 0
     ORDER BY upload_date DESC`,
    [coachingId]
  );

  const paperStatsByStudent = new Map();
  paperStats.forEach((row) => paperStatsByStudent.set(row.student_id, row));

  const latestMarkedByStudent = new Map();
  latestMarkedPapers.forEach((paper) => {
    if (!latestMarkedByStudent.has(paper.student_id)) {
      latestMarkedByStudent.set(paper.student_id, paper);
    }
  });

  const overviewStudents = students.map((student) => {
    const paperRow = paperStatsByStudent.get(student.id);
    const latestMarked = latestMarkedByStudent.get(student.id);
    const latestPercent = latestMarked && Number(latestMarked.max_marks) > 0
      ? ((Number(latestMarked.marks_obtained || 0) / Number(latestMarked.max_marks)) * 100).toFixed(1)
      : null;

    return {
      ...student,
      paperCount: Number(paperRow?.paper_count || 0),
      lastUpload: paperRow?.last_upload || null,
      latestPercent,
      latestMarkedLabel: latestMarked?.test_label || latestMarked?.original_name || null,
    };
  });

  const defaultAnswerRequestStart = toDateTimeLocalInput(new Date());

  const stats = {
    totalStudents: students.length,
    totalPapers: papers.length,
    pendingFees: fees.filter((item) => item.status === 'pending' || item.status === 'overdue').length,
    absentEntries: attendance.filter((item) => item.status === 'absent').length,
    notesCount: notes.length,
    activeAnswerRequests: answerRequestSummaries.filter((item) => item.state.isActive).length,
  };
  const studentUsage = getStudentUsage(students.length, coaching);

  renderWithMessage(res, 'admin-dashboard', {
    user: req.session.user,
    coaching,
    branding: buildBranding(coaching),
    subscriptionState,
    subscriptionNotice: subscriptionState.notice,
    students,
    batches,
    batchSummaries: toBatchSummaries(students, batches),
    studentBatchGroups: toStudentBatchGroups(students, batches),
    studentUsage,
    papers,
    attendance,
    attendanceByDate: groupAttendanceByDate(attendance),
    attendanceDates,
    attendanceDateFilter,
    fees,
    notes,
    answerRequestSummaries,
    overviewStudents,
    defaultAnswerRequestStart,
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
  const contactPhone = (req.body.contactPhone || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const submittedPassword = (req.body.password || '').trim();
  const password = submittedPassword || rollNo;
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);

  if (!rollNo) {
    req.session.flash = { type: 'error', text: 'Roll number is required' };
    return res.redirect('/admin/dashboard?section=students');
  }

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Please select a batch for the student' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const batch = await getBatchForCoaching(coachingId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Selected batch was not found' };
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
      coaching_id, role, is_owner, username, roll_no, name, batch_id, standard, course, contact_phone, email, password_hash, password_display
    ) VALUES (?, 'student', 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      coachingId,
      rollNo,
      name,
      batch.id,
      batch.standard || null,
      batch.course || null,
      contactPhone || null,
      email || null,
      passwordHash,
      password,
    ]
  );

  req.session.flash = {
    type: 'success',
    text: submittedPassword
      ? `Student ${rollNo} created with a custom password`
      : `Student ${rollNo} created. Default password is the roll number`,
  };
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/batches', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const batchName = normalizeBatchName(req.body.batchName);

  if (!batchName) {
    req.session.flash = { type: 'error', text: 'Batch name is required' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const normalizedName = batchName.toLowerCase();
  const existing = await get(
    `SELECT id FROM batches WHERE coaching_id = ? AND normalized_name = ? LIMIT 1`,
    [coachingId, normalizedName]
  );

  if (existing) {
    req.session.flash = { type: 'error', text: 'This batch already exists' };
    return res.redirect('/admin/dashboard?section=students');
  }

  await run(
    `INSERT INTO batches (coaching_id, name, normalized_name, created_by)
     VALUES (?, ?, ?, ?)`,
    [coachingId, batchName, normalizedName, req.session.user.id]
  );

  req.session.flash = { type: 'success', text: `Batch "${batchName}" created successfully` };
  return res.redirect('/admin/dashboard?section=students');
});

app.get('/admin/students/:id/overview', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const studentId = Number(req.params.id);
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const dashboard = await getStudentDashboardPayload(coachingId, studentId);

  if (!dashboard.profile) {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  renderWithMessage(res, 'admin-student-overview', {
    user: req.session.user,
    coaching,
    branding: buildBranding(coaching),
    student: dashboard.profile,
    papers: dashboard.papers,
    attendance: dashboard.attendance,
    fees: dashboard.fees,
    notes: dashboard.notes,
    attendanceSummary: dashboard.attendanceSummary,
    feeSummary: dashboard.feeSummary,
    marksSummary: dashboard.marksSummary,
    progressSeries: dashboard.progressSeries,
    flash: req.session.flash,
  });
  req.session.flash = null;
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
  await run(`UPDATE users SET password_hash = ?, password_display = ? WHERE id = ?`, [passwordHash, student.roll_no, studentId]);

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

app.post('/admin/upload-paper-single', requireCoachingAdmin, upload.single('paper'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const file = req.file;
  const rollNo = (req.body.rollNo || '').trim();
  const testLabel = (req.body.testLabel || '').trim();
  const marksObtained = parseOptionalNumber(req.body.marksObtained);
  const maxMarks = parseOptionalNumber(req.body.maxMarks);
  const answerRequestId = parseOptionalNumber(req.body.answerRequestId);

  if (!file) {
    req.session.flash = { type: 'error', text: 'Select a file to upload' };
    return res.redirect('/admin/dashboard?section=papers');
  }

  const student = await get(
    `SELECT id, roll_no, batch_id, standard, course
     FROM users
     WHERE coaching_id = ? AND role = 'student' AND roll_no = ?`,
    [coachingId, rollNo]
  );

  if (!student) {
    req.session.flash = { type: 'error', text: 'Student roll number not found' };
    return res.redirect('/admin/dashboard?section=papers');
  }

  if ((marksObtained === null) !== (maxMarks === null)) {
    req.session.flash = { type: 'error', text: 'Enter both obtained marks and max marks, or leave both blank' };
    return res.redirect('/admin/dashboard?section=papers');
  }

  let linkedAnswerRequest = null;
  if (answerRequestId !== null) {
    linkedAnswerRequest = await get(
      `SELECT id, batch_id, standard, course, title
       FROM answer_upload_requests
       WHERE id = ? AND coaching_id = ?`,
      [answerRequestId, coachingId]
    );
    if (!linkedAnswerRequest) {
      req.session.flash = { type: 'error', text: 'Selected answer upload request was not found' };
      return res.redirect('/admin/dashboard?section=papers');
    }

    const studentMatchesRequest = linkedAnswerRequest.batch_id
      ? Number(linkedAnswerRequest.batch_id) === Number(student.batch_id || 0)
      : linkedAnswerRequest.standard === student.standard && linkedAnswerRequest.course === student.course;

    if (!studentMatchesRequest) {
      req.session.flash = { type: 'error', text: `Student ${student.roll_no} does not belong to the selected upload window batch` };
      return res.redirect('/admin/dashboard?section=papers');
    }
  }

  const result = await savePaperUpload({
    coachingId,
    studentId: student.id,
    file,
    uploadedBy: req.session.user.id,
    testLabel: testLabel || file.originalname,
    marksObtained,
    maxMarks,
    answerRequestId: linkedAnswerRequest ? linkedAnswerRequest.id : null,
  });

  const textByStatus = {
    inserted: `Paper uploaded for ${student.roll_no}`,
    replaced: `Paper updated for ${student.roll_no}. Previous upload was replaced.`,
    duplicate: `Duplicate click ignored. Latest paper for ${student.roll_no} is already saved.`,
  };
  req.session.flash = { type: 'success', text: textByStatus[result.status] || `Paper uploaded for ${student.roll_no}` };
  return res.redirect('/admin/dashboard?section=papers');
});

app.post('/admin/upload-papers', requireCoachingAdmin, upload.array('papers', 100), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const files = req.files || [];

  if (!files.length) {
    req.session.flash = { type: 'error', text: 'No files uploaded' };
    return res.redirect('/admin/dashboard?section=papers');
  }

  const report = { assigned: 0, skipped: 0, failed: 0, duplicates: 0 };

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
      const result = await savePaperUpload({
        coachingId,
        studentId: student.id,
        file,
        uploadedBy: req.session.user.id,
        testLabel: paperMeta.testLabel || file.originalname,
        marksObtained: paperMeta.marksObtained,
        maxMarks: paperMeta.maxMarks,
        answerRequestId: null,
      });

      if (result.status === 'duplicate') {
        report.duplicates += 1;
      } else {
        report.assigned += 1;
      }
    } catch (err) {
      console.error('Upload failed for', file.originalname, err);
      report.failed += 1;
    }
  }

  req.session.flash = {
    type: report.failed ? 'error' : 'success',
    text: `Upload complete. Assigned: ${report.assigned}, Duplicate ignored: ${report.duplicates}, Skipped: ${report.skipped}, Failed: ${report.failed}`,
  };
  return res.redirect('/admin/dashboard?section=papers');
});

app.post('/admin/answer-requests', requireCoachingAdmin, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const startsAtInput = (req.body.startsAt || '').trim() || toDateTimeLocalInput(new Date());

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Select a batch for answer upload request' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  const batch = await getBatchForCoaching(coachingId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Selected batch was not found' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  if (!title) {
    req.session.flash = { type: 'error', text: 'Title is required for answer upload request' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  const startsAt = parseDateTimeLocal(startsAtInput);
  if (!startsAt) {
    req.session.flash = { type: 'error', text: 'Enter a valid start date and time' };
    return res.redirect('/admin/dashboard?section=overview');
  }

  const endsAt = addHours(startsAt, ANSWER_UPLOAD_WINDOW_HOURS);

  await run(
    `INSERT INTO answer_upload_requests (
      coaching_id, batch_id, standard, course, title, description, starts_at, ends_at, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      coachingId,
      batch.id,
      batch.standard || null,
      batch.course || null,
      title,
      description || null,
      toDateTimeLocalInput(startsAt),
      toDateTimeLocalInput(endsAt),
      req.session.user.id,
    ]
  );

  req.session.flash = {
    type: 'success',
    text: `Answer upload request created for ${batch.name}. Window stays open for ${ANSWER_UPLOAD_WINDOW_HOURS} hours.`,
  };
  return res.redirect('/admin/dashboard?section=overview');
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
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const attendanceDate = req.body.attendanceDate;
  const notes = (req.body.notes || '').trim();

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Please select a batch' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const batch = await getBatchForCoaching(coachingId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Selected batch was not found' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  if (!attendanceDate) {
    req.session.flash = { type: 'error', text: 'Attendance date is required' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const students = await all(
    `SELECT id, roll_no
     FROM users
     WHERE coaching_id = ? AND role = 'student' AND batch_id = ?
     ORDER BY roll_no ASC`,
    [coachingId, batch.id]
  );

  if (!students.length) {
    req.session.flash = { type: 'error', text: 'No students found in selected batch' };
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
  const batchId = Number.parseInt(String(req.body.batchId || '').trim(), 10);
  const title = (req.body.title || '').trim();
  const resourceUrl = (req.body.resourceUrl || '').trim();
  const description = (req.body.description || '').trim();

  if (!Number.isInteger(batchId) || batchId <= 0) {
    req.session.flash = { type: 'error', text: 'Please select a batch for note' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  const batch = await getBatchForCoaching(coachingId, batchId);
  if (!batch) {
    req.session.flash = { type: 'error', text: 'Selected batch was not found' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  if (!title || !resourceUrl || !isValidHttpUrl(resourceUrl)) {
    req.session.flash = { type: 'error', text: 'Valid title and URL are required' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  await run(
    `INSERT INTO batch_notes (coaching_id, batch_id, standard, course, title, resource_url, description, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [coachingId, batch.id, batch.standard || null, batch.course || null, title, resourceUrl, description, req.session.user.id]
  );

  req.session.flash = { type: 'success', text: `Batch note published for ${batch.name}` };
  return res.redirect('/admin/dashboard?section=notes');
});

app.post('/student/upload-paper', requireStudent, upload.single('paper'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const studentId = req.session.user.id;
  const file = req.file;
  const testLabel = (req.body.testLabel || '').trim();
  const marksObtained = parseOptionalNumber(req.body.marksObtained);
  const maxMarks = parseOptionalNumber(req.body.maxMarks);

  if (!file) {
    req.session.flash = { type: 'error', text: 'Select a file to upload' };
    return res.redirect('/student/dashboard');
  }

  if ((marksObtained === null) !== (maxMarks === null)) {
    req.session.flash = { type: 'error', text: 'Enter both obtained marks and max marks, or leave both blank' };
    return res.redirect('/student/dashboard');
  }

  const result = await savePaperUpload({
    coachingId,
    studentId,
    file,
    uploadedBy: studentId,
    testLabel: testLabel || file.originalname,
    marksObtained,
    maxMarks,
    answerRequestId: null,
  });

  const studentUploadText = {
    inserted: 'Your paper was uploaded successfully',
    replaced: 'Your paper was updated successfully',
    duplicate: 'Duplicate click ignored. Your paper is already saved.',
  };
  req.session.flash = { type: 'success', text: studentUploadText[result.status] || 'Your paper was uploaded successfully' };
  return res.redirect('/student/dashboard');
});

app.post('/student/answer-requests/:id/upload', requireStudent, upload.single('paper'), async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const studentId = req.session.user.id;
  const requestId = Number(req.params.id);
  const file = req.file;
  const marksObtained = parseOptionalNumber(req.body.marksObtained);
  const maxMarks = parseOptionalNumber(req.body.maxMarks);

  if (!file) {
    req.session.flash = { type: 'error', text: 'Select a file to upload for this answer request' };
    return res.redirect('/student/dashboard');
  }

  if ((marksObtained === null) !== (maxMarks === null)) {
    req.session.flash = { type: 'error', text: 'Enter both obtained marks and max marks, or leave both blank' };
    return res.redirect('/student/dashboard');
  }

  const student = await get(
    `SELECT id, batch_id, standard, course FROM users WHERE id = ? AND coaching_id = ? AND role = 'student'`,
    [studentId, coachingId]
  );
  if (!student) {
    req.session.flash = { type: 'error', text: 'Student account not found' };
    return res.redirect('/student/dashboard');
  }

  const answerRequest = await get(
    `SELECT id, title, batch_id, standard, course, starts_at, ends_at
     FROM answer_upload_requests
     WHERE id = ? AND coaching_id = ?`,
    [requestId, coachingId]
  );
  if (!answerRequest) {
    req.session.flash = { type: 'error', text: 'Answer upload request not found' };
    return res.redirect('/student/dashboard');
  }

  const batchMismatch = answerRequest.batch_id
    ? Number(answerRequest.batch_id) !== Number(student.batch_id || 0)
    : answerRequest.standard !== student.standard || answerRequest.course !== student.course;

  if (batchMismatch) {
    req.session.flash = { type: 'error', text: 'This answer upload request does not belong to your batch' };
    return res.redirect('/student/dashboard');
  }

  const requestState = getAnswerRequestState(answerRequest);
  if (!requestState.isActive) {
    req.session.flash = { type: 'error', text: 'This upload window is no longer active' };
    return res.redirect('/student/dashboard');
  }

  const result = await savePaperUpload({
    coachingId,
    studentId,
    file,
    uploadedBy: studentId,
    testLabel: answerRequest.title,
    marksObtained,
    maxMarks,
    answerRequestId: answerRequest.id,
  });

  const answerUploadText = {
    inserted: `Uploaded for ${answerRequest.title}`,
    replaced: `Updated your upload for ${answerRequest.title}`,
    duplicate: `Duplicate click ignored. Your upload for ${answerRequest.title} is already saved.`,
  };
  req.session.flash = { type: 'success', text: answerUploadText[result.status] || `Uploaded for ${answerRequest.title}` };
  return res.redirect('/student/dashboard');
});

app.post('/papers/:id/delete', requireAuth, async (req, res) => {
  const paper = await getPaperForDelete(req.params.id, req.session.user);
  const redirectTo = String(req.body.redirectTo || '').startsWith('/')
    ? String(req.body.redirectTo)
    : req.session.user.role === 'admin'
      ? '/admin/dashboard?section=papers'
      : '/student/dashboard';

  if (!paper) {
    if (req.session) {
      req.session.flash = { type: 'error', text: 'Paper not found or delete is not allowed' };
    }
    return res.redirect(redirectTo);
  }

  await deletePaperRecord(paper);
  if (req.session) {
    req.session.flash = { type: 'success', text: 'Paper deleted successfully' };
  }
  return res.redirect(redirectTo);
});

app.get('/student/dashboard', requireStudent, async (req, res) => {
  const coachingId = req.session.user.coachingId;
  const coaching = req.currentCoaching || await getCoachingContextById(coachingId);
  const subscriptionState = req.subscriptionState || getSubscriptionState(coaching);
  const dashboard = await getStudentDashboardPayload(coachingId, req.session.user.id);
  const profile = dashboard.profile;

  const answerRequests = profile?.batch_id
    ? await all(
      `SELECT ar.id, ar.title, ar.description, ar.starts_at, ar.ends_at, ar.created_at, ar.batch_id, b.name AS batch_name
       FROM answer_upload_requests ar
       LEFT JOIN batches b ON b.id = ar.batch_id
       WHERE ar.coaching_id = ? AND ar.batch_id = ?
       ORDER BY ar.created_at DESC
       LIMIT 12`,
      [coachingId, profile.batch_id]
    )
    : profile?.standard || profile?.course
      ? await all(
        `SELECT id, title, description, starts_at, ends_at, created_at, batch_id
         FROM answer_upload_requests
         WHERE coaching_id = ?
           AND COALESCE(standard, '') = COALESCE(?, '')
           AND COALESCE(course, '') = COALESCE(?, '')
         ORDER BY created_at DESC
         LIMIT 12`,
        [coachingId, profile.standard || null, profile.course || null]
      )
      : [];

  const submissions = await all(
    `SELECT id, answer_request_id, upload_date, original_name
     FROM test_papers
     WHERE coaching_id = ? AND student_id = ? AND answer_request_id IS NOT NULL
     ORDER BY upload_date DESC`,
    [coachingId, req.session.user.id]
  );

  const latestSubmissionByRequest = new Map();
  submissions.forEach((submission) => {
    if (!latestSubmissionByRequest.has(submission.answer_request_id)) {
      latestSubmissionByRequest.set(submission.answer_request_id, submission);
    }
  });

  const answerRequestCards = answerRequests.map((request) => ({
    ...request,
    state: getAnswerRequestState(request),
    mySubmission: latestSubmissionByRequest.get(request.id) || null,
  }));

  renderWithMessage(res, 'student-dashboard', {
    user: req.session.user,
    coaching,
    branding: buildBranding(coaching),
    subscriptionState,
    subscriptionNotice: subscriptionState.notice,
    profile,
    papers: dashboard.papers,
    attendance: dashboard.attendance,
    fees: dashboard.fees,
    notes: dashboard.notes,
    attendanceSummary: dashboard.attendanceSummary,
    feeSummary: dashboard.feeSummary,
    marksSummary: dashboard.marksSummary,
    progressSeries: dashboard.progressSeries,
    answerRequestCards,
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
  .then(() => cleanupDuplicateAnswerSubmissions())
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`Server started on http://localhost:${PORT}`);
      console.log(`File storage mode: ${getStorageMode()}`);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const suggestedPort = Number(PORT) + 1;
        console.error(`Port ${PORT} is already in use. Start with another port, for example: PORT=${suggestedPort} npm start`);
        process.exit(1);
      }

      console.error('Startup server error', err);
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error('Startup failed', err);
    process.exit(1);
  });
