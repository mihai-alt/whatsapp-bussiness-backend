import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';
import { asyncHandler, AppError } from '../middleware/error.js';
import {
  authenticate,
  signAccessToken,
  signRefreshToken,
  requireRole,
} from '../middleware/auth.js';
import { hashToken, randomToken } from '../utils/helpers.js';
import { sendEmail } from '../services/email.service.js';
import { config } from '../config.js';
import { USER_PUBLIC_FIELDS } from '../constants/userFields.js';
import {
  assertPrimaryAdminRoleStatusImmutable,
  ensurePrimaryAdminIntegrity,
  getPrimaryAdminId,
} from '../services/primaryAdmin.service.js';

const router = Router();

async function createSession(user) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  await storeRefreshToken(user.id, refreshToken);
  return { accessToken, refreshToken };
}

const avatarDir = path.resolve(config.uploadDir, 'avatars');
fs.mkdirSync(avatarDir, { recursive: true });

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, avatarDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
      cb(null, `user-${req.user.id}-${Date.now()}${safeExt}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype?.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(2).max(255),
});

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = registerSchema.parse(req.body);
    const email = body.email.toLowerCase();

    const existing = await query('SELECT id FROM users WHERE email = :email LIMIT 1', { email });
    if (existing.length) throw new AppError('Email already registered', 409, 'EMAIL_EXISTS');

    // Clear any leftover pending signup from the old email-code flow
    await query('DELETE FROM pending_signups WHERE email = :email', { email });

    // First account in the system is admin; everyone after is member
    const counts = await query('SELECT COUNT(*) AS c FROM users');
    const isFirstUser = Number(counts[0]?.c || 0) === 0;
    const role = isFirstUser ? 'admin' : 'member';

    const password_hash = await bcrypt.hash(body.password, 12);
    const result = await query(
      `INSERT INTO users (email, password_hash, name, role, email_verified, email_verified_at)
       VALUES (:email, :password_hash, :name, :role, 1, NOW())`,
      { email, password_hash, name: body.name, role }
    );

    if (isFirstUser) {
      await ensurePrimaryAdminIntegrity();
    }

    try {
      const { ensureUserWallet } = await import('../services/wallet.service.js');
      await ensureUserWallet(result.insertId);
    } catch {
      /* lazy */
    }

    const users = await query(`SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE id = :id LIMIT 1`, {
      id: result.insertId,
    });
    const tokens = await createSession(users[0]);

    res.status(201).json({
      success: true,
      data: { user: users[0], ...tokens },
    });
  })
);

router.post(
  '/verify-email',
  asyncHandler(async (_req, res) => {
    res.status(410).json({
      success: false,
      message: 'Email verification is no longer required. Please register or log in directly.',
      state: 'failed',
      error: { code: 'EMAIL_VERIFY_DISABLED', message: 'Email verification is disabled' },
    });
  })
);

router.post(
  '/resend-verification',
  asyncHandler(async (_req, res) => {
    res.status(410).json({
      success: false,
      message: 'Email verification is no longer required. Please register or log in directly.',
      state: 'failed',
      error: { code: 'EMAIL_VERIFY_DISABLED', message: 'Email verification is disabled' },
    });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1),
    });
    const body = schema.parse(req.body);
    const email = body.email.toLowerCase();

    const users = await query(
      `SELECT ${USER_PUBLIC_FIELDS}, password_hash FROM users WHERE email = :email LIMIT 1`,
      { email }
    );
    if (!users.length) throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');

    const user = users[0];
    if (!user.is_active) throw new AppError('Account disabled', 403, 'DISABLED');

    const ok = await bcrypt.compare(body.password, user.password_hash);
    if (!ok) throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');

    // Auto-mark legacy unverified accounts as verified (email codes disabled)
    if (!user.email_verified) {
      await query(
        `UPDATE users SET email_verified = 1, email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = :id`,
        { id: user.id }
      );
      user.email_verified = 1;
      user.email_verified_at = user.email_verified_at || new Date();
    }

    const { password_hash: _ph, ...safe } = user;
    const tokens = await createSession(safe);

    res.json({ success: true, data: { user: safe, ...tokens } });
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body || {};
    if (!refreshToken) throw new AppError('Refresh token required', 400);
    let payload;
    try {
      payload = jwt.verify(refreshToken, config.jwt.refreshSecret);
    } catch {
      throw new AppError('Invalid refresh token', 401, 'UNAUTHORIZED');
    }
    const tokenHash = hashToken(refreshToken);
    const rows = await query(
      `SELECT id FROM refresh_tokens WHERE user_id = :user_id AND token_hash = :token_hash AND expires_at > NOW() LIMIT 1`,
      { user_id: payload.sub, token_hash: tokenHash }
    );
    if (!rows.length) throw new AppError('Invalid refresh token', 401, 'UNAUTHORIZED');

    const users = await query(
      `SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE id = :id LIMIT 1`,
      { id: payload.sub }
    );
    if (!users.length || !users[0].is_active) {
      throw new AppError('Unauthorized', 401);
    }

    const accessToken = signAccessToken(users[0]);
    res.json({ success: true, data: { accessToken, user: users[0] } });
  })
);

router.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    const schema = z.object({ email: z.string().email() });
    const { email } = schema.parse(req.body);
    const users = await query('SELECT id, email, name FROM users WHERE email = :email LIMIT 1', {
      email: email.toLowerCase(),
    });
    // Always return success to avoid email enumeration
    if (users.length) {
      const token = randomToken();
      const token_hash = hashToken(token);
      await query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (:user_id, :token_hash, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
        { user_id: users[0].id, token_hash }
      );
      const resetUrl = `${config.appUrl}/reset-password?token=${token}`;
      await sendEmail({
        to: users[0].email,
        subject: 'Reset your password',
        text: `Hi ${users[0].name},\n\nReset your password: ${resetUrl}\n\nThis link expires in 1 hour.`,
        html: `<p>Hi ${users[0].name},</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in 1 hour.</p>`,
      });
    }
    res.json({ success: true, data: { message: 'If the email exists, a reset link was sent.' } });
  })
);

router.post(
  '/reset-password',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      token: z.string().min(10),
      password: z.string().min(8),
    });
    const body = schema.parse(req.body);
    const token_hash = hashToken(body.token);
    const rows = await query(
      `SELECT id, user_id FROM password_resets
       WHERE token_hash = :token_hash AND used_at IS NULL AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      { token_hash }
    );
    if (!rows.length) throw new AppError('Invalid or expired reset token', 400, 'INVALID_TOKEN');

    const password_hash = await bcrypt.hash(body.password, 12);
    await query('UPDATE users SET password_hash = :password_hash WHERE id = :id', {
      password_hash,
      id: rows[0].user_id,
    });
    await query('UPDATE password_resets SET used_at = NOW() WHERE id = :id', { id: rows[0].id });
    await query('DELETE FROM refresh_tokens WHERE user_id = :user_id', { user_id: rows[0].user_id });

    res.json({ success: true, data: { message: 'Password updated successfully' } });
  })
);

