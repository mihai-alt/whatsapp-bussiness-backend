import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { stringify } from 'csv-stringify/sync';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/error.js';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { normalizePhone, parseJson } from '../utils/helpers.js';
import { parseSpreadsheetFile } from '../utils/spreadsheet.js';
import {
  isAdminUser,
  canEditContact,
  canDeleteContact,
  canViewContactGroup,
  assertCanManage,
  assertCanEditContact,
  assertCanDeleteContact,
  assertCanViewContactGroup,
  assertCanUseContactGroup,
  assertCanAddContactsToGroup,
  assertCanRemoveContactsFromGroup,
  assertCanManageContactGroupAccess,
  assertCanUseGroupIds,
  withManageFlag,
  decorateGroupFlags,
  loadContactGroupOrThrow,
  listViewableGroups,
  listUsableGroups,
  listGroupAccessUsers,
  listShareableMembers,
  grantGroupAccess,
  revokeGroupAccess,
  clearGroupAccess,
  listContactEditableGroupIds,
  GROUP_ACCESS_MODE,
  normalizeGroupStatus,
  normalizeAccessMode,
} from '../services/contactAccess.service.js';
import { notifyProjectEvent } from '../services/notification.service.js';
import { emitWorkspaceChanged } from '../realtime.js';

const router = Router();
router.use(authenticate);

const uploadDir = path.resolve(config.uploadDir);
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 20 * 1024 * 1024 } });

function withContactManageFlag(user, rows) {
  return (rows || []).map((row) => {
    const canEdit = canEditContact(user, row);
    const canDelete = canDeleteContact(user, row);
    return {
      ...row,
      can_edit: canEdit,
      can_delete: canDelete,
      // Backward-compatible: UI historically used can_manage for edit actions
      can_manage: canEdit,
    };
  });
}

async function attachGroups(contacts, user) {
  if (!contacts?.length) return contacts;
  const ids = contacts.map((c) => Number(c.id)).filter(Boolean);
  if (!ids.length) {
    contacts.forEach((c) => {
      c.groups = [];
    });
    return contacts;
  }
  const placeholders = ids.map((_, i) => `:id${i}`).join(', ');
  const params = {};
  ids.forEach((id, i) => {
    params[`id${i}`] = id;
  });
  const memberships = await query(
    `SELECT cgm.contact_id, g.id, g.name, g.created_by, g.status, g.access_mode
     FROM contact_group_members cgm
     JOIN contact_groups g ON g.id = cgm.group_id
     WHERE cgm.contact_id IN (${placeholders})
     ORDER BY g.name ASC`,
    params
  );
  const byContact = new Map();
  for (const row of memberships) {
    if (!(await canViewContactGroup(user, row))) continue;
    const flags = await decorateGroupFlags(user, row);
    const list = byContact.get(row.contact_id) || [];
    list.push({
      id: row.id,
      name: row.name,
      created_by: row.created_by,
      status: flags.status,
      access_mode: flags.access_mode,
      can_manage: flags.can_manage,
      can_use: flags.can_use,
    });
    byContact.set(row.contact_id, list);
  }
  contacts.forEach((c) => {
    c.groups = byContact.get(c.id) || [];
  });
  return contacts;
}

