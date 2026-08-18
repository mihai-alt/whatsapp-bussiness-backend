/**
 * Contact Group access control (ownership + PRIVATE/SHARED + per-member grants).
 *
 * - PRIVATE: Admin + Owner + users in contact_group_access
 * - SHARED: every authenticated Member (org-wide)
 * - Owners (and admins) may grant/revoke Members (never Admins) via contact_group_access
 * - Add-all grants every remaining active Member except the owner and administrators
 * - contact_group_members = contacts inside a group (phone numbers), not site users
 */
import { AppError } from '../middleware/error.js';
import { query } from '../db/pool.js';

export const GROUP_STATUS = Object.freeze({ ACTIVE: 'ACTIVE', INACTIVE: 'INACTIVE' });
export const GROUP_ACCESS_MODE = Object.freeze({ PRIVATE: 'PRIVATE', SHARED: 'SHARED' });

export function isAdminUser(user) {
  return user?.role === 'admin';
}

export function isGroupOwner(user, group) {
  return Boolean(user && group && Number(group.created_by) === Number(user.id));
}

export function normalizeGroupStatus(status) {
  const s = String(status || GROUP_STATUS.ACTIVE).toUpperCase();
  return s === GROUP_STATUS.INACTIVE ? GROUP_STATUS.INACTIVE : GROUP_STATUS.ACTIVE;
}

export function normalizeAccessMode(mode) {
  const m = String(mode || GROUP_ACCESS_MODE.PRIVATE).toUpperCase();
  return m === GROUP_ACCESS_MODE.SHARED ? GROUP_ACCESS_MODE.SHARED : GROUP_ACCESS_MODE.PRIVATE;
}

export function isGroupActive(group) {
  return normalizeGroupStatus(group?.status) === GROUP_STATUS.ACTIVE;
}

export function isSharedGroup(group) {
  return normalizeAccessMode(group?.access_mode) === GROUP_ACCESS_MODE.SHARED;
}

export async function hasExplicitGroupAccess(userId, groupId) {
  const uid = Number(userId);
  const gid = Number(groupId);
  if (!uid || !gid) return false;
  const rows = await query(
    `SELECT 1 AS ok FROM contact_group_access
     WHERE group_id = :group_id AND user_id = :user_id
     LIMIT 1`,
    { group_id: gid, user_id: uid }
  );
  return rows.length > 0;
}

/** View group metadata / contacts list */
export async function canViewContactGroup(user, group) {
  if (!user || !group) return false;
  if (isAdminUser(user)) return true;
  if (isGroupOwner(user, group)) return true;
  if (isSharedGroup(group)) return true;
  return hasExplicitGroupAccess(user.id, group.id);
}

/** Edit name/description/status/access_mode; delete group */
export function canManageContactGroup(user, group) {
  if (!user || !group) return false;
  if (isAdminUser(user)) return true;
  return isGroupOwner(user, group);
}

/** Grant/revoke Members — owner/admin only */
export function canManageContactGroupAccess(user, group) {
  return canManageContactGroup(user, group);
}

/** Assign contacts / use in campaigns / CSV target (must be ACTIVE) */
export async function canUseContactGroup(user, group) {
  if (!isGroupActive(group)) return false;
  return canViewContactGroup(user, group);
}

export async function canAddContactsToGroup(user, group) {
  return canUseContactGroup(user, group);
}

export async function canRemoveContactsFromGroup(user, group) {
  if (!user || !group) return false;
  if (isAdminUser(user) || isGroupOwner(user, group)) return true;
  if (!isGroupActive(group)) return false;
  return canViewContactGroup(user, group);
}

/** Contact edit: owner only — Admin may view/delete but not edit */
export function canEditContact(user, contact) {
  if (!user || !contact) return false;
  if (isAdminUser(user)) return false;
  return Number(contact.created_by) === Number(user.id);
}

/** Contact delete: Admin can delete any; Member only own */
export function canDeleteContact(user, contact) {
  if (!user || !contact) return false;
  if (isAdminUser(user)) return true;
  return Number(contact.created_by) === Number(user.id);
}

