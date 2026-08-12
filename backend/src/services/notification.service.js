import { query } from '../db/pool.js';
import { getIO } from '../realtime.js';

function emitToUser(userId, notification) {
  try {
    getIO()?.to(`user:${userId}`).emit('notification', notification);
  } catch {
    /* socket may not be ready */
  }
}

/**
 * Persist one notification for a single user. Rows are always user-scoped so
 * is_read is independent per recipient.
 */
export async function createNotification({ userId, type, title, body, meta = null }) {
  if (!userId) return null;

  const result = await query(
    `INSERT INTO notifications (user_id, type, title, body, meta)
     VALUES (:user_id, :type, :title, :body, :meta)`,
    {
      user_id: userId,
      type,
      title,
      body: body || null,
      meta: meta ? JSON.stringify(meta) : null,
    }
  );
  const notification = {
    id: result.insertId,
    user_id: userId,
    type,
    title,
    body,
    meta,
    is_read: 0,
    created_at: new Date().toISOString(),
  };
  emitToUser(userId, notification);
  return notification;
}

async function listActiveAdminIds() {
  const rows = await query(
    `SELECT id FROM users
     WHERE role = 'admin' AND is_active = 1 AND email_verified = 1`
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Project event fan-out:
 * - Every active admin receives the notification (unless they are the actor).
 * - Related members (e.g. share target, campaign owner for outcomes) also receive it.
 * - The actor who caused the event never receives their own notification.
 */
export async function notifyProjectEvent({
  type,
  title,
  body,
  meta = null,
  relatedUserIds = [],
  excludeUserIds = [],
  actorUserId = null,
}) {
  const adminIds = await listActiveAdminIds();
  const related = (relatedUserIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const excluded = new Set(
    [...(excludeUserIds || []), actorUserId]
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0)
  );

  const recipientIds = [...new Set([...adminIds, ...related])].filter((id) => !excluded.has(id));
  const created = [];
  for (const userId of recipientIds) {
    const row = await createNotification({ userId, type, title, body, meta });
    if (row) created.push(row);
  }
  return created;
}

/** Notify only the given users (no automatic admin fan-out). */
export async function notifyUsers(userIds, { type, title, body, meta = null } = {}) {
  const ids = [...new Set((userIds || []).map((id) => Number(id)).filter((id) => id > 0))];
  const created = [];
  for (const userId of ids) {
    const row = await createNotification({ userId, type, title, body, meta });
    if (row) created.push(row);
  }
  return created;
}

export async function listNotifications({ userId, page = 1, limit = 30 } = {}) {
  const offset = (page - 1) * limit;
  const rows = await query(
    `SELECT * FROM notifications
     WHERE user_id = :user_id
     ORDER BY id DESC LIMIT :limit OFFSET :offset`,
    { user_id: userId, limit, offset }
  );
  return rows;
}

export async function countUnreadNotifications(userId) {
  const rows = await query(
    `SELECT COUNT(*) AS c FROM notifications
     WHERE user_id = :user_id AND is_read = 0`,
    { user_id: userId }
  );
  return Number(rows[0]?.c || 0);
}

export async function markNotificationRead(id, userId) {
  await query(
    `UPDATE notifications SET is_read = 1
     WHERE id = :id AND user_id = :user_id`,
    { id, user_id: userId }
  );
}

export async function markAllRead(userId) {
  await query(
    `UPDATE notifications SET is_read = 1
     WHERE is_read = 0 AND user_id = :user_id`,
    { user_id: userId }
  );
}
