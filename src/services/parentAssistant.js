const PDFDocument = require('pdfkit');
const { get, all, run } = require('../db');
const { getPaperAccess, uploadGeneratedFile } = require('../storage');
const { sendDocumentNotification, sendWhatsAppNotification } = require('./notificationService');
const { getNextDueDate, getStudentFeeSummary } = require('./feeStructure');
const { buildProgressSummaryFromPapers } = require('./progress');

function cleanPhoneNumber(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return `${String(date.getDate()).padStart(2, '0')}-${date.toLocaleString('en-US', { month: 'short' })}-${date.getFullYear()}`;
}

function formatAmount(value) {
  return Number(value || 0).toFixed(2);
}

function resolveAdminPhone(result) {
  return result?.admin_contact_phone
    || result?.contact_phone
    || result?.whatsapp_number
    || result?.phone
    || null;
}

function buildReceiptNumber(feeId, paymentDate = new Date()) {
  return `RCP-${String(feeId).padStart(6, '0')}`;
}

function escapePdfText(value) {
  return String(value || '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function createSimplePdfBuffer(title, lines) {
  const safeLines = [title, '', ...lines].map((line) => escapePdfText(line));
  const content = [
    'BT',
    '/F1 12 Tf',
    '50 780 Td',
    '16 TL',
    ...safeLines.map((line) => `(${line}) Tj T*`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function createPdfKitBuffer(buildDocument) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    buildDocument(doc);
    doc.end();
  });
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createPerformanceSvgBuffer(student, progressSeries) {
  const width = 720;
  const height = 420;
  const pad = { left: 64, right: 40, top: 52, bottom: 72 };
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const points = progressSeries.length
    ? progressSeries.map((item, index) => {
      const x = pad.left + (chartWidth * index) / Math.max(progressSeries.length - 1, 1);
      const y = pad.top + chartHeight - (Math.max(0, Math.min(100, Number(item.percent || 0))) / 100) * chartHeight;
      return { x, y, label: item.label || `Test ${index + 1}`, percent: Number(item.percent || 0) };
    })
    : [];
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const emptyState = points.length
    ? ''
    : '<text x="360" y="215" font-size="22" font-family="Arial" text-anchor="middle" fill="#64748b">No performance data available</text>';

  const circles = points.map((point) => (
    `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="6" fill="#1769aa" />`
  )).join('');
  const labels = points
    .filter((_, index) => index % Math.max(1, Math.ceil(points.length / 6)) === 0)
    .map((point) => `<text x="${point.x.toFixed(1)}" y="${height - 30}" font-size="12" text-anchor="middle" fill="#334155">${escapeXml(point.label).slice(0, 12)}</text>`)
    .join('');

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  <text x="40" y="34" font-size="22" font-family="Arial" font-weight="700" fill="#0f172a">Performance Report</text>
  <text x="40" y="60" font-size="14" font-family="Arial" fill="#475569">${escapeXml(student.name || student.roll_no)} (${escapeXml(student.roll_no)})</text>
  ${[0, 25, 50, 75, 100].map((value) => {
    const y = pad.top + chartHeight - (value / 100) * chartHeight;
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#dbe4ef"/><text x="20" y="${y + 4}" font-size="12" fill="#64748b">${value}%</text>`;
  }).join('')}
  <path d="${path}" fill="none" stroke="#1769aa" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  ${circles}
  ${labels}
  ${emptyState}
</svg>`;
  return Buffer.from(svg);
}

async function getPaperDocument(paper) {
  if (!paper) return null;
  const access = await getPaperAccess(paper, 'attachment');
  return {
    fileUrl: access?.type === 'redirect' ? access.url : paper.public_url,
    fileName: paper.original_name || 'paper.pdf',
  };
}

async function getCoachingByWhatsAppPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return get(
    `SELECT ws.coaching_id, cc.name, cc.contact_email, ws.phone_number_id AS phone,
            admin.contact_phone AS admin_contact_phone,
            admin.contact_phone AS contact_phone,
            admin.whatsapp_number AS whatsapp_number
     FROM whatsapp_settings ws
     JOIN coaching_classes cc ON cc.id = ws.coaching_id
     LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.role = 'admin'
     WHERE ws.phone_number_id = ?
     LIMIT 1`,
    [phoneNumberId]
  );
}

async function findStudentByParentPhone(coachingId, phone) {
  const cleanPhone = cleanPhoneNumber(phone);
  const phoneSuffix = cleanPhone.slice(-10);
  if (!cleanPhone) return null;
  return get(
    `SELECT u.id, u.coaching_id, u.roll_no, u.name, u.contact_phone, u.guardian_phone,
            u.whatsapp_number, u.parent_whatsapp_number, b.name AS batch_name
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id
     WHERE u.coaching_id = ? AND u.role = 'student'
       AND (
         REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g') = ?
         OR REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g') = ?
         OR REGEXP_REPLACE(COALESCE(u.contact_phone, ''), '[^0-9]', '', 'g') = ?
         OR REGEXP_REPLACE(COALESCE(u.whatsapp_number, ''), '[^0-9]', '', 'g') = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g'), 10) = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g'), 10) = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.contact_phone, ''), '[^0-9]', '', 'g'), 10) = ?
         OR RIGHT(REGEXP_REPLACE(COALESCE(u.whatsapp_number, ''), '[^0-9]', '', 'g'), 10) = ?
       )
     ORDER BY CASE
       WHEN REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g') = ? THEN 1
       WHEN REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g') = ? THEN 2
       WHEN RIGHT(REGEXP_REPLACE(COALESCE(u.parent_whatsapp_number, ''), '[^0-9]', '', 'g'), 10) = ? THEN 3
       WHEN RIGHT(REGEXP_REPLACE(COALESCE(u.guardian_phone, ''), '[^0-9]', '', 'g'), 10) = ? THEN 4
       ELSE 3
     END
     LIMIT 1`,
    [
      coachingId,
      cleanPhone,
      cleanPhone,
      cleanPhone,
      cleanPhone,
      phoneSuffix,
      phoneSuffix,
      phoneSuffix,
      phoneSuffix,
      cleanPhone,
      cleanPhone,
      phoneSuffix,
      phoneSuffix,
    ]
  );
}

function buildParentMenuMessage(coaching) {
  return [
    `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
    '',
    'Welcome Parent Portal',
    '',
    'Reply with:',
    '',
    '1️⃣ FEES',
    '2️⃣ ATTENDANCE',
    '3️⃣ RESULTS',
    '4️⃣ PERFORMANCE',
    '5️⃣ STUDENT INFO',
    '',
    'Type option name.',
  ].join('\n');
}

