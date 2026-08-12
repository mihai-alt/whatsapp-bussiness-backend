import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transporter;

const PROVIDER_PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false },
  googlemail: { host: 'smtp.gmail.com', port: 587, secure: false },
  outlook: { host: 'smtp.office365.com', port: 587, secure: false },
  hotmail: { host: 'smtp.office365.com', port: 587, secure: false },
  live: { host: 'smtp.office365.com', port: 587, secure: false },
  office365: { host: 'smtp.office365.com', port: 587, secure: false },
  yahoo: { host: 'smtp.mail.yahoo.com', port: 587, secure: false },
  ymail: { host: 'smtp.mail.yahoo.com', port: 587, secure: false },
};

function detectProviderFromEmail(email) {
  const domain = String(email || '')
    .split('@')[1]
    ?.toLowerCase();
  if (!domain) return null;
  if (domain === 'gmail.com' || domain === 'googlemail.com') return 'gmail';
  if (['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain)) return 'outlook';
  if (domain === 'yahoo.com' || domain.endsWith('.yahoo.com') || domain === 'ymail.com') return 'yahoo';
  return null;
}

export function resolveSmtpSettings() {
  const user = String(config.smtp.user || '').trim();
  const pass = String(config.smtp.pass || '').trim();
  const from = String(config.smtp.from || user || '').trim();
  const providerKey = String(config.smtp.provider || detectProviderFromEmail(user) || '')
    .trim()
    .toLowerCase();
  const preset = PROVIDER_PRESETS[providerKey] || null;

  const host = String(config.smtp.host || preset?.host || '').trim();
  const port = Number(config.smtp.port || preset?.port || 587);
  const secure = config.smtp.secure === true || port === 465 || preset?.secure === true;

  return { host, port, secure, user, pass, from, providerKey };
}

export function isSmtpConfigured() {
  const s = resolveSmtpSettings();
  return Boolean(s.host && s.user && s.pass);
}

function smtpNotConfiguredError() {
  const error = new Error(
    'Email sending is not configured. Set SMTP_HOST/SMTP_USER/SMTP_PASSWORD (or SMTP_PASS) and EMAIL_FROM in backend/.env, then restart the API.'
  );
  error.status = 503;
  error.code = 'SMTP_NOT_CONFIGURED';
  return error;
}

function getTransporter() {
  if (transporter) return transporter;
  if (!isSmtpConfigured()) throw smtpNotConfiguredError();

  const s = resolveSmtpSettings();
  transporter = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    requireTLS: !s.secure && s.port === 587,
    auth: {
      user: s.user,
      pass: s.pass,
    },
  });
  return transporter;
}

export async function sendEmail({ to, subject, text, html }) {
  if (!isSmtpConfigured()) throw smtpNotConfiguredError();

  const s = resolveSmtpSettings();
  const tx = getTransporter();

  try {
    const info = await tx.sendMail({
      from: s.from || s.user,
      to,
      subject,
      text,
      html,
    });
    // Do not log message body (may contain verification codes)
    console.log(`[email] delivered to ${to} via ${s.host} id=${info.messageId || 'n/a'}`);
    return { messageId: info.messageId };
  } catch (err) {
    console.error('[email] send failed:', err?.message || err);
    const error = new Error(
      `Failed to send email to ${to}. Check SMTP settings (${err.message || 'SMTP error'})`
    );
    error.status = 502;
    error.code = 'EMAIL_SEND_FAILED';
    throw error;
  }
}

export function resetEmailTransport() {
  transporter = undefined;
}
