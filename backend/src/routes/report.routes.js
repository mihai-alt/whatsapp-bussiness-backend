import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { writeAudit } from '../services/audit.service.js';
import {
  exportCampaigns,
  exportMessages,
  exportRows,
  getCampaignReport,
  getFilterMeta,
  getMessagePerformance,
  getOverview,
  getUsage,
  listCampaigns,
  listFailed,
  listMessages,
  parseListParams,
  retryFailedMessages,
} from '../services/report.service.js';

const router = Router();
router.use(authenticate);

function filtersFrom(req) {
  return {
    range: req.query.range,
    from: req.query.from,
    to: req.query.to,
    whatsappAccountId: req.query.whatsappAccountId || req.query.whatsapp_account_id,
    campaignId: req.query.campaignId || req.query.campaign_id,
    templateId: req.query.templateId || req.query.template_id,
    status: req.query.status,
    campaignStatus: req.query.campaignStatus || req.query.campaign_status,
    search: req.query.search || req.query.q,
    groupBy: req.query.groupBy,
  };
}

router.get(
  '/meta',
  asyncHandler(async (req, res) => {
    const data = await getFilterMeta(req.user);
    res.json({ success: true, data });
  })
);

router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const data = await getOverview(req.user, filtersFrom(req));
    res.json({ success: true, data });
  })
);

router.get(
  '/message-performance',
  asyncHandler(async (req, res) => {
    const data = await getMessagePerformance(req.user, filtersFrom(req));
    res.json({ success: true, data });
  })
);

router.get(
  '/messages',
  asyncHandler(async (req, res) => {
    const paging = parseListParams(req.query);
    const data = await listMessages(req.user, filtersFrom(req), paging);
    res.json({
      success: true,
      data: data.rows,
      pagination: {
        page: data.page,
        limit: data.limit,
        total: data.total,
        totalPages: data.totalPages,
      },
      meta: { timezone: data.timezone },
    });
  })
);

router.get(
  '/messages/export',
  asyncHandler(async (req, res) => {
    const rows = await exportMessages(req.user, filtersFrom(req));
    await writeAudit({
      userId: req.user.id,
      action: 'report.messages_export',
      entityType: 'report',
      meta: { count: rows.length, format: req.query.format || 'csv' },
      ip: req.ip,
    });
    await exportRows({
      res,
      filename: `message-report-${Date.now()}`,
      format: req.query.format,
      columns: [
        { header: 'Phone', key: 'phone' },
        { header: 'Campaign', key: 'campaign_name' },
        { header: 'Template', key: 'template_name' },
        { header: 'Status', key: 'status' },
        { header: 'Sent At', key: 'sent_at' },
        { header: 'Delivered At', key: 'delivered_at' },
        { header: 'Read At', key: 'read_at' },
        { header: 'Failed At', key: 'failed_at' },
        { header: 'Error', key: 'error_message' },
        { header: 'Cost', key: 'cost' },
      ],
      rows,
    });
  })
);

router.get(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const paging = parseListParams(req.query);
    const data = await listCampaigns(req.user, filtersFrom(req), paging);
    res.json({
      success: true,
      data: data.rows,
      pagination: {
        page: data.page,
        limit: data.limit,
        total: data.total,
        totalPages: data.totalPages,
      },
      meta: { timezone: data.timezone },
    });
  })
);

router.get(
  '/campaigns/export',
  asyncHandler(async (req, res) => {
    const rows = await exportCampaigns(req.user, filtersFrom(req));
    await writeAudit({
      userId: req.user.id,
      action: 'report.campaigns_export',
      entityType: 'report',
      meta: { count: rows.length, format: req.query.format || 'csv' },
      ip: req.ip,
    });
    await exportRows({
      res,
      filename: `campaign-report-${Date.now()}`,
      format: req.query.format,
      columns: [
        { header: 'Campaign', key: 'name' },
        { header: 'Template', key: 'template_name' },
        { header: 'Contacts', key: 'contacts' },
        { header: 'Sent', key: 'sent' },
        { header: 'Delivered', key: 'delivered' },
        { header: 'Read', key: 'read' },
        { header: 'Failed', key: 'failed' },
        { header: 'Pending', key: 'pending' },
        { header: 'Cost', key: 'cost' },
        { header: 'Status', key: 'status' },
        { header: 'Created At', key: 'created_at' },
      ],
      rows,
    });
  })
);

router.get(
  '/campaigns/:id',
  asyncHandler(async (req, res) => {
    const data = await getCampaignReport(req.user, Number(req.params.id));
    res.json({ success: true, data });
  })
);

router.get(
  '/failed',
  asyncHandler(async (req, res) => {
    const paging = parseListParams(req.query);
    const data = await listFailed(req.user, filtersFrom(req), paging);
    res.json({
      success: true,
      data: data.rows,
      pagination: {
        page: data.page,
        limit: data.limit,
        total: data.total,
        totalPages: data.totalPages,
      },
      meta: { timezone: data.timezone },
    });
  })
);

router.get(
  '/failed/export',
  asyncHandler(async (req, res) => {
    const paging = { page: 1, limit: 50000, offset: 0 };
    const data = await listFailed(req.user, filtersFrom(req), paging);
    await writeAudit({
      userId: req.user.id,
      action: 'report.failed_export',
      entityType: 'report',
      meta: { count: data.rows.length, format: req.query.format || 'csv' },
      ip: req.ip,
    });
    await exportRows({
      res,
      filename: `failed-messages-${Date.now()}`,
      format: req.query.format,
      columns: [
        { header: 'Phone', key: 'phone' },
        { header: 'Campaign', key: 'campaign_name' },
        { header: 'Template', key: 'template_name' },
        { header: 'Error code', key: 'error_code' },
        { header: 'Error', key: 'error_message' },
        { header: 'Failed At', key: 'failed_at' },
      ],
      rows: data.rows,
    });
  })
);

router.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const data = await getUsage(req.user, filtersFrom(req));
    res.json({ success: true, data });
  })
);

router.get(
  '/usage/export',
  asyncHandler(async (req, res) => {
    const data = await getUsage(req.user, filtersFrom(req));
    await writeAudit({
      userId: req.user.id,
      action: 'report.usage_export',
      entityType: 'report',
      meta: { format: req.query.format || 'csv' },
      ip: req.ip,
    });
    await exportRows({
      res,
      filename: `usage-report-${Date.now()}`,
      format: req.query.format,
      columns: [
        { header: 'Date', key: 'date' },
        { header: 'Messages', key: 'messages' },
        { header: 'Sent', key: 'sent' },
        { header: 'Delivered', key: 'delivered' },
        { header: 'Failed', key: 'failed' },
        { header: 'Cost', key: 'cost' },
      ],
      rows: data.daily,
    });
  })
);

router.post(
  '/failed/retry',
  asyncHandler(async (req, res) => {
    const id = Number(req.body?.id || req.body?.messageId);
    const data = await retryFailedMessages(req.user, { ids: [id] }, req.ip);
    res.json({ success: true, data });
  })
);

router.post(
  '/failed/retry-selected',
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const data = await retryFailedMessages(req.user, { ids }, req.ip);
    res.json({ success: true, data });
  })
);

router.post(
  '/failed/retry-all',
  asyncHandler(async (req, res) => {
    const data = await retryFailedMessages(
      req.user,
      { all: true, filters: { ...filtersFrom(req), ...req.body?.filters } },
      req.ip
    );
    res.json({ success: true, data });
  })
);

export default router;