router.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(8),
    });
    const body = schema.parse(req.body);
    const users = await query('SELECT password_hash FROM users WHERE id = :id LIMIT 1', {
      id: req.user.id,
    });
    const ok = await bcrypt.compare(body.currentPassword, users[0].password_hash);
    if (!ok) throw new AppError('Current password is incorrect', 400);

    const password_hash = await bcrypt.hash(body.newPassword, 12);
    await query('UPDATE users SET password_hash = :password_hash WHERE id = :id', {
      password_hash,
      id: req.user.id,
    });
    res.json({ success: true, data: { message: 'Password changed' } });
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: { user: req.user } });
  })
);

router.patch(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(2).max(255).optional(),
      avatar_url: z.string().max(1024).nullable().optional(),
      phone: z.string().max(32).nullable().optional(),
      language: z.string().max(32).optional(),
      timezone: z.string().max(64).optional(),
      date_format: z.string().max(32).optional(),
      bio: z.string().max(2000).nullable().optional(),
    });
    const body = schema.parse(req.body);
    const fields = [];
    const params = { id: req.user.id };

    if (body.name !== undefined) {
      fields.push('name = :name');
      params.name = body.name;
    }
    if (body.avatar_url !== undefined) {
      fields.push('avatar_url = :avatar_url');
      params.avatar_url = body.avatar_url;
    }
    if (body.phone !== undefined) {
      fields.push('phone = :phone');
      params.phone = body.phone || null;
    }
    if (body.language !== undefined) {
      fields.push('language = :language');
      params.language = body.language;
    }
    if (body.timezone !== undefined) {
      fields.push('timezone = :timezone');
      params.timezone = body.timezone;
    }
    if (body.date_format !== undefined) {
      fields.push('date_format = :date_format');
      params.date_format = body.date_format;
    }
    if (body.bio !== undefined) {
      fields.push('bio = :bio');
      params.bio = body.bio || null;
    }

    if (fields.length) {
      await query(`UPDATE users SET ${fields.join(', ')} WHERE id = :id`, params);
    }

    const users = await query(
      `SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE id = :id LIMIT 1`,
      { id: req.user.id }
    );
    res.json({ success: true, data: { user: users[0] } });
  })
);

