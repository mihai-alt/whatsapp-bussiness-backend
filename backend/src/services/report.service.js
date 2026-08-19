import ExcelJS from 'exceljs';
import { query } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { getWallet } from './wallet.service.js';
import { enqueueCampaignMessages, refreshCampaignStatus } from '../queues/campaign.queue.js';
import { writeAudit } from './audit.service.js';
import { emitWorkspaceChanged } from '../realtime.js';

export const REPORT_TZ = 'Asia/Kolkata';

const SENT_STATUSES = `cm.status IN ('sent','delivered','read')`;
const PENDING_STATUSES = `cm.status IN ('pending','queued')`;

export function isAdminUser(user) {
  return user?.role === 'admin';
}

export function ymdInTimeZone(date = new Date(), timeZone = REPORT_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function tzOffsetMs(timeZone, at = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUTC - at.getTime();
}

export function zonedDayStartUtc(ymd, timeZone = REPORT_TZ) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  return new Date(guess.getTime() - tzOffsetMs(timeZone, guess));
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function sqlBucketExpr(column, group, timeZone = REPORT_TZ) {
  const shift = timeZone === 'Asia/Kolkata' || timeZone === 'Asia/Calcutta'
    ? `DATE_ADD(${column}, INTERVAL 330 MINUTE)`
    : column;
  if (group === 'hour') return `DATE_FORMAT(${shift}, '%Y-%m-%d %H:00')`;
  if (group === 'week') return `DATE_FORMAT(${shift}, '%x-W%v')`;
  return `DATE(${shift})`;
}

const MSG_STATUSES = new Set(['pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'cancelled']);

export function resolveDateRange(queryParams = {}, timeZone = REPORT_TZ) {
  const preset = String(queryParams.range || queryParams.preset || 'last_7_days').toLowerCase();
  const today = ymdInTimeZone(new Date(), timeZone);
  let fromYmd = queryParams.from ? String(queryParams.from).slice(0, 10) : null;
  let toYmd = queryParams.to ? String(queryParams.to).slice(0, 10) : null;

  if (preset === 'all' || preset === 'lifetime') {
    const fromUtc = new Date(Date.UTC(2000, 0, 1));
    const toExclusive = zonedDayStartUtc(addDaysYmd(today, 1), timeZone);
    return {
      preset: 'all',
      fromYmd: '2000-01-01',
      toYmd: today,
      fromUtc,
      toExclusive,
      prevFrom: fromUtc,
      prevTo: fromUtc,
      timeZone,
    };
  }

  if (preset === 'today') {
    fromYmd = today;
    toYmd = today;
  } else if (preset === 'yesterday') {
    fromYmd = addDaysYmd(today, -1);
    toYmd = fromYmd;
  } else if (preset === 'last_7_days' || preset === '7d') {
    fromYmd = addDaysYmd(today, -6);
    toYmd = today;
  } else if (preset === 'last_30_days' || preset === '30d') {
    fromYmd = addDaysYmd(today, -29);
    toYmd = today;
  } else if (preset === 'custom') {
    fromYmd = fromYmd || today;
    toYmd = toYmd || today;
  } else if (!fromYmd || !toYmd) {
    fromYmd = addDaysYmd(today, -6);
    toYmd = today;
  }

  if (fromYmd > toYmd) {
    const swap = fromYmd;
    fromYmd = toYmd;
    toYmd = swap;
  }

  const fromUtc = zonedDayStartUtc(fromYmd, timeZone);
  const toExclusive = zonedDayStartUtc(addDaysYmd(toYmd, 1), timeZone);
  const days = Math.max(1, Math.round((toExclusive - fromUtc) / 86400000));
  const prevTo = fromUtc;
  const prevFrom = new Date(fromUtc.getTime() - days * 86400000);

  return {
    preset,
    fromYmd,
    toYmd,
    fromUtc,
    toExclusive,
    prevFrom,
    prevTo,
    timeZone,
  };
}

function sqlDate(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 6) return '******';
  return `${digits.slice(0, 2)}******${digits.slice(-4)}`;
}

function num(v) {
  return Number(v || 0);
}

function pct(part, whole) {
  const w = num(whole);
  if (!w) return 0;
  return Math.round((num(part) / w) * 1000) / 10;
}

function deltaPct(current, previous) {
  const prev = num(previous);
  const cur = num(current);
  if (!prev && !cur) return 0;
  if (!prev) return 100;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

export function parseListParams(reqQuery = {}) {
  const page = Math.max(1, Number(reqQuery.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(reqQuery.limit) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

export function buildReportScope(user, filters = {}, { alias = 'c' } = {}) {
  const params = {};
  const clauses = ['1=1'];
  if (!isAdminUser(user)) {
    clauses.push(`${alias}.created_by = :scopeUserId`);
    params.scopeUserId = user.id;
  }
  const accountId = Number(filters.whatsappAccountId || filters.whatsapp_account_id || 0);
  if (accountId > 0) {
    clauses.push(`${alias}.whatsapp_account_id = :whatsappAccountId`);
    params.whatsappAccountId = accountId;
  }
  const campaignId = Number(filters.campaignId || filters.campaign_id || 0);
  if (campaignId > 0) {
    clauses.push(`${alias}.id = :campaignId`);
    params.campaignId = campaignId;
  }
  const templateId = Number(filters.templateId || filters.template_id || 0);
  if (templateId > 0) {
    clauses.push(`${alias}.template_id = :templateId`);
    params.templateId = templateId;
  }
  const campaignStatus = String(filters.campaignStatus || filters.campaign_status || '').trim();
  if (campaignStatus) {
    clauses.push(`${alias}.status = :campaignStatus`);
    params.campaignStatus = campaignStatus;
  }
  return { sql: clauses.join(' AND '), params };
}

export function buildMessageFilters(user, filters = {}, range) {
  const scope = buildReportScope(user, filters, { alias: 'c' });
  const params = {
    ...scope.params,
    fromUtc: sqlDate(range.fromUtc),
    toExclusive: sqlDate(range.toExclusive),
  };
  const clauses = [
    scope.sql,
    'cm.created_at >= :fromUtc',
    'cm.created_at < :toExclusive',
  ];
  const status = String(filters.status || '').trim().toLowerCase();
  if (status && status !== 'all' && MSG_STATUSES.has(status)) {
    if (status === 'pending') {
      clauses.push(`cm.status IN ('pending','queued')`);
    } else {
      clauses.push('cm.status = :msgStatus');
      params.msgStatus = status;
    }
  }
  const search = String(filters.search || filters.q || '').trim();
  if (search) {
    clauses.push(
      `(cm.phone LIKE :search OR c.name LIKE :search OR t.name LIKE :search OR cm.error_message LIKE :search)`
    );
    params.search = `%${search}%`;
  }
  return { sql: clauses.join(' AND '), params };
}

function totalsFromRow(row = {}) {
  const sent = num(row.sent);
  const delivered = num(row.delivered);
  const read = num(row.read);
  const failed = num(row.failed);
  const pending = num(row.pending);
  const total = num(row.total) || sent + failed + pending;
  return {
    sent,
    delivered,
    read,
    failed,
    pending,
    total,
    total_cost: num(row.total_cost),
    delivery_rate: pct(delivered + read, sent || total),
    read_rate: pct(read, sent || total),
    failure_rate: pct(failed, total),
    pending_rate: pct(pending, total),
  };
}

const SUMMARY_SELECT = `
  SUM(${SENT_STATUSES}) AS sent,
  SUM(cm.status IN ('delivered','read')) AS delivered,
  SUM(cm.status = 'delivered') AS delivered_only,
  SUM(cm.status = 'sent') AS sent_only,
  SUM(cm.status = 'read') AS \`read\`,
  SUM(cm.status = 'failed') AS failed,
  SUM(${PENDING_STATUSES}) AS pending,
  COUNT(*) AS total,
  SUM(cm.cost) AS total_cost
`;

export async function getFilterMeta(user) {
  const scope = buildReportScope(user, {}, { alias: 'c' });
  const [accounts, campaigns, templates] = await Promise.all([
    query(
      `SELECT id, phone_number, business_name, status
       FROM whatsapp_accounts
       WHERE status = 'connected'
       ORDER BY id DESC`
    ),
    query(
      `SELECT c.id, c.name, c.status
       FROM campaigns c
       WHERE ${scope.sql}
       ORDER BY c.id DESC
       LIMIT 300`,
      scope.params
    ),
    query(
      `SELECT DISTINCT t.id, t.name
       FROM campaigns c
       JOIN templates t ON t.id = c.template_id
       WHERE ${scope.sql}
       ORDER BY t.name ASC
       LIMIT 200`,
      scope.params
    ),
  ]);
  return { accounts, campaigns, templates, timezone: REPORT_TZ };
}

export async function getOverview(user, filters) {
  const tz = user?.timezone || REPORT_TZ;
  const range = resolveDateRange(filters, tz);
  const current = buildMessageFilters(user, filters, range);
  const prevRange = {
    fromUtc: range.prevFrom,
    toExclusive: range.prevTo,
  };
  const previous = buildMessageFilters(user, { ...filters, search: '' }, prevRange);

  const [nowRows, prevRows, campaignRows, failedRows, wallet] = await Promise.all([
    query(
      `SELECT ${SUMMARY_SELECT}
       FROM campaign_messages cm
       JOIN campaigns c ON c.id = cm.campaign_id
       LEFT JOIN templates t ON t.id = c.template_id
       WHERE ${current.sql}`,
      current.params
    ),
    query(
      `SELECT ${SUMMARY_SELECT}
       FROM campaign_messages cm
       JOIN campaigns c ON c.id = cm.campaign_id
       LEFT JOIN templates t ON t.id = c.template_id
       WHERE ${previous.sql}`,
      previous.params
    ),
    listCampaignRows(user, filters, range, { page: 1, limit: 5 }),
    listFailedRows(user, filters, range, { page: 1, limit: 5 }),
    getWallet(),
  ]);

  const kpis = totalsFromRow(nowRows[0]);
  const prev = totalsFromRow(prevRows[0]);
  return {
    timezone: tz,
    range: { preset: range.preset, from: range.fromYmd, to: range.toYmd },
    kpis: {
      ...kpis,
      sent_delta: deltaPct(kpis.sent, prev.sent),
      delivered_delta: deltaPct(kpis.delivered, prev.delivered),
      read_delta: deltaPct(kpis.read, prev.read),
      failed_delta: deltaPct(kpis.failed, prev.failed),
      pending_delta: deltaPct(kpis.pending, prev.pending),
      cost_delta: deltaPct(kpis.total_cost, prev.total_cost),
    },
    distribution: {
      delivered: kpis.delivered,
      delivered_only: num(nowRows[0]?.delivered_only),
      sent_only: num(nowRows[0]?.sent_only),
      read: kpis.read,
      failed: kpis.failed,
      pending: kpis.pending,
      total: kpis.total,
    },
    campaigns: campaignRows.rows,
    failed: failedRows.rows,
    wallet: {
      balance: num(wallet?.balance),
      currency: wallet?.currency || 'INR',
      spent: kpis.total_cost,
      remaining: num(wallet?.balance),
      used_pct: pct(kpis.total_cost, num(wallet?.balance) + kpis.total_cost),
    },
  };
}

export async function getMessagePerformance(user, filters) {
  const tz = user?.timezone || REPORT_TZ;
  const range = resolveDateRange(filters, tz);
  const scoped = buildMessageFilters(user, filters, range);
  const group = String(filters.groupBy || 'day').toLowerCase();
  const bucketExpr = sqlBucketExpr('cm.created_at', group, tz);

  const rows = await query(
    `SELECT ${bucketExpr} AS bucket,
            SUM(${SENT_STATUSES}) AS sent,
            SUM(cm.status IN ('delivered','read')) AS delivered,
            SUM(cm.status = 'read') AS \`read\`,
            SUM(cm.status = 'failed') AS failed,
            SUM(${PENDING_STATUSES}) AS pending
     FROM campaign_messages cm
     JOIN campaigns c ON c.id = cm.campaign_id
     LEFT JOIN templates t ON t.id = c.template_id
     WHERE ${scoped.sql}
     GROUP BY bucket
     ORDER BY bucket ASC`,
    scoped.params
  );

  return {
    groupBy: group === 'hour' || group === 'week' ? group : 'day',
    timezone: tz,
    data: rows.map((r) => ({
      date: r.bucket,
      sent: num(r.sent),
      delivered: num(r.delivered),
      read: num(r.read),
      failed: num(r.failed),
      pending: num(r.pending),
    })),
  };
}

async function listCampaignRows(user, filters, range, paging) {
  const limit = paging.limit || 25;
  const offset = paging.offset ?? (Math.max(1, paging.page || 1) - 1) * limit;
  const scope = buildReportScope(user, filters, { alias: 'c' });
  const params = {
    ...scope.params,
    fromUtc: sqlDate(range.fromUtc),
    toExclusive: sqlDate(range.toExclusive),
    limit,
    offset,
  };
  const search = String(filters.search || filters.q || '').trim();
  let extra = '';
  if (search) {
    extra = ' AND (c.name LIKE :search OR t.name LIKE :search)';
    params.search = `%${search}%`;
  }
  let joinStatus = '';
  const status = String(filters.status || '').trim().toLowerCase();
  if (status && status !== 'all' && MSG_STATUSES.has(status)) {
    if (status === 'pending') {
      joinStatus = ` AND cm.status IN ('pending','queued')`;
    } else {
      joinStatus = ' AND cm.status = :msgStatus';
      params.msgStatus = status;
    }
  }
  const having = status && status !== 'all' && MSG_STATUSES.has(status)
    ? 'HAVING COUNT(cm.id) > 0'
    : 'HAVING COUNT(cm.id) > 0 OR (c.created_at >= :fromUtc AND c.created_at < :toExclusive)';
  const fromSql = `
     FROM campaigns c
     LEFT JOIN campaign_messages cm
       ON cm.campaign_id = c.id
      AND cm.created_at >= :fromUtc
      AND cm.created_at < :toExclusive
      ${joinStatus}
     LEFT JOIN templates t ON t.id = c.template_id
     LEFT JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
     WHERE ${scope.sql}${extra}
     GROUP BY c.id, c.name, c.status, c.total_count, c.created_at, c.completed_at, c.started_at,
              t.name, t.id, wa.phone_number, wa.id
     ${having}`;
  const totalRows = await query(`SELECT COUNT(*) AS c FROM (SELECT c.id ${fromSql}) grouped_campaigns`, params);
  const rows = await query(
    `SELECT c.id, c.name, c.status, c.total_count, c.created_at, c.completed_at, c.started_at,
            t.name AS template_name, t.id AS template_id,
            wa.phone_number, wa.id AS whatsapp_account_id,
            COUNT(cm.id) AS period_messages,
            SUM(${SENT_STATUSES}) AS sent,
            SUM(cm.status IN ('delivered','read')) AS delivered,
            SUM(cm.status = 'read') AS \`read\`,
            SUM(cm.status = 'failed') AS failed,
            SUM(${PENDING_STATUSES}) AS pending,
            SUM(cm.cost) AS cost
     ${fromSql}
     ORDER BY c.id DESC
     LIMIT :limit OFFSET :offset`,
    params
  );
  return {
    rows: rows.map((r) => ({
      ...r,
      contacts: num(r.total_count),
      sent: num(r.sent),
      delivered: num(r.delivered),
      read: num(r.read),
      failed: num(r.failed),
      pending: num(r.pending),
      cost: num(r.cost),
      delivery_rate: pct(num(r.delivered), num(r.sent) || num(r.total_count)),
      read_rate: pct(r.read, num(r.sent) || num(r.total_count)),
    })),
    total: num(totalRows[0]?.c),
  };
}

export async function listCampaigns(user, filters, paging) {
  const tz = user?.timezone || REPORT_TZ;
  const range = resolveDateRange(filters, tz);
  const result = await listCampaignRows(user, filters, range, paging);
  return {
    ...result,
    page: paging.page,
    limit: paging.limit,
    totalPages: Math.max(1, Math.ceil(result.total / paging.limit)),
    timezone: tz,
  };
}

export async function getCampaignReport(user, campaignId) {
  const scope = buildReportScope(user, {}, { alias: 'c' });
  const rows = await query(
    `SELECT c.*, t.name AS template_name, t.status AS template_status, t.category,
            wa.phone_number, wa.business_name
     FROM campaigns c
     LEFT JOIN templates t ON t.id = c.template_id
     LEFT JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
     WHERE c.id = :id AND ${scope.sql}
     LIMIT 1`,
    { ...scope.params, id: campaignId }
  );
  if (!rows.length) throw new AppError('Campaign not found', 404, 'NOT_FOUND');
  const c = rows[0];
  const start = c.started_at ? new Date(c.started_at) : c.created_at ? new Date(c.created_at) : null;
  const end = c.completed_at ? new Date(c.completed_at) : c.status === 'running' ? new Date() : null;
  const durationMs = start && end ? Math.max(0, end - start) : 0;
  const processed = num(c.sent_count) + num(c.failed_count);
  const minutes = durationMs / 60000;
  return {
    campaign: {
      id: c.id,
      name: c.name,
      status: c.status,
      template: c.template_name,
      template_status: c.template_status,
      phone_number: c.phone_number,
      business_name: c.business_name,
      created_at: c.created_at,
      started_at: c.started_at,
      completed_at: c.completed_at,
      recipients: num(c.total_count),
      sent: num(c.sent_count),
      delivered: num(c.delivered_count),
      read: num(c.read_count),
      failed: num(c.failed_count),
      pending: num(c.pending_count),
      total_cost: num(c.total_cost),
      delivery_rate: pct(num(c.delivered_count) + num(c.read_count), num(c.sent_count) || num(c.total_count)),
      read_rate: pct(c.read_count, num(c.sent_count) || num(c.total_count)),
      failure_rate: pct(c.failed_count, c.total_count),
      processed,
      progress_pct: pct(processed, c.total_count),
      messages_per_minute: minutes > 0 ? Math.round((processed / minutes) * 10) / 10 : 0,
      processing_ms: durationMs,
    },
  };
}

const MESSAGE_SELECT = `
  cm.id, cm.phone, cm.status, cm.cost, cm.error_code, cm.error_message, cm.wamid,
  cm.sent_at, cm.delivered_at, cm.read_at, cm.failed_at, cm.created_at,
  c.id AS campaign_id, c.name AS campaign_name, c.status AS campaign_status,
  t.name AS template_name, wa.phone_number AS whatsapp_number
`;

function mapMessageRow(r) {
  return {
    ...r,
    phone: maskPhone(r.phone),
    phone_raw_length: String(r.phone || '').length,
    cost: num(r.cost),
  };
}

export async function listMessages(user, filters, paging) {
  const tz = user?.timezone || REPORT_TZ;
  const range = resolveDateRange(filters, tz);
  const scoped = buildMessageFilters(user, filters, range);
  const params = { ...scoped.params, limit: paging.limit, offset: paging.offset };
  const totalRows = await query(
    `SELECT COUNT(*) AS c
     FROM campaign_messages cm
     JOIN campaigns c ON c.id = cm.campaign_id
     LEFT JOIN templates t ON t.id = c.template_id
     WHERE ${scoped.sql}`,
    scoped.params
  );
  const rows = await query(
    `SELECT ${MESSAGE_SELECT}
     FROM campaign_messages cm
     JOIN campaigns c ON c.id = cm.campaign_id
     LEFT JOIN templates t ON t.id = c.template_id
     LEFT JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
     WHERE ${scoped.sql}
     ORDER BY cm.id DESC
     LIMIT :limit OFFSET :offset`,
    params
  );
  const total = num(totalRows[0]?.c);
  return {
    rows: rows.map(mapMessageRow),
    page: paging.page,
    limit: paging.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / paging.limit) || 1),
    timezone: tz,
  };
}

async function listFailedRows(user, filters, range, paging) {
  const limit = paging.limit || 25;
  const offset = paging.offset ?? (Math.max(1, paging.page || 1) - 1) * limit;
  const scoped = buildMessageFilters(user, { ...filters, status: 'failed' }, range);
  const params = { ...scoped.params, limit, offset };
  const totalRows = await query(
    `SELECT COUNT(*) AS c
     FROM campaign_messages cm
     JOIN campaigns c ON c.id = cm.campaign_id
     LEFT JOIN templates t ON t.id = c.template_id
     WHERE ${scoped.sql}`,
    scoped.params
  );
  const rows = await query(
    `SELECT ${MESSAGE_SELECT},
            (cm.wamid IS NULL OR cm.wamid = '') AS retryable
     FROM campaign_messages cm
     JOIN campaigns c ON c.id = cm.campaign_id
     LEFT JOIN templates t ON t.id = c.template_id
     LEFT JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
     WHERE ${scoped.sql}
     ORDER BY COALESCE(cm.failed_at, cm.updated_at) DESC, cm.id DESC
     LIMIT :limit OFFSET :offset`,
    params
  );
  return {
    rows: rows.map((r) => ({ ...mapMessageRow(r), retryable: Boolean(Number(r.retryable)) })),
    total: num(totalRows[0]?.c),
  };
}

export async function listFailed(user, filters, paging) {
  const tz = user?.timezone || REPORT_TZ;
  const range = resolveDateRange(filters, tz);
  const result = await listFailedRows(user, filters, range, paging);
  return {
    ...result,
    page: paging.page,
    limit: paging.limit,
    totalPages: Math.max(1, Math.ceil(result.total / paging.limit) || 1),
    timezone: tz,
  };
}

export async function getUsage(user, filters) {
  const tz = user?.timezone || REPORT_TZ;
  const range = resolveDateRange(filters, tz);
  const scoped = buildMessageFilters(user, filters, range);
  const todayRange = resolveDateRange({ range: 'today' }, tz);
  const weekRange = resolveDateRange({ range: 'last_7_days' }, tz);
  const monthRange = resolveDateRange({ range: 'last_30_days' }, tz);

  const summarize = async (r) => {
    const f = buildMessageFilters(user, { ...filters, search: '' }, r);
    const rows = await query(
      `SELECT ${SUMMARY_SELECT}
       FROM campaign_messages cm
       JOIN campaigns c ON c.id = cm.campaign_id
       LEFT JOIN templates t ON t.id = c.template_id
       WHERE ${f.sql}`,
      f.params
    );
    return totalsFromRow(rows[0]);
  };

  const [current, today, week, month, daily, wallet] = await Promise.all([
    summarize(range),
    summarize(todayRange),
    summarize(weekRange),
    summarize(monthRange),
    query(
      `SELECT ${sqlBucketExpr('cm.created_at', 'day', tz)} AS day,
              COUNT(*) AS messages,
              SUM(${SENT_STATUSES}) AS sent,
              SUM(cm.status IN ('delivered','read')) AS delivered,
              SUM(cm.status = 'failed') AS failed,
              SUM(cm.cost) AS cost
       FROM campaign_messages cm
       JOIN campaigns c ON c.id = cm.campaign_id
       LEFT JOIN templates t ON t.id = c.template_id
       WHERE ${scoped.sql}
       GROUP BY day
       ORDER BY day ASC`,
      scoped.params
    ),
    getWallet(),
  ]);

  const avg = current.total ? Math.round((current.total_cost / current.total) * 10000) / 10000 : 0;
  return {
    timezone: tz,
    totals: {
      messages: current.total,
      cost: current.total_cost,
      today_cost: today.total_cost,
      week_cost: week.total_cost,
      month_cost: month.total_cost,
      avg_cost: avg,
    },
    wallet: {
      balance: num(wallet?.balance),
      spent: current.total_cost,
      remaining: num(wallet?.balance),
    },
    daily: daily.map((r) => ({
      date: r.day,
      messages: num(r.messages),
      sent: num(r.sent),
      delivered: num(r.delivered),
      failed: num(r.failed),
      cost: num(r.cost),
    })),
  };
}

async function loadRetryCandidates(user, ids) {
  const scope = buildReportScope(user, {}, { alias: 'c' });
  const placeholders = ids.map((_, i) => `:id${i}`).join(',');
  const params = { ...scope.params };
  ids.forEach((id, i) => {
    params[`id${i}`] = id;
  });
  return query(
    `SELECT cm.id, cm.campaign_id, cm.phone, cm.status, cm.wamid, cm.variables,
            c.status AS campaign_status, c.created_by, c.cost_per_message,
            t.status AS template_status, t.name AS template_name
     FROM campaign_messages cm
     JOIN campaigns c ON c.id = cm.campaign_id
     LEFT JOIN templates t ON t.id = c.template_id
     WHERE cm.id IN (${placeholders}) AND ${scope.sql}`,
    params
  );
}

export async function retryFailedMessages(user, { ids = [], all = false, filters = {} } = {}, ip) {
  let targetIds = (ids || []).map(Number).filter((n) => n > 0);
  if (all) {
    const tz = user?.timezone || REPORT_TZ;
    const range = resolveDateRange(filters, tz);
    const scoped = buildMessageFilters(user, { ...filters, status: 'failed' }, range);
    const rows = await query(
      `SELECT cm.id
       FROM campaign_messages cm
       JOIN campaigns c ON c.id = cm.campaign_id
       LEFT JOIN templates t ON t.id = c.template_id
       WHERE ${scoped.sql}
         AND (cm.wamid IS NULL OR cm.wamid = '')
       ORDER BY cm.id ASC
       LIMIT 2000`,
      scoped.params
    );
    targetIds = rows.map((r) => Number(r.id));
  }
  if (!targetIds.length) {
    throw new AppError('No failed messages selected', 400, 'NO_FAILED');
  }

  const rows = await loadRetryCandidates(user, targetIds);
  const skipped = [];
  const eligible = [];
  for (const row of rows) {
    if (row.status !== 'failed') {
      skipped.push({ id: row.id, reason: 'Message is not failed' });
      continue;
    }
    if (row.wamid) {
      skipped.push({ id: row.id, reason: 'Already accepted by Meta; cannot resend' });
      continue;
    }
    if (row.campaign_status === 'cancelled') {
      skipped.push({ id: row.id, reason: 'Campaign is cancelled' });
      continue;
    }
    if (!row.phone) {
      skipped.push({ id: row.id, reason: 'Missing recipient' });
      continue;
    }
    const tmpl = String(row.template_status || '').toUpperCase();
    if (tmpl && tmpl !== 'APPROVED') {
      skipped.push({ id: row.id, reason: 'Template is not approved' });
      continue;
    }
    eligible.push(row);
  }

  if (!eligible.length) {
    throw new AppError(skipped[0]?.reason || 'No eligible failed messages to retry', 400, 'NO_ELIGIBLE');
  }

  const wallet = await getWallet();
  const estimated = eligible.reduce((s, r) => s + num(r.cost_per_message), 0);
  if (num(wallet.balance) < estimated) {
    throw new AppError('Insufficient wallet balance to retry these messages', 402, 'INSUFFICIENT_BALANCE');
  }

  const byCampaign = new Map();
  for (const row of eligible) {
    const list = byCampaign.get(row.campaign_id) || [];
    list.push(row.id);
    byCampaign.set(row.campaign_id, list);
  }

  let retried = 0;
  for (const [campaignId, messageIds] of byCampaign.entries()) {
    await query(
      `UPDATE campaign_messages
       SET status = 'pending', error_code = NULL, error_message = NULL, failed_at = NULL
       WHERE campaign_id = :campaignId
         AND id IN (${messageIds.map((_, i) => `:m${i}`).join(',')})
         AND status = 'failed'
         AND (wamid IS NULL OR wamid = '')`,
      Object.fromEntries([['campaignId', campaignId], ...messageIds.map((id, i) => [`m${i}`, id])])
    );
    await query(
      `UPDATE campaigns SET status = 'running' WHERE id = :id AND status NOT IN ('cancelled')`,
      { id: campaignId }
    );
    retried += await enqueueCampaignMessages(Number(campaignId), messageIds);
    await refreshCampaignStatus(Number(campaignId));
  }

  emitWorkspaceChanged({
    resource: 'campaigns',
    action: 'updated',
    actorUserId: user.id,
    meta: { source: 'report_retry', retried },
  });

  await writeAudit({
    userId: user.id,
    action: all ? 'report.failed_retry_all' : 'report.failed_retry',
    entityType: 'campaign_message',
    entityId: eligible[0]?.id,
    meta: { retried, skipped: skipped.length, ids: eligible.map((r) => r.id).slice(0, 50) },
    ip,
  });

  return { retried, skipped, requested: targetIds.length };
}

export async function exportRows({ res, filename, columns, rows, format }) {
  const kind = String(format || 'csv').toLowerCase();
  if (kind === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Report');
    sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: 18 }));
    rows.forEach((row) => sheet.addRow(row));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
    return;
  }
  const header = columns.map((c) => csvCell(c.header)).join(',');
  const body = rows.map((row) => columns.map((c) => csvCell(row[c.key])).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(`${header}\n${body}`);
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function exportMessages(user, filters, format) {
  const tz = user?.timezone || REPORT_TZ;
  const range = resolveDateRange(filters, tz);
  const scoped = buildMessageFilters(user, filters, range);
  const rows = await query(
    `SELECT ${MESSAGE_SELECT}
     FROM campaign_messages cm
     JOIN campaigns c ON c.id = cm.campaign_id
     LEFT JOIN templates t ON t.id = c.template_id
     LEFT JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
     WHERE ${scoped.sql}
     ORDER BY cm.id DESC
     LIMIT 50000`,
    scoped.params
  );
  return rows.map(mapMessageRow);
}

export async function exportCampaigns(user, filters) {
  const tz = user?.timezone || REPORT_TZ;
  const range = resolveDateRange(filters, tz);
  const result = await listCampaignRows(user, filters, range, { page: 1, limit: 50000, offset: 0 });
  return result.rows;
}
