import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { config } from '../config.js';
import { paymentGateway } from '../services/payment.gateway.js';
import {
  getBusinessWallet,
  getSpendStats,
  getPendingDeductions,
  getWalletSummaryTotals,
  getBalanceHistory,
  listTransactions,
  listRecharges,
} from '../services/wallet.service.js';
import { query } from '../db/pool.js';

const router = Router();
router.use(authenticate, requireRole('admin'));

function periodToRange(period, from, to) {
  const today = new Date();
  const ymd = (d) => d.toISOString().slice(0, 10);
  if (from && to) return { from, to };

  if (period === 'week') {
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    return { from: ymd(start), to: ymd(today) };
  }
  if (period === 'last_month') {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { from: ymd(start), to: ymd(end) };
  }
  // this month default
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  return { from: ymd(start), to: ymd(today) };
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const wallet = await getBusinessWallet();
    const spend = await getSpendStats();
    const pending = await getPendingDeductions();
    const totals = await getWalletSummaryTotals();
    const low = Number(wallet.balance) < config.lowWalletThreshold;

    res.json({
      success: true,
      data: {
        balance: Number(wallet.balance),
        currency: wallet.currency || 'INR',
        todaySpend: spend.todaySpend,
        todayMessages: spend.todayMessages,
        monthSpend: spend.monthSpend,
        monthMessages: spend.monthMessages,
        pendingDeductions: pending.amount,
        pendingMessageCount: pending.messageCount,
        totalRecharged: totals.totalRecharged,
        totalSpent: totals.totalSpent,
        availableBalance: totals.availableBalance,
        lowBalance: low,
        lowWalletThreshold: config.lowWalletThreshold,
        razorpayConfigured: paymentGateway.isConfigured(),
        minRecharge: config.wallet.minRecharge,
        maxRecharge: config.wallet.maxRecharge,
        processingFee: Number(config.wallet.processingFee || 0),
        processingFeePercent: Number(config.wallet.processingFeePercent || 0),
        paymentMethods: [
          {
            id: 'razorpay',
            label: 'Razorpay',
            description: 'UPI, Cards, Netbanking',
            enabled: paymentGateway.isConfigured(),
          },
          {
            id: 'bank_transfer',
            label: 'Bank Transfer (Manual)',
            description: 'Requires admin confirmation',
            enabled: true,
          },
        ],
      },
    });
  })
);

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const data = await getWalletSummaryTotals();
    res.json({ success: true, data });
  })
);

router.get(
  '/balance-history',
  asyncHandler(async (req, res) => {
    const { from, to } = periodToRange(req.query.period, req.query.from, req.query.to);
    const data = await getBalanceHistory({ from, to });
    res.json({ success: true, data });
  })
);

router.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page || 1);
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const data = await listTransactions({
      page,
      limit,
      type: req.query.type,
      referenceType: req.query.referenceType,
      status: req.query.status,
      from: req.query.from,
      to: req.query.to,
      search: req.query.search,
    });
    res.json({ success: true, data });
  })
);

router.get(
  '/recharges',
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page || 1);
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const data = await listRecharges({ page, limit });
    res.json({ success: true, data });
  })
);

router.get(
  '/usage',
  asyncHandler(async (req, res) => {
    const days = Math.min(Number(req.query.days || 30), 365);
    const daily = await query(
      `SELECT DATE(created_at) AS day,
              SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END) AS spent,
              SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END) AS credited,
              COUNT(*) AS transactions
       FROM wallet_transactions
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL :days DAY)
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      { days }
    );
    const byCampaign = await query(
      `SELECT c.id, c.name,
              COALESCE(SUM(cm.cost), 0) AS spent,
              COUNT(cm.id) AS messages
       FROM campaigns c
       LEFT JOIN campaign_messages cm
         ON cm.campaign_id = c.id
        AND cm.status IN ('sent','delivered','read','failed','queued','pending')
       WHERE c.created_at >= DATE_SUB(CURDATE(), INTERVAL :days DAY)
       GROUP BY c.id, c.name
       ORDER BY spent DESC
       LIMIT 20`,
      { days }
    );
    const spend = await getSpendStats();
    const pending = await getPendingDeductions();
    res.json({
      success: true,
      data: {
        daily,
        byCampaign,
        todaySpend: spend.todaySpend,
        monthSpend: spend.monthSpend,
        pendingDeductions: pending.amount,
      },
    });
  })
);

export default router;
