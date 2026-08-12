import { config } from '../config.js';
import { AppError } from '../middleware/error.js';
import { withTransaction, query } from '../db/pool.js';
import { notifyProjectEvent } from './notification.service.js';

/**
 * ONE authoritative business/organization wallet.
 * user_id IS NULL marks the shared business wallet row.
 */
export async function getBusinessWallet(conn) {
  const selectSql = `
    SELECT id, user_id, balance, currency, updated_at
    FROM wallets
    WHERE user_id IS NULL
    ORDER BY id ASC
    LIMIT 1
  `;

  if (conn) {
    let [rows] = await conn.execute(selectSql);
    if (rows.length) return rows[0];

    // Fallback: adopt oldest wallet as business wallet
    const [any] = await conn.execute(
      `SELECT id, user_id, balance, currency, updated_at FROM wallets ORDER BY id ASC LIMIT 1`
    );
    if (any.length) {
      await conn.execute(`UPDATE wallets SET user_id = NULL WHERE id = :id`, { id: any[0].id });
      return { ...any[0], user_id: null };
    }

    await conn.execute(
      `INSERT INTO wallets (user_id, balance, currency) VALUES (NULL, 0, :currency)`,
      { currency: config.wallet.currency || 'INR' }
    );
    [rows] = await conn.execute(selectSql);
    return rows[0];
  }

  let rows = await query(selectSql);
  if (rows.length) return rows[0];

  const any = await query(
    `SELECT id, user_id, balance, currency, updated_at FROM wallets ORDER BY id ASC LIMIT 1`
  );
  if (any.length) {
    await query(`UPDATE wallets SET user_id = NULL WHERE id = :id`, { id: any[0].id });
    return { ...any[0], user_id: null };
  }

  await query(`INSERT INTO wallets (user_id, balance, currency) VALUES (NULL, 0, :currency)`, {
    currency: config.wallet.currency || 'INR',
  });
  rows = await query(selectSql);
  return rows[0];
}

/** @deprecated use getBusinessWallet — kept for call-site compatibility */
export async function ensureUserWallet(_userId, conn) {
  return getBusinessWallet(conn);
}

/** Shared business wallet (userId ignored — one org balance). */
export async function getWallet(_userId) {
  return getBusinessWallet();
}

export async function getMessagePricing(category = 'DEFAULT') {
  const rows = await query(
    'SELECT category, cost, provider_cost FROM message_pricing WHERE category = :category LIMIT 1',
    { category }
  );
  if (rows.length) {
    return {
      category: rows[0].category,
      cost: Number(rows[0].cost),
      providerCost: Number(rows[0].provider_cost || 0),
    };
  }
  const fallback = await query(
    `SELECT category, cost, provider_cost FROM message_pricing WHERE category = 'DEFAULT' LIMIT 1`
  );
  if (fallback.length) {
    return {
      category: 'DEFAULT',
      cost: Number(fallback[0].cost),
      providerCost: Number(fallback[0].provider_cost || 0),
    };
  }
  return {
    category: 'DEFAULT',
    cost: config.defaultMessageCost,
    providerCost: Number(config.wallet.defaultProviderCost || 0),
  };
}

export async function getMessageCost(category = 'DEFAULT') {
  const pricing = await getMessagePricing(category);
  return pricing.cost;
}

export function calcPlatformRevenue(customerCharge, providerCost) {
  const charge = Number(customerCharge || 0);
  const provider = Number(providerCost || 0);
  return Math.max(0, Number((charge - provider).toFixed(4)));
}

async function findExistingByReference(c, referenceType, referenceId) {
  if (!referenceType || !referenceId) return null;
  const [rows] = await c.execute(
    `SELECT id, balance_after, wallet_id, user_id FROM wallet_transactions
     WHERE reference_type = :reference_type AND reference_id = :reference_id
     ORDER BY id ASC LIMIT 1`,
    { reference_type: referenceType, reference_id: String(referenceId) }
  );
  return rows[0] || null;
}

async function maybeNotifyLowBalance(balance, notifyUserId = null) {
  const threshold = config.lowWalletThreshold;
  if (Number(balance) >= threshold) return;

  const recent = await query(
    `SELECT id FROM notifications
     WHERE type = 'low_wallet'
       AND is_read = 0
       AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)
     LIMIT 1`
  );
  if (recent.length) return;

  await notifyProjectEvent({
    type: 'low_wallet',
    title: 'Low Wallet Balance',
    body: `Wallet balance is ₹${Number(balance).toFixed(2)}. Please recharge.`,
    meta: { balance: Number(balance), threshold },
    relatedUserIds: notifyUserId ? [notifyUserId] : [],
  });
}

/**
 * Credit the shared business wallet.
 * userId/createdBy are audit attribution only (who performed the action).
 */
