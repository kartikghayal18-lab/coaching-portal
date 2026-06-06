const crypto = require('crypto');
const { run, get, all } = require('../db');
const { getWhatsAppSettings, sendTextMessage, sendDocumentMessage } = require('./whatsapp');

function cleanPhoneNumber(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

function buildEventKey({ studentId, type, message, eventKey }) {
  if (eventKey) return String(eventKey).trim();
  const hash = crypto.createHash('sha256').update(`${studentId}:${type}:${message}`).digest('hex').slice(0, 24);
  return `${studentId}:${type}:${hash}`;
}

async function ensureNotificationSchema() {
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(20)`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_whatsapp_number VARCHAR(20)`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS attendance_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS fee_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS result_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS test_paper_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS notice_alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  await run(`ALTER TABLE fees ADD COLUMN IF NOT EXISTS receipt_number VARCHAR(40)`);
  await run(`ALTER TABLE fees ADD COLUMN IF NOT EXISTS receipt_file_url TEXT`);
  await run(`ALTER TABLE fees ADD COLUMN IF NOT EXISTS receipt_storage_key TEXT`);
  await run(`ALTER TABLE fees ADD COLUMN IF NOT EXISTS receipt_storage_type VARCHAR(20)`);
  await run(`ALTER TABLE fees ADD COLUMN IF NOT EXISTS receipt_generated_at TIMESTAMPTZ`);

  await run(`
    CREATE TABLE IF NOT EXISTS notification_logs (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      student_id INTEGER NOT NULL,
      type VARCHAR(80) NOT NULL,
      message TEXT NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      phone_number VARCHAR(20),
      event_key VARCHAR(220) UNIQUE,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS notification_logs_student_type_idx
    ON notification_logs (student_id, type, created_at DESC)
  `);
}

function getToggleKeyForType(type) {
  const notificationType = String(type || '').trim();
  if (notificationType.startsWith('attendance_')) return 'attendanceAlertsEnabled';
  if (notificationType.startsWith('fee_')) return 'feeAlertsEnabled';
  if (notificationType.startsWith('test_result_')) return 'resultAlertsEnabled';
  if (notificationType.startsWith('test_paper_')) return 'testPaperAlertsEnabled';
  if (notificationType.startsWith('notice_') || notificationType === 'announcement') return 'noticeAlertsEnabled';
  return null;
}

async function getRecentNotificationLogs(coachingId, limit = 50) {
  return all(
    `SELECT nl.*, u.roll_no, u.name
     FROM notification_logs nl
     LEFT JOIN users u ON u.id = nl.student_id
     WHERE nl.coaching_id = ?
     ORDER BY COALESCE(nl.sent_at, nl.created_at) DESC
     LIMIT ?`,
    [coachingId, limit]
  );
}

async function sendWhatsAppNotification({
  studentId,
  phone,
  type,
  message,
  eventKey = null,
}) {
  const student = await get(
    `SELECT id, coaching_id, roll_no, name, contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number
     FROM users
     WHERE id = ? AND role = 'student'
     LIMIT 1`,
    [studentId]
  );

  if (!student) {
    return { ok: false, skipped: true, reason: 'Student not found' };
  }

  const resolvedPhone = cleanPhoneNumber(
    phone
    || student.parent_whatsapp_number
    || student.guardian_phone
    || student.whatsapp_number
    || student.contact_phone
  );
  const notificationType = String(type || 'whatsapp').trim();
  const notificationMessage = String(message || '').trim();
  const notificationEventKey = buildEventKey({
    studentId: student.id,
    type: notificationType,
    message: notificationMessage,
    eventKey,
  });
  const settings = await getWhatsAppSettings(student.coaching_id);
  const toggleKey = getToggleKeyForType(notificationType);
  if (toggleKey && settings[toggleKey] === false) {
    return { ok: false, skipped: true, reason: 'Notification type disabled' };
  }

  const existing = await get(
    `SELECT id, status
     FROM notification_logs
     WHERE event_key = ?
     LIMIT 1`,
    [notificationEventKey]
  );
  if (existing) {
    return { ok: true, skipped: true, duplicate: true, logId: existing.id, status: existing.status };
  }

  const logResult = await run(
    `INSERT INTO notification_logs (
      coaching_id, student_id, type, message, status, phone_number, event_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      student.coaching_id,
      student.id,
      notificationType,
      notificationMessage,
      'pending',
      resolvedPhone || null,
      notificationEventKey,
    ]
  );
  const logId = logResult.lastID;

  if (!resolvedPhone) {
    await run(
      `UPDATE notification_logs SET status = ? WHERE id = ?`,
      ['skipped', logId]
    );
    return { ok: false, skipped: true, reason: 'WhatsApp number missing', logId };
  }

  try {
    const result = await sendTextMessage({
      coachingId: student.coaching_id,
      studentId: student.id,
      to: resolvedPhone,
      message: notificationMessage,
      settings,
    });
    await run(
      `UPDATE notification_logs
       SET status = ?, sent_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      ['sent', logId]
    );
    return { ok: true, logId, metaMessageId: result.metaMessageId };
  } catch (error) {
    await run(
      `UPDATE notification_logs
       SET status = ?
       WHERE id = ?`,
      ['failed', logId]
    );
    throw error;
  }
}

