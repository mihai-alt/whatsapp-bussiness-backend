import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/error.js';
import { query } from '../db/pool.js';
import { createMessageTemplate, listMessageTemplates, deleteMessageTemplate } from '../services/meta.service.js';
import { notifyProjectEvent } from '../services/notification.service.js';
import { emitWorkspaceChanged } from '../realtime.js';
import { parseJson } from '../utils/helpers.js';
import { getAccountAccessToken } from '../services/numberConnection.service.js';

const router = Router();
router.use(authenticate);

const componentSchema = z.array(z.record(z.any()));

const TEMPLATE_LANGUAGES = [
  { value: 'en_US', label: 'English (US)', flag: '🇺🇸' },
  { value: 'en_GB', label: 'English (UK)', flag: '🇬🇧' },
  { value: 'hi_IN', label: 'Hindi', flag: '🇮🇳' },
  { value: 'es_ES', label: 'Spanish', flag: '🇪🇸' },
];

const TEMPLATE_CATEGORIES = [
  { value: 'UTILITY', label: 'UTILITY' },
  { value: 'MARKETING', label: 'MARKETING' },
  { value: 'AUTHENTICATION', label: 'AUTHENTICATION' },
];

const TEMPLATE_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'];

function decorateTemplate(row) {
  if (!row) return row;
  row.components = parseJson(row.components, []);
  const body = Array.isArray(row.components)
    ? row.components.find((c) => String(c.type || '').toUpperCase() === 'BODY')
    : null;
  row.body_text = body?.text || '';
  row.body_preview = row.body_text
    ? row.body_text.length > 120
      ? `${row.body_text.slice(0, 117)}...`
      : row.body_text
    : '';
  return row;
}

async function getTemplateStats(accountId = null) {
  const params = {};
  let where = '1=1';
  if (accountId) {
    where += ' AND whatsapp_account_id = :accountId';
    params.accountId = accountId;
  }
  const rows = await query(
    `SELECT status, COUNT(*) AS count
     FROM templates
     WHERE ${where}
     GROUP BY status`,
    params
  );
  const counts = {
    DRAFT: 0,
    PENDING: 0,
    APPROVED: 0,
    REJECTED: 0,
    PAUSED: 0,
    DISABLED: 0,
  };
  for (const row of rows) {
    const key = String(row.status || '').toUpperCase();
    if (key in counts) counts[key] = Number(row.count || 0);
  }
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const pct = (n) => (total ? Number(((n / total) * 100).toFixed(2)) : 0);
  return {
    total,
    approved: counts.APPROVED,
    pending: counts.PENDING,
    rejected: counts.REJECTED,
    draft: counts.DRAFT,
    paused: counts.PAUSED,
    disabled: counts.DISABLED,
    approvedPct: pct(counts.APPROVED),
    pendingPct: pct(counts.PENDING),
    rejectedPct: pct(counts.REJECTED),
    draftPct: pct(counts.DRAFT),
    byStatus: counts,
  };
}

