const crypto = require('crypto');
const dns = require('dns').promises;
const nodemailer = require('nodemailer');
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

function resendConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY
    && process.env.RESEND_FROM
  );
}

function getOtpChannelOptions({ email, contactPhone }) {
  const emailDeliveryConfigured = smtpConfigured() || resendConfigured();
  return {
    email: {
      available: Boolean(email) && emailDeliveryConfigured,
      value: String(email || '').trim().toLowerCase(),
      masked: maskEmail(email),
      reason: !email ? 'No email saved for this admin account' : (!emailDeliveryConfigured ? 'Email delivery is not configured yet' : null),
    },
    sms: {
      available: false,
      value: '',
      masked: '',
      reason: 'SMS OTP is disabled. Use email OTP.',
    },
  };
}

function getPurposeLabel(purpose) {
  if (purpose === 'forgot-password') return 'password reset';
  if (purpose === 'login-2fa') return 'sign in verification';
  if (purpose === 'settings-password-change') return 'password change';
  return 'security verification';
}

async function sendWithResend({ to, subject, text }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = String(process.env.RESEND_FROM || '').trim();

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
    }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || `Resend API failed with status ${response.status}`;
    const error = new Error(message);
    error.code = `RESEND_${response.status}`;
    error.responseCode = response.status;
    throw error;
  }

  return payload;
}

async function buildSmtpTransporter() {
  const smtpHost = String(process.env.SMTP_HOST || '').trim();
  const smtpPort = Number(process.env.SMTP_PORT || 0);
  const smtpUser = String(process.env.SMTP_USER || '').trim();
  const smtpPass = String(process.env.SMTP_PASS || '').replace(/\s+/g, '');
  const smtpFamily = Number(process.env.SMTP_FAMILY || 4);

  let resolvedHost = smtpHost;
  if (smtpHost) {
    try {
      const lookup = await dns.lookup(smtpHost, { family: smtpFamily === 6 ? 6 : 4 });
      resolvedHost = lookup.address || smtpHost;
    } catch {
      resolvedHost = smtpHost;
    }
  }

  const secureSetting = String(process.env.SMTP_SECURE || '').toLowerCase();
  const secure = secureSetting === 'true' || smtpPort === 465;

  return nodemailer.createTransport({
    host: resolvedHost,
    port: smtpPort,
    secure,
    family: Number.isInteger(smtpFamily) && (smtpFamily === 4 || smtpFamily === 6) ? smtpFamily : 4,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || 20000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 15000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 30000),
    tls: smtpHost ? { servername: smtpHost } : undefined,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });
}

async function sendEmailOtp({ to, otpCode, adminName, className, purpose }) {
  const purposeLabel = getPurposeLabel(purpose);
  const subject = `OTP for ${purposeLabel} - ${className}`;
  const text = [
    `Hello ${adminName},`,
    '',
    `Your Coaching Portal OTP is: ${otpCode}`,
    `This OTP is valid for ${OTP_TTL_MINUTES} minutes.`,
    '',
    `Purpose: ${purposeLabel}`,
    '',
    `Class: ${className}`,
    '',
    'If you did not request this, please ignore this message.',
  ].join('\n');

  if (resendConfigured()) {
    await sendWithResend({ to, subject, text });
    return;
  }

  const smtpFrom = String(process.env.SMTP_FROM || '').trim();
  const transporter = await buildSmtpTransporter();
  await transporter.sendMail({
    from: smtpFrom,
    to,
    subject,
    text,
  });
}

async function sendTestEmail({ to, subject, text }) {
  if (resendConfigured()) {
    return sendWithResend({ to, subject, text });
  }

  const smtpFrom = String(process.env.SMTP_FROM || '').trim();
  const transporter = await buildSmtpTransporter();
  await transporter.verify();
  const info = await transporter.sendMail({
    from: smtpFrom,
    to,
    subject,
    text,
  });
  return info;
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

  throw new Error('Only email OTP is enabled');
}

module.exports = {
  OTP_TTL_MINUTES,
  generateOtpCode,
  smtpConfigured,
  resendConfigured,
  getOtpChannelOptions,
  sendOtpMessage,
  sendTestEmail,
};