async function syncContactGroups(contactId, groupIds, user) {
  const unique = await assertCanUseGroupIds(user, groupIds);

  // Only rewrite memberships in groups the user is allowed to assign (ACTIVE + access).
  // Memberships in inaccessible / inactive groups are left untouched.
  let scopeIds;
  if (isAdminUser(user)) {
    const active = await query(`SELECT id FROM contact_groups WHERE status = 'ACTIVE'`);
    scopeIds = active.map((r) => Number(r.id));
  } else {
    scopeIds = await listContactEditableGroupIds(user);
  }

  if (scopeIds.length) {
    const placeholders = scopeIds.map((_, i) => `:gid${i}`).join(', ');
    const params = { contact_id: contactId };
    scopeIds.forEach((id, i) => {
      params[`gid${i}`] = id;
    });
    await query(
      `DELETE FROM contact_group_members
       WHERE contact_id = :contact_id AND group_id IN (${placeholders})`,
      params
    );
  }

  for (const gid of unique) {
    await query(
      `INSERT IGNORE INTO contact_group_members (group_id, contact_id) VALUES (:group_id, :contact_id)`,
      { group_id: gid, contact_id: contactId }
    );
  }
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page || 1);
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const groupId = req.query.groupId;
    const params = { limit, offset };
    let where = '1=1';
    let join = '';
    if (search) {
      where +=
        ' AND (c.name LIKE :search OR c.phone LIKE :search OR c.phone_normalized LIKE :search OR c.email LIKE :search)';
      params.search = `%${search}%`;
    }
    if (groupId) {
      const group = await loadContactGroupOrThrow(groupId);
      await assertCanViewContactGroup(req.user, group);
      join = 'JOIN contact_group_members cgm ON cgm.contact_id = c.id';
      where += ' AND cgm.group_id = :groupId';
      params.groupId = groupId;
    }
    const rows = await query(
      `SELECT c.* FROM contacts c ${join} WHERE ${where} ORDER BY c.id DESC LIMIT :limit OFFSET :offset`,
      params
    );
    rows.forEach((r) => {
      r.custom_fields = parseJson(r.custom_fields, {});
    });
    await attachGroups(rows, req.user);
    const countRows = await query(
      `SELECT COUNT(*) AS c FROM contacts c ${join} WHERE ${where}`,
      params
    );
    res.json({
      success: true,
      data: { rows: withContactManageFlag(req.user, rows), total: countRows[0].c, page, limit },
    });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).max(255).transform((s) => s.trim()),
      phone: z.string().min(6),
      email: z.string().email().optional().nullable(),
      customFields: z.record(z.any()).optional(),
      groupIds: z.array(z.coerce.number().int().positive()).optional(),
    });
    const body = schema.parse(req.body);
    const phone_normalized = normalizePhone(body.phone);
    if (!phone_normalized) throw new AppError('Invalid phone number', 400);

    const dup = await query(
      'SELECT id FROM contacts WHERE phone_normalized = :phone_normalized LIMIT 1',
      { phone_normalized }
    );
    if (dup.length) throw new AppError('Duplicate contact phone number', 409, 'DUPLICATE_CONTACT');

    if (body.groupIds?.length) {
      await assertCanUseGroupIds(req.user, body.groupIds);
    }

    const result = await query(
      `INSERT INTO contacts (name, phone, phone_normalized, email, custom_fields, created_by)
       VALUES (:name, :phone, :phone_normalized, :email, :custom_fields, :created_by)`,
      {
        name: body.name,
        phone: body.phone,
        phone_normalized,
        email: body.email || null,
        custom_fields: JSON.stringify(body.customFields || {}),
        created_by: req.user.id,
      }
    );

    if (body.groupIds?.length) {
      await syncContactGroups(result.insertId, body.groupIds, req.user);
    }

    const rows = await query('SELECT * FROM contacts WHERE id = :id', { id: result.insertId });
    rows[0].custom_fields = parseJson(rows[0].custom_fields, {});
    await attachGroups(rows, req.user);

    await notifyProjectEvent({
      type: 'contact_created',
      title: 'Contact created',
      body: `${req.user.name || 'A user'} created contact "${body.name}" (${body.phone}).`,
      meta: { contactId: result.insertId, createdBy: req.user.id },
      actorUserId: req.user.id,
    });
    emitWorkspaceChanged({
      resource: 'contacts',
      action: 'created',
      actorUserId: req.user.id,
      entityId: result.insertId,
      meta: { groupIds: body.groupIds || [] },
    });
    if (body.groupIds?.length) {
      emitWorkspaceChanged({
        resource: 'groups',
        action: 'updated',
        actorUserId: req.user.id,
        meta: { reason: 'members_changed', groupIds: body.groupIds },
      });
    }

    res.status(201).json({ success: true, data: withContactManageFlag(req.user, rows)[0] });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).max(255).transform((s) => s.trim()).optional(),
      phone: z.string().min(6).optional(),
      email: z.string().email().nullable().optional(),
      customFields: z.record(z.any()).optional(),
      groupIds: z.array(z.coerce.number().int().positive()).optional(),
    });
    const body = schema.parse(req.body);
    const existing = await query('SELECT * FROM contacts WHERE id = :id LIMIT 1', {
      id: req.params.id,
    });
    if (!existing.length) throw new AppError('Contact not found', 404);
    assertCanEditContact(req.user, existing[0]);

    let phone_normalized = existing[0].phone_normalized;
    let phone = existing[0].phone;
    if (body.phone) {
      phone = body.phone;
      phone_normalized = normalizePhone(body.phone);
      const dup = await query(
        'SELECT id FROM contacts WHERE phone_normalized = :phone_normalized AND id <> :id LIMIT 1',
        { phone_normalized, id: req.params.id }
      );
      if (dup.length) throw new AppError('Duplicate contact phone number', 409, 'DUPLICATE_CONTACT');
    }

    await query(
      `UPDATE contacts SET
        name = COALESCE(:name, name),
        phone = :phone,
        phone_normalized = :phone_normalized,
        email = COALESCE(:email, email),
        custom_fields = COALESCE(:custom_fields, custom_fields)
       WHERE id = :id`,
      {
        id: req.params.id,
        name: body.name || null,
        phone,
        phone_normalized,
        email: body.email !== undefined ? body.email : null,
        custom_fields: body.customFields ? JSON.stringify(body.customFields) : null,
      }
    );

    if (body.groupIds !== undefined) {
      await syncContactGroups(req.params.id, body.groupIds, req.user);
    }

    const rows = await query('SELECT * FROM contacts WHERE id = :id', { id: req.params.id });
    rows[0].custom_fields = parseJson(rows[0].custom_fields, {});
    await attachGroups(rows, req.user);
    emitWorkspaceChanged({
      resource: 'contacts',
      action: 'updated',
      actorUserId: req.user.id,
      entityId: Number(req.params.id),
    });
    if (body.groupIds !== undefined) {
      emitWorkspaceChanged({
        resource: 'groups',
        action: 'updated',
        actorUserId: req.user.id,
        meta: { reason: 'members_changed' },
      });
    }
    res.json({ success: true, data: withContactManageFlag(req.user, rows)[0] });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT id, created_by FROM contacts WHERE id = :id LIMIT 1', {
      id: req.params.id,
    });
    if (!existing.length) throw new AppError('Contact not found', 404);
    assertCanDeleteContact(req.user, existing[0]);

    await query('DELETE FROM contacts WHERE id = :id', { id: req.params.id });
    emitWorkspaceChanged({
      resource: 'contacts',
      action: 'deleted',
      actorUserId: req.user.id,
      entityId: Number(req.params.id),
    });
    emitWorkspaceChanged({
      resource: 'groups',
      action: 'updated',
      actorUserId: req.user.id,
      meta: { reason: 'members_changed' },
    });
    res.json({ success: true, data: { message: 'Deleted' } });
  })
);