router.get(
  '/meta',
  asyncHandler(async (_req, res) => {
    res.json({
      success: true,
      data: {
        languages: TEMPLATE_LANGUAGES,
        categories: TEMPLATE_CATEGORIES,
        statuses: TEMPLATE_STATUSES,
        guidelinesUrl:
          'https://developers.facebook.com/docs/whatsapp/message-templates/guidelines',
      },
    });
  })
);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const accountId = req.query.accountId ? Number(req.query.accountId) : null;
    if (req.query.accountId && (!Number.isFinite(accountId) || accountId < 1)) {
      throw new AppError('Invalid accountId', 400, 'INVALID_ACCOUNT');
    }
    const stats = await getTemplateStats(accountId);
    res.json({ success: true, data: stats });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : '';
    const search = req.query.search ? String(req.query.search).trim() : '';
    const accountId = req.query.accountId ? Number(req.query.accountId) : null;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const includeStats = String(req.query.includeStats || '') === 'true';

    if (status && !TEMPLATE_STATUSES.includes(status)) {
      throw new AppError('Invalid template status filter', 400, 'INVALID_STATUS');
    }
    if (req.query.accountId && (!Number.isFinite(accountId) || accountId < 1)) {
      throw new AppError('Invalid accountId', 400, 'INVALID_ACCOUNT');
    }

    const params = {};
    let where = '1=1';
    if (status) {
      where += ' AND t.status = :status';
      params.status = status;
    }
    if (accountId) {
      where += ' AND t.whatsapp_account_id = :accountId';
      params.accountId = accountId;
    }
    if (search) {
      where +=
        ' AND (t.name LIKE :search OR t.category LIKE :search OR t.language LIKE :search OR wa.phone_number LIKE :search OR wa.business_name LIKE :search)';
      params.search = `%${search}%`;
    }

    const countRows = await query(
      `SELECT COUNT(*) AS c
       FROM templates t
       JOIN whatsapp_accounts wa ON wa.id = t.whatsapp_account_id
       WHERE ${where}`,
      params
    );
    const total = Number(countRows[0]?.c || 0);

    const rows = await query(
      `SELECT t.*, wa.phone_number, wa.business_name, wa.status AS account_status
       FROM templates t
       JOIN whatsapp_accounts wa ON wa.id = t.whatsapp_account_id
       WHERE ${where}
       ORDER BY t.updated_at DESC, t.id DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    rows.forEach(decorateTemplate);

    const payload = {
      rows,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
    if (includeStats) {
      payload.stats = await getTemplateStats(accountId);
    }

    // Back-compat: older clients expect `data` to be an array
    if (String(req.query.paged || '') !== 'true' && !req.query.page && !req.query.limit) {
      res.json({ success: true, data: rows, meta: { total, stats: includeStats ? payload.stats : undefined } });
      return;
    }

    res.json({ success: true, data: payload });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT t.*, wa.phone_number, wa.business_name, wa.status AS account_status
       FROM templates t
       JOIN whatsapp_accounts wa ON wa.id = t.whatsapp_account_id
       WHERE t.id = :id LIMIT 1`,
      { id: req.params.id }
    );
    if (!rows.length) throw new AppError('Template not found', 404, 'NOT_FOUND');
    res.json({ success: true, data: decorateTemplate(rows[0]) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      whatsappAccountId: z.coerce.number().int().positive(),
      name: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .regex(/^[a-z0-9_]+$/, 'Template name must be lowercase alphanumeric with underscores'),
      language: z.string().trim().min(2).max(16).default('en_US'),
      category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
      components: componentSchema,
      bodyText: z.string().trim().max(1024).optional(),
    });
    const body = schema.parse(req.body);

    let components = body.components;
    if ((!components || !components.length) && body.bodyText) {
      components = [
        {
          type: 'BODY',
          text: body.bodyText,
          example: { body_text: [['Sample1', 'Sample2']] },
        },
      ];
    }
    if (!Array.isArray(components) || !components.length) {
      throw new AppError('Template body/components are required', 400, 'COMPONENTS_REQUIRED');
    }

    const bodyComp = components.find((c) => String(c.type || '').toUpperCase() === 'BODY');
    if (!bodyComp?.text || !String(bodyComp.text).trim()) {
      throw new AppError('Body text is required', 400, 'BODY_REQUIRED');
    }

    const accounts = await query(
      'SELECT id FROM whatsapp_accounts WHERE id = :id AND status = "connected" LIMIT 1',
      { id: body.whatsappAccountId }
    );
    if (!accounts.length) throw new AppError('Connected WhatsApp account required', 400, 'NUMBER_NOT_CONNECTED');

    const dup = await query(
      `SELECT id FROM templates
       WHERE whatsapp_account_id = :aid AND name = :name AND language = :language LIMIT 1`,
      { aid: body.whatsappAccountId, name: body.name, language: body.language }
    );
    if (dup.length) {
      throw new AppError('A template with this name and language already exists', 409, 'DUPLICATE_TEMPLATE');
    }

    const result = await query(
      `INSERT INTO templates (whatsapp_account_id, name, language, category, status, components, created_by)
       VALUES (:whatsapp_account_id, :name, :language, :category, 'DRAFT', :components, :created_by)`,
      {
        whatsapp_account_id: body.whatsappAccountId,
        name: body.name,
        language: body.language,
        category: body.category,
        components: JSON.stringify(components),
        created_by: req.user.id,
      }
    );
    const rows = await query(
      `SELECT t.*, wa.phone_number, wa.business_name
       FROM templates t
       JOIN whatsapp_accounts wa ON wa.id = t.whatsapp_account_id
       WHERE t.id = :id`,
      { id: result.insertId }
    );
    emitWorkspaceChanged({
      resource: 'templates',
      action: 'created',
      actorUserId: req.user.id,
      entityId: result.insertId,
    });
    res.status(201).json({ success: true, data: decorateTemplate(rows[0]) });
  })
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']).optional(),
      components: componentSchema.optional(),
      language: z.string().optional(),
      bodyText: z.string().trim().max(1024).optional(),
    });
    const body = schema.parse(req.body);
    const rows = await query('SELECT * FROM templates WHERE id = :id LIMIT 1', { id: req.params.id });
    if (!rows.length) throw new AppError('Template not found', 404, 'NOT_FOUND');
    if (!['DRAFT', 'REJECTED'].includes(rows[0].status)) {
      throw new AppError('Only draft or rejected templates can be edited', 400, 'INVALID_STATE');
    }

    let components = body.components;
    if (!components && body.bodyText != null) {
      const existing = parseJson(rows[0].components, []);
      const next = Array.isArray(existing) ? [...existing] : [];
      const idx = next.findIndex((c) => String(c.type || '').toUpperCase() === 'BODY');
      const bodyComp = {
        type: 'BODY',
        text: body.bodyText,
        example: { body_text: [['Sample1', 'Sample2']] },
      };
      if (idx >= 0) next[idx] = { ...next[idx], ...bodyComp };
      else next.push(bodyComp);
      components = next;
    }

    await query(
      `UPDATE templates SET
        category = COALESCE(:category, category),
        language = COALESCE(:language, language),
        components = COALESCE(:components, components)
       WHERE id = :id`,
      {
        id: req.params.id,
        category: body.category || null,
        language: body.language || null,
        components: components ? JSON.stringify(components) : null,
      }
    );
    const updated = await query(
      `SELECT t.*, wa.phone_number, wa.business_name
       FROM templates t
       JOIN whatsapp_accounts wa ON wa.id = t.whatsapp_account_id
       WHERE t.id = :id`,
      { id: req.params.id }
    );
    res.json({ success: true, data: decorateTemplate(updated[0]) });
  })
);