/** @deprecated prefer canEditContact / canDeleteContact */
export function canManageContact(user, contact) {
  return canEditContact(user, contact);
}

export function canManageResource(user, resource) {
  return canEditContact(user, resource);
}

export function assertCanManage(user, resource, label = 'resource') {
  if (label === 'group') {
    if (!canManageContactGroup(user, resource)) {
      throw new AppError(
        'Only the creator or an administrator can manage this group',
        403,
        'FORBIDDEN'
      );
    }
    return;
  }
  if (!canEditContact(user, resource)) {
    throw new AppError('Only the contact creator can edit this contact', 403, 'FORBIDDEN');
  }
}

export function assertCanEditContact(user, contact) {
  if (!canEditContact(user, contact)) {
    throw new AppError('Only the contact creator can edit this contact', 403, 'FORBIDDEN');
  }
}

export function assertCanDeleteContact(user, contact) {
  if (!canDeleteContact(user, contact)) {
    throw new AppError(
      'Only the contact creator or an administrator can delete this contact',
      403,
      'FORBIDDEN'
    );
  }
}

export async function assertCanViewContactGroup(user, group) {
  if (!(await canViewContactGroup(user, group))) {
    throw new AppError('You do not have access to this contact group', 403, 'FORBIDDEN');
  }
}

export async function assertCanAccessContactGroup(user, group) {
  return assertCanViewContactGroup(user, group);
}

export async function assertCanUseContactGroup(user, group) {
  if (!(await canViewContactGroup(user, group))) {
    throw new AppError('You do not have access to this contact group', 403, 'FORBIDDEN');
  }
  if (!isGroupActive(group)) {
    throw new AppError('This contact group is inactive', 400, 'GROUP_INACTIVE');
  }
}

export async function assertCanAddContactsToGroup(user, group) {
  await assertCanUseContactGroup(user, group);
}

export async function assertCanRemoveContactsFromGroup(user, group) {
  if (!(await canRemoveContactsFromGroup(user, group))) {
    throw new AppError(
      'You do not have permission to remove contacts from this group',
      403,
      'FORBIDDEN'
    );
  }
}

export function assertCanManageContactGroupAccess(user, group) {
  if (!canManageContactGroupAccess(user, group)) {
    throw new AppError(
      'Only the group owner or an administrator can manage group access',
      403,
      'FORBIDDEN'
    );
  }
}

export async function decorateGroupFlags(user, group, extras = {}) {
  const shared = isSharedGroup(group);
  const canView = await canViewContactGroup(user, group);
  const canManage = canManageContactGroup(user, group);
  const canManageAccess = canManageContactGroupAccess(user, group);
  const active = isGroupActive(group);
  const canUse = canView && active;
  const canRemoveContacts = await canRemoveContactsFromGroup(user, group);

  return {
    ...group,
    status: normalizeGroupStatus(group.status),
    access_mode: normalizeAccessMode(group.access_mode),
    can_view: canView,
    can_access: canView,
    can_manage: canManage,
    can_manage_access: canManageAccess,
    can_use: canUse,
    can_add_contacts: canUse,
    can_remove_contacts: canRemoveContacts,
    is_owner: isGroupOwner(user, group),
    shared_with_everyone: shared,
    ...extras,
  };
}

export async function withManageFlag(user, rows) {
  const out = [];
  for (const row of rows || []) {
    out.push(await decorateGroupFlags(user, row));
  }
  return out;
}

export async function loadContactGroupOrThrow(id) {
  const rows = await query(
    `SELECT g.*,
            u.name AS owner_name,
            u.email AS owner_email
     FROM contact_groups g
     LEFT JOIN users u ON u.id = g.created_by
     WHERE g.id = :id
     LIMIT 1`,
    { id }
  );
  if (!rows.length) throw new AppError('Group not found', 404, 'NOT_FOUND');
  return rows[0];
}

