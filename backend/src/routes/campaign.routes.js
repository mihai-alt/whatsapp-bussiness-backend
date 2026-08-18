import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/error.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { getMessageCost, getWallet } from '../services/wallet.service.js';
import { notifyProjectEvent } from '../services/notification.service.js';
import { writeAudit } from '../services/audit.service.js';
import { emitWorkspaceChanged } from '../realtime.js';
import { normalizePhone, parseJson } from '../utils/helpers.js';
import { parseSpreadsheetFile } from '../utils/spreadsheet.js';
import {
  drainCampaignJobs,
  enqueueCampaign,
  enqueueCampaignMessages,
  getCampaignQueue,
  refreshCampaignStatus,
} from '../queues/campaign.queue.js';
import {
  assertCanUseContactGroup,
  loadContactGroupOrThrow,
} from '../services/contactAccess.service.js';

const router = Router();
router.use(authenticate);

const uploadDir = path.resolve(config.uploadDir);
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

const PAUSABLE = ['running', 'queued', 'scheduled'];
const CANCELLABLE = [
  'draft',
  'pending_approval',
  'scheduled',
  'queued',
  'running',
  'paused',
  'failed',
];

const createCampaignLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  keyFn: (req) => `campaign-create:${req.user?.id || req.ip}`,
  message: 'Too many campaigns created. Please wait a minute and try again.',
});
function unlinkQuiet(filePath) {
  try {
    if (filePath) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

function analyzeSpreadsheetRows(rows) {
  const seen = new Set();
  let valid = 0;
  let invalid = 0;
  let duplicates = 0;
  const errors = [];
  const sample = [];
  const columns = rows[0] ? Object.keys(rows[0]) : [];

  rows.forEach((row, idx) => {
    const phoneRaw = row.Phone || row.phone || row.PHONE || row.Mobile || row.mobile || '';
    const phone = normalizePhone(phoneRaw);
    if (!phone) {
      invalid += 1;
      if (errors.length < 25) {
        errors.push({ row: idx + 2, reason: 'Missing or invalid phone number' });
      }
      return;
    }
    if (seen.has(phone)) {
      duplicates += 1;
      if (errors.length < 25) {
        errors.push({ row: idx + 2, reason: `Duplicate phone ${phone}` });
      }
      return;
    }
    seen.add(phone);
    valid += 1;
    if (sample.length < 5) {
      sample.push({ phone, ...row });
    }
  });

  return {
    columns,
    totalRows: rows.length,
    valid,
    invalid,
    duplicates,
    errors,
    sample,
  };
}

function normalizeTags(raw) {
  let tags = raw;
  if (typeof raw === 'string') {
    try {
      tags = JSON.parse(raw);
    } catch {
      tags = raw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(tags)) return [];
  const cleaned = [];
  const seen = new Set();
  for (const t of tags) {
    const label = String(t || '')
      .trim()
      .slice(0, 40);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(label);
    if (cleaned.length >= 20) break;
  }
  return cleaned;
}

function decorateCampaign(row) {
  if (!row) return row;
  row.variable_mapping = parseJson(row.variable_mapping, {});
  row.components = parseJson(row.components, []);
  row.tags = parseJson(row.tags, []);
  if (!Array.isArray(row.tags)) row.tags = [];
  return row;
}

async function loadCampaignOrThrow(id) {
  const rows = await query(
    `SELECT c.*, t.name AS template_name, t.language, t.components, t.category, t.status AS template_status,
            wa.phone_number, wa.phone_number_id, wa.business_name, wa.status AS account_status,
            g.name AS group_name
     FROM campaigns c
     LEFT JOIN templates t ON t.id = c.template_id
     LEFT JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
     LEFT JOIN contact_groups g ON g.id = c.contact_group_id
     WHERE c.id = :id LIMIT 1`,
    { id }
  );
  if (!rows.length) throw new AppError('Campaign not found', 404, 'NOT_FOUND');
  return decorateCampaign(rows[0]);
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT c.*, t.name AS template_name, t.language, wa.phone_number, wa.business_name,
              g.name AS group_name
       FROM campaigns c
       LEFT JOIN templates t ON t.id = c.template_id
       LEFT JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
       LEFT JOIN contact_groups g ON g.id = c.contact_group_id
       ORDER BY c.id DESC
       LIMIT 200`
    );
    rows.forEach(decorateCampaign);
    res.json({ success: true, data: rows });
  })
);

router.get(
  '/meta',
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT tags FROM campaigns WHERE tags IS NOT NULL ORDER BY id DESC LIMIT 100`
    );
    const seen = new Set();
    const tags = [];
    for (const row of rows) {
      const list = parseJson(row.tags, []);
      if (!Array.isArray(list)) continue;
      for (const t of list) {
        const label = String(t || '').trim();
        if (!label) continue;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push(label);
        if (tags.length >= 50) break;
      }
      if (tags.length >= 50) break;
    }
    res.json({
      success: true,
      data: {
        types: [
          { value: 'marketing', label: 'Marketing', description: 'Promotional messages and offers' },
          { value: 'utility', label: 'Utility', description: 'Transactional or update messages' },
        ],
        priorities: [
          { value: 'low', label: 'Low', hint: 'Low priority campaigns are sent after normal ones.' },
          { value: 'normal', label: 'Normal', hint: 'Normal priority campaigns will be sent in queue order.' },
          { value: 'high', label: 'High', hint: 'High priority campaigns are preferred in the send queue.' },
        ],
        tags,
      },
    });
  })
);

