import { query } from '../db/pool.js';
import { AppError } from '../middleware/error.js';

let primaryCache = { id: null, checkedAt: 0 };
const PRIMARY_CACHE_MS = 60_000;

export function invalidatePrimaryAdminCache() {
  primaryCache = { id: null, checkedAt: 0 };
}

/** First registered account (lowest id) — immutable admin. */
export async function getPrimaryAdminId() {
  const now = Date.now();
  if (primaryCache.id != null && now - primaryCache.checkedAt < PRIMARY_CACHE_MS) {
    return primaryCache.id;
  }
  const rows = await query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
  const id = rows[0] ? Number(rows[0].id) : null;
  primaryCache = { id, checkedAt: now };
  return id;
}

export async function isPrimaryAdmin(userId) {
  const primaryId = await getPrimaryAdminId();
  return primaryId != null && Number(userId) === primaryId;
}

/** Keep the first signup as active admin if somehow altered. */
export async function ensurePrimaryAdminIntegrity() {
  const rows = await query(
    `SELECT id, role, is_active FROM users ORDER BY id ASC LIMIT 1`
  );
  if (!rows.length) {
    invalidatePrimaryAdminCache();
    return null;
  }
  const first = rows[0];
  const active = Number(first.is_active) === 1 || first.is_active === true;
  if (first.role !== 'admin' || !active) {
    await query(
      `UPDATE users SET role = 'admin', is_active = 1 WHERE id = :id`,
      { id: first.id }
    );
  }
  const id = Number(first.id);
  primaryCache = { id, checkedAt: Date.now() };
  return id;
}

/**
 * Nobody may change the first signup admin's role or status.
 * Name remains editable. Password of another admin is primary-only.
 */
export async function assertPrimaryAdminRoleStatusImmutable(userId, { role, is_active } = {}) {
  if (role === undefined && is_active === undefined) return;

  const rows = await query(
    `SELECT id, role, is_active FROM users ORDER BY id ASC LIMIT 1`
  );
  if (!rows.length) return;
  const primary = rows[0];
  if (Number(userId) !== Number(primary.id)) return;

  const currentActive = Number(primary.is_active) === 1 || primary.is_active === true;
  const roleChanging = role !== undefined && role !== primary.role;
  const statusChanging =
    is_active !== undefined && Boolean(is_active) !== currentActive;

  if (roleChanging || statusChanging) {
    throw new AppError(
      'The first administrator account role and status cannot be changed.',
      403,
      'PRIMARY_ADMIN_IMMUTABLE'
    );
  }
}

function isActiveFlag(value) {
  return Number(value) === 1 || value === true;
}

/**
 * Remaining admins cannot change another admin's role or status.
 * Only the first registered administrator may do that.
 */
export async function assertOnlyPrimaryAdminMayChangeAdminAuthority(
  actorId,
  target,
  { role, is_active } = {}
) {
  if (role === undefined && is_active === undefined) return;
  if (String(target?.role) !== 'admin') return;
  if (await isPrimaryAdmin(actorId)) return;

  const roleChanging = role !== undefined && role !== target.role;
  const statusChanging =
    is_active !== undefined && Boolean(is_active) !== isActiveFlag(target.is_active);

  if (roleChanging || statusChanging) {
    throw new AppError(
      "Only the first administrator can change another administrator's role or status.",
      403,
      'ADMIN_AUTHORITY_LOCKED'
    );
  }
}

/**
 * Remaining admins cannot manage another admin at all (name, password, role, status).
 * They may still edit themselves and members. Only the first admin may edit other admins.
 */
export async function assertOnlyPrimaryAdminMayManageOtherAdmin(actorId, target) {
  if (String(target?.role) !== 'admin') return;
  if (Number(actorId) === Number(target.id)) return;
  if (await isPrimaryAdmin(actorId)) return;

  throw new AppError(
    'Only the first administrator can manage another administrator.',
    403,
    'ADMIN_MANAGE_LOCKED'
  );
}