async function saveParentSession({ coachingId, studentId, phone, state, lastMessage }) {
  const cleanPhone = cleanPhoneNumber(phone);
  if (!cleanPhone || !coachingId) return;
  await run(
    `INSERT INTO whatsapp_parent_sessions (coaching_id, student_id, phone_number, state, last_message, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (coaching_id, phone_number)
     DO UPDATE SET student_id = EXCLUDED.student_id,
                   state = EXCLUDED.state,
                   last_message = EXCLUDED.last_message,
                   updated_at = CURRENT_TIMESTAMP`,
    [coachingId, studentId || null, cleanPhone, state || 'menu', lastMessage || null]
  );
}

async function buildStudentPerformance(coachingId, studentId) {
  const papers = await all(
    `SELECT id, original_name, upload_date, marks_obtained, max_marks, test_label,
            stored_name, storage_type, storage_key, public_url, content_type
     FROM test_papers
     WHERE coaching_id = ? AND student_id = ?
     ORDER BY upload_date DESC
     LIMIT 20`,
    [coachingId, studentId]
  );
  const { markedPapers, progressSeries, marksSummary } = buildProgressSummaryFromPapers(papers);
  return {
    papers,
    marked: markedPapers,
    totalMarks: marksSummary.totalMarksObtained,
    totalMax: marksSummary.totalMaxMarks,
    percentage: marksSummary.marksPercent,
    progressSeries,
    marksSummary,
  };
}

async function sendLatestPaper(student, phone) {
  const paper = await get(
    `SELECT id, original_name, stored_name, storage_type, storage_key, public_url, content_type
     FROM test_papers
     WHERE coaching_id = ? AND student_id = ?
       AND (marks_obtained IS NULL OR max_marks IS NULL)
     ORDER BY upload_date DESC, id DESC
     LIMIT 1`,
    [student.coaching_id, student.id]
  );
  const document = await getPaperDocument(paper);
  if (!document?.fileUrl) return false;
  await sendDocumentNotification(student.id, phone, document.fileUrl, document.fileName, 'Latest test paper attached.', {
    type: 'parent_menu_latest_paper',
    eventKey: `parent_menu_latest_paper:${student.id}:${paper.id}:${Date.now()}`,
  });
  return true;
}

