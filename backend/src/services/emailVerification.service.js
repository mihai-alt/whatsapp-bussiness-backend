import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { hashToken, randomDigits } from '../utils/helpers.js';
import { sendEmail, isSmtpConfigured } from './email.service.js';
import { USER_PUBLIC_FIELDS } from '../constants/userFields.js';

export const CODE_TTL_MINUTES = 10;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_VERIFY_ATTEMPTS = 5;

export function isUserEmailVerified(user) {
  if (!user) return false;
  const flag = Number(user.email_verified);
  if (flag === 1) return true;
  if (user.email_verified === true || user.email_verified === '1') return true;
  // Require BOTH flag and timestamp only when flag is explicitly set;
  // never treat timestamp alone as verified if email_verified is 0.
  if (flag === 0) return false;
  const at = user.email_verified_at;
  return at != null && at !== '' && String(at) !== '0000-00-00 00:00:00';
}

async function sendVerificationEmail({ email, name, code }) {
  await sendEmail({
    to: email,
    subject: 'Your verification code',
    text: `Hi ${name},\n\nYour verification code is ${code}.\nIt expires in ${CODE_TTL_MINUTES} minutes.\n\nIf you did not create an account, ignore this email.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 8px">Verify your email</h2>
        <p style="margin:0 0 16px;color:#64748b">Hi ${name}, use this code to finish creating your account.</p>
        <div style="letter-spacing:8px;font-size:32px;font-weight:700;background:#f1f5f9;border-radius:12px;padding:16px 20px;text-align:center">${code}</div>
        <p style="margin:16px 0 0;color:#64748b;font-size:14px">This code expires in ${CODE_TTL_MINUTES} minutes.</p>
      </div>
    `,
  });
}

function assertSmtpReady() {
  if (!isSmtpConfigured()) {
    throw new AppError(
      'Email sending is not configured. Set SMTP_USER and SMTP_PASSWORD in backend/.env, then restart the API.',
      503,
      'SMTP_NOT_CONFIGURED'
    );
  }
}

function assertResendCooldown(lastSentAt) {
  if (!lastSentAt) return;
  const ageSec = (Date.now() - new Date(lastSentAt).getTime()) / 1000;
  if (Number.isFinite(ageSec) && ageSec < RESEND_COOLDOWN_SECONDS) {
    const retryAfter = Math.ceil(RESEND_COOLDOWN_SECONDS - ageSec);
    throw new AppError(
      `Please wait ${retryAfter}s before requesting another code`,
      429,
      'RESEND_COOLDOWN'
    );
  }
}

/** Store signup as pending only — no users row until email is verified. */
export async function startPendingSignup({ email, name, password }) {
  assertSmtpReady();

  const verified = await query(
    `SELECT id FROM users WHERE email = :email AND email_verified = 1 LIMIT 1`,
    { email }
  );
  if (verified.length) {
    throw new AppError('Email already registered', 409, 'EMAIL_EXISTS');
  }

  // Remove any leftover unverified user row (legacy) so they are not "registered"
  const legacy = await query(
    `SELECT id FROM users WHERE email = :email AND (email_verified = 0 OR email_verified IS NULL) LIMIT 1`,
    { email }
  );
  if (legacy.length) {
    await query(`DELETE FROM refresh_tokens WHERE user_id = :user_id`, { user_id: legacy[0].id });
    await query(`DELETE FROM email_verification_codes WHERE user_id = :user_id`, {
      user_id: legacy[0].id,
    });
    await query(`DELETE FROM users WHERE id = :id`, { id: legacy[0].id });
  }

  const existingPending = await query(
    `SELECT id, last_sent_at FROM pending_signups WHERE email = :email LIMIT 1`,
    { email }
  );
  if (existingPending.length) {
    assertResendCooldown(existingPending[0].last_sent_at);
  }

  const password_hash = await bcrypt.hash(password, 12);
  const code = randomDigits(6);
  const code_hash = hashToken(code);

  if (existingPending.length) {
    await query(
      `UPDATE pending_signups
       SET name = :name,
           password_hash = :password_hash,
           code_hash = :code_hash,
           attempts = 0,
           expires_at = DATE_ADD(NOW(), INTERVAL ${CODE_TTL_MINUTES} MINUTE),
           last_sent_at = NOW()
       WHERE email = :email`,
      { email, name, password_hash, code_hash }
    );
  } else {
    await query(
      `INSERT INTO pending_signups
        (email, name, password_hash, code_hash, attempts, expires_at, last_sent_at)
       VALUES
        (:email, :name, :password_hash, :code_hash, 0,
         DATE_ADD(NOW(), INTERVAL ${CODE_TTL_MINUTES} MINUTE), NOW())`,
      { email, name, password_hash, code_hash }
    );
  }

  await sendVerificationEmail({ email, name, code });

  return {
    email,
    requiresVerification: true,
    expiresInMinutes: CODE_TTL_MINUTES,
    message: `We sent a 6-digit verification code to ${email}. Check your inbox (and spam folder).`,
  };
}

