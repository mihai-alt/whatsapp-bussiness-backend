import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { AppError } from './error.js';
import { query } from '../db/pool.js';
import { USER_PUBLIC_FIELDS } from '../constants/userFields.js';
import { isUserEmailVerified } from '../services/emailVerification.service.js';

export function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpires }
  );
}

export function signRefreshToken(user) {
  return jwt.sign({ sub: user.id }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpires,
  });
}

export async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');

    const payload = jwt.verify(token, config.jwt.accessSecret);
    const users = await query(
      `SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE id = :id LIMIT 1`,
      { id: payload.sub }
    );
    if (!users.length || !users[0].is_active || !isUserEmailVerified(users[0])) {
      throw new AppError('Unauthorized', 401, 'UNAUTHORIZED');
    }
    req.user = users[0];
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return next(new AppError('Invalid or expired token', 401, 'UNAUTHORIZED'));
    }
    next(err);
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('Forbidden', 403, 'FORBIDDEN'));
    }
    next();
  };
}