async function sendLatestResult(student, phone) {
  const paper = await get(
    `SELECT id, original_name, stored_name, storage_type, storage_key, public_url, content_type,
            upload_date, marks_obtained, max_marks, test_label
     FROM test_papers
     WHERE coaching_id = ? AND student_id = ?
       AND marks_obtained IS NOT NULL AND max_marks IS NOT NULL
     ORDER BY upload_date DESC, id DESC
     LIMIT 1`,
    [student.coaching_id, student.id]
  );
  const document = await getPaperDocument(paper);
  if (!document?.fileUrl) return false;
  const resultMessage = [
    '📚 Latest Result',
    '',
    'Student:',
    student.name || '-',
    '',
    'Test:',
    paper.test_label || paper.original_name || '-',
    '',
    'Marks:',
    `${paper.marks_obtained ?? '-'}/${paper.max_marks ?? '-'}`,
    '',
    'Result PDF attached.',
  ].join('\n');
  await sendWhatsAppNotification({
    studentId: student.id,
    phone,
    type: 'parent_menu_latest_result_summary',
    message: resultMessage,
    eventKey: `parent_menu_latest_result_summary:${student.id}:${paper.id}:${Date.now()}`,
  });
  await sendDocumentNotification(student.id, phone, document.fileUrl, document.fileName, 'Latest result PDF attached.', {
    type: 'parent_menu_latest_result',
    eventKey: `parent_menu_latest_result:${student.id}:${paper.id}:${Date.now()}`,
  });
  return true;
}

async function sendPerformanceGraph(student, phone, coaching = null, options = {}) {
  const performance = await buildStudentPerformance(student.coaching_id, student.id);
  const graphBuffer = createPerformanceSvgBuffer(student, performance.progressSeries);
  const graph = await uploadGeneratedFile({
    buffer: graphBuffer,
    fileName: `performance-${student.roll_no}.svg`,
    contentType: 'image/svg+xml',
    folder: 'whatsapp/performance',
  });
  const message = performance.marked.length
    ? [
      '📈 Performance Updated',
      '',
      `Student: ${student.name || student.roll_no}`,
      '',
      'Overall Score:',
      `${performance.marksSummary.marksPercent}%`,
      '',
      'Performance graph attached.',
    ].join('\n')
    : 'No performance data available';
  if (options.sendMessage !== false) {
    await sendWhatsAppNotification({
      studentId: student.id,
      phone,
      type: 'performance_report',
      message,
      eventKey: `performance_report_text:${student.id}:${Date.now()}`,
    });
  }
  await sendDocumentNotification(student.id, phone, graph.publicUrl, `performance-${student.roll_no}.svg`, 'Performance graph attached.', {
    type: 'performance_graph',
    eventKey: `performance_graph:${student.id}:${Date.now()}`,
  });
  return { graph, performance, coaching };
}

async function sendPerformanceReport(student, phone, coaching = null) {
  const performance = await buildStudentPerformance(student.coaching_id, student.id);
  const report = createSimplePdfBuffer('Performance Report', [
    `Coaching: ${coaching?.name || 'Coaching Institute'}`,
    `Student: ${student.name || student.roll_no}`,
    `Roll No: ${student.roll_no}`,
    `Total Tests: ${performance.marked.length}`,
    `Total Marks: ${performance.totalMarks}/${performance.totalMax}`,
    performance.marked.length
      ? `Overall Score: ${performance.marksSummary.marksPercent}%`
      : 'No performance data available',
    '',
    'Recent Results:',
    ...performance.marked.slice(-10).map((paper) => (
      `${paper.test_label || paper.original_name}: ${paper.marks_obtained}/${paper.max_marks} (${formatDate(paper.upload_date)})`
    )),
  ]);
  const file = await uploadGeneratedFile({
    buffer: report,
    fileName: `performance-report-${student.roll_no}.pdf`,
    contentType: 'application/pdf',
    folder: 'whatsapp/performance-reports',
  });
  return sendDocumentNotification(student.id, phone, file.publicUrl, `performance-report-${student.roll_no}.pdf`, 'Performance report attached.', {
    type: 'performance_report_pdf',
    eventKey: `performance_report_pdf:${student.id}:${Date.now()}`,
  });
}