router.post(
  '/import',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('CSV or XLSX file required', 400);
    const groupId = req.body.groupId ? Number(req.body.groupId) : null;
    if (groupId) {
      const group = await loadContactGroupOrThrow(groupId);
      await assertCanUseContactGroup(req.user, group);
    }
    const records = await parseSpreadsheetFile(req.file);
    let imported = 0;
    let duplicates = 0;
    let errors = 0;

    for (const row of records) {
      try {
        const name = row.Name || row.name || row.NAME || '';
        const phone = row.Phone || row.phone || row.PHONE || row.Mobile || '';
        if (!name || !phone) {
          errors += 1;
          continue;
        }
        const phone_normalized = normalizePhone(phone);
        const custom = { ...row };
        delete custom.Name;
        delete custom.name;
        delete custom.Phone;
        delete custom.phone;
        delete custom.PHONE;
        delete custom.Mobile;
        delete custom.Email;
        delete custom.email;

        const dup = await query(
          'SELECT id FROM contacts WHERE phone_normalized = :phone_normalized LIMIT 1',
          { phone_normalized }
        );
        if (dup.length) {
          duplicates += 1;
          if (groupId) {
            await query(
              `INSERT IGNORE INTO contact_group_members (group_id, contact_id) VALUES (:group_id, :contact_id)`,
              { group_id: groupId, contact_id: dup[0].id }
            );
          }
          continue;
        }

        const result = await query(
          `INSERT INTO contacts (name, phone, phone_normalized, email, custom_fields, created_by)
           VALUES (:name, :phone, :phone_normalized, :email, :custom_fields, :created_by)`,
          {
            name: String(name).trim(),
            phone: String(phone),
            phone_normalized,
            email: row.Email || row.email || null,
            custom_fields: JSON.stringify(custom),
            created_by: req.user.id,
          }
        );
        if (groupId) {
          await query(
            `INSERT IGNORE INTO contact_group_members (group_id, contact_id) VALUES (:group_id, :contact_id)`,
            { group_id: groupId, contact_id: result.insertId }
          );
        }
        imported += 1;
      } catch {
        errors += 1;
      }
    }

    try {
      fs.unlinkSync(req.file.path);
    } catch {
      /* ignore */
    }

    if (imported > 0) {
      await notifyProjectEvent({
        type: 'contacts_imported',
        title: 'Contacts imported',
        body: `${req.user.name || 'A user'} imported ${imported} contact${imported === 1 ? '' : 's'}.`,
        meta: { imported, duplicates, errors, createdBy: req.user.id },
        actorUserId: req.user.id,
      });
      emitWorkspaceChanged({
        resource: 'contacts',
        action: 'imported',
        actorUserId: req.user.id,
        meta: { imported, duplicates, errors, groupId: groupId || null },
      });
      if (groupId) {
        emitWorkspaceChanged({
          resource: 'groups',
          action: 'updated',
          actorUserId: req.user.id,
          entityId: groupId,
          meta: { reason: 'members_changed' },
        });
      }
    }

    res.json({ success: true, data: { imported, duplicates, errors, total: records.length } });
  })
);

