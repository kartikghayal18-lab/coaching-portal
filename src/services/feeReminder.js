const { sendWhatsAppNotification } = require('./notificationService');
const { getStudentFeeSummary } = require('./feeStructure');

function formatDate(value) {
  if (!value) return '-';
  return String(value).slice(0, 10);
}

async function buildFeeReminderMessage({ student, fee, coaching, reminderType }) {
  const feeSummary = fee.feeSummary || await getStudentFeeSummary(student.coaching_id || coaching?.coaching_id || coaching?.id, student.id);
  return [
    `🏫 ${coaching?.name || 'SHIV CHHATRAPATI CLASSES'}`,
    '',
    '💰 Fee Reminder',
    '',
    `Student: ${student.name || student.roll_no}`,
    '',
    `Pending Amount: ₹${Number(feeSummary.pendingFee || fee.amount || 0).toFixed(2)}`,
    '',
    `Due Date: ${formatDate(fee.due_date)}`,
    '',
    'Reply FEES for complete details.',
  ].join('\n');
}

async function sendDueFeeReminder({ coachingId, student, fee, coaching, settings = null }) {
  return sendWhatsAppNotification({
    studentId: student.id,
    phone: student.parent_whatsapp_number || student.guardian_phone,
    type: 'fee_due_reminder',
    message: await buildFeeReminderMessage({ student: { ...student, coaching_id: coachingId }, fee, coaching, reminderType: 'due' }),
    eventKey: `fee_due_reminder:${student.id}:${fee.id || fee.fee_id}:${formatDate(fee.due_date)}`,
  });
}

async function sendOverdueReminder({ coachingId, student, fee, coaching, settings = null }) {
  return sendWhatsAppNotification({
    studentId: student.id,
    phone: student.parent_whatsapp_number || student.guardian_phone,
    type: 'fee_overdue_reminder',
    message: await buildFeeReminderMessage({ student: { ...student, coaching_id: coachingId }, fee, coaching, reminderType: 'overdue' }),
    eventKey: `fee_overdue_reminder:${student.id}:${fee.id || fee.fee_id}:${formatDate(fee.due_date)}`,
  });
}

module.exports = {
  sendDueFeeReminder,
  sendOverdueReminder,
};