async function generateFeeReceiptPdf(feeId) {
  const fee = await get(
    `SELECT f.id, f.amount, f.payment_date, f.status, f.receipt_number, f.receipt_file_url,
            f.notes, f.added_by,
            u.id AS student_id, u.roll_no, u.name AS student_name, u.batch_id,
            b.name AS batch_name,
            cc.name AS coaching_name, cc.contact_email,
            sfs.total_fee, sfs.paid_fee, sfs.pending_fee,
            admin.contact_phone AS admin_contact_phone,
            admin.contact_phone AS contact_phone,
            admin.whatsapp_number AS whatsapp_number,
            receiver.name AS received_by_name
     FROM fees f
     JOIN users u ON u.id = f.student_id
     LEFT JOIN batches b ON b.id = u.batch_id
     JOIN coaching_classes cc ON cc.id = f.coaching_id
     LEFT JOIN student_fee_structure sfs ON sfs.coaching_id = f.coaching_id AND sfs.student_id = f.student_id
     LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.role = 'admin'
     LEFT JOIN users receiver ON receiver.id = f.added_by
     WHERE f.id = ?
     LIMIT 1`,
    [feeId]
  );

  if (!fee) {
    throw new Error(`Fee record not found for receipt generation: ${feeId}`);
  }

  const amount = Number(fee.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Cannot generate receipt for invalid amount on fee ${feeId}`);
  }

  const receiptNumber = fee.receipt_number || buildReceiptNumber(fee.id, fee.payment_date || new Date());
  if (fee.receipt_file_url) {
    return {
      receiptNumber,
      fileUrl: fee.receipt_file_url,
      fileName: `${receiptNumber}.pdf`,
      fee,
    };
  }

  const receipt = await createPdfKitBuffer((doc) => {
    const adminPhone = resolveAdminPhone(fee);
    doc.fontSize(18).text(fee.coaching_name || 'SHIV CHHATRAPATI CLASSES', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(20).text('Payment Receipt', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#555').text(`Contact: ${adminPhone || '-'} | Email: ${fee.contact_email || '-'}`, { align: 'center' });
    doc.moveDown(1.5);
    doc.fillColor('#000').fontSize(12);
    const rows = [
      ['Receipt No', receiptNumber],
      ['Date', formatDate(fee.payment_date || new Date().toISOString())],
      ['Transaction ID', `FEE-${fee.id}`],
      ['Student', fee.student_name || '-'],
      ['Roll Number', fee.roll_no || '-'],
      ['Batch', fee.batch_name || '-'],
      ['Amount Paid', `Rs. ${formatAmount(amount)}`],
      ['Payment Method', fee.notes || 'Manual/Portal'],
      ['Pending Balance', `Rs. ${formatAmount(fee.pending_fee)}`],
      ['Received By', fee.received_by_name || 'Admin'],
      ['Coaching Contact', adminPhone || fee.contact_email || '-'],
    ];
    rows.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
      doc.font('Helvetica').text(String(value));
      doc.moveDown(0.35);
    });
    doc.moveDown(1);
    doc.fontSize(10).fillColor('#555').text('This is a system-generated receipt from EduSync.', { align: 'center' });
  });

  const file = await uploadGeneratedFile({
    buffer: receipt,
    fileName: `${receiptNumber}.pdf`,
    contentType: 'application/pdf',
    folder: 'whatsapp/receipts',
  });

  await run(
    `UPDATE fees
     SET receipt_number = ?, receipt_file_url = ?, receipt_storage_key = ?, receipt_storage_type = ?, receipt_generated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [receiptNumber, file.publicUrl, file.storageKey || file.storedName || null, file.storageType || null, fee.id]
  );

  return {
    receiptNumber,
    fileUrl: file.publicUrl,
    fileName: `${receiptNumber}.pdf`,
    fee,
  };
}

async function createFeeReceiptAndSend({ student, fee, coaching, phone, recipient = 'parent' }) {
  const receipt = await generateFeeReceiptPdf(fee.id);
  return sendDocumentNotification(student.id, phone, receipt.fileUrl, receipt.fileName, 'Payment received successfully. Receipt attached.', {
    type: 'fee_receipt',
    eventKey: `fee_receipt:${recipient}:${student.id}:${fee.id}`,
  });
}

