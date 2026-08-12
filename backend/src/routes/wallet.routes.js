import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/error.js';
import {
  getWallet,
  creditWallet,
  listTransactions,
  listRecharges,
  getMessagePricing,
  getBusinessWallet,
  getProcessingFee,
} from '../services/wallet.service.js';
import {
  createRechargeOrder,
  verifyRechargePayment,
  markRechargeCancelled,
  createManualRechargeIntent,
} from '../services/recharge.service.js';
import { paymentGateway } from '../services/payment.gateway.js';
import { query } from '../db/pool.js';
import { config } from '../config.js';

const router = Router();

router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const wallet = await getWallet();
    res.json({
      success: true,
      data: {
        ...wallet,
        razorpayConfigured: paymentGateway.isConfigured(),
        minRecharge: config.wallet.minRecharge,
        maxRecharge: config.wallet.maxRecharge,
        lowWalletThreshold: config.lowWalletThreshold,
        processingFee: Number(config.wallet.processingFee || 0),
        processingFeePercent: Number(config.wallet.processingFeePercent || 0),
      },
    });
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
    const rows = await query(
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
    res.json({ success: true, data: rows });
  })
);

router.get(
  '/pricing',
  asyncHandler(async (req, res) => {
    const rows = await query('SELECT * FROM message_pricing ORDER BY category');
    res.json({ success: true, data: rows });
  })
);

router.put(
  '/pricing',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      items: z.array(
        z.object({
          category: z.string(),
          cost: z.number().nonnegative(),
          provider_cost: z.number().nonnegative().optional(),
        })
      ),
    });
    const body = schema.parse(req.body);
    for (const item of body.items) {
      await query(
        `INSERT INTO message_pricing (category, cost, provider_cost)
         VALUES (:category, :cost, :provider_cost)
         ON DUPLICATE KEY UPDATE
           cost = VALUES(cost),
           provider_cost = COALESCE(VALUES(provider_cost), provider_cost)`,
        {
          category: item.category,
          cost: item.cost,
          provider_cost: item.provider_cost ?? 0,
        }
      );
    }
    const rows = await query('SELECT * FROM message_pricing ORDER BY category');
    res.json({ success: true, data: rows });
  })
);

/** Admin manual credit to the shared business wallet */
router.post(
  '/credit',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      amount: z.number().positive(),
      description: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const refId = `admin_${req.user.id}_${Date.now()}`;
    const wallet = await getBusinessWallet();
    const balance = await creditWallet({
      userId: req.user.id,
      amount: body.amount,
      description: body.description || 'Manual wallet credit by administrator',
      createdBy: req.user.id,
      referenceType: 'admin_credit',
      referenceId: refId,
    });
    await query(
      `INSERT INTO recharges (
         amount, currency, status, gateway, gateway_ref, payment_method,
         credited, created_by, user_id, wallet_id, completed_at
       ) VALUES (
         :amount, :currency, 'completed', 'manual', :ref, 'Admin credit',
         1, :created_by, :user_id, :wallet_id, NOW()
       )`,
      {
        amount: body.amount,
        currency: config.wallet.currency || 'INR',
        ref: refId,
        created_by: req.user.id,
        user_id: req.user.id,
        wallet_id: wallet.id,
      }
    );
    res.json({ success: true, data: { balance } });
  })
);

router.post('/admin-credit', requireRole('admin'), asyncHandler(async (req, res) => {
  const schema = z.object({
    amount: z.number().positive(),
    description: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const refId = `admin_${req.user.id}_${Date.now()}`;
  const balance = await creditWallet({
    userId: req.user.id,
    amount: body.amount,
    description: body.description || 'Manual wallet credit by administrator',
    createdBy: req.user.id,
    referenceType: 'admin_credit',
    referenceId: refId,
  });
  res.json({ success: true, data: { balance } });
}));

router.post(
  '/recharge/create-order',
  asyncHandler(async (req, res) => {
    const schema = z.object({ amount: z.number().positive() });
    const body = schema.parse(req.body);
    const data = await createRechargeOrder({
      amount: body.amount,
      userId: req.user.id,
      source: req.user.role === 'admin' ? 'admin_business_recharge' : 'member_recharge',
    });
    res.json({
      success: true,
      orderId: data.orderId,
      amount: data.amount,
      amountInr: data.amountInr,
      processingFee: data.processingFee,
      totalPayable: data.totalPayable,
      currency: data.currency,
      keyId: data.keyId,
      rechargeId: data.rechargeId,
      internalOrderId: data.internalOrderId,
    });
  })
);

router.post(
  '/recharge/verify',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      razorpay_order_id: z.string().min(1),
      razorpay_payment_id: z.string().min(1),
      razorpay_signature: z.string().min(1),
    });
    const body = schema.parse(req.body);
    const data = await verifyRechargePayment({
      razorpayOrderId: body.razorpay_order_id,
      razorpayPaymentId: body.razorpay_payment_id,
      razorpaySignature: body.razorpay_signature,
      userId: req.user.id,
    });
    res.json({ success: true, data });
  })
);

router.post(
  '/recharge/cancel',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      razorpay_order_id: z.string().min(1),
      reason: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const data = await markRechargeCancelled({
      razorpayOrderId: body.razorpay_order_id,
      userId: req.user.id,
      reason: body.reason || 'checkout_dismissed',
    });
    res.json({ success: true, data });
  })
);

router.post(
  '/recharge/manual-intent',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      amount: z.number().positive(),
      method: z.enum(['bank_transfer', 'upi']).default('bank_transfer'),
    });
    const body = schema.parse(req.body);
    const data = await createManualRechargeIntent({
      amount: body.amount,
      userId: req.user.id,
      method: body.method,
    });
    res.json({ success: true, data });
  })
);

router.post(
  '/recharge',
  asyncHandler(async (req, res) => {
    const schema = z.object({ amount: z.number().positive() });
    const body = schema.parse(req.body);
    if (paymentGateway.isConfigured()) {
      const data = await createRechargeOrder({
        amount: body.amount,
        userId: req.user.id,
      });
      return res.json({
        success: true,
        orderId: data.orderId,
        amount: data.amount,
        currency: data.currency,
        keyId: data.keyId,
        rechargeId: data.rechargeId,
      });
    }
    throw new AppError(
      'Online payment is not configured. Ask an admin to credit the wallet manually after bank transfer.',
      503,
      'PAYMENT_NOT_CONFIGURED'
    );
  })
);

router.get(
  '/cost',
  asyncHandler(async (req, res) => {
    const category = req.query.category || 'DEFAULT';
    const pricing = await getMessagePricing(category);
    res.json({
      success: true,
      data: {
        category: pricing.category,
        cost: pricing.cost,
        providerCost: pricing.providerCost,
        platformMargin: Math.max(0, pricing.cost - pricing.providerCost),
        lowWalletThreshold: config.lowWalletThreshold,
      },
    });
  })
);

router.get(
  '/fee',
  asyncHandler(async (req, res) => {
    const amount = Number(req.query.amount || 0);
    const fee = getProcessingFee(amount);
    res.json({
      success: true,
      data: {
        amount,
        processingFee: fee,
        totalPayable: Number((amount + fee).toFixed(2)),
      },
    });
  })
);

export default router;
