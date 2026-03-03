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
const VALID_ADMIN_SECTIONS = new Set(['overview', 'attendance', 'students', 'fees', 'papers', 'notes']);
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

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== role) return res.status(403).send('Forbidden');
    return next();
  };
}

function renderWithMessage(res, view, data = {}) {
  const flash = data.flash || null;
  return res.render(view, { ...data, flash });
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
      .map((v) => v.trim())
      .filter(Boolean)
  );
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

function getAdminSection(input) {
  const section = (input || '').trim();
  return VALID_ADMIN_SECTIONS.has(section) ? section : 'overview';
}

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  return req.session.user.role === 'admin'
    ? res.redirect('/admin/dashboard')
    : res.redirect('/student/dashboard');
});

app.get('/login', (req, res) => {
  renderWithMessage(res, 'auth-login', {
    user: req.session.user,
    defaultAdminUsername: process.env.ADMIN_USERNAME || 'Scc@coaching',
  });
});

app.post('/login', async (req, res) => {
  const { role, username, password } = req.body;

  let user;
  if (role === 'admin') {
    const adminUsername = (username || '').trim();
    if (adminUsername) {
      user = await get(`SELECT * FROM users WHERE role = 'admin' AND name = ? LIMIT 1`, [adminUsername]);
    } else {
      user = await get(`SELECT * FROM users WHERE role = 'admin' LIMIT 1`);
    }
  } else {
    user = await get(`SELECT * FROM users WHERE role = 'student' AND roll_no = ?`, [username?.trim()]);
  }

  if (!user) {
    return renderWithMessage(res, 'auth-login', {
      flash: { type: 'error', text: 'Invalid credentials' },
      user: null,
      defaultAdminUsername: process.env.ADMIN_USERNAME || 'Scc@coaching',
    });
  }

  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) {
    return renderWithMessage(res, 'auth-login', {
      flash: { type: 'error', text: 'Invalid credentials' },
      user: null,
      defaultAdminUsername: process.env.ADMIN_USERNAME || 'Scc@coaching',
    });
  }

  req.session.user = {
    id: user.id,
    role: user.role,
    rollNo: user.roll_no,
    name: user.name,
    standard: user.standard,
    course: user.course,
  };

  return user.role === 'admin'
    ? res.redirect('/admin/dashboard')
    : res.redirect('/student/dashboard');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/admin/dashboard', requireRole('admin'), async (req, res) => {
  const activeSection = getAdminSection(req.query.section);
  const attendanceDateFilter = (req.query.attendanceDate || '').trim();

  const students = await all(`
    SELECT id, roll_no, name, standard, course, created_at
    FROM users
    WHERE role = 'student'
    ORDER BY standard DESC, course ASC, roll_no ASC
  `);

  const papers = await all(`
    SELECT tp.id, tp.original_name, tp.stored_name, tp.upload_date, tp.storage_type, tp.storage_key, tp.size_bytes, u.roll_no, u.name, u.standard, u.course
    FROM test_papers tp
    JOIN users u ON u.id = tp.student_id
    ORDER BY tp.upload_date DESC
    LIMIT 150
  `);

  let attendanceSql = `
    SELECT a.id, a.attendance_date, a.status, a.notes, u.roll_no, u.name, u.standard, u.course
    FROM attendance a
    JOIN users u ON u.id = a.student_id
  `;
  const attendanceParams = [];
  if (attendanceDateFilter) {
    attendanceSql += ` WHERE a.attendance_date = ? `;
    attendanceParams.push(attendanceDateFilter);
  }
  attendanceSql += ` ORDER BY a.attendance_date DESC, a.id DESC LIMIT 300 `;
  const attendance = await all(attendanceSql, attendanceParams);

  const attendanceDates = await all(`
    SELECT DISTINCT attendance_date
    FROM attendance
    ORDER BY attendance_date DESC
    LIMIT 90
  `);

  const fees = await all(`
    SELECT f.id, f.amount, f.due_date, f.payment_date, f.status, f.notes, u.roll_no, u.name, u.standard, u.course
    FROM fees f
    JOIN users u ON u.id = f.student_id
    ORDER BY f.created_at DESC
    LIMIT 150
  `);

  const notes = await all(`
    SELECT bn.id, bn.standard, bn.course, bn.title, bn.resource_url, bn.description, bn.created_at, u.name AS admin_name
    FROM batch_notes bn
    LEFT JOIN users u ON u.id = bn.created_by
    ORDER BY bn.created_at DESC
    LIMIT 150
  `);

  const stats = {
    totalStudents: students.length,
    totalPapers: papers.length,
    pendingFees: fees.filter((f) => f.status === 'pending' || f.status === 'overdue').length,
    absentEntries: attendance.filter((a) => a.status === 'absent').length,
    notesCount: notes.length,
  };

  renderWithMessage(res, 'admin-dashboard', {
    user: req.session.user,
    students,
    studentGroups: toStudentGroups(students),
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

app.post('/admin/students', requireRole('admin'), async (req, res) => {
  const { rollNo, name, password, standard, course } = req.body;
  const cleanRoll = (rollNo || '').trim();
  const cleanStandard = (standard || '').trim();
  const cleanCourse = (course || '').trim().toLowerCase();

  if (!cleanRoll) {
    req.session.flash = { type: 'error', text: 'Roll number is required' };
    return res.redirect('/admin/dashboard?section=students');
  }

  if (!VALID_STANDARDS.has(cleanStandard) || !VALID_COURSES.has(cleanCourse)) {
    req.session.flash = { type: 'error', text: 'Please select valid standard and course' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const existing = await get(`SELECT id FROM users WHERE roll_no = ?`, [cleanRoll]);
  if (existing) {
    req.session.flash = { type: 'error', text: 'Roll number already exists' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const studentPassword = (password || cleanRoll).trim();
  const hash = await bcrypt.hash(studentPassword, 10);
  await run(
    `INSERT INTO users (role, roll_no, name, standard, course, password_hash) VALUES ('student', ?, ?, ?, ?, ?)`,
    [cleanRoll, (name || '').trim() || cleanRoll, cleanStandard, cleanCourse, hash]
  );

  req.session.flash = {
    type: 'success',
    text: `Student created: ${cleanRoll} (${cleanStandard} ${cleanCourse.toUpperCase()}). Password: ${studentPassword}`,
  };
  return res.redirect('/admin/dashboard?section=students');
});

app.post('/admin/students/:id/delete', requireRole('admin'), async (req, res) => {
  const studentId = Number(req.params.id);
  if (!Number.isInteger(studentId) || studentId <= 0) {
    req.session.flash = { type: 'error', text: 'Invalid student id' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const student = await get(`SELECT id, roll_no, role FROM users WHERE id = ?`, [studentId]);
  if (!student || student.role !== 'student') {
    req.session.flash = { type: 'error', text: 'Student not found' };
    return res.redirect('/admin/dashboard?section=students');
  }

  const files = await all(`
    SELECT stored_name, storage_type, storage_key, public_url, content_type
    FROM test_papers
    WHERE student_id = ?
  `, [studentId]);

  await run(`DELETE FROM attendance WHERE student_id = ?`, [studentId]);
  await run(`DELETE FROM fees WHERE student_id = ?`, [studentId]);
  await run(`DELETE FROM test_papers WHERE student_id = ?`, [studentId]);
  await run(`DELETE FROM users WHERE id = ?`, [studentId]);

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

app.post('/admin/upload-papers', requireRole('admin'), upload.array('papers', 100), async (req, res) => {
  const files = req.files || [];

  if (!files.length) {
    req.session.flash = { type: 'error', text: 'No files uploaded' };
    return res.redirect('/admin/dashboard?section=papers');
  }

  const report = { assigned: 0, skipped: 0, failed: 0 };

  for (const file of files) {
    const base = path.parse(file.originalname).name.trim();
    const student = await get(`SELECT id FROM users WHERE role = 'student' AND roll_no = ?`, [base]);

    if (!student) {
      report.skipped += 1;
      continue;
    }

    try {
      const stored = await uploadPaperFile(file);
      await run(
        `INSERT INTO test_papers (
          student_id, original_name, stored_name, uploaded_by,
          storage_type, storage_key, public_url, content_type, size_bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          student.id,
          file.originalname,
          stored.storedName,
          req.session.user.id,
          stored.storageType,
          stored.storageKey,
          stored.publicUrl,
          stored.contentType,
          stored.sizeBytes,
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
    text: `Upload complete. Assigned: ${report.assigned}, Skipped (roll no not found): ${report.skipped}, Failed: ${report.failed}`,
  };
  return res.redirect('/admin/dashboard?section=papers');
});

app.post('/admin/attendance', requireRole('admin'), async (req, res) => {
  const { rollNo, attendanceDate, status, notes } = req.body;
  const cleanRoll = (rollNo || '').trim();
  const student = await get(`SELECT id FROM users WHERE role = 'student' AND roll_no = ?`, [cleanRoll]);

  if (!student) {
    req.session.flash = { type: 'error', text: 'Student roll number not found' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const existing = await get(
    `SELECT id FROM attendance WHERE student_id = ? AND attendance_date = ? ORDER BY id DESC LIMIT 1`,
    [student.id, attendanceDate]
  );

  if (existing) {
    await run(`UPDATE attendance SET status = ?, notes = ?, marked_by = ? WHERE id = ?`, [
      status,
      (notes || '').trim(),
      req.session.user.id,
      existing.id,
    ]);
  } else {
    await run(
      `INSERT INTO attendance (student_id, attendance_date, status, notes, marked_by) VALUES (?, ?, ?, ?, ?)`,
      [student.id, attendanceDate, status, (notes || '').trim(), req.session.user.id]
    );
  }

  req.session.flash = { type: 'success', text: 'Attendance saved' };
  return res.redirect(`/admin/dashboard?section=attendance&attendanceDate=${encodeURIComponent(attendanceDate)}`);
});

app.post('/admin/attendance-bulk', requireRole('admin'), async (req, res) => {
  const { standard, course, attendanceDate, absentRollNos, notes } = req.body;
  const cleanStandard = (standard || '').trim();
  const cleanCourse = (course || '').trim().toLowerCase();

  if (!VALID_STANDARDS.has(cleanStandard) || !VALID_COURSES.has(cleanCourse)) {
    req.session.flash = { type: 'error', text: 'Please select valid standard and course' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  if (!attendanceDate) {
    req.session.flash = { type: 'error', text: 'Attendance date is required' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const students = await all(
    `SELECT id, roll_no FROM users WHERE role = 'student' AND standard = ? AND course = ? ORDER BY roll_no ASC`,
    [cleanStandard, cleanCourse]
  );

  if (!students.length) {
    req.session.flash = { type: 'error', text: 'No students found in selected group' };
    return res.redirect('/admin/dashboard?section=attendance');
  }

  const absentees = parseAbsentees(absentRollNos);
  let absentCount = 0;
  let presentCount = 0;

  for (const student of students) {
    const isAbsent = absentees.has(student.roll_no);
    const nextStatus = isAbsent ? 'absent' : 'present';
    if (isAbsent) absentCount += 1;
    else presentCount += 1;

    const existing = await get(
      `SELECT id FROM attendance WHERE student_id = ? AND attendance_date = ? ORDER BY id DESC LIMIT 1`,
      [student.id, attendanceDate]
    );

    if (existing) {
      await run(`UPDATE attendance SET status = ?, notes = ?, marked_by = ? WHERE id = ?`, [
        nextStatus,
        (notes || '').trim(),
        req.session.user.id,
        existing.id,
      ]);
    } else {
      await run(
        `INSERT INTO attendance (student_id, attendance_date, status, notes, marked_by) VALUES (?, ?, ?, ?, ?)`,
        [student.id, attendanceDate, nextStatus, (notes || '').trim(), req.session.user.id]
      );
    }
  }

  req.session.flash = {
    type: 'success',
    text: `Attendance done for ${cleanStandard} ${cleanCourse.toUpperCase()} on ${attendanceDate}. Present: ${presentCount}, Absent: ${absentCount}`,
  };
  return res.redirect(`/admin/dashboard?section=attendance&attendanceDate=${encodeURIComponent(attendanceDate)}`);
});

app.post('/admin/fees', requireRole('admin'), async (req, res) => {
  const { rollNo, amount, dueDate, paymentDate, status, notes } = req.body;
  const student = await get(`SELECT id FROM users WHERE role = 'student' AND roll_no = ?`, [(rollNo || '').trim()]);

  if (!student) {
    req.session.flash = { type: 'error', text: 'Student roll number not found' };
    return res.redirect('/admin/dashboard?section=fees');
  }

  await run(
    `INSERT INTO fees (student_id, amount, due_date, payment_date, status, notes, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [student.id, Number(amount), dueDate || null, paymentDate || null, status, (notes || '').trim(), req.session.user.id]
  );

  req.session.flash = { type: 'success', text: 'Fee record added' };
  return res.redirect('/admin/dashboard?section=fees');
});

app.post('/admin/notes', requireRole('admin'), async (req, res) => {
  const { standard, course, title, resourceUrl, description } = req.body;
  const cleanStandard = (standard || '').trim();
  const cleanCourse = (course || '').trim().toLowerCase();
  const cleanTitle = (title || '').trim();
  const cleanUrl = (resourceUrl || '').trim();
  const cleanDescription = (description || '').trim();

  if (!VALID_STANDARDS.has(cleanStandard) || !VALID_COURSES.has(cleanCourse)) {
    req.session.flash = { type: 'error', text: 'Please select valid standard and course for note' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  if (!cleanTitle || !cleanUrl) {
    req.session.flash = { type: 'error', text: 'Note title and URL are required' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  if (!isValidHttpUrl(cleanUrl)) {
    req.session.flash = { type: 'error', text: 'Please enter a valid URL (http/https)' };
    return res.redirect('/admin/dashboard?section=notes');
  }

  await run(
    `INSERT INTO batch_notes (standard, course, title, resource_url, description, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
    [cleanStandard, cleanCourse, cleanTitle, cleanUrl, cleanDescription, req.session.user.id]
  );

  req.session.flash = { type: 'success', text: `Note added for ${cleanStandard} ${cleanCourse.toUpperCase()}` };
  return res.redirect('/admin/dashboard?section=notes');
});

app.get('/student/dashboard', requireRole('student'), async (req, res) => {
  const profile = await get(
    `SELECT id, roll_no, name, standard, course FROM users WHERE id = ? AND role = 'student'`,
    [req.session.user.id]
  );

  const papers = await all(
    `SELECT id, original_name, stored_name, upload_date, storage_type, storage_key, content_type
     FROM test_papers WHERE student_id = ? ORDER BY upload_date DESC`,
    [req.session.user.id]
  );

  const attendance = await all(
    `SELECT attendance_date, status, notes FROM attendance WHERE student_id = ? ORDER BY attendance_date DESC, id DESC`,
    [req.session.user.id]
  );

  const fees = await all(
    `SELECT amount, due_date, payment_date, status, notes FROM fees WHERE student_id = ? ORDER BY created_at DESC`,
    [req.session.user.id]
  );

  const notes = profile?.standard && profile?.course
    ? await all(
      `SELECT title, resource_url, description, created_at
       FROM batch_notes
       WHERE standard = ? AND course = ?
       ORDER BY created_at DESC`,
      [profile.standard, profile.course]
    )
    : [];

  const attendanceSummary = await get(
    `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS presentCount,
      SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absentCount,
      SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS lateCount
     FROM attendance
     WHERE student_id = ?`,
    [req.session.user.id]
  );

  const feeSummary = await get(
    `SELECT
      COUNT(*) AS totalFees,
      SUM(CASE WHEN status IN ('pending', 'overdue') THEN 1 ELSE 0 END) AS pendingCount,
      SUM(CASE WHEN status IN ('pending', 'overdue') THEN amount ELSE 0 END) AS pendingAmount
     FROM fees
     WHERE student_id = ?`,
    [req.session.user.id]
  );

  const total = Number(attendanceSummary?.total || 0);
  const presentCount = Number(attendanceSummary?.presentCount || 0);
  const attendancePercent = total ? ((presentCount / total) * 100).toFixed(1) : '0.0';

  renderWithMessage(res, 'student-dashboard', {
    user: {
      ...req.session.user,
      standard: profile?.standard,
      course: profile?.course,
    },
    papers,
    attendance,
    fees,
    notes,
    profile,
    attendanceSummary: {
      total,
      presentCount,
      absentCount: Number(attendanceSummary?.absentCount || 0),
      lateCount: Number(attendanceSummary?.lateCount || 0),
      attendancePercent,
    },
    feeSummary: {
      totalFees: Number(feeSummary?.totalFees || 0),
      pendingCount: Number(feeSummary?.pendingCount || 0),
      pendingAmount: Number(feeSummary?.pendingAmount || 0),
    },
    flash: req.session.flash,
  });
  req.session.flash = null;
});

async function getPaperForUser(id, user) {
  const paper = await get(
    `SELECT tp.*, u.roll_no
     FROM test_papers tp
     JOIN users u ON u.id = tp.student_id
     WHERE tp.id = ?`,
    [id]
  );
  if (!paper) return null;

  if (user.role === 'admin') return paper;
  if (user.role === 'student' && paper.student_id === user.id) return paper;
  return null;
}

app.get('/papers/:id/view', requireAuth, async (req, res) => {
  const paper = await getPaperForUser(req.params.id, req.session.user);
  if (!paper) return res.status(404).send('Paper not found');

  const access = await getPaperAccess(paper, 'inline');
  if (access.type === 'redirect') {
    return res.redirect(access.url);
  }

  if (!fs.existsSync(access.filePath)) return res.status(404).send('File not available');

  res.setHeader('Content-Disposition', `inline; filename="${paper.original_name}"`);
  return res.sendFile(access.filePath);
});

app.get('/papers/:id/download', requireAuth, async (req, res) => {
  const paper = await getPaperForUser(req.params.id, req.session.user);
  if (!paper) return res.status(404).send('Paper not found');

  const access = await getPaperAccess(paper, 'attachment');
  if (access.type === 'redirect') {
    return res.redirect(access.url);
  }

  if (!fs.existsSync(access.filePath)) return res.status(404).send('File not available');

  return res.download(access.filePath, paper.original_name);
});

app.use((err, req, res, next) => {
  console.error(err);

  if (req.session && req.path && req.path.startsWith('/admin')) {
    req.session.flash = { type: 'error', text: err.message || 'Server error' };
    return res.redirect('/admin/dashboard');
  }

  return res.status(500).send('Server error');
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
