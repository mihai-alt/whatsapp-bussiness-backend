import { query } from '../db/pool.js';

export async function writeAudit({
  userId = null,
  action,
  entityType = null,
  entityId = null,
  meta = null,
  ip = null,
} = {}) {
  if (!action) return;
  try {
    await query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, meta, ip)
       VALUES (:user_id, :action, :entity_type, :entity_id, :meta, :ip)`,
      {
        user_id: userId || null,
        action: String(action).slice(0, 128),
        entity_type: entityType ? String(entityType).slice(0, 64) : null,
        entity_id: entityId != null ? String(entityId).slice(0, 64) : null,
        meta: meta ? JSON.stringify(meta) : null,
        ip: ip ? String(ip).slice(0, 64) : null,
      }
    );
  } catch (err) {
    console.warn('audit write skipped:', err.message);
  }
}

export async function listAuditLogs({ page = 1, limit = 50 } = {}) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;

  const rows = await query(
    `SELECT a.id, a.user_id, u.email AS user_email, u.name AS user_name,
            a.action, a.entity_type, a.entity_id, a.meta, a.ip, a.created_at
     FROM audit_logs a
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.id DESC
     LIMIT :limit OFFSET :offset`,
    { limit: safeLimit, offset }
  );

  const totalRows = await query(`SELECT COUNT(*) AS c FROM audit_logs`);
  return {
    rows: rows.map((r) => ({
      ...r,
      meta: typeof r.meta === 'string' ? safeJson(r.meta) : r.meta,
    })),
    page: safePage,
    limit: safeLimit,
    total: Number(totalRows[0]?.c || 0),
  };
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