async function sendDocumentNotification(
  studentId,
  phone,
  fileUrl,
  fileName,
  caption,
  options = {}
) {
  const student = await get(
    `SELECT id, coaching_id, roll_no, name, contact_phone, guardian_phone, whatsapp_number, parent_whatsapp_number
     FROM users
     WHERE id = ? AND role = 'student'
     LIMIT 1`,
    [studentId]
  );

  if (!student) {
    return { ok: false, skipped: true, reason: 'Student not found' };
  }

  const resolvedPhone = cleanPhoneNumber(phone);
  const notificationType = String(options.type || 'document').trim();
  const notificationMessage = String(caption || '').trim();
  const notificationEventKey = buildEventKey({
    studentId: student.id,
    type: notificationType,
    message: `${notificationMessage}:${fileUrl}:${fileName}`,
    eventKey: options.eventKey || null,
  });
  const settings = await getWhatsAppSettings(student.coaching_id);
  const toggleKey = getToggleKeyForType(notificationType);
  if (toggleKey && settings[toggleKey] === false) {
    return { ok: false, skipped: true, reason: 'Notification type disabled' };
  }

  const existing = await get(
    `SELECT id, status
     FROM notification_logs
     WHERE event_key = ?
     LIMIT 1`,
    [notificationEventKey]
  );
  if (existing) {
    return { ok: true, skipped: true, duplicate: true, logId: existing.id, status: existing.status };
  }

  const logResult = await run(
    `INSERT INTO notification_logs (
      coaching_id, student_id, type, message, status, phone_number, event_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      student.coaching_id,
      student.id,
      notificationType,
      notificationMessage || fileName || fileUrl,
      'pending',
      resolvedPhone || null,
      notificationEventKey,
    ]
  );
  const logId = logResult.lastID;

  if (!resolvedPhone) {
    await run(`UPDATE notification_logs SET status = ? WHERE id = ?`, ['skipped', logId]);
    return { ok: false, skipped: true, reason: 'WhatsApp number missing', logId };
  }

  if (!fileUrl) {
    await run(`UPDATE notification_logs SET status = ? WHERE id = ?`, ['failed', logId]);
    return { ok: false, skipped: true, reason: 'Document URL missing', logId };
  }

  try {
    const result = await sendDocumentMessage({
      coachingId: student.coaching_id,
      studentId: student.id,
      to: resolvedPhone,
      documentUrl: fileUrl,
      filename: fileName || 'paper.pdf',
      caption: notificationMessage,
      settings,
    });
    await run(
      `UPDATE notification_logs
       SET status = ?, sent_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      ['sent', logId]
    );
    return { ok: true, logId, metaMessageId: result.metaMessageId };
  } catch (error) {
    await run(
      `UPDATE notification_logs
       SET status = ?
       WHERE id = ?`,
      ['failed', logId]
    );
    throw error;
  }
}

module.exports = {
  ensureNotificationSchema,
  getRecentNotificationLogs,
  sendDocumentNotification,
  sendWhatsAppNotification,
};