router.post(
  '/:id/submit',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT t.*, wa.waba_id, wa.access_token, wa.status AS account_status
       FROM templates t
       JOIN whatsapp_accounts wa ON wa.id = t.whatsapp_account_id
       WHERE t.id = :id LIMIT 1`,
      { id: req.params.id }
    );
    if (!rows.length) throw new AppError('Template not found', 404, 'NOT_FOUND');
    const tpl = rows[0];
    if (tpl.account_status !== 'connected') {
      throw new AppError('WhatsApp account disconnected', 400, 'NUMBER_NOT_CONNECTED');
    }
    if (!['DRAFT', 'REJECTED'].includes(tpl.status)) {
      throw new AppError('Template already submitted', 400, 'INVALID_STATE');
    }

    const components = parseJson(tpl.components, []);
    const meta = await createMessageTemplate(tpl.waba_id, getAccountAccessToken(tpl), {
      name: tpl.name,
      language: tpl.language,
      category: tpl.category,
      components,
    });

    await query(
      `UPDATE templates SET status = 'PENDING', meta_template_id = :meta_template_id, rejection_reason = NULL
       WHERE id = :id`,
      { id: tpl.id, meta_template_id: meta.id || null }
    );

    const updated = await query(
      `SELECT t.*, wa.phone_number, wa.business_name
       FROM templates t
       JOIN whatsapp_accounts wa ON wa.id = t.whatsapp_account_id
       WHERE t.id = :id`,
      { id: tpl.id }
    );

    res.json({
      success: true,
      data: {
        meta,
        status: 'PENDING',
        template: decorateTemplate(updated[0]),
      },
    });
  })
);

router.post(
  '/sync',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const schema = z.object({ whatsappAccountId: z.coerce.number().int().positive() });
    const body = schema.parse(req.body);
    const accounts = await query('SELECT * FROM whatsapp_accounts WHERE id = :id LIMIT 1', {
      id: body.whatsappAccountId,
    });
    if (!accounts.length) throw new AppError('WhatsApp account not found', 404, 'NOT_FOUND');
    const account = accounts[0];
    if (account.status !== 'connected') {
      throw new AppError('Account disconnected', 400, 'NUMBER_NOT_CONNECTED');
    }

    const remote = await listMessageTemplates(account.waba_id, getAccountAccessToken(account));
    const items = remote.data || [];
    let upserted = 0;
    let created = 0;
    let updated = 0;

    for (const item of items) {
      const existing = await query(
        `SELECT id, status, created_by FROM templates
         WHERE whatsapp_account_id = :aid AND name = :name AND language = :language LIMIT 1`,
        { aid: account.id, name: item.name, language: item.language }
      );
      const status = (item.status || 'PENDING').toUpperCase();
      if (existing.length) {
        const prev = existing[0].status;
        await query(
          `UPDATE templates SET status = :status, category = :category, components = :components,
           meta_template_id = :meta_template_id, rejection_reason = :rejection_reason
           WHERE id = :id`,
          {
            id: existing[0].id,
            status,
            category: item.category || 'MARKETING',
            components: JSON.stringify(item.components || []),
            meta_template_id: item.id || null,
            rejection_reason: item.rejected_reason || null,
          }
        );
        updated += 1;
        if (prev !== status && (status === 'APPROVED' || status === 'REJECTED')) {
          await notifyProjectEvent({
            type: status === 'APPROVED' ? 'template_approved' : 'template_rejected',
            title: `Template ${item.name} ${status.toLowerCase()}`,
            body: item.rejected_reason || `Template ${item.name} is now ${status}`,
            meta: { templateName: item.name, status },
            relatedUserIds: existing[0].created_by ? [existing[0].created_by] : [],
          });
        }
      } else {
        await query(
          `INSERT INTO templates (whatsapp_account_id, name, language, category, status, meta_template_id, components, rejection_reason)
           VALUES (:aid, :name, :language, :category, :status, :meta_template_id, :components, :rejection_reason)`,
          {
            aid: account.id,
            name: item.name,
            language: item.language,
            category: item.category || 'MARKETING',
            status,
            meta_template_id: item.id || null,
            components: JSON.stringify(item.components || []),
            rejection_reason: item.rejected_reason || null,
          }
        );
        created += 1;
      }
      upserted += 1;
    }

    const stats = await getTemplateStats(account.id);
    res.json({
      success: true,
      data: { upserted, created, updated, total: items.length, stats },
    });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT t.*, wa.waba_id, wa.access_token, wa.status AS account_status
       FROM templates t
       JOIN whatsapp_accounts wa ON wa.id = t.whatsapp_account_id
       WHERE t.id = :id LIMIT 1`,
      { id: req.params.id }
    );
    if (!rows.length) throw new AppError('Template not found', 404, 'NOT_FOUND');
    const tpl = rows[0];
    if (tpl.status !== 'DRAFT' && tpl.account_status === 'connected') {
      try {
        await deleteMessageTemplate(tpl.waba_id, getAccountAccessToken(tpl), tpl.name);
      } catch (err) {
        console.warn('Meta template delete warning:', err.message);
      }
    }
    await query('DELETE FROM templates WHERE id = :id', { id: tpl.id });
    res.json({ success: true, data: { message: 'Deleted', id: tpl.id } });
  })
);

export default router;