router.post(
  '/me/avatar',
  authenticate,
  (req, res, next) => {
    avatarUpload.single('avatar')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError('Avatar must be 2MB or smaller', 400, 'FILE_TOO_LARGE'));
        }
        return next(new AppError(err.message, 400, 'UPLOAD_ERROR'));
      }
      return next(err);
    });
  },
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('Avatar image is required', 400, 'FILE_REQUIRED');

    const users = await query('SELECT avatar_url FROM users WHERE id = :id LIMIT 1', {
      id: req.user.id,
    });
    const previous = users[0]?.avatar_url;
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;

    await query('UPDATE users SET avatar_url = :avatar_url WHERE id = :id', {
      avatar_url: avatarUrl,
      id: req.user.id,
    });

    // Remove previous local avatar file if we own it
    if (previous && String(previous).startsWith('/uploads/avatars/')) {
      const candidate = path.resolve(process.cwd(), previous.replace(/^\//, ''));
      try {
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      } catch {
        /* ignore cleanup errors */
      }
    }

    const updated = await query(
      `SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE id = :id LIMIT 1`,
      { id: req.user.id }
    );

    res.json({
      success: true,
      data: {
        user: updated[0],
        avatar_url: avatarUrl,
      },
    });
  })
);

router.delete(
  '/me/avatar',
  authenticate,
  asyncHandler(async (req, res) => {
    const users = await query('SELECT avatar_url FROM users WHERE id = :id LIMIT 1', {
      id: req.user.id,
    });
    const previous = users[0]?.avatar_url;

    await query('UPDATE users SET avatar_url = NULL WHERE id = :id', { id: req.user.id });

    if (previous && String(previous).startsWith('/uploads/avatars/')) {
      const candidate = path.resolve(process.cwd(), previous.replace(/^\//, ''));
      try {
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      } catch {
        /* ignore */
      }
    }

    const updated = await query(
      `SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE id = :id LIMIT 1`,
      { id: req.user.id }
    );
    res.json({ success: true, data: { user: updated[0] } });
  })
);

router.get(
  '/users',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    await ensurePrimaryAdminIntegrity();
    const primaryAdminId = await getPrimaryAdminId();
    const rows = await query(
      `SELECT ${USER_PUBLIC_FIELDS}, created_at FROM users ORDER BY id ASC`
    );
    const data = rows.map((u) => ({
      ...u,
      is_primary_admin: Number(u.id) === Number(primaryAdminId),
    }));
    res.json({ success: true, data });
  })
);

router.post(
  '/users',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      email: z.string().email(),
      name: z.string().min(2).max(255),
      password: z.string().min(8),
      role: z.enum(['admin', 'member']).default('member'),
      is_active: z.boolean().optional().default(true),
    });
    const body = schema.parse(req.body);
    const email = body.email.toLowerCase();

    const existing = await query('SELECT id FROM users WHERE email = :email LIMIT 1', { email });
    if (existing.length) throw new AppError('Email already registered', 409, 'EMAIL_EXISTS');

    const password_hash = await bcrypt.hash(body.password, 12);
    const result = await query(
      `INSERT INTO users (email, password_hash, name, role, is_active, email_verified, email_verified_at)
       VALUES (:email, :password_hash, :name, :role, :is_active, 1, NOW())`,
      {
        email,
        password_hash,
        name: body.name,
        role: body.role,
        is_active: body.is_active ? 1 : 0,
      }
    );

    try {
      const { ensureUserWallet } = await import('../services/wallet.service.js');
      await ensureUserWallet(result.insertId);
    } catch {
      /* lazy */
    }

    const created = await query(
      `SELECT ${USER_PUBLIC_FIELDS}, created_at FROM users WHERE id = :id LIMIT 1`,
      { id: result.insertId }
    );
    res.status(201).json({ success: true, data: { user: created[0] } });
  })
);