export async function resendPendingVerification(email) {
  assertSmtpReady();

  const verified = await query(
    `SELECT id FROM users WHERE email = :email AND email_verified = 1 LIMIT 1`,
    { email }
  );
  if (verified.length) {
    return { message: 'Account is already verified. Please log in.' };
  }

  const pendingRows = await query(
    `SELECT id, email, name, password_hash, last_sent_at FROM pending_signups WHERE email = :email LIMIT 1`,
    { email }
  );
  if (!pendingRows.length) {
    // Legacy unverified user support
    const users = await query(
      `SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE email = :email LIMIT 1`,
      { email }
    );
    if (!users.length || isUserEmailVerified(users[0])) {
      return { message: 'If a signup is pending, a new code was sent.' };
    }
    // Convert legacy unverified user → pending then resend
    const u = users[0];
    const pw = await query(`SELECT password_hash FROM users WHERE id = :id LIMIT 1`, { id: u.id });
    await query(`DELETE FROM refresh_tokens WHERE user_id = :user_id`, { user_id: u.id });
    await query(`DELETE FROM email_verification_codes WHERE user_id = :user_id`, { user_id: u.id });
    await query(`DELETE FROM users WHERE id = :id`, { id: u.id });
    await query(
      `INSERT INTO pending_signups
        (email, name, password_hash, code_hash, attempts, expires_at, last_sent_at)
       VALUES
        (:email, :name, :password_hash, 'needs_resend', 0,
         DATE_ADD(NOW(), INTERVAL ${CODE_TTL_MINUTES} MINUTE), DATE_SUB(NOW(), INTERVAL 1 HOUR))`,
      { email: u.email, name: u.name, password_hash: pw[0].password_hash }
    );
    return resendPendingVerification(email);
  }

  const pending = pendingRows[0];
  assertResendCooldown(pending.last_sent_at);

  const code = randomDigits(6);
  const code_hash = hashToken(code);
  await query(
    `UPDATE pending_signups
     SET code_hash = :code_hash,
         attempts = 0,
         expires_at = DATE_ADD(NOW(), INTERVAL ${CODE_TTL_MINUTES} MINUTE),
         last_sent_at = NOW()
     WHERE id = :id`,
    { id: pending.id, code_hash }
  );
  await sendVerificationEmail({ email: pending.email, name: pending.name, code });

  return {
    email,
    expiresInMinutes: CODE_TTL_MINUTES,
    message: `A new verification code was sent to ${email}.`,
  };
}

export async function verifyPendingEmailCode({ email, code }) {
  const verifiedUsers = await query(
    `SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE email = :email AND email_verified = 1 LIMIT 1`,
    { email }
  );
  if (verifiedUsers.length) {
    return { alreadyVerified: true, user: verifiedUsers[0] };
  }

  const pendingRows = await query(
    `SELECT * FROM pending_signups WHERE email = :email LIMIT 1`,
    { email }
  );
  if (!pendingRows.length) {
    throw new AppError(
      'No pending signup found. Please register again to receive a verification code.',
      400,
      'NO_PENDING'
    );
  }

  const pending = pendingRows[0];
  if (pending.code_hash === 'needs_resend') {
    throw new AppError('Please request a new verification code.', 400, 'NO_CODE');
  }
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    throw new AppError('Verification code expired. Please request a new one.', 400, 'CODE_EXPIRED');
  }
  if (Number(pending.attempts) >= MAX_VERIFY_ATTEMPTS) {
    throw new AppError('Too many invalid attempts. Please request a new code.', 400, 'TOO_MANY_ATTEMPTS');
  }
  if (hashToken(code) !== pending.code_hash) {
    await query(`UPDATE pending_signups SET attempts = attempts + 1 WHERE id = :id`, {
      id: pending.id,
    });
    throw new AppError('Invalid verification code', 400, 'INVALID_CODE');
  }

  // Only NOW create the real registered user
  const countRows = await query('SELECT COUNT(*) AS c FROM users');
  const role = Number(countRows[0].c) === 0 ? 'admin' : 'member';

  // Clean any leftover unverified row
  await query(`DELETE FROM users WHERE email = :email AND email_verified = 0`, { email });

  const result = await query(
    `INSERT INTO users (email, password_hash, name, role, email_verified, email_verified_at)
     VALUES (:email, :password_hash, :name, :role, 1, NOW())`,
    {
      email: pending.email,
      password_hash: pending.password_hash,
      name: pending.name,
      role,
    }
  );
  await query(`DELETE FROM pending_signups WHERE id = :id`, { id: pending.id });

  try {
    const { ensureUserWallet } = await import('./wallet.service.js');
    await ensureUserWallet(result.insertId);
  } catch {
    /* wallet created lazily on first use */
  }

  const created = await query(
    `SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE id = :id LIMIT 1`,
    { id: result.insertId }
  );

  return { alreadyVerified: false, user: created[0] };
}

/** Login gate helpers */
export async function findPendingSignup(email) {
  const rows = await query(`SELECT * FROM pending_signups WHERE email = :email LIMIT 1`, { email });
  return rows[0] || null;
}