router.get(
  '/export/csv',
  asyncHandler(async (req, res) => {
    const rows = await query(
      'SELECT name, phone, email, custom_fields FROM contacts ORDER BY id ASC'
    );
    const data = rows.map((r) => {
      const custom = parseJson(r.custom_fields, {});
      return { Name: r.name, Phone: r.phone, Email: r.email || '', ...custom };
    });
    const csv = stringify(data, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.send(csv);
  })
);

// ─── Groups ───────────────────────────────────────────────────────────────────

/** ACTIVE groups the user may assign / campaign against */
router.get(
  '/groups/available',
  asyncHandler(async (req, res) => {
    const rows = await listUsableGroups(req.user);
    res.json({ success: true, data: await withManageFlag(req.user, rows) });
  })
);

/** All viewable groups (includes inactive for owners/admin) */
router.get(
  '/groups/list',
  asyncHandler(async (req, res) => {
    const rows = await listViewableGroups(req.user);
    res.json({ success: true, data: await withManageFlag(req.user, rows) });
  })
);

router.get(
  '/groups/:id',
  asyncHandler(async (req, res) => {
    const group = await loadContactGroupOrThrow(req.params.id);
    await assertCanViewContactGroup(req.user, group);
    const countRows = await query(
      'SELECT COUNT(*) AS c FROM contact_group_members WHERE group_id = :id',
      { id: group.id }
    );
    const accessRows = await query(
      'SELECT COUNT(*) AS c FROM contact_group_access WHERE group_id = :id',
      { id: group.id }
    );
    res.json({
      success: true,
      data: await decorateGroupFlags(req.user, {
        ...group,
        member_count: countRows[0].c,
        access_count: accessRows[0].c,
      }),
    });
  })
);

router.get(
  '/groups/:id/contacts',
  asyncHandler(async (req, res) => {
    const group = await loadContactGroupOrThrow(req.params.id);
    await assertCanViewContactGroup(req.user, group);

    const page = Number(req.query.page || 1);
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const params = { gid: group.id, limit, offset };
    let where = 'cgm.group_id = :gid';
    if (search) {
      where +=
        ' AND (c.name LIKE :search OR c.phone LIKE :search OR c.phone_normalized LIKE :search OR c.email LIKE :search)';
      params.search = `%${search}%`;
    }

    const rows = await query(
      `SELECT c.*
       FROM contact_group_members cgm
       JOIN contacts c ON c.id = cgm.contact_id
       WHERE ${where}
       ORDER BY c.id DESC
       LIMIT :limit OFFSET :offset`,
      params
    );
    rows.forEach((r) => {
      r.custom_fields = parseJson(r.custom_fields, {});
    });
    await attachGroups(rows, req.user);
    const countRows = await query(
      `SELECT COUNT(*) AS c
       FROM contact_group_members cgm
       JOIN contacts c ON c.id = cgm.contact_id
       WHERE ${where}`,
      params
    );
    res.json({
      success: true,
      data: {
        group: await decorateGroupFlags(req.user, group),
        rows: withContactManageFlag(req.user, rows),
        total: countRows[0].c,
        page,
        limit,
      },
    });
  })
);

router.get(
  '/groups/:id/access',
  asyncHandler(async (req, res) => {
    const group = await loadContactGroupOrThrow(req.params.id);
    assertCanManageContactGroupAccess(req.user, group);
    const users = await listGroupAccessUsers(group.id);
    const shareable = await listShareableMembers(group);
    res.json({
      success: true,
      data: {
        group: await decorateGroupFlags(req.user, group),
        users,
        shareable,
      },
    });
  })
);

router.post(
  '/groups/:id/access',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      userId: z.coerce.number().int().positive(),
    });
    const body = schema.parse(req.body);
    const group = await loadContactGroupOrThrow(req.params.id);
    await grantGroupAccess(group, body.userId, req.user);
    const users = await listGroupAccessUsers(group.id);

    const target = await query(
      `SELECT id, name FROM users WHERE id = :id AND is_active = 1 LIMIT 1`,
      { id: body.userId }
    );
    await notifyProjectEvent({
      type: 'group_access_granted',
      title: 'Group access granted',
      body: `${req.user.name || 'A user'} granted ${target[0]?.name || 'a member'} access to "${group.name}".`,
      meta: {
        groupId: group.id,
        targetUserId: body.userId,
        grantedBy: req.user.id,
      },
      relatedUserIds: [body.userId, Number(group.created_by || 0)].filter((id) => id > 0),
      actorUserId: req.user.id,
    });
    emitWorkspaceChanged({
      resource: 'groups',
      action: 'access_granted',
      actorUserId: req.user.id,
      entityId: group.id,
      meta: { targetUserId: body.userId },
    });

    res.status(201).json({ success: true, data: { users } });
  })
);