/** Groups IDs the user may assign contacts into / use (ACTIVE + view access). */
export async function assertCanUseGroupIds(user, groupIds) {
  const unique = [...new Set((groupIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  for (const gid of unique) {
    const group = await loadContactGroupOrThrow(gid);
    await assertCanUseContactGroup(user, group);
  }
  return unique;
}

/** @deprecated prefer assertCanUseGroupIds for assignment */
export async function assertCanManageGroupIds(user, groupIds) {
  return assertCanUseGroupIds(user, groupIds);
}

/**
 * List groups the user can view.
 * Admin: all.
 * Member: own groups OR SHARED OR explicitly granted via contact_group_access.
 */
export async function listViewableGroups(user) {
  const params = {};
  let where = '1=1';
  if (!isAdminUser(user)) {
    where += ` AND (
      g.created_by = :uid
      OR g.access_mode = 'SHARED'
      OR EXISTS (
        SELECT 1 FROM contact_group_access ca
        WHERE ca.group_id = g.id AND ca.user_id = :uid
      )
    )`;
    params.uid = user.id;
  }

  return query(
    `SELECT g.*,
            u.name AS owner_name,
            u.email AS owner_email,
            COUNT(DISTINCT m.contact_id) AS member_count,
            COUNT(DISTINCT a.user_id) AS access_count
     FROM contact_groups g
     LEFT JOIN users u ON u.id = g.created_by
     LEFT JOIN contact_group_members m ON m.group_id = g.id
     LEFT JOIN contact_group_access a ON a.group_id = g.id
     WHERE ${where}
     GROUP BY g.id
     ORDER BY g.id DESC`,
    params
  );
}

/**
 * Groups selectable for contact assign / campaign / import.
 * Same visibility as listViewableGroups, but ACTIVE only.
 */
export async function listUsableGroups(user) {
  const rows = await listViewableGroups(user);
  return rows.filter((g) => isGroupActive(g));
}

export async function listAccessibleGroups(user) {
  return listViewableGroups(user);
}

export async function listGroupAccessUsers(groupId) {
  return query(
    `SELECT u.id, u.name, u.email, u.role, a.created_at AS granted_at
     FROM contact_group_access a
     JOIN users u ON u.id = a.user_id
     WHERE a.group_id = :group_id
       AND u.role = 'member'
     ORDER BY u.name ASC`,
    { group_id: groupId }
  );
}

function skipGrantReason(group, user) {
  if (!user) return { code: 'NOT_FOUND', message: 'User not found' };
  if (!Number(user.is_active)) return { code: 'INACTIVE_USER', message: 'User is inactive' };
  if (user.role === 'admin') {
    return { code: 'ADMIN_ACCESS', message: 'Administrators already have access to all groups' };
  }
  if (user.role !== 'member') {
    return { code: 'NOT_MEMBER', message: 'Only site members can be added to a group' };
  }
  if (Number(group.created_by) === Number(user.id)) {
    return { code: 'OWNER_ACCESS', message: 'Owner already has access' };
  }
  return null;
}

/** Site members (non-admin) that can still be added to this group. */
export async function listShareableMembers(group) {
  return query(
    `SELECT u.id, u.name, u.email, u.role
     FROM users u
     WHERE u.role = 'member'
       AND u.is_active = 1
       AND u.id <> :owner_id
       AND NOT EXISTS (
         SELECT 1 FROM contact_group_access a
         WHERE a.group_id = :group_id AND a.user_id = u.id
       )
     ORDER BY u.name ASC`,
    { owner_id: group.created_by || 0, group_id: group.id }
  );
}

export async function getGroupAccessPayload(actor, group) {
  const [users, shareable, decorated] = await Promise.all([
    listGroupAccessUsers(group.id),
    listShareableMembers(group),
    decorateGroupFlags(actor, group),
  ]);
  return { group: decorated, users, shareable };
}

export async function grantGroupAccess(group, targetUserId, actor) {
  assertCanManageContactGroupAccess(actor, group);
  const uid = Number(targetUserId);
  if (!uid) throw new AppError('Invalid user', 400);
  const users = await query(
    `SELECT id, role, is_active FROM users WHERE id = :id LIMIT 1`,
    { id: uid }
  );
  if (!users.length) throw new AppError('User not found', 404, 'NOT_FOUND');
  const reason = skipGrantReason(group, users[0]);
  if (reason) throw new AppError(reason.message, 400, reason.code);
  await query(
    `INSERT IGNORE INTO contact_group_access (group_id, user_id) VALUES (:group_id, :user_id)`,
    { group_id: group.id, user_id: uid }
  );
  return uid;
}

/**
 * Grant many members at once. Admins, the owner, inactive users, and missing
 * ids are skipped instead of failing the whole batch.
 */
export async function grantGroupAccessMany(group, targetUserIds, actor) {
  assertCanManageContactGroupAccess(actor, group);
  const unique = [...new Set((targetUserIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  if (!unique.length) return { granted: [], skipped: [] };

  const placeholders = unique.map((_, i) => `:id${i}`).join(', ');
  const params = Object.fromEntries(unique.map((id, i) => [`id${i}`, id]));
  const users = await query(
    `SELECT id, role, is_active FROM users WHERE id IN (${placeholders})`,
    params
  );
  const byId = new Map(users.map((u) => [Number(u.id), u]));
  const granted = [];
  const skipped = [];

  for (const uid of unique) {
    const reason = skipGrantReason(group, byId.get(uid) || null);
    if (reason) {
      skipped.push({ userId: uid, ...reason });
      continue;
    }
    granted.push(uid);
  }

  if (granted.length) {
    const values = granted.map((_, i) => `(:group_id, :uid${i})`).join(', ');
    const insertParams = { group_id: group.id };
    granted.forEach((id, i) => {
      insertParams[`uid${i}`] = id;
    });
    await query(
      `INSERT IGNORE INTO contact_group_access (group_id, user_id) VALUES ${values}`,
      insertParams
    );
  }

  return { granted, skipped };
}

/** Add every remaining active site member except administrators and the owner. */
export async function grantAllEligibleMembers(group, actor) {
  assertCanManageContactGroupAccess(actor, group);
  const eligible = await listShareableMembers(group);
  if (!eligible.length) return { granted: [], skipped: [] };
  return grantGroupAccessMany(
    group,
    eligible.map((u) => u.id),
    actor
  );
}

export async function revokeGroupAccess(group, targetUserId, actor) {
  assertCanManageContactGroupAccess(actor, group);
  const uid = Number(targetUserId);
  if (!uid) throw new AppError('Invalid user', 400);
  if (Number(group.created_by) === uid) {
    throw new AppError('Cannot remove the group owner', 400, 'OWNER_ACCESS');
  }
  const users = await query(`SELECT id, role FROM users WHERE id = :id LIMIT 1`, {
    id: uid,
  });
  if (!users.length) throw new AppError('User not found', 404, 'NOT_FOUND');
  if (users[0].role === 'admin') {
    throw new AppError('Cannot revoke administrator access', 400, 'ADMIN_ACCESS');
  }
  const existing = await query(
    `SELECT 1 AS ok FROM contact_group_access
     WHERE group_id = :group_id AND user_id = :user_id
     LIMIT 1`,
    { group_id: group.id, user_id: uid }
  );
  if (!existing.length) {
    throw new AppError('Member is not in this group', 404, 'NOT_IN_GROUP');
  }
  await query(
    `DELETE FROM contact_group_access WHERE group_id = :group_id AND user_id = :user_id`,
    { group_id: group.id, user_id: uid }
  );
  return uid;
}

export async function clearGroupAccess(groupId) {
  await query(`DELETE FROM contact_group_access WHERE group_id = :group_id`, {
    group_id: groupId,
  });
}

/** Group IDs where the member may add/remove contacts (owned + SHARED + granted ACTIVE). */
export async function listContactEditableGroupIds(user) {
  if (isAdminUser(user)) {
    const rows = await query(`SELECT id FROM contact_groups`);
    return rows.map((r) => Number(r.id));
  }
  const rows = await query(
    `SELECT g.id
     FROM contact_groups g
     WHERE g.created_by = :uid
        OR (g.access_mode = 'SHARED' AND g.status = 'ACTIVE')
        OR EXISTS (
          SELECT 1 FROM contact_group_access ca
          WHERE ca.group_id = g.id AND ca.user_id = :uid
        )`,
    { uid: user.id }
  );
  return rows.map((r) => Number(r.id));
}