export async function creditWallet({
  userId,
  amount,
  description,
  createdBy,
  referenceType,
  referenceId,
  platformRevenue = 0,
  entryType = 'credit',
  conn,
}) {
  const actorId = createdBy || userId || null;

  const run = async (c) => {
    const existing = await findExistingByReference(c, referenceType, referenceId);
    if (existing) return Number(existing.balance_after);

    const wallet = await getBusinessWallet(c);
    const [locked] = await c.execute(`SELECT id, balance FROM wallets WHERE id = :id FOR UPDATE`, {
      id: wallet.id,
    });
    if (!locked.length) throw new AppError('Wallet not found', 404);

    const balanceBefore = Number(locked[0].balance);
    const balance = balanceBefore + Number(amount);
    await c.execute('UPDATE wallets SET balance = :balance WHERE id = :id', {
      balance,
      id: locked[0].id,
    });
    await c.execute(
      `INSERT INTO wallet_transactions
         (wallet_id, user_id, type, amount, balance_before, balance_after, platform_revenue,
          reference_type, reference_id, description, created_by, status)
       VALUES
         (:wallet_id, :user_id, :type, :amount, :balance_before, :balance_after, :platform_revenue,
          :reference_type, :reference_id, :description, :created_by, 'success')`,
      {
        wallet_id: locked[0].id,
        user_id: actorId,
        type: entryType === 'refund' ? 'refund' : 'credit',
        amount,
        balance_before: balanceBefore,
        balance_after: balance,
        platform_revenue: Number(platformRevenue || 0),
        reference_type: referenceType || null,
        reference_id: referenceId || null,
        description: description || 'Wallet credit',
        created_by: actorId,
      }
    );
    return balance;
  };

  if (conn) return run(conn);
  return withTransaction(run);
}

export async function debitWallet({
  userId,
  amount,
  description,
  createdBy,
  referenceType,
  referenceId,
  platformRevenue = 0,
  conn,
}) {
  const actorId = createdBy || userId || null;

  const run = async (c) => {
    const existing = await findExistingByReference(c, referenceType, referenceId);
    if (existing) return Number(existing.balance_after);

    const wallet = await getBusinessWallet(c);
    const [locked] = await c.execute(`SELECT id, balance FROM wallets WHERE id = :id FOR UPDATE`, {
      id: wallet.id,
    });
    if (!locked.length) throw new AppError('Wallet not found', 404);

    const current = Number(locked[0].balance);
    if (current < Number(amount)) {
      throw new AppError('Insufficient wallet balance', 402, 'INSUFFICIENT_BALANCE');
    }
    const balance = current - Number(amount);
    await c.execute('UPDATE wallets SET balance = :balance WHERE id = :id', {
      balance,
      id: locked[0].id,
    });
    await c.execute(
      `INSERT INTO wallet_transactions
         (wallet_id, user_id, type, amount, balance_before, balance_after, platform_revenue,
          reference_type, reference_id, description, created_by, status)
       VALUES
         (:wallet_id, :user_id, 'debit', :amount, :balance_before, :balance_after, :platform_revenue,
          :reference_type, :reference_id, :description, :created_by, 'success')`,
      {
        wallet_id: locked[0].id,
        user_id: actorId,
        amount,
        balance_before: current,
        balance_after: balance,
        platform_revenue: Number(platformRevenue || 0),
        reference_type: referenceType || null,
        reference_id: referenceId || null,
        description: description || 'Wallet debit',
        created_by: actorId,
      }
    );

    setImmediate(() => {
      maybeNotifyLowBalance(balance, actorId).catch(() => {});
    });

    return balance;
  };

  if (conn) return run(conn);
  return withTransaction(run);
}