router.delete(
  '/groups/:id/access/:userId',
  asyncHandler(async (req, res) => {
    const group = await loadContactGroupOrThrow(req.params.id);
    const targetUserId = Number(req.params.userId);
    const target = await query(
      `SELECT id, name FROM users WHERE id = :id LIMIT 1`,
      { id: targetUserId }
    );
    await revokeGroupAccess(group, targetUserId, req.user);
    const users = await listGroupAccessUsers(group.id);

    await notifyProjectEvent({
      type: 'group_access_revoked',
      title: 'Group access revoked',
      body: `${req.user.name || 'A user'} revoked ${target[0]?.name || 'a member'}'s access to "${group.name}".`,
      meta: {
        groupId: group.id,
        targetUserId,
        revokedBy: req.user.id,
      },
      relatedUserIds: [targetUserId, Number(group.created_by || 0)].filter((id) => id > 0),
      actorUserId: req.user.id,
    });
    emitWorkspaceChanged({
      resource: 'groups',
      action: 'access_revoked',
      actorUserId: req.user.id,
      entityId: group.id,
      meta: { targetUserId },
    });

    res.json({ success: true, data: { users } });
  })
);

router.post(
  '/groups',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).max(255).transform((s) => s.trim()),
      description: z.string().max(2000).optional().nullable(),
      status: z.enum(['ACTIVE', 'INACTIVE']).optional().default('ACTIVE'),
      accessMode: z.enum(['PRIVATE', 'SHARED']).optional().default('PRIVATE'),
    });
    const body = schema.parse(req.body);
    // Never trust created_by / business_id from client
    try {
      const result = await query(
        `INSERT INTO contact_groups (name, description, status, access_mode, created_by)
         VALUES (:name, :description, :status, :access_mode, :created_by)`,
        {
          name: body.name,
          description: body.description || null,
          status: normalizeGroupStatus(body.status),
          access_mode: normalizeAccessMode(body.accessMode),
          created_by: req.user.id,
        }
      );
      const group = await loadContactGroupOrThrow(result.insertId);

      await notifyProjectEvent({
        type: 'contact_group_created',
        title: 'Contact group created',
        body: `${req.user.name || 'A user'} created group "${body.name}".`,
        meta: { groupId: result.insertId, createdBy: req.user.id, accessMode: body.accessMode },
        actorUserId: req.user.id,
      });
      emitWorkspaceChanged({
        resource: 'groups',
        action: 'created',
        actorUserId: req.user.id,
        entityId: result.insertId,
        meta: { accessMode: normalizeAccessMode(body.accessMode) },
      });

      res.status(201).json({
        success: true,
        data: await decorateGroupFlags(req.user, {
          ...group,
          member_count: 0,
          access_count: 0,
        }),
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError('Group name already exists', 409);
      throw err;
    }
  })
);

