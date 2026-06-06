const { run, get, all } = require('../db');

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || 'v23.0';
const GRAPH_API_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function cleanPhoneNumber(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  return input.replace(/[^\d]/g, '');
}

function normalizeStatus(value) {
  return String(value || 'pending').trim().toLowerCase().slice(0, 40);
}

function truncateMessage(value) {
  return String(value || '').slice(0, 4000);
}

function getEnvSettings() {
  return {
    accessToken: String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim(),
    phoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim(),
    businessAccountId: String(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '').trim(),
    verifyToken: String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim(),
  };
}

function normalizeSettings(row = null) {
  const env = getEnvSettings();
  return {
    accessToken: String(row?.access_token || env.accessToken || '').trim(),
    phoneNumberId: String(row?.phone_number_id || env.phoneNumberId || '').trim(),
    businessAccountId: String(row?.business_account_id || env.businessAccountId || '').trim(),
    verifyToken: String(row?.verify_token || env.verifyToken || '').trim(),
  };
}

async function ensureWhatsAppSchema() {
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(20)`);

  await run(`
    CREATE TABLE IF NOT EXISTS whatsapp_settings (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER NOT NULL UNIQUE,
      access_token TEXT,
      phone_number_id VARCHAR(80),
      business_account_id VARCHAR(80),
      verify_token VARCHAR(160),
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS whatsapp_logs (
      id SERIAL PRIMARY KEY,
      coaching_id INTEGER,
      student_id INTEGER,
      phone_number VARCHAR(20) NOT NULL,
      message_type VARCHAR(40) NOT NULL,
      message_content TEXT,
      status VARCHAR(40) NOT NULL DEFAULT 'pending',
      meta_message_id VARCHAR(160),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS whatsapp_logs_coaching_created_idx
    ON whatsapp_logs (coaching_id, created_at DESC)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS whatsapp_logs_meta_message_id_idx
    ON whatsapp_logs (meta_message_id)
  `);
}

async function getWhatsAppSettings(coachingId) {
  const row = coachingId
    ? await get(`SELECT * FROM whatsapp_settings WHERE coaching_id = ? LIMIT 1`, [coachingId])
    : null;
  return normalizeSettings(row);
}

async function saveWhatsAppSettings(coachingId, settings, updatedBy = null) {
  await run(
    `INSERT INTO whatsapp_settings (
      coaching_id, access_token, phone_number_id, business_account_id, verify_token, updated_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (coaching_id)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      phone_number_id = EXCLUDED.phone_number_id,
      business_account_id = EXCLUDED.business_account_id,
      verify_token = EXCLUDED.verify_token,
      updated_by = EXCLUDED.updated_by,
      updated_at = CURRENT_TIMESTAMP`,
    [
      coachingId,
      String(settings.accessToken || '').trim(),
      String(settings.phoneNumberId || '').trim(),
      String(settings.businessAccountId || '').trim(),
      String(settings.verifyToken || '').trim(),
      updatedBy,
    ]
  );
}

async function logWhatsAppMessage({
  coachingId = null,
  studentId = null,
  phoneNumber,
  messageType,
  messageContent = '',
  status = 'pending',
  metaMessageId = null,
}) {
  const result = await run(
    `INSERT INTO whatsapp_logs (
      coaching_id, student_id, phone_number, message_type, message_content, status, meta_message_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      coachingId,
      studentId,
      cleanPhoneNumber(phoneNumber),
      String(messageType || 'text').slice(0, 40),
      truncateMessage(messageContent),
      normalizeStatus(status),
      metaMessageId || null,
    ]
  );
  return result.lastID;
}

async function updateWhatsAppLogStatus(metaMessageId, status) {
  if (!metaMessageId || !status) return;
  await run(
    `UPDATE whatsapp_logs
     SET status = ?
     WHERE meta_message_id = ?`,
    [normalizeStatus(status), metaMessageId]
  );
}

async function sendMetaMessage({ settings, payload }) {
  if (!settings.accessToken || !settings.phoneNumberId) {
    throw new Error('WhatsApp access token and phone number ID are required');
  }

  const response = await fetch(`${GRAPH_API_BASE_URL}/${settings.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      ...payload,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || `WhatsApp API request failed with status ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.response = body;
    throw error;
  }

  return body;
}

async function sendTextMessage({ coachingId, studentId = null, to, message, settings = null }) {
  const phoneNumber = cleanPhoneNumber(to);
  const messageContent = String(message || '').trim();
  const logId = await logWhatsAppMessage({
    coachingId,
    studentId,
    phoneNumber,
    messageType: 'text',
    messageContent,
    status: 'pending',
  });

  try {
    const activeSettings = settings || await getWhatsAppSettings(coachingId);
    const response = await sendMetaMessage({
      settings: activeSettings,
      payload: {
        to: phoneNumber,
        type: 'text',
        text: {
          preview_url: false,
          body: messageContent,
        },
      },
    });
    const metaMessageId = response?.messages?.[0]?.id || null;
    await run(
      `UPDATE whatsapp_logs SET status = ?, meta_message_id = ? WHERE id = ?`,
      ['sent', metaMessageId, logId]
    );
    return { ok: true, metaMessageId, response };
  } catch (error) {
    await run(
      `UPDATE whatsapp_logs SET status = ?, message_content = ? WHERE id = ?`,
      ['failed', truncateMessage(`${messageContent}\n\nError: ${error.message}`), logId]
    );
    throw error;
  }
}

async function sendDocumentMessage({
  coachingId,
  studentId = null,
  to,
  documentUrl,
  filename,
  caption = '',
  settings = null,
}) {
  const phoneNumber = cleanPhoneNumber(to);
  const messageContent = caption || documentUrl;
  const logId = await logWhatsAppMessage({
    coachingId,
    studentId,
    phoneNumber,
    messageType: 'document',
    messageContent,
    status: 'pending',
  });

  try {
    const activeSettings = settings || await getWhatsAppSettings(coachingId);
    const response = await sendMetaMessage({
      settings: activeSettings,
      payload: {
        to: phoneNumber,
        type: 'document',
        document: {
          link: documentUrl,
          filename: filename || 'result.pdf',
          caption,
        },
      },
    });
    const metaMessageId = response?.messages?.[0]?.id || null;
    await run(
      `UPDATE whatsapp_logs SET status = ?, meta_message_id = ? WHERE id = ?`,
      ['sent', metaMessageId, logId]
    );
    return { ok: true, metaMessageId, response };
  } catch (error) {
    await run(
      `UPDATE whatsapp_logs SET status = ?, message_content = ? WHERE id = ?`,
      ['failed', truncateMessage(`${messageContent}\n\nError: ${error.message}`), logId]
    );
    throw error;
  }
}

async function sendTemplateMessage({
  coachingId,
  studentId = null,
  to,
  templateName,
  languageCode = 'en',
  components = [],
  settings = null,
}) {
  const phoneNumber = cleanPhoneNumber(to);
  const messageContent = `template:${templateName}`;
  const logId = await logWhatsAppMessage({
    coachingId,
    studentId,
    phoneNumber,
    messageType: 'template',
    messageContent,
    status: 'pending',
  });

  try {
    const activeSettings = settings || await getWhatsAppSettings(coachingId);
    const response = await sendMetaMessage({
      settings: activeSettings,
      payload: {
        to: phoneNumber,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      },
    });
    const metaMessageId = response?.messages?.[0]?.id || null;
    await run(
      `UPDATE whatsapp_logs SET status = ?, meta_message_id = ? WHERE id = ?`,
      ['sent', metaMessageId, logId]
    );
    return { ok: true, metaMessageId, response };
  } catch (error) {
    await run(
      `UPDATE whatsapp_logs SET status = ?, message_content = ? WHERE id = ?`,
      ['failed', truncateMessage(`${messageContent}\n\nError: ${error.message}`), logId]
    );
    throw error;
  }
}

async function sendBulkMessages({ coachingId, recipients, message, settings = null }) {
  const activeSettings = settings || await getWhatsAppSettings(coachingId);
  const summary = { sent: 0, failed: 0, results: [] };

  for (const recipient of recipients) {
    try {
      const result = await sendTextMessage({
        coachingId,
        studentId: recipient.studentId || recipient.id || null,
        to: recipient.phoneNumber || recipient.guardian_phone || recipient.contact_phone,
        message,
        settings: activeSettings,
      });
      summary.sent += 1;
      summary.results.push({ ok: true, recipient, metaMessageId: result.metaMessageId });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({ ok: false, recipient, error: error.message });
    }
  }

  return summary;
}

async function getRecentWhatsAppLogs(coachingId, limit = 25) {
  return all(
    `SELECT wl.*, u.roll_no, u.name
     FROM whatsapp_logs wl
     LEFT JOIN users u ON u.id = wl.student_id
     WHERE wl.coaching_id = ?
     ORDER BY wl.created_at DESC
     LIMIT ?`,
    [coachingId, limit]
  );
}

module.exports = {
  ensureWhatsAppSchema,
  getWhatsAppSettings,
  saveWhatsAppSettings,
  getRecentWhatsAppLogs,
  updateWhatsAppLogStatus,
  sendTextMessage,
  sendDocumentMessage,
  sendTemplateMessage,
  sendBulkMessages,
};