async function createMonthlyReportAndSend({ student, coaching, phone, monthKey }) {
  const attendanceSummary = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_count
     FROM attendance
     WHERE coaching_id = ? AND student_id = ?
       AND CAST(attendance_date AS TEXT) LIKE ?`,
    [student.coaching_id, student.id, `${monthKey}%`]
  );
  const pending = await get(
    `SELECT COALESCE(SUM(amount), 0) AS pending_amount
     FROM fees
     WHERE coaching_id = ? AND student_id = ? AND status IN ('pending', 'overdue')`,
    [student.coaching_id, student.id]
  );
  const performance = await buildStudentPerformance(student.coaching_id, student.id);
  const totalAttendance = Number(attendanceSummary?.total || 0);
  const present = Number(attendanceSummary?.present_count || 0);
  const attendancePercent = totalAttendance ? Number(((present / totalAttendance) * 100).toFixed(1)) : 0;
  const report = createSimplePdfBuffer(`Monthly Parent Report - ${monthKey}`, [
    `Coaching: ${coaching?.name || 'Coaching Institute'}`,
    `Student: ${student.name || student.roll_no}`,
    `Roll No: ${student.roll_no}`,
    `Attendance: ${attendancePercent}%`,
    `Total Tests: ${performance.marked.length}`,
    performance.marked.length
      ? `Average Marks: ${performance.marksSummary.marksPercent}%`
      : 'No performance data available',
    `Pending Fees: Rs. ${formatAmount(pending?.pending_amount)}`,
  ]);
  const file = await uploadGeneratedFile({
    buffer: report,
    fileName: `monthly-report-${student.roll_no}-${monthKey}.pdf`,
    contentType: 'application/pdf',
    folder: 'whatsapp/monthly-reports',
  });
  return sendDocumentNotification(student.id, phone, file.publicUrl, `monthly-report-${student.roll_no}-${monthKey}.pdf`, 'Monthly parent report attached.', {
    type: 'monthly_parent_report',
    eventKey: `monthly_parent_report:${student.id}:${monthKey}`,
  });
}

async function handleParentAssistantMessage({ coaching, student, from, text }) {
  const command = String(text || '').trim().toUpperCase();
  const phone = cleanPhoneNumber(from);
  if (!student) return false;
  await saveParentSession({
    coachingId: student.coaching_id,
    studentId: student.id,
    phone,
    state: 'menu',
    lastMessage: command,
  });

  if (['HI', 'HELLO', 'MENU', 'START', 'HELP'].includes(command)) {
    await sendWhatsAppNotification({
      studentId: student.id,
      phone,
      type: 'parent_menu',
      message: buildParentMenuMessage(coaching),
      eventKey: `parent_menu:${student.id}:${Date.now()}`,
    });
    return true;
  }

  if (command === '1' || command === 'FEES') {
    const feeSummary = await getStudentFeeSummary(student.coaching_id, student.id);
    const nextDueDate = await getNextDueDate(student.coaching_id, student.id);
    await sendWhatsAppNotification({
      studentId: student.id,
      phone,
      type: 'parent_menu_fee_summary',
      message: [
        '💰 Fee Summary',
        '',
        'Student:',
        student.name || '-',
        '',
        'Total Fees:',
        `₹${formatAmount(feeSummary.totalFee)}`,
        '',
        'Paid:',
        `₹${formatAmount(feeSummary.paidFee)}`,
        '',
        'Pending:',
        `₹${formatAmount(feeSummary.pendingFee)}`,
        '',
        'Next Due:',
        formatDate(nextDueDate),
      ].join('\n'),
      eventKey: `parent_menu_fee_summary:${student.id}:${Date.now()}`,
    });
    return true;
  }

  if (command === '2' || command === 'ATTENDANCE') {
    const summary = await get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present_count,
              SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent_count,
              SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late_count
       FROM attendance
       WHERE coaching_id = ? AND student_id = ?`,
      [student.coaching_id, student.id]
    );
    const total = Number(summary?.total || 0);
    const present = Number(summary?.present_count || 0);
    const percent = total ? ((present / total) * 100).toFixed(1) : '0.0';
    await sendWhatsAppNotification({
      studentId: student.id,
      phone,
      type: 'parent_menu_attendance',
      message: [
        '📅 Attendance Summary',
        '',
        'Present:',
        String(present),
        '',
        'Absent:',
        String(Number(summary?.absent_count || 0)),
        '',
        'Attendance:',
        `${percent}%`,
      ].join('\n'),
      eventKey: `parent_menu_attendance:${student.id}:${Date.now()}`,
    });
    return true;
  }

  if (command === '3' || command === 'RESULTS' || command === 'RESULT') {
    const sent = await sendLatestResult(student, phone);
    if (!sent) {
      await sendWhatsAppNotification({ studentId: student.id, phone, type: 'parent_menu_latest_result', message: 'No result PDF is available yet.', eventKey: `parent_menu_latest_result_empty:${student.id}:${Date.now()}` });
    }
    return true;
  }

  if (command === '4' || command === 'PERFORMANCE') {
    const performance = await buildStudentPerformance(student.coaching_id, student.id);
    const percentages = performance.progressSeries.map((item) => Number(item.percent)).filter(Number.isFinite);
    const average = performance.marked.length ? performance.marksSummary.marksPercent : '0.00';
    const highest = percentages.length ? Math.max(...percentages).toFixed(2) : '0.00';
    const latest = percentages.length ? percentages[percentages.length - 1].toFixed(2) : '0.00';
    await sendWhatsAppNotification({
      studentId: student.id,
      phone,
      type: 'parent_menu_performance_report',
      message: [
        '📈 Performance Report',
        '',
        'Average:',
        `${average}%`,
        '',
        'Highest:',
        `${highest}%`,
        '',
        'Latest:',
        `${latest}%`,
        '',
        'Graph attached.',
      ].join('\n'),
      eventKey: `parent_menu_performance_report:${student.id}:${Date.now()}`,
    });
    await sendPerformanceGraph(student, phone, coaching, { sendMessage: false });
    return true;
  }

  if (command === '5' || command === 'STUDENT INFO' || command === 'STUDENT' || command === 'INFO') {
    await sendWhatsAppNotification({
      studentId: student.id,
      phone,
      type: 'parent_menu_student_profile',
      message: [
        '👨‍🎓 Student Information',
        '',
        'Name:',
        student.name || '-',
        '',
        'Roll No:',
        student.roll_no || '-',
        '',
        'Batch:',
        student.batch_name || '-',
      ].join('\n'),
      eventKey: `parent_menu_student_profile:${student.id}:${Date.now()}`,
    });
    return true;
  }

  return false;
}