router.post(
  '/estimate',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      templateId: z.coerce.number().int().positive().optional().nullable(),
      category: z.string().max(64).optional().nullable(),
      audienceCount: z.coerce.number().int().min(0).max(1_000_000).default(0),
    });
    const body = schema.parse(req.body || {});
    let category = body.category || 'DEFAULT';
    if (body.templateId) {
      const templates = await query(`SELECT category FROM templates WHERE id = :id LIMIT 1`, {
        id: body.templateId,
      });
      if (templates.length) category = templates[0].category || category;
    }
    const costPerMessage = await getMessageCost(category);
    const audienceCount = body.audienceCount || 0;
    const estimatedCost = costPerMessage * audienceCount;
    const wallet = await getWallet();
    const balance = Number(wallet.balance || 0);
    res.json({
      success: true,
      data: {
        category,
        costPerMessage,
        audienceCount,
        estimatedCost,
        currency: wallet.currency || 'INR',
        walletBalance: balance,
        sufficient: balance >= estimatedCost,
      },
    });
  })
);

router.post(
  '/preview-csv',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('CSV/XLSX file required', 400, 'FILE_REQUIRED');
    try {
      const rows = await parseSpreadsheetFile(req.file);
      const analysis = analyzeSpreadsheetRows(rows);
      res.json({ success: true, data: analysis });
    } finally {
      unlinkQuiet(req.file.path);
    }
  })
);

router.get(
  '/:id/progress',
  asyncHandler(async (req, res) => {
    const campaign = await loadCampaignOrThrow(req.params.id);
    res.json({
      success: true,
      data: {
        campaignId: campaign.id,
        status: campaign.status,
        total_count: campaign.total_count,
        sent_count: campaign.sent_count,
        delivered_count: campaign.delivered_count,
        read_count: campaign.read_count,
        failed_count: campaign.failed_count,
        pending_count: campaign.pending_count,
      },
    });
  })
);

