const {
  sendTextMessage,
  getWhatsAppSettings,
} = require('./whatsapp');

function formatDate(value) {
  if (!value) return '-';
  return String(value).slice(0, 10);
}

function buildFeeReminderMessage({ student, fee, coaching, reminderType }) {
  const heading = reminderType === 'overdue'
    ? 'This is a reminder that the following fee is overdue.'
    : 'This is a reminder for the upcoming fee due date.';

  return [
    'Dear Parent,',
    '',
    heading,
    '',
    `Student: ${student.name} (${student.roll_no})`,
    `Amount: Rs. ${Number(fee.amount || 0).toFixed(2)}`,
    `Due Date: ${formatDate(fee.due_date)}`,
    '',
    `Regards,`,
    coaching?.name || 'Coaching Institute',
  ].join('\n');
}

async function sendDueFeeReminder({ coachingId, student, fee, coaching, settings = null }) {
  if (!student.guardian_phone) {
    return { ok: false, skipped: true, reason: 'Guardian phone missing' };
  }

  return sendTextMessage({
    coachingId,
    studentId: student.id,
    to: student.guardian_phone,
    message: buildFeeReminderMessage({ student, fee, coaching, reminderType: 'due' }),
    settings: settings || await getWhatsAppSettings(coachingId),
  });
}

async function sendOverdueReminder({ coachingId, student, fee, coaching, settings = null }) {
  if (!student.guardian_phone) {
    return { ok: false, skipped: true, reason: 'Guardian phone missing' };
  }

  return sendTextMessage({
    coachingId,
    studentId: student.id,
    to: student.guardian_phone,
    message: buildFeeReminderMessage({ student, fee, coaching, reminderType: 'overdue' }),
    settings: settings || await getWhatsAppSettings(coachingId),
  });
}

module.exports = {
  sendDueFeeReminder,
  sendOverdueReminder,
};
