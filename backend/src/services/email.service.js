import nodemailer from 'nodemailer';
import axios from 'axios';
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

export function isResendConfigured() {
  return Boolean(String(config.resend.apiKey || '').trim());
}

export function isSmtpConfigured() {
  const s = resolveSmtpSettings();
  return Boolean(s.host && s.user && s.pass);
}

/** True if either Resend (HTTPS) or classic SMTP is ready. */
export function isEmailConfigured() {
  return isResendConfigured() || isSmtpConfigured();
}

function emailNotConfiguredError() {
  const error = new Error(
    'Email sending is not configured. On Render Free set RESEND_API_KEY (SMTP ports are blocked). Locally you can use SMTP_USER/SMTP_PASSWORD instead.'
  );
  error.status = 503;
  error.code = 'SMTP_NOT_CONFIGURED';
  return error;
}

function getTransporter() {
  if (transporter) return transporter;
  if (!isSmtpConfigured()) throw emailNotConfiguredError();

  const s = resolveSmtpSettings();
  transporter = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    requireTLS: !s.secure && s.port === 587,
    // Render free instances often lack working IPv6; force IPv4 to avoid ENETUNREACH
    family: 4,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 20000,
    auth: {
      user: s.user,
      pass: s.pass,
    },
  });
  return transporter;
}

async function sendViaResend({ to, subject, text, html }) {
  const apiKey = String(config.resend.apiKey || '').trim();
  const from = String(config.resend.from || 'onboarding@resend.dev').trim();
  const { data } = await axios.post(
    'https://api.resend.com/emails',
    {
      from,
      to: [to],
      subject,
      text,
      html,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );
  return { messageId: data?.id || 'resend' };
}

async function sendViaSmtp({ to, subject, text, html }) {
  const s = resolveSmtpSettings();
  const tx = getTransporter();
  const info = await tx.sendMail({
    from: s.from || s.user,
    to,
    subject,
    text,
    html,
  });
  return { messageId: info.messageId };
}

export async function sendEmail({ to, subject, text, html }) {
  if (!isEmailConfigured()) throw emailNotConfiguredError();

  try {
    // Prefer Resend on cloud hosts where SMTP is blocked (Render Free).
    if (isResendConfigured()) {
      const info = await sendViaResend({ to, subject, text, html });
      console.log(`[email] delivered to ${to} via resend id=${info.messageId || 'n/a'}`);
      return info;
    }

    const s = resolveSmtpSettings();
    const info = await sendViaSmtp({ to, subject, text, html });
    console.log(`[email] delivered to ${to} via ${s.host} id=${info.messageId || 'n/a'}`);
    return info;
  } catch (err) {
    const detail =
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      err?.message ||
      'email error';
    console.error('[email] send failed:', detail);
    const error = new Error(`Failed to send email to ${to}. Check email settings (${detail})`);
    error.status = 502;
    error.code = 'EMAIL_SEND_FAILED';
    throw error;
  }
}

export function resetEmailTransport() {
  transporter = undefined;
}