router.patch(
  '/users/:id',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId < 1) {
      throw new AppError('Invalid user id', 400, 'INVALID_ID');
    }

    const schema = z.object({
      name: z.string().min(2).max(255).optional(),
      role: z.enum(['admin', 'member']).optional(),
      is_active: z.boolean().optional(),
      password: z.string().min(8).optional(),
    });
    const body = schema.parse(req.body);

    const targets = await query(
      `SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE id = :id LIMIT 1`,
      { id: userId }
    );
    if (!targets.length) throw new AppError('User not found', 404, 'NOT_FOUND');
    const target = targets[0];

    await assertPrimaryAdminRoleStatusImmutable(userId, {
      role: body.role,
      is_active: body.is_active,
    });

    const nextRole = body.role ?? target.role;
    const nextActive = body.is_active !== undefined ? body.is_active : !!target.is_active;

    const demotingAdmin = target.role === 'admin' && nextRole === 'member';
    const deactivatingAdmin = target.role === 'admin' && target.is_active && !nextActive;
    if (demotingAdmin || deactivatingAdmin) {
      const adminCount = await query(
        `SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1`
      );
      if (Number(adminCount[0].c) <= 1) {
        throw new AppError(
          'Cannot demote or deactivate the last admin. Promote another user first.',
          400,
          'LAST_ADMIN'
        );
      }
    }

    const fields = [];
    const params = { id: userId };
    if (body.name !== undefined) {
      fields.push('name = :name');
      params.name = body.name;
    }
    if (body.role !== undefined) {
      fields.push('role = :role');
      params.role = body.role;
    }
    if (body.is_active !== undefined) {
      fields.push('is_active = :is_active');
      params.is_active = body.is_active ? 1 : 0;
    }
    if (body.password) {
      fields.push('password_hash = :password_hash');
      params.password_hash = await bcrypt.hash(body.password, 12);
    }

    if (!fields.length) {
      throw new AppError('No changes provided', 400, 'NO_CHANGES');
    }

    await query(`UPDATE users SET ${fields.join(', ')} WHERE id = :id`, params);

    if (body.is_active === false) {
      await query('DELETE FROM refresh_tokens WHERE user_id = :user_id', { user_id: userId });
    }

    const primaryAdminId = await getPrimaryAdminId();
    const updated = await query(
      `SELECT ${USER_PUBLIC_FIELDS}, created_at FROM users WHERE id = :id LIMIT 1`,
      { id: userId }
    );
    res.json({
      success: true,
      data: {
        user: {
          ...updated[0],
          is_primary_admin: Number(updated[0].id) === Number(primaryAdminId),
        },
      },
    });
  })
);

router.patch(
  '/users/:id/role',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId < 1) {
      throw new AppError('Invalid user id', 400, 'INVALID_ID');
    }

    const schema = z.object({
      role: z.enum(['admin', 'member']),
    });
    const { role } = schema.parse(req.body);

    const targets = await query(
      `SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE id = :id LIMIT 1`,
      { id: userId }
    );
    if (!targets.length) throw new AppError('User not found', 404, 'NOT_FOUND');
    const target = targets[0];

    if (target.role === role) {
      return res.json({ success: true, data: { user: target } });
    }

    await assertPrimaryAdminRoleStatusImmutable(userId, { role });

    if (target.role === 'admin' && role === 'member') {
      const adminCount = await query(
        `SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND is_active = 1`
      );
      if (Number(adminCount[0].c) <= 1) {
        throw new AppError(
          'Cannot demote the last admin. Promote another user first.',
          400,
          'LAST_ADMIN'
        );
      }
    }

    await query('UPDATE users SET role = :role WHERE id = :id', {
      role,
      id: userId,
    });

    try {
      await query(
        `INSERT INTO audit_logs (user_id, action, meta, ip)
         VALUES (:user_id, :action, :meta, :ip)`,
        {
          user_id: req.user.id,
          action: 'user.role_changed',
          meta: JSON.stringify({
            targetUserId: userId,
            from: target.role,
            to: role,
          }),
          ip: req.ip || null,
        }
      );
    } catch {
      /* audit is best-effort */
    }

    const primaryAdminId = await getPrimaryAdminId();
    const updated = await query(
      `SELECT ${USER_PUBLIC_FIELDS}, created_at FROM users WHERE id = :id LIMIT 1`,
      { id: userId }
    );
    res.json({
      success: true,
      data: {
        user: {
          ...updated[0],
          is_primary_admin: Number(updated[0].id) === Number(primaryAdminId),
        },
      },
    });
  })
);

async function storeRefreshToken(userId, refreshToken) {
  const token_hash = hashToken(refreshToken);
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES (:user_id, :token_hash, DATE_ADD(NOW(), INTERVAL 7 DAY))`,
    { user_id: userId, token_hash }
  );
}

export default router;
