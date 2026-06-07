const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { get, all, run } = require('../db');
const { getPaperAccess, getStoredFilePublicUrl, uploadGeneratedFile } = require('../storage');
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
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return '0';
  return amount.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function formatPercent(value) {
  const percent = Number(value || 0);
  if (!Number.isFinite(percent)) return '0';
  return percent.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function compactWhatsAppMessage(lines) {
  const output = [];
  for (const line of lines) {
    const value = String(line ?? '').trim();
    if (!value && output[output.length - 1] === '') continue;
    output.push(value);
  }
  while (output[output.length - 1] === '') output.pop();
  return output.join('\n');
}

function resolveAdminPhone(result) {
  return result?.admin_contact_phone
    || result?.contact_phone
    || result?.whatsapp_number
    || result?.phone
    || null;
}

function getAppPublicBaseUrl() {
  return String(
    process.env.APP_BASE_URL
    || process.env.PUBLIC_BASE_URL
    || process.env.RENDER_EXTERNAL_URL
    || process.env.VERCEL_URL
    || ''
  ).trim().replace(/\/$/, '').replace(/^([^h])/, 'https://$1');
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const url = new URL(withProtocol);
    const hostname = url.hostname.toLowerCase();
    const isPrivateHost = hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '0.0.0.0'
      || hostname === '::1'
      || hostname.endsWith('.internal');
    if (isPrivateHost) return '';
    url.pathname = url.pathname.replace(/\/$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    return '';
  }
}

function getReceiptPublicBaseUrl(explicitBaseUrl = '') {
  return [
    explicitBaseUrl,
    process.env.APP_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.VERCEL_URL,
  ].map(normalizePublicBaseUrl).find(Boolean) || '';
}

function getReceiptUrlSecret() {
  return String(process.env.RECEIPT_URL_SECRET || process.env.SESSION_SECRET || 'local-development-receipt-secret');
}

function createReceiptAccessToken({ feeId, receiptNumber, storageKey }) {
  return crypto
    .createHmac('sha256', getReceiptUrlSecret())
    .update(`${feeId}:${receiptNumber || ''}:${storageKey || ''}`)
    .digest('hex');
}

function verifyReceiptAccessToken({ feeId, receiptNumber, storageKey, token }) {
  const expected = createReceiptAccessToken({ feeId, receiptNumber, storageKey });
  const actual = String(token || '');
  if (!actual || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function buildReceiptAccessUrl({
  publicBaseUrl = '',
  feeId,
  receiptNumber,
  storageKey,
  fileName,
}) {
  const baseUrl = getReceiptPublicBaseUrl(publicBaseUrl);
  if (!baseUrl || !feeId || !storageKey) return null;
  const token = createReceiptAccessToken({ feeId, receiptNumber, storageKey });
  return `${baseUrl}/receipts/${encodeURIComponent(feeId)}/${token}/${encodeURIComponent(fileName || `${receiptNumber || 'receipt'}.pdf`)}`;
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

async function validatePublicUrl(url) {
  if (!url) return { ok: false, status: 0, error: 'URL missing' };

  try {
    let response = await fetch(url, { method: 'HEAD' });
    if (!response.ok || response.status === 403 || response.status === 405) {
      response = await fetch(url, { method: 'GET' });
    }

    return {
      ok: response.status === 200,
      status: response.status,
      contentType: response.headers.get('content-type') || null,
    };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

async function getPaperDocument(paper) {
  if (!paper) return null;
  const access = await getPaperAccess(paper, 'attachment');
  const localUrl = access?.type === 'local' && getAppPublicBaseUrl() && paper.stored_name
    ? `${getAppPublicBaseUrl()}/paper-files/${encodeURIComponent(paper.stored_name)}`
    : null;
  return {
    fileUrl: paper.public_url || (access?.type === 'redirect' ? access.url : localUrl),
    fileName: paper.original_name || 'paper.pdf',
  };
}

async function getCoachingByWhatsAppPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;

  const selectCoachingSql = `
    SELECT ws.coaching_id, cc.name, cc.contact_email, ws.phone_number_id AS phone,
           admin.contact_phone AS admin_contact_phone,
           admin.contact_phone AS contact_phone,
           admin.whatsapp_number AS whatsapp_number
    FROM whatsapp_settings ws
    JOIN coaching_classes cc ON cc.id = ws.coaching_id
    LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.role = 'admin'
  `;

  const exactMatch = await get(
    `${selectCoachingSql}
     WHERE ws.phone_number_id = ?
     LIMIT 1`,
    [phoneNumberId]
  );
  if (exactMatch) return exactMatch;

  console.error('[COACHING] No exact WhatsApp phone_number_id mapping found', { phoneNumberId });

  const settingsRows = await all(
    `${selectCoachingSql}
     ORDER BY ws.updated_at DESC
     LIMIT 2`
  );
  if (settingsRows.length === 1) {
    await run(
      `UPDATE whatsapp_settings
       SET phone_number_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE coaching_id = ?`,
      [phoneNumberId, settingsRows[0].coaching_id]
    );
    console.log('[COACHING] Repaired WhatsApp phone_number_id mapping', {
      coachingId: settingsRows[0].coaching_id,
      phoneNumberId,
    });
    return {
      ...settingsRows[0],
      phone: phoneNumberId,
    };
  }

  if (settingsRows.length > 1) {
    console.error('[COACHING] Ambiguous WhatsApp settings; cannot choose coaching automatically', {
      phoneNumberId,
      matchingRows: settingsRows.length,
    });
    return null;
  }

  const coachingRows = await all(
    `SELECT cc.id AS coaching_id, cc.name, cc.contact_email, ? AS phone,
            admin.contact_phone AS admin_contact_phone,
            admin.contact_phone AS contact_phone,
            admin.whatsapp_number AS whatsapp_number
     FROM coaching_classes cc
     LEFT JOIN users admin ON admin.coaching_id = cc.id AND admin.role = 'admin'
     ORDER BY cc.id ASC
     LIMIT 2`,
    [phoneNumberId]
  );

  if (coachingRows.length === 1) {
    await run(
      `INSERT INTO whatsapp_settings (coaching_id, phone_number_id, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (coaching_id)
       DO UPDATE SET phone_number_id = EXCLUDED.phone_number_id,
                     updated_at = CURRENT_TIMESTAMP`,
      [coachingRows[0].coaching_id, phoneNumberId]
    );
    console.log('[COACHING] Created WhatsApp phone_number_id mapping from single coaching fallback', {
      coachingId: coachingRows[0].coaching_id,
      phoneNumberId,
    });
    return coachingRows[0];
  }

  console.error('[COACHING] Unable to resolve WhatsApp phone_number_id mapping', {
    phoneNumberId,
    coachingRows: coachingRows.length,
  });
  return null;
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

async function findStudentByParentSession(coachingId, phone) {
  const session = await getParentSession({ coachingId, phone });
  if (!session?.student_id) return null;

  return get(
    `SELECT u.id, u.coaching_id, u.roll_no, u.name, u.contact_phone, u.guardian_phone,
            u.whatsapp_number, u.parent_whatsapp_number, b.name AS batch_name
     FROM users u
     LEFT JOIN batches b ON b.id = u.batch_id
     WHERE u.coaching_id = ? AND u.role = 'student' AND u.id = ?
     LIMIT 1`,
    [coachingId, session.student_id]
  );
}

function buildParentMenuMessage(coaching) {
  return [
    `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
    '',
    'Welcome to Parent Portal',
    '',
    'Choose an option:',
    '',
    '1️⃣ FEES',
    '2️⃣ ATTENDANCE',
    '3️⃣ RESULTS',
    '4️⃣ PERFORMANCE',
    '5️⃣ STUDENT INFO',
    '',
    'Reply with the option name.',
    '',
    'Example:',
    'FEES',
    'RESULTS',
    'ATTENDANCE',
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

async function getParentSession({ coachingId, phone }) {
  const cleanPhone = cleanPhoneNumber(phone);
  if (!cleanPhone || !coachingId) return null;
  return get(
    `SELECT id, coaching_id, student_id, phone_number, state, last_message, updated_at
     FROM whatsapp_parent_sessions
     WHERE coaching_id = ? AND phone_number = ?
     LIMIT 1`,
    [coachingId, cleanPhone]
  );
}

function normalizeParentOption(text) {
  const command = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!command) return '';

  if (command.startsWith('1') || command === 'fees' || command === 'fee') return 'FEES';
  if (command.startsWith('2') || command === 'attendance') return 'ATTENDANCE';
  if (command.startsWith('3') || command === 'results' || command === 'result') return 'RESULTS';
  if (command.startsWith('4') || command === 'performance') return 'PERFORMANCE';
  if (command.startsWith('5') || command === 'student info' || command === 'student' || command === 'info') return 'STUDENT_INFO';
  if (command === 'menu' || command === 'start' || command === 'help') return 'MENU';
  if (command === 'hi' || command === 'hello') return 'GREETING';

  return command.toUpperCase();
}

async function buildStudentPerformance(coachingId, studentId) {
  const papers = await all(
    `SELECT id, original_name, upload_date, marks_obtained, max_marks, test_label,
            stored_name, storage_type, storage_key, public_url, content_type
     FROM test_papers
     WHERE coaching_id = ? AND student_id = ?
     ORDER BY upload_date DESC`,
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
  if (!paper) return false;
  const percentage = Number(paper.max_marks) > 0
    ? formatPercent((Number(paper.marks_obtained || 0) / Number(paper.max_marks)) * 100)
    : '-';
  const resultMessage = [
    '🏫 SHIV CHHATRAPATI CLASSES',
    '',
    '📚 New Result Available',
    '',
    `Student: ${student.name || '-'}`,
    `Test: ${paper.test_label || paper.original_name || '-'}`,
    `Marks: ${paper.marks_obtained ?? '-'}/${paper.max_marks ?? '-'}`,
    `Percentage: ${percentage}%`,
    '',
    'View full result in Parent Portal.',
  ];
  await sendWhatsAppNotification({
    studentId: student.id,
    phone,
    type: 'parent_menu_latest_result_summary',
    message: compactWhatsAppMessage(resultMessage),
    eventKey: `parent_menu_latest_result_summary:${student.id}:${paper.id}:${Date.now()}`,
  });

  try {
    const document = await getPaperDocument(paper);
    if (!document?.fileUrl) {
      console.error('Latest result PDF missing public URL', { studentId: student.id, paperId: paper.id });
      return true;
    }
    await sendDocumentNotification(student.id, phone, document.fileUrl, document.fileName, 'Result PDF attached.', {
      type: 'parent_menu_latest_result',
      eventKey: `parent_menu_latest_result:${student.id}:${paper.id}:${Date.now()}`,
    });
  } catch (error) {
    console.error('Latest result PDF send failed', { studentId: student.id, paperId: paper.id, error: error.message });
  }
  return true;
}

async function sendPerformanceGraph(student, phone, coaching = null, options = {}) {
  const performance = await buildStudentPerformance(student.coaching_id, student.id);
  const hasPerformanceRows = Number(performance.marksSummary.papersCount || 0) > 0;
  const message = hasPerformanceRows
    ? [
      `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
      '',
      '📈 Performance Update',
      '',
      `Student: ${student.name || student.roll_no}`,
      `Overall Performance: ${performance.marksSummary.marksPercent}%`,
    ]
    : 'No performance data available';
  if (options.sendMessage !== false) {
    await sendWhatsAppNotification({
      studentId: student.id,
      phone,
      type: 'performance_report',
      message: Array.isArray(message) ? compactWhatsAppMessage(message) : message,
      eventKey: `performance_report_text:${student.id}:${Date.now()}`,
    });
  }

  try {
    if (!hasPerformanceRows) return { graph: null, performance, coaching };
    const graphBuffer = createPerformanceSvgBuffer(student, performance.progressSeries);
    const graph = await uploadGeneratedFile({
      buffer: graphBuffer,
      fileName: `performance-${student.roll_no}.svg`,
      contentType: 'image/svg+xml',
      folder: 'whatsapp/performance',
    });
    await sendDocumentNotification(student.id, phone, graph.publicUrl, `performance-${student.roll_no}.svg`, 'Performance graph attached below.', {
      type: 'performance_graph',
      eventKey: `performance_graph:${student.id}:${Date.now()}`,
    });
    return { graph, performance, coaching };
  } catch (error) {
    console.error('Performance graph send failed', { studentId: student.id, error: error.message });
    return { graph: null, performance, coaching, error: error.message };
  }
}

async function sendPerformanceReport(student, phone, coaching = null) {
  const performance = await buildStudentPerformance(student.coaching_id, student.id);
  const report = createSimplePdfBuffer('Performance Report', [
    `Coaching: ${coaching?.name || 'Coaching Institute'}`,
    `Student: ${student.name || student.roll_no}`,
    `Roll No: ${student.roll_no}`,
    `Total Tests: ${performance.marked.length}`,
    `Total Marks: ${performance.totalMarks}/${performance.totalMax}`,
    Number(performance.marksSummary.papersCount || 0) > 0
      ? `Overall Performance: ${performance.marksSummary.marksPercent}%`
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

async function generateFeeReceiptPdf(feeId, options = {}) {
  const forceRegenerate = options.forceRegenerate === true;
  const publicBaseUrl = options.publicBaseUrl || '';
  const fee = await get(
    `SELECT f.id, f.amount, f.payment_date, f.status, f.receipt_number, f.receipt_file_url,
            f.notes, f.added_by,
            u.id AS student_id, u.roll_no, u.name AS student_name, u.batch_id,
            b.name AS batch_name,
            cc.name AS coaching_name, cc.contact_email,
            sfs.total_fee, sfs.paid_fee, sfs.pending_fee,
            f.receipt_storage_key, f.receipt_storage_type,
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
  if (fee.receipt_file_url && !forceRegenerate) {
    const receiptAccessUrl = buildReceiptAccessUrl({
      publicBaseUrl,
      feeId: fee.id,
      receiptNumber,
      storageKey: fee.receipt_storage_key,
      fileName: `${receiptNumber}.pdf`,
    });
    const freshUrl = await getStoredFilePublicUrl({
      storageType: fee.receipt_storage_type || 'local',
      storageKey: fee.receipt_storage_key,
      fileName: `${receiptNumber}.pdf`,
      contentType: 'application/pdf',
      dispositionType: 'attachment',
    });
    const fileUrl = receiptAccessUrl || freshUrl || fee.receipt_file_url;
    console.log('Receipt generated', {
      feeId: fee.id,
      receiptNumber,
      reused: true,
      storageType: fee.receipt_storage_type,
      storageKey: fee.receipt_storage_key,
    });
    console.log('Receipt URL', fileUrl);
    return {
      receiptNumber,
      fileUrl,
      fileName: `${receiptNumber}.pdf`,
      storageKey: fee.receipt_storage_key || null,
      storageType: fee.receipt_storage_type || null,
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
      ['Amount Paid', `₹${formatAmount(amount)}`],
      ['Payment Method', fee.notes || 'Manual/Portal'],
      ['Remaining Balance', `₹${formatAmount(fee.pending_fee)}`],
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
  const receiptAccessUrl = buildReceiptAccessUrl({
    publicBaseUrl,
    feeId: fee.id,
    receiptNumber,
    storageKey: file.storageKey || file.storedName,
    fileName: `${receiptNumber}.pdf`,
  });
  console.log('Receipt generated', {
    feeId: fee.id,
    receiptNumber,
    storageType: file.storageType,
    storageKey: file.storageKey || file.storedName,
  });
  console.log('Receipt URL', receiptAccessUrl || file.publicUrl);

  if (!receiptAccessUrl && !file.publicUrl) {
    throw new Error('Receipt PDF generated but no public URL is available. Configure APP_BASE_URL/PUBLIC_BASE_URL/RENDER_EXTERNAL_URL for the public app URL or S3_PUBLIC_BASE_URL for direct S3 access.');
  }

  await run(
    `UPDATE fees
     SET receipt_number = ?, receipt_file_url = ?, receipt_storage_key = ?, receipt_storage_type = ?, receipt_generated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [receiptNumber, receiptAccessUrl || file.publicUrl, file.storageKey || file.storedName || null, file.storageType || null, fee.id]
  );

  return {
    receiptNumber,
    fileUrl: receiptAccessUrl || file.publicUrl,
    fileName: `${receiptNumber}.pdf`,
    storageKey: file.storageKey || file.storedName || null,
    storageType: file.storageType || null,
    fee,
  };
}

async function createFeeReceiptAndSend({ student, fee, coaching, phone, recipient = 'parent', publicBaseUrl = '' }) {
  const receipt = await generateFeeReceiptPdf(fee.id, { publicBaseUrl });
  console.log('Generated receipt URL', receipt.fileUrl);
  console.log('Receipt storage type', receipt.storageType);
  const validation = await validatePublicUrl(receipt.fileUrl);
  console.log('RECEIPT VALIDATION', validation);
  if (!validation.ok) {
    throw new Error(`Receipt URL is not publicly accessible with HTTP 200. Status: ${validation.status || 'unknown'}${validation.error ? ` Error: ${validation.error}` : ''}`);
  }
  return sendDocumentNotification(student.id, phone, receipt.fileUrl, receipt.fileName, 'Payment received successfully. Receipt attached.', {
    type: 'fee_receipt',
    eventKey: `fee_receipt:${recipient}:${student.id}:${fee.id}`,
    retryFailed: true,
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
    Number(performance.marksSummary.papersCount || 0) > 0
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
  try {
    const incomingText = String(text || '').trim();
    const normalizedOption = normalizeParentOption(incomingText);
    const phone = cleanPhoneNumber(from);
    if (!student) return false;
    const session = await getParentSession({
      coachingId: student.coaching_id,
      phone,
    });
    console.log('Incoming message:', incomingText);
    console.log('Normalized option:', normalizedOption);
    console.log('Session:', session);
    console.log('Student:', student?.id);

    if (normalizedOption === 'MENU' || (normalizedOption === 'GREETING' && !session)) {
      console.log('[HANDLER] Enter MENU');
      const notificationResult = await sendWhatsAppNotification({
        studentId: student.id,
        phone,
        type: 'parent_menu',
        message: buildParentMenuMessage(coaching),
        eventKey: `parent_menu:${student.id}:${Date.now()}`,
      });
      console.log('[WHATSAPP] Menu result:', notificationResult);
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'menu',
        lastMessage: normalizedOption,
      });
      return true;
    } else if (normalizedOption === 'FEES') {
      console.log('Before FEES block');
      console.log('[HANDLER] Enter FEES');
      const feeSummary = await getStudentFeeSummary(student.coaching_id, student.id);
      const nextDueDate = await getNextDueDate(student.coaching_id, student.id);
      const notificationResult = await sendWhatsAppNotification({
        studentId: student.id,
        phone,
        type: 'parent_menu_fee_summary',
        message: compactWhatsAppMessage([
          `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
          '',
          '💰 Fee Summary',
          '',
          `Student: ${student.name || '-'}`,
          `Total Fees: ₹${formatAmount(feeSummary.totalFee)}`,
          `Paid Fees: ₹${formatAmount(feeSummary.paidFee)}`,
          `Pending Fees: ₹${formatAmount(feeSummary.pendingFee)}`,
          '',
          'Next Due Date:',
          formatDate(nextDueDate),
        ]),
        eventKey: `parent_menu_fee_summary:${student.id}:${Date.now()}`,
      });
      console.log('[WHATSAPP] Fee summary result:', notificationResult);
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'fees',
        lastMessage: normalizedOption,
      });
      return true;
    } else if (normalizedOption === 'ATTENDANCE') {
      console.log('Before ATTENDANCE block');
      console.log('[HANDLER] Enter ATTENDANCE');
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
      const notificationResult = await sendWhatsAppNotification({
        studentId: student.id,
        phone,
        type: 'parent_menu_attendance',
        message: compactWhatsAppMessage([
          '📅 Attendance Summary',
          '',
          `Present: ${present}`,
          `Absent: ${Number(summary?.absent_count || 0)}`,
          `Attendance Percentage: ${percent}%`,
        ]),
        eventKey: `parent_menu_attendance:${student.id}:${Date.now()}`,
      });
      console.log('[WHATSAPP] Attendance result:', notificationResult);
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'attendance',
        lastMessage: normalizedOption,
      });
      return true;
    } else if (normalizedOption === 'RESULTS') {
      console.log('Before RESULTS block');
      console.log('[HANDLER] Enter RESULTS');
      const sent = await sendLatestResult(student, phone);
      console.log('[WHATSAPP] Latest result send status:', sent);
      if (!sent) {
        const notificationResult = await sendWhatsAppNotification({ studentId: student.id, phone, type: 'parent_menu_latest_result', message: 'No result PDF is available yet.', eventKey: `parent_menu_latest_result_empty:${student.id}:${Date.now()}` });
        console.log('[WHATSAPP] Empty latest result response:', notificationResult);
      }
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'results',
        lastMessage: normalizedOption,
      });
      return true;
    } else if (normalizedOption === 'PERFORMANCE') {
      console.log('Before PERFORMANCE block');
      console.log('[HANDLER] Enter PERFORMANCE');
      const performance = await buildStudentPerformance(student.coaching_id, student.id);
      const percentages = performance.progressSeries.map((item) => Number(item.percent)).filter(Number.isFinite);
      const average = Number(performance.marksSummary.papersCount || 0) > 0 ? performance.marksSummary.marksPercent : '0';
      const highest = percentages.length ? formatPercent(Math.max(...percentages)) : '0';
      const latest = percentages.length ? formatPercent(percentages[percentages.length - 1]) : '0';
      const notificationResult = await sendWhatsAppNotification({
        studentId: student.id,
        phone,
        type: 'parent_menu_performance_report',
        message: compactWhatsAppMessage([
          '📈 Performance Report',
          '',
          'Overall:',
          `${average}%`,
          'Highest:',
          `${highest}%`,
          'Latest:',
          `${latest}%`,
          '',
          'Graph attached.',
        ]),
        eventKey: `parent_menu_performance_report:${student.id}:${Date.now()}`,
      });
      console.log('[WHATSAPP] Performance report result:', notificationResult);
      const graphResult = await sendPerformanceGraph(student, phone, coaching, { sendMessage: false });
      console.log('[WHATSAPP] Performance graph result:', graphResult);
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'performance',
        lastMessage: normalizedOption,
      });
      return true;
    } else if (normalizedOption === 'STUDENT_INFO') {
      console.log('Before STUDENT_INFO block');
      console.log('[HANDLER] Enter STUDENT_INFO');
      const notificationResult = await sendWhatsAppNotification({
        studentId: student.id,
        phone,
        type: 'parent_menu_student_profile',
        message: compactWhatsAppMessage([
          '👨‍🎓 Student Information',
          '',
          `Name: ${student.name || '-'}`,
          `Roll No: ${student.roll_no || '-'}`,
          `Batch: ${student.batch_name || '-'}`,
        ]),
        eventKey: `parent_menu_student_profile:${student.id}:${Date.now()}`,
      });
      console.log('[WHATSAPP] Student info result:', notificationResult);
      await saveParentSession({
        coachingId: student.coaching_id,
        studentId: student.id,
        phone,
        state: 'student_info',
        lastMessage: normalizedOption,
      });
      return true;
    }

    console.log('[HANDLER] No matching option:', normalizedOption);
    return false;
  } catch (error) {
    console.error('Parent Assistant Error', error);
    console.error(error.stack);
    return false;
  }
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
  findStudentByParentSession,
  generateFeeReceiptPdf,
  getCoachingByWhatsAppPhoneNumberId,
  handleParentAssistantMessage,
  sendLatestPaper,
  sendLatestResult,
  sendMonthlyParentReports,
  sendPerformanceGraph,
  verifyReceiptAccessToken,
  validatePublicUrl,
};