async function sendMonthlyParentReports({ monthKey, coachingId = null }) {
  const params = [];
  let sql = `
    SELECT u.id, u.coaching_id, u.roll_no, u.name, u.parent_whatsapp_number, u.guardian_phone,
           cc.name, cc.contact_email,
           admin.contact_phone AS admin_contact_phone,
           admin.contact_phone AS contact_phone,
           admin.whatsapp_number AS whatsapp_number
    FROM users u
    JOIN coaching_classes cc ON cc.id = u.coaching_id
    LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.role = 'admin'
    WHERE u.role = 'student'
      AND COALESCE(u.parent_whatsapp_number, u.guardian_phone) IS NOT NULL
      AND TRIM(COALESCE(u.parent_whatsapp_number, u.guardian_phone, '')) <> ''
  `;
  if (coachingId) {
    params.push(coachingId);
    sql += ` AND u.coaching_id = ?`;
  }
  sql += ` ORDER BY u.coaching_id, u.roll_no ASC LIMIT 400`;

  const students = await all(sql, params);
  const summary = { sent: 0, skipped: 0, failed: 0 };
  for (const row of students) {
    try {
      const result = await createMonthlyReportAndSend({
        student: row,
        coaching: row,
        phone: row.parent_whatsapp_number || row.guardian_phone,
        monthKey,
      });
      if (result?.skipped) {
        summary.skipped += 1;
      } else {
        await sendPerformanceGraph(row, row.parent_whatsapp_number || row.guardian_phone, row);
        summary.sent += 1;
      }
    } catch (error) {
      console.error('Monthly parent report failed', { studentId: row.id, error: error.message });
      summary.failed += 1;
    }
  }
  return summary;
}

module.exports = {
  buildParentMenuMessage,
  createFeeReceiptAndSend,
  createMonthlyReportAndSend,
  findStudentByParentPhone,
  generateFeeReceiptPdf,
  getCoachingByWhatsAppPhoneNumberId,
  handleParentAssistantMessage,
  sendLatestPaper,
  sendLatestResult,
  sendMonthlyParentReports,
  sendPerformanceGraph,
};