router.patch(
  '/groups/:id',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z.string().min(1).max(255).transform((s) => s.trim()).optional(),
      description: z.string().max(2000).nullable().optional(),
      status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
      accessMode: z.enum(['PRIVATE', 'SHARED']).optional(),
    });
    const body = schema.parse(req.body);
    const group = await loadContactGroupOrThrow(req.params.id);
    assertCanManage(req.user, group, 'group');

    const nextAccess =
      body.accessMode !== undefined
        ? normalizeAccessMode(body.accessMode)
        : normalizeAccessMode(group.access_mode);

    try {
      await query(
        `UPDATE contact_groups SET
          name = COALESCE(:name, name),
          description = IF(:desc_set = 1, :description, description),
          status = COALESCE(:status, status),
          access_mode = COALESCE(:access_mode, access_mode)
         WHERE id = :id`,
        {
          id: group.id,
          name: body.name || null,
          description: body.description !== undefined ? body.description : null,
          desc_set: body.description !== undefined ? 1 : 0,
          status: body.status ? normalizeGroupStatus(body.status) : null,
          access_mode: body.accessMode !== undefined ? nextAccess : null,
        }
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError('Group name already exists', 409);
      throw err;
    }

    // SHARED → PRIVATE clears explicit member access (contacts/history untouched)
    if (
      normalizeAccessMode(group.access_mode) === GROUP_ACCESS_MODE.SHARED &&
      nextAccess === GROUP_ACCESS_MODE.PRIVATE
    ) {
      await clearGroupAccess(group.id);
    }

    const prevAccess = normalizeAccessMode(group.access_mode);
    if (body.accessMode !== undefined && nextAccess !== prevAccess) {
      const groupLabel = body.name || group.name;
      const memberRows = await query(
        `SELECT id FROM users
         WHERE role = 'member' AND is_active = 1 AND email_verified = 1`
      );
      const relatedUserIds = [
        ...memberRows.map((r) => Number(r.id)),
        Number(group.created_by || 0),
      ].filter((id) => id > 0);

      const shared = nextAccess === GROUP_ACCESS_MODE.SHARED;
      await notifyProjectEvent({
        type: shared ? 'group_access_shared' : 'group_access_private',
        title: shared ? 'Group access shared' : 'Group access set to private',
        body: shared
          ? `${req.user.name || 'A user'} made "${groupLabel}" Shared — all members can view and use it.`
          : `${req.user.name || 'A user'} made "${groupLabel}" Private — only the owner and admins can access it.`,
        meta: {
          groupId: group.id,
          accessMode: nextAccess,
          previousAccessMode: prevAccess,
          changedBy: req.user.id,
        },
        relatedUserIds,
        actorUserId: req.user.id,
      });
      emitWorkspaceChanged({
        resource: 'groups',
        action: shared ? 'shared' : 'unshared',
        actorUserId: req.user.id,
        entityId: group.id,
        meta: {
          accessMode: nextAccess,
          previousAccessMode: prevAccess,
          name: groupLabel,
        },
      });
    }

    const updated = await loadContactGroupOrThrow(group.id);
    const countRows = await query(
      'SELECT COUNT(*) AS c FROM contact_group_members WHERE group_id = :id',
      { id: group.id }
    );
    const accessRows = await query(
      'SELECT COUNT(*) AS c FROM contact_group_access WHERE group_id = :id',
      { id: group.id }
    );
    if (body.accessMode === undefined || nextAccess === prevAccess) {
      emitWorkspaceChanged({
        resource: 'groups',
        action: 'updated',
        actorUserId: req.user.id,
        entityId: group.id,
      });
    }
    res.json({
      success: true,
      data: await decorateGroupFlags(req.user, {
        ...updated,
        member_count: countRows[0].c,
        access_count: accessRows[0].c,
      }),
    });
  })
);

