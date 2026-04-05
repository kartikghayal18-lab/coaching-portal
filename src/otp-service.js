const crypto = require('crypto');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const OTP_LENGTH = 6;
const OTP_TTL_MINUTES = 10;

function generateOtpCode() {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

function normalizePhoneNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

function maskEmail(value) {
  const email = String(value || '').trim();
  if (!email.includes('@')) return email;
  const [name, domain] = email.split('@');
  if (name.length <= 2) return `${name[0] || '*'}*@${domain}`;
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(name.length - 2, 1))}@${domain}`;
}

function maskPhone(value) {
  const phone = normalizePhoneNumber(value);
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return `+${digits}`;
  return `+${digits.slice(0, Math.max(digits.length - 4, 2)).replace(/\d/g, '*')}${digits.slice(-4)}`;
}

function smtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST
    && process.env.SMTP_PORT
    && process.env.SMTP_USER
    && process.env.SMTP_PASS
    && process.env.SMTP_FROM
  );
}

function twilioConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_FROM_NUMBER
  );
}

function getOtpChannelOptions({ email, contactPhone }) {
  const normalizedPhone = normalizePhoneNumber(contactPhone);

  return {
    email: {
      available: Boolean(email) && smtpConfigured(),
      value: String(email || '').trim().toLowerCase(),
      masked: maskEmail(email),
      reason: !email ? 'No email saved for this admin account' : (!smtpConfigured() ? 'SMTP is not configured yet' : null),
    },
    sms: {
      available: Boolean(normalizedPhone) && twilioConfigured(),
      value: normalizedPhone,
      masked: maskPhone(normalizedPhone),
      reason: !normalizedPhone ? 'No contact number saved for this admin account' : (!twilioConfigured() ? 'SMS provider is not configured yet' : null),
    },
  };
}

async function sendEmailOtp({ to, otpCode, adminName, className, purpose }) {
  const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const subject = `OTP for ${purpose === 'forgot-password' ? 'password reset' : 'password change'} - ${className}`;
  const text = [
    `Hello ${adminName},`,
    '',
    `Your Coaching Portal OTP is: ${otpCode}`,
    `This OTP is valid for ${OTP_TTL_MINUTES} minutes.`,
    '',
    `Class: ${className}`,
    '',
    'If you did not request this, please ignore this message.',
  ].join('\n');

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text,
  });
}

async function sendSmsOtp({ to, otpCode, className }) {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: process.env.TWILIO_FROM_NUMBER,
    to,
    body: `Your ${className} Coaching Portal OTP is ${otpCode}. Valid for ${OTP_TTL_MINUTES} minutes.`,
  });
}

async function sendOtpMessage({ channel, destination, otpCode, adminName, className, purpose }) {
  if (channel === 'email') {
    await sendEmailOtp({
      to: destination,
      otpCode,
      adminName,
      className,
      purpose,
    });
    return;
  }

  if (channel === 'sms') {
    await sendSmsOtp({
      to: destination,
      otpCode,
      className,
    });
    return;
  }

  throw new Error('Invalid OTP channel selected');
}

module.exports = {
  OTP_TTL_MINUTES,
  generateOtpCode,
  getOtpChannelOptions,
  sendOtpMessage,
};
