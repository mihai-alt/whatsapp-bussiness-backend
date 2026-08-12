/**
 * Contact Group access control (ownership + PRIVATE/SHARED + ACTIVE/INACTIVE).
 *
 * Naming note:
 * - contact_group_members  = contacts inside a group (existing)
 * - contact_group_access    = legacy optional grant table (not required for SHARED)
 *
 * SHARED means every authenticated Member in the org can view and use the group.
 * PRIVATE means only Admin + Owner.
 *
 * Single-business app: no business_id column. All authenticated users share one org.
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

/** View group metadata / contacts list */
export async function canViewContactGroup(user, group) {
  if (!user || !group) return false;
  if (isAdminUser(user)) return true;
  if (isGroupOwner(user, group)) return true;
  // SHARED: every Member can view / join (use) the group
  return isSharedGroup(group);
}

/** Edit name/description/status/access_mode; delete group */
export function canManageContactGroup(user, group) {
  if (!user || !group) return false;
  if (isAdminUser(user)) return true;
  return isGroupOwner(user, group);
}

/** Change access mode (Private ↔ Shared) — owner/admin only */
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
  return isSharedGroup(group);
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
 * Member: own groups OR any SHARED group in the org.
 */
export async function listViewableGroups(user) {
  const params = {};
  let where = '1=1';
  if (!isAdminUser(user)) {
    where += ` AND (g.created_by = :uid OR g.access_mode = 'SHARED')`;
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
     ORDER BY u.name ASC`,
    { group_id: groupId }
  );
}

export async function listShareableMembers(group) {
  return query(
    `SELECT u.id, u.name, u.email, u.role
     FROM users u
     WHERE u.role = 'member'
       AND u.is_active = 1
       AND u.id <> :owner_id
     ORDER BY u.name ASC`,
    { owner_id: group.created_by || 0 }
  );
}

export async function grantGroupAccess(group, targetUserId, actor) {
  assertCanManageContactGroupAccess(actor, group);
  if (!isSharedGroup(group)) {
    throw new AppError('Switch the group to Shared before granting access', 400, 'NOT_SHARED');
  }
  const uid = Number(targetUserId);
  if (!uid) throw new AppError('Invalid user', 400);
  if (Number(group.created_by) === uid) {
    throw new AppError('Owner already has access', 400, 'OWNER_ACCESS');
  }
  const users = await query(
    `SELECT id, role FROM users WHERE id = :id AND is_active = 1 LIMIT 1`,
    { id: uid }
  );
  if (!users.length) throw new AppError('User not found', 404);
  if (users[0].role === 'admin') {
    throw new AppError('Admins already have access to all groups', 400, 'ADMIN_ACCESS');
  }
  await query(
    `INSERT IGNORE INTO contact_group_access (group_id, user_id) VALUES (:group_id, :user_id)`,
    { group_id: group.id, user_id: uid }
  );
}

export async function revokeGroupAccess(group, targetUserId, actor) {
  assertCanManageContactGroupAccess(actor, group);
  if (Number(targetUserId) === Number(group.created_by)) {
    throw new AppError('Cannot remove the group owner', 400, 'OWNER_ACCESS');
  }
  await query(
    `DELETE FROM contact_group_access WHERE group_id = :group_id AND user_id = :user_id`,
    { group_id: group.id, user_id: targetUserId }
  );
}

export async function clearGroupAccess(groupId) {
  await query(`DELETE FROM contact_group_access WHERE group_id = :group_id`, {
    group_id: groupId,
  });
}

/** Group IDs where the member may add/remove contacts (owned + all SHARED ACTIVE). */
export async function listContactEditableGroupIds(user) {
  if (isAdminUser(user)) {
    const rows = await query(`SELECT id FROM contact_groups`);
    return rows.map((r) => Number(r.id));
  }
  const rows = await query(
    `SELECT g.id
     FROM contact_groups g
     WHERE g.created_by = :uid
        OR (g.access_mode = 'SHARED' AND g.status = 'ACTIVE')`,
    { uid: user.id }
  );
  return rows.map((r) => Number(r.id));
}