router.post(
  '/groups/:id/members',
  asyncHandler(async (req, res) => {
    const group = await loadContactGroupOrThrow(req.params.id);
    await assertCanAddContactsToGroup(req.user, group);

    const schema = z.object({
      contactIds: z.array(z.coerce.number().int().positive()).min(1),
    });
    const body = schema.parse(req.body);

    for (const contactId of body.contactIds) {
      const contacts = await query('SELECT id FROM contacts WHERE id = :id LIMIT 1', {
        id: contactId,
      });
      if (!contacts.length) {
        throw new AppError(`Contact not found: ${contactId}`, 404, 'NOT_FOUND');
      }
      await query(
        `INSERT IGNORE INTO contact_group_members (group_id, contact_id) VALUES (:group_id, :contact_id)`,
        { group_id: group.id, contact_id: contactId }
      );
    }
    emitWorkspaceChanged({
      resource: 'groups',
      action: 'updated',
      actorUserId: req.user.id,
      entityId: group.id,
      meta: { reason: 'members_added' },
    });
    emitWorkspaceChanged({
      resource: 'contacts',
      action: 'updated',
      actorUserId: req.user.id,
      meta: { reason: 'group_members_changed', groupId: group.id },
    });
    res.json({ success: true, data: { message: 'Members added' } });
  })
);

router.delete(
  '/groups/:id/members/:contactId',
  asyncHandler(async (req, res) => {
    const group = await loadContactGroupOrThrow(req.params.id);
    await assertCanRemoveContactsFromGroup(req.user, group);

    const contacts = await query('SELECT id FROM contacts WHERE id = :id LIMIT 1', {
      id: req.params.contactId,
    });
    if (!contacts.length) throw new AppError('Contact not found', 404);

    await query(
      `DELETE FROM contact_group_members
       WHERE group_id = :group_id AND contact_id = :contact_id`,
      { group_id: group.id, contact_id: req.params.contactId }
    );
    emitWorkspaceChanged({
      resource: 'groups',
      action: 'updated',
      actorUserId: req.user.id,
      entityId: group.id,
      meta: { reason: 'member_removed', contactId: Number(req.params.contactId) },
    });
    emitWorkspaceChanged({
      resource: 'contacts',
      action: 'updated',
      actorUserId: req.user.id,
      entityId: Number(req.params.contactId),
      meta: { reason: 'group_members_changed', groupId: group.id },
    });
    res.json({ success: true, data: { message: 'Member removed from group' } });
  })
);

router.delete(
  '/groups/:id',
  asyncHandler(async (req, res) => {
    const group = await loadContactGroupOrThrow(req.params.id);
    assertCanManage(req.user, group, 'group');

    // CASCADE removes contact_group_members + contact_group_access only
    await query('DELETE FROM contact_groups WHERE id = :id', { id: group.id });
    emitWorkspaceChanged({
      resource: 'groups',
      action: 'deleted',
      actorUserId: req.user.id,
      entityId: group.id,
      meta: { name: group.name, accessMode: group.access_mode },
    });
    emitWorkspaceChanged({
      resource: 'contacts',
      action: 'updated',
      actorUserId: req.user.id,
      meta: { reason: 'group_deleted', groupId: group.id },
    });
    res.json({ success: true, data: { message: 'Deleted' } });
  })
);

export default router;