export async function listTransactions({
  page = 1,
  limit = 20,
  type,
  referenceType,
  status,
  from,
  to,
  search,
  walletId,
} = {}) {
  const offset = (page - 1) * limit;
  const params = {};
  const where = ['1=1'];

  if (walletId) {
    where.push('wt.wallet_id = :wallet_id');
    params.wallet_id = walletId;
  }
  if (type) {
    where.push('wt.type = :type');
    params.type = type;
  }
  if (referenceType) {
    where.push('wt.reference_type = :reference_type');
    params.reference_type = referenceType;
  }
  if (status) {
    where.push('wt.status = :status');
    params.status = status;
  }
  if (from) {
    where.push('wt.created_at >= :from');
    params.from = `${from} 00:00:00`;
  }
  if (to) {
    where.push('wt.created_at <= :to');
    params.to = `${to} 23:59:59`;
  }
  if (search) {
    where.push(
      `(u.name LIKE :search OR u.email LIKE :search OR wt.description LIKE :search OR CAST(wt.id AS CHAR) LIKE :search OR wt.reference_id LIKE :search)`
    );
    params.search = `%${search}%`;
  }

  const whereSql = where.join(' AND ');
  const rows = await query(
    `SELECT wt.*, u.name AS performed_by_name, u.email AS performed_by_email, u.role AS performed_by_role
     FROM wallet_transactions wt
     LEFT JOIN users u ON u.id = COALESCE(wt.created_by, wt.user_id)
     WHERE ${whereSql}
     ORDER BY wt.id DESC
     LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );
  const countRows = await query(
    `SELECT COUNT(*) AS c
     FROM wallet_transactions wt
     LEFT JOIN users u ON u.id = COALESCE(wt.created_by, wt.user_id)
     WHERE ${whereSql}`,
    params
  );
  return { rows, total: countRows[0].c, page, limit };
}

export async function listRecharges({ page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  const rows = await query(
    `SELECT r.*, u.name AS performed_by_name, u.email AS performed_by_email
     FROM recharges r
     LEFT JOIN users u ON u.id = COALESCE(r.created_by, r.user_id)
     ORDER BY r.id DESC
     LIMIT :limit OFFSET :offset`,
    { limit, offset }
  );
  const countRows = await query(`SELECT COUNT(*) AS c FROM recharges`);
  return { rows, total: countRows[0].c, page, limit };
}

export function getProcessingFee(amount) {
  const flat = Number(config.wallet.processingFee || 0);
  const percent = Number(config.wallet.processingFeePercent || 0);
  const fee = flat + (Number(amount) * percent) / 100;
  return Number(fee.toFixed(2));
}

export async function getPendingDeductions() {
  const rows = await query(
    `SELECT
       COALESCE(SUM(cost), 0) AS amount,
       COUNT(*) AS message_count
     FROM campaign_messages
     WHERE status IN ('pending', 'queued')`
  );
  return {
    amount: Number(rows[0]?.amount || 0),
    messageCount: Number(rows[0]?.message_count || 0),
  };
}

export async function getSpendStats() {
  const [today] = await query(
    `SELECT
       COALESCE(SUM(amount), 0) AS amount,
       COUNT(*) AS tx_count
     FROM wallet_transactions
     WHERE type = 'debit'
       AND status = 'success'
       AND DATE(created_at) = CURDATE()`
  );
  const [month] = await query(
    `SELECT
       COALESCE(SUM(amount), 0) AS amount,
       COUNT(*) AS tx_count
     FROM wallet_transactions
     WHERE type = 'debit'
       AND status = 'success'
       AND YEAR(created_at) = YEAR(CURDATE())
       AND MONTH(created_at) = MONTH(CURDATE())`
  );
  const [todayMsgs] = await query(
    `SELECT COUNT(*) AS c FROM campaign_messages
     WHERE status IN ('sent','delivered','read')
       AND DATE(COALESCE(sent_at, created_at)) = CURDATE()`
  );
  const [monthMsgs] = await query(
    `SELECT COUNT(*) AS c from campaign_messages
     WHERE status IN ('sent','delivered','read')
       AND YEAR(COALESCE(sent_at, created_at)) = YEAR(CURDATE())
       AND MONTH(COALESCE(sent_at, created_at)) = MONTH(CURDATE())`
  );
  return {
    todaySpend: Number(today?.amount || 0),
    todayMessages: Number(todayMsgs?.c || 0),
    monthSpend: Number(month?.amount || 0),
    monthMessages: Number(monthMsgs?.c || 0),
  };
}

export async function getWalletSummaryTotals() {
  const [credited] = await query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM wallet_transactions
     WHERE type IN ('credit', 'refund') AND status = 'success'`
  );
  const [spent] = await query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM wallet_transactions
     WHERE type = 'debit' AND status = 'success'`
  );
  const pending = await getPendingDeductions();
  const wallet = await getBusinessWallet();
  return {
    totalRecharged: Number(credited?.total || 0),
    totalSpent: Number(spent?.total || 0),
    pendingDeductions: pending.amount,
    pendingMessageCount: pending.messageCount,
    availableBalance: Number(wallet.balance || 0),
    currency: wallet.currency || 'INR',
  };
}

/**
 * Balance history points for chart (end-of-day balance_after).
 */
export async function getBalanceHistory({ from, to }) {
  const rows = await query(
    `SELECT DATE(created_at) AS day, MAX(id) AS max_id
     FROM wallet_transactions
     WHERE status = 'success'
       AND created_at BETWEEN :from AND :to
     GROUP BY DATE(created_at)
     ORDER BY day ASC`,
    { from: `${from} 00:00:00`, to: `${to} 23:59:59` }
  );

  const map = new Map();
  for (const row of rows) {
    const [tx] = await query(
      `SELECT balance_after FROM wallet_transactions WHERE id = :id LIMIT 1`,
      { id: row.max_id }
    );
    if (tx) map.set(String(row.day).slice(0, 10), Number(tx.balance_after));
  }

  const points = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);

  const before = await query(
    `SELECT balance_after FROM wallet_transactions
     WHERE status = 'success' AND created_at < :from
     ORDER BY id DESC LIMIT 1`,
    { from: `${from} 00:00:00` }
  );
  let last = before.length ? Number(before[0].balance_after) : null;
  if (last == null) {
    const wallet = await getBusinessWallet();
    last = Number(wallet.balance || 0);
  }

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    if (map.has(key)) last = map.get(key);
    points.push({ day: key, balance: last });
  }

  return { from, to, points };
}