router.get(
  '/:id/recipients',
  asyncHandler(async (req, res) => {
    await loadCampaignOrThrow(req.params.id);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const status = req.query.status ? String(req.query.status) : null;
    const params = { id: req.params.id };
    let where = 'campaign_id = :id';
    if (status) {
      where += ' AND status = :status';
      params.status = status;
    }
    const messages = await query(
      `SELECT id, phone, status, wamid, error_code, error_message, sent_at, delivered_at, read_at, failed_at, cost
       FROM campaign_messages WHERE ${where}
       ORDER BY id ASC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const countRows = await query(
      `SELECT COUNT(*) AS c FROM campaign_messages WHERE ${where}`,
      params
    );
    res.json({
      success: true,
      data: { recipients: messages, total: Number(countRows[0].c || 0), limit, offset },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const campaign = await loadCampaignOrThrow(req.params.id);
    const messages = await query(
      `SELECT id, phone, status, wamid, error_message, sent_at, delivered_at, read_at, failed_at, cost
       FROM campaign_messages WHERE campaign_id = :id ORDER BY id DESC LIMIT 200`,
      { id: req.params.id }
    );
    res.json({ success: true, data: { campaign, messages } });
  })
);

router.post(
  '/',
  createCampaignLimiter,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      name: z
        .string()
        .trim()
        .min(2, 'Campaign name is required')
        .max(120, 'Campaign name is too long'),
      description: z.string().trim().max(2000).optional().nullable(),
      campaignType: z.enum(['marketing', 'utility']).optional().default('marketing'),
      tags: z.string().optional().nullable(),
      priority: z.enum(['low', 'normal', 'high']).optional().default('normal'),
      notes: z.string().trim().max(5000).optional().nullable(),
      whatsappAccountId: z.coerce.number().int().positive().optional().nullable(),
      templateId: z.coerce.number().int().positive().optional().nullable(),
      contactGroupId: z.coerce.number().int().positive().optional().nullable(),
      variableMapping: z.string().optional(),
      scheduledAt: z.string().datetime().optional().nullable(),
      timezone: z.string().max(64).optional().nullable(),
      sendNow: z.coerce.boolean().optional().default(true),
      saveAsDraft: z.coerce.boolean().optional().default(false),
    });

    const body = schema.parse({
      ...req.body,
      description: req.body.description || null,
      campaignType: req.body.campaignType || req.body.campaign_type || 'marketing',
      tags: req.body.tags || null,
      priority: req.body.priority || 'normal',
      notes: req.body.notes || null,
      whatsappAccountId: req.body.whatsappAccountId || null,
      templateId: req.body.templateId || null,
      contactGroupId: req.body.contactGroupId || null,
      scheduledAt: req.body.scheduledAt || null,
      timezone: req.body.timezone || null,
      sendNow: req.body.sendNow === 'false' ? false : req.body.sendNow ?? true,
      saveAsDraft: req.body.saveAsDraft === 'true' || req.body.saveAsDraft === true,
    });

    const tags = normalizeTags(body.tags);
    const saveAsDraft = Boolean(body.saveAsDraft);
    const wantsImmediate = !saveAsDraft && body.sendNow && !body.scheduledAt;
    const wantsSchedule = !saveAsDraft && Boolean(body.scheduledAt);

    let variableMapping = {};
    if (body.variableMapping) {
      try {
        variableMapping = JSON.parse(body.variableMapping);
      } catch {
        throw new AppError('Invalid variable mapping JSON', 400, 'INVALID_MAPPING');
      }
      if (!variableMapping || typeof variableMapping !== 'object' || Array.isArray(variableMapping)) {
        throw new AppError('Invalid variable mapping', 400, 'INVALID_MAPPING');
      }
    }

    let account = null;
    if (body.whatsappAccountId) {
      const accounts = await query(
        `SELECT id, phone_number_id, status FROM whatsapp_accounts
         WHERE id = :id AND status = 'connected' LIMIT 1`,
        { id: body.whatsappAccountId }
      );
      if (!accounts.length) {
        throw new AppError('Connected WhatsApp number required', 400, 'NUMBER_NOT_CONNECTED');
      }
      account = accounts[0];
    } else if (!saveAsDraft) {
      throw new AppError('WhatsApp number is required', 400, 'NUMBER_REQUIRED');
    }

    let template = null;
    if (body.templateId) {
      if (!body.whatsappAccountId) {
        throw new AppError('Select a WhatsApp number before choosing a template', 400, 'NUMBER_REQUIRED');
      }
      const templates = await query(
        `SELECT t.*
         FROM templates t
         WHERE t.id = :id AND t.whatsapp_account_id = :aid AND t.status = 'APPROVED' LIMIT 1`,
        { id: body.templateId, aid: body.whatsappAccountId }
      );
      if (!templates.length) {
        throw new AppError(
          'Approved template on the selected WhatsApp number is required',
          400,
          'TEMPLATE_NOT_APPROVED'
        );
      }
      template = templates[0];
    } else if (!saveAsDraft) {
      throw new AppError('Template is required', 400, 'TEMPLATE_REQUIRED');
    }

    if (body.contactGroupId) {
      // Must be viewable + ACTIVE (Admin any; Owner; Shared members)
      const group = await loadContactGroupOrThrow(body.contactGroupId);
      await assertCanUseContactGroup(req.user, group);
    }

    if (body.scheduledAt) {
      const when = new Date(body.scheduledAt);
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now() + 30_000) {
        throw new AppError('Scheduled time must be in the future', 400, 'INVALID_SCHEDULE');
      }
    }

    const recipients = [];
    if (body.contactGroupId) {
      const contacts = await query(
        `SELECT c.id, c.name, c.phone_normalized AS phone, c.custom_fields
         FROM contacts c
         JOIN contact_group_members m ON m.contact_id = c.id
         WHERE m.group_id = :gid`,
        { gid: body.contactGroupId }
      );
      for (const c of contacts) {
        if (!c.phone) continue;
        recipients.push({
          contact_id: c.id,
          phone: c.phone,
          variables: { Name: c.name, name: c.name, ...parseJson(c.custom_fields, {}) },
        });
      }
    }

    if (req.file) {
      try {
        const rows = await parseSpreadsheetFile(req.file);
        for (const row of rows) {
          const phoneRaw = row.Phone || row.phone || row.PHONE || row.Mobile || row.mobile || '';
          const phone = normalizePhone(phoneRaw);
          if (!phone) continue;
          const name = row.Name || row.name || '';
          recipients.push({
            contact_id: null,
            phone,
            variables: { Name: name, name, ...row },
          });
        }
      } finally {
        unlinkQuiet(req.file.path);
      }
    }

    const unique = new Map();
    for (const r of recipients) unique.set(r.phone, r);
    const finalRecipients = [...unique.values()];

    if (!finalRecipients.length && !saveAsDraft) {
      throw new AppError('No valid recipients found', 400, 'NO_RECIPIENTS');
    }

    const cost = template ? await getMessageCost(template.category) : 0;
    const wallet = await getWallet();
    const estimated = cost * finalRecipients.length;
    if (wantsImmediate && estimated > 0 && Number(wallet.balance) < estimated) {
      throw new AppError(
        `Insufficient wallet balance. Need ${estimated}, have ${wallet.balance}`,
        402,
        'INSUFFICIENT_BALANCE'
      );
    }

    const needsApproval =
      config.campaignRequireApproval &&
      req.user.role !== 'admin' &&
      !saveAsDraft &&
      (wantsImmediate || wantsSchedule);

    const status = saveAsDraft
      ? 'draft'
      : needsApproval
        ? 'pending_approval'
        : wantsSchedule
          ? 'scheduled'
          : wantsImmediate
            ? 'queued'
            : 'draft';

    if (
      (status === 'queued' || status === 'scheduled' || status === 'pending_approval') &&
      (!account || !template || !finalRecipients.length)
    ) {
      throw new AppError(
        'WhatsApp number, approved template, and recipients are required to launch or schedule',
        400,
        'INCOMPLETE_CAMPAIGN'
      );
    }

    const result = await query(
      `INSERT INTO campaigns
       (name, description, campaign_type, tags, priority, notes,
        whatsapp_account_id, template_id, contact_group_id, status, variable_mapping,
        scheduled_at, scheduled_timezone, total_count, pending_count, cost_per_message, created_by)
       VALUES
       (:name, :description, :campaign_type, :tags, :priority, :notes,
        :whatsapp_account_id, :template_id, :contact_group_id, :status, :variable_mapping,
        :scheduled_at, :scheduled_timezone, :total_count, :pending_count, :cost_per_message, :created_by)`,
      {
        name: body.name.trim(),
        description: body.description || null,
        campaign_type: body.campaignType || 'marketing',
        tags: JSON.stringify(tags),
        priority: body.priority || 'normal',
        notes: body.notes || null,
        whatsapp_account_id: body.whatsappAccountId || null,
        template_id: body.templateId || null,
        contact_group_id: body.contactGroupId || null,
        status,
        variable_mapping: JSON.stringify(variableMapping),
        scheduled_at: wantsSchedule ? new Date(body.scheduledAt) : null,
        scheduled_timezone: body.timezone || null,
        total_count: finalRecipients.length,
        pending_count: finalRecipients.length,
        cost_per_message: cost,
        created_by: req.user.id,
      }
    );

    const campaignId = result.insertId;
    for (const r of finalRecipients) {
      await query(
        `INSERT INTO campaign_messages (campaign_id, contact_id, phone, variables, status, cost)
         VALUES (:campaign_id, :contact_id, :phone, :variables, 'pending', :cost)`,
        {
          campaign_id: campaignId,
          contact_id: r.contact_id,
          phone: r.phone,
          variables: JSON.stringify(r.variables),
          cost,
        }
      );
    }

    if (status === 'queued') {
      await enqueueCampaign(campaignId);
    } else if (status === 'scheduled' && body.scheduledAt) {
      const delay = Math.max(0, new Date(body.scheduledAt).getTime() - Date.now());
      await getCampaignQueue().add(
        'run-campaign',
        { campaignId },
        { delay, jobId: `campaign-sched-${campaignId}`, removeOnComplete: 100 }
      );
    }

    const created = await loadCampaignOrThrow(campaignId);
    await notifyProjectEvent({
      type: 'campaign_created',
      title: 'Campaign created',
      body: `${req.user.name || 'A user'} created campaign "${body.name.trim()}" (${status}).`,
      meta: { campaignId, status, createdBy: req.user.id },
      actorUserId: req.user.id,
    });
    await writeAudit({
      userId: req.user.id,
      action: 'campaign.created',
      entityType: 'campaign',
      entityId: campaignId,
      meta: { status, name: body.name.trim() },
      ip: req.ip,
    });
    emitWorkspaceChanged({
      resource: 'campaigns',
      action: 'created',
      actorUserId: req.user.id,
      entityId: campaignId,
      meta: { status },
    });
    res.status(201).json({ success: true, data: created });
  })
);

router.post(
  '/:id/approve',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const campaign = await loadCampaignOrThrow(req.params.id);
    if (campaign.status !== 'pending_approval') {
      throw new AppError(
        `Only campaigns awaiting approval can be approved (current: ${campaign.status}).`,
        400,
        'INVALID_STATE'
      );
    }
    if (!campaign.whatsapp_account_id || !campaign.template_id) {
      throw new AppError('Campaign is incomplete', 400, 'INCOMPLETE_CAMPAIGN');
    }
    if (campaign.account_status !== 'connected') {
      throw new AppError('WhatsApp number is disconnected', 400, 'NUMBER_NOT_CONNECTED');
    }

    const when = campaign.scheduled_at ? new Date(campaign.scheduled_at).getTime() : null;
    const launchNow = !when || when <= Date.now();

    if (launchNow) {
      await drainCampaignJobs(campaign.id, { removeScheduled: true });
      await query(
        `UPDATE campaigns SET status = 'queued', started_at = COALESCE(started_at, NOW()) WHERE id = :id`,
        { id: campaign.id }
      );
      await enqueueCampaign(Number(campaign.id));
    } else {
      const delay = Math.max(0, when - Date.now());
      await query(`UPDATE campaigns SET status = 'scheduled' WHERE id = :id`, { id: campaign.id });
      await getCampaignQueue().add(
        'run-campaign',
        { campaignId: Number(campaign.id) },
        { delay, jobId: `campaign-sched-${campaign.id}`, removeOnComplete: 100 }
      );
    }

    await writeAudit({
      userId: req.user.id,
      action: 'campaign.approved',
      entityType: 'campaign',
      entityId: campaign.id,
      meta: { launchNow },
      ip: req.ip,
    });
    await notifyProjectEvent({
      type: 'campaign_approved',
      title: 'Campaign approved',
      body: `Admin approved campaign "${campaign.name}".`,
      meta: { campaignId: campaign.id },
      actorUserId: req.user.id,
      relatedUserIds: campaign.created_by ? [campaign.created_by] : [],
    });

    const updated = await loadCampaignOrThrow(campaign.id);
    res.json({
      success: true,
      data: {
        message: launchNow ? 'Campaign approved and launched' : 'Campaign approved and scheduled',
        campaign: updated,
      },
    });
  })
);

router.post(
  '/:id/send',
  asyncHandler(async (req, res) => {
    const campaign = await loadCampaignOrThrow(req.params.id);
    if (campaign.status === 'pending_approval' && req.user.role !== 'admin') {
      throw new AppError('This campaign is waiting for admin approval.', 403, 'PENDING_APPROVAL');
    }
    if (!['draft', 'scheduled', 'pending_approval'].includes(campaign.status)) {
      throw new AppError(
        `Cannot launch a campaign in status "${campaign.status}". Only draft, scheduled, or pending-approval campaigns can be launched.`,
        400,
        'INVALID_STATE'
      );
    }
    if (!campaign.whatsapp_account_id || !campaign.template_id) {
      throw new AppError(
        'Complete WhatsApp number and template selection before launching',
        400,
        'INCOMPLETE_CAMPAIGN'
      );
    }
    if (campaign.account_status !== 'connected') {
      throw new AppError('WhatsApp number is disconnected', 400, 'NUMBER_NOT_CONNECTED');
    }
    if (campaign.template_status && campaign.template_status !== 'APPROVED') {
      throw new AppError('Template is not approved', 400, 'TEMPLATE_NOT_APPROVED');
    }

    const pending = await query(
      `SELECT COUNT(*) AS c FROM campaign_messages
       WHERE campaign_id = :id AND status IN ('pending','failed','queued') AND (wamid IS NULL OR wamid = '')`,
      { id: campaign.id }
    );
    const remaining = Number(pending[0].c || 0);
    if (remaining < 1) {
      throw new AppError('No pending messages to send', 400, 'NO_RECIPIENTS');
    }

    const estimated = Number(campaign.cost_per_message || 0) * remaining;
    const wallet = await getWallet();
    if (estimated > 0 && Number(wallet.balance) < estimated) {
      throw new AppError(
        `Insufficient wallet balance. Need ${estimated}, have ${wallet.balance}`,
        402,
        'INSUFFICIENT_BALANCE'
      );
    }

    if (
      config.campaignRequireApproval &&
      req.user.role !== 'admin' &&
      campaign.status !== 'pending_approval'
    ) {
      await query(`UPDATE campaigns SET status = 'pending_approval' WHERE id = :id`, {
        id: campaign.id,
      });
      await writeAudit({
        userId: req.user.id,
        action: 'campaign.submitted_for_approval',
        entityType: 'campaign',
        entityId: campaign.id,
        ip: req.ip,
      });
      const waiting = await loadCampaignOrThrow(campaign.id);
      return res.json({
        success: true,
        data: {
          message: 'Campaign submitted for admin approval',
          status: waiting.status,
          campaign: waiting,
        },
      });
    }

    // Drop any delayed schedule job, then start immediately
    await drainCampaignJobs(campaign.id, { removeScheduled: true });
    await query(
      `UPDATE campaigns
       SET status = 'queued',
           scheduled_at = NULL,
           started_at = COALESCE(started_at, NOW())
       WHERE id = :id`,
      { id: campaign.id }
    );
    await enqueueCampaign(Number(campaign.id));
    await refreshCampaignStatus(Number(campaign.id));
    await writeAudit({
      userId: req.user.id,
      action: 'campaign.launched',
      entityType: 'campaign',
      entityId: campaign.id,
      ip: req.ip,
    });

    const updated = await loadCampaignOrThrow(campaign.id);
    res.json({
      success: true,
      data: {
        message: 'Campaign launched immediately',
        status: updated.status,
        campaign: updated,
      },
    });
  })
);

router.post(
  '/:id/pause',
  asyncHandler(async (req, res) => {
    const campaign = await loadCampaignOrThrow(req.params.id);
    if (!PAUSABLE.includes(campaign.status)) {
      throw new AppError(`Cannot pause a campaign in status "${campaign.status}"`, 400, 'INVALID_STATE');
    }
    await query(`UPDATE campaigns SET status = 'paused' WHERE id = :id`, { id: campaign.id });
    await drainCampaignJobs(campaign.id, { removeScheduled: true });
    await refreshCampaignStatus(campaign.id);
    res.json({ success: true, data: { message: 'Campaign paused', status: 'paused' } });
    emitWorkspaceChanged({
      resource: 'campaigns',
      action: 'updated',
      actorUserId: req.user.id,
      entityId: Number(req.params.id),
      meta: { status: 'paused' },
    });
  })
);

router.post(
  '/:id/resume',
  asyncHandler(async (req, res) => {
    const campaign = await loadCampaignOrThrow(req.params.id);
    if (campaign.status !== 'paused') {
      throw new AppError('Campaign is not paused', 400, 'INVALID_STATE');
    }
    if (campaign.account_status !== 'connected') {
      throw new AppError('WhatsApp number is disconnected', 400, 'NUMBER_NOT_CONNECTED');
    }
    await query(`UPDATE campaigns SET status = 'queued' WHERE id = :id`, { id: campaign.id });
    await enqueueCampaignMessages(Number(campaign.id));
    await query(`UPDATE campaigns SET status = 'running' WHERE id = :id`, { id: campaign.id });
    await refreshCampaignStatus(campaign.id);
    res.json({ success: true, data: { message: 'Campaign resumed', status: 'running' } });
    emitWorkspaceChanged({
      resource: 'campaigns',
      action: 'updated',
      actorUserId: req.user.id,
      entityId: Number(req.params.id),
      meta: { status: 'running' },
    });
  })
);

router.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const campaign = await loadCampaignOrThrow(req.params.id);
    if (!CANCELLABLE.includes(campaign.status)) {
      throw new AppError(`Cannot cancel a campaign in status "${campaign.status}"`, 400, 'INVALID_STATE');
    }
    await query(
      `UPDATE campaigns SET status = 'cancelled', completed_at = NOW() WHERE id = :id`,
      { id: campaign.id }
    );
    await query(
      `UPDATE campaign_messages SET status = 'cancelled'
       WHERE campaign_id = :id AND status IN ('pending','queued')`,
      { id: campaign.id }
    );
    await drainCampaignJobs(campaign.id, { removeScheduled: true });
    await refreshCampaignStatus(Number(campaign.id));
    res.json({ success: true, data: { message: 'Campaign cancelled', status: 'cancelled' } });
    emitWorkspaceChanged({
      resource: 'campaigns',
      action: 'updated',
      actorUserId: req.user.id,
      entityId: Number(req.params.id),
      meta: { status: 'cancelled' },
    });
  })
);

router.post(
  '/:id/retry-failed',
  asyncHandler(async (req, res) => {
    const campaign = await loadCampaignOrThrow(req.params.id);
    if (['cancelled'].includes(campaign.status)) {
      throw new AppError('Cannot retry messages on a cancelled campaign', 400, 'INVALID_STATE');
    }
    // Only retry failures that never received a Meta message id
    const failed = await query(
      `SELECT id FROM campaign_messages
       WHERE campaign_id = :id AND status = 'failed' AND (wamid IS NULL OR wamid = '')`,
      { id: campaign.id }
    );
    if (!failed.length) throw new AppError('No eligible failed messages to retry', 400, 'NO_FAILED');

    await query(
      `UPDATE campaign_messages
       SET status = 'pending', error_code = NULL, error_message = NULL, failed_at = NULL
       WHERE campaign_id = :id AND status = 'failed' AND (wamid IS NULL OR wamid = '')`,
      { id: campaign.id }
    );
    await query(`UPDATE campaigns SET status = 'running' WHERE id = :id`, { id: campaign.id });
    const count = await enqueueCampaignMessages(
      Number(campaign.id),
      failed.map((f) => f.id)
    );
    await refreshCampaignStatus(Number(campaign.id));
    res.json({ success: true, data: { retried: count } });
  })
);

export default router;
