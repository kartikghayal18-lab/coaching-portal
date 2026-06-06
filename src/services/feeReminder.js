const { sendWhatsAppNotification } = require('./notificationService');

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
  return sendWhatsAppNotification({
    studentId: student.id,
    phone: student.parent_whatsapp_number || student.guardian_phone,
    type: 'fee_due_reminder',
    message: buildFeeReminderMessage({ student, fee, coaching, reminderType: 'due' }),
    eventKey: `fee_due_reminder:${student.id}:${fee.id || fee.fee_id}:${formatDate(fee.due_date)}`,
  });
}

async function sendOverdueReminder({ coachingId, student, fee, coaching, settings = null }) {
  return sendWhatsAppNotification({
    studentId: student.id,
    phone: student.parent_whatsapp_number || student.guardian_phone,
    type: 'fee_overdue_reminder',
    message: buildFeeReminderMessage({ student, fee, coaching, reminderType: 'overdue' }),
    eventKey: `fee_overdue_reminder:${student.id}:${fee.id || fee.fee_id}:${formatDate(fee.due_date)}`,
  });
}

module.exports = {
  sendDueFeeReminder,
  sendOverdueReminder,
};
