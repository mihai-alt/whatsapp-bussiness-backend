import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { AppError } from '../middleware/error.js';
import { query, withTransaction } from '../db/pool.js';
import { creditWallet, getBusinessWallet, getWallet, getProcessingFee } from './wallet.service.js';
import { paymentGateway } from './payment.gateway.js';

function validateRechargeAmount(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError('Amount must be a positive number', 400, 'INVALID_AMOUNT');
  }
  const paise = Math.round(value * 100);
  if (Math.abs(value * 100 - paise) > 1e-6) {
    throw new AppError('Amount can have at most 2 decimal places', 400, 'INVALID_AMOUNT');
  }
  const min = config.wallet.minRecharge;
  const max = config.wallet.maxRecharge;
  if (value < min) {
    throw new AppError(`Minimum recharge amount is ₹${min}`, 400, 'AMOUNT_TOO_LOW');
  }
  if (value > max) {
    throw new AppError(`Maximum recharge amount is ₹${max}`, 400, 'AMOUNT_TOO_HIGH');
  }
  return Number((paise / 100).toFixed(2));
}

function paymentMethodLabel(payment) {
  if (!payment) return null;
  const method = payment.method || payment.payment_method;
  if (!method) return null;
  if (method === 'upi') {
    const vpa = payment.vpa || payment.upi?.vpa;
    return vpa ? `UPI (${vpa})` : 'UPI';
  }
  if (method === 'card') {
    const network = payment.card?.network || '';
    return network ? `Card (${network})` : 'Card';
  }
  if (method === 'netbanking') return 'Net Banking';
  if (method === 'wallet') {
    const wallet = payment.wallet || payment.wallet_name;
    return wallet ? `Wallet (${wallet})` : 'Wallet';
  }
  return String(method);
}

async function findRechargeByOrderId(orderId, conn) {
  const sql = `SELECT * FROM recharges WHERE razorpay_order_id = :order_id LIMIT 1 FOR UPDATE`;
  if (conn) {
    const [rows] = await conn.execute(sql, { order_id: orderId });
    return rows[0] || null;
  }
  const rows = await query(`SELECT * FROM recharges WHERE razorpay_order_id = :order_id LIMIT 1`, {
    order_id: orderId,
  });
  return rows[0] || null;
}

async function creditRechargeIfNeeded({
  recharge,
  paymentId,
  signature,
  paymentMethod,
  createdBy,
  conn,
}) {
  if (!recharge) throw new AppError('Recharge order not found', 404, 'RECHARGE_NOT_FOUND');

  if (recharge.status === 'completed' || Number(recharge.credited) === 1) {
    const wallet = await getWallet();
    return {
      alreadyCredited: true,
      balance: Number(wallet.balance),
      recharge,
    };
  }

  if (['failed', 'cancelled', 'refunded'].includes(recharge.status)) {
    throw new AppError(`Cannot credit recharge in status: ${recharge.status}`, 409, 'INVALID_RECHARGE_STATUS');
  }

  if (paymentId && recharge.razorpay_payment_id && recharge.razorpay_payment_id !== paymentId) {
    throw new AppError('Payment ID mismatch for this order', 409, 'PAYMENT_MISMATCH');
  }

  const amount = Number(recharge.amount);
  const methodLabel = paymentMethod || 'Razorpay';
  const actorId = createdBy || recharge.created_by || recharge.user_id;
  const wallet = await getBusinessWallet(conn);

  const balance = await creditWallet({
    userId: actorId,
    amount,
    description: `Wallet added via Razorpay (${methodLabel})`,
    createdBy: actorId,
    referenceType: 'recharge',
    referenceId: String(recharge.id),
    conn,
  });

  await conn.execute(
    `UPDATE recharges
     SET status = 'completed',
         credited = 1,
         wallet_id = COALESCE(wallet_id, :wallet_id),
         razorpay_payment_id = COALESCE(:payment_id, razorpay_payment_id),
         razorpay_signature = COALESCE(:signature, razorpay_signature),
         payment_method = COALESCE(:payment_method, payment_method),
         gateway_ref = COALESCE(:payment_id, gateway_ref),
         completed_at = COALESCE(completed_at, NOW())
     WHERE id = :id`,
    {
      id: recharge.id,
      wallet_id: wallet.id,
      payment_id: paymentId || null,
      signature: signature || null,
      payment_method: methodLabel,
    }
  );

  const [updatedRows] = await conn.execute(`SELECT * FROM recharges WHERE id = :id LIMIT 1`, {
    id: recharge.id,
  });

  return {
    alreadyCredited: false,
    balance,
    recharge: updatedRows[0],
  };
}

export async function createRechargeOrder({ amount, userId, source = 'wallet_recharge' }) {
  if (!paymentGateway.isConfigured()) {
    throw new AppError(
      'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env',
      503,
      'PAYMENT_NOT_CONFIGURED'
    );
  }

  const amountInr = validateRechargeAmount(amount);
  const currency = config.wallet.currency || 'INR';
  const fee = getProcessingFee(amountInr);
  const totalPayable = Number((amountInr + fee).toFixed(2));
  const internalOrderId = `wr_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const wallet = await getBusinessWallet();

  const insert = await query(
    `INSERT INTO recharges (
       amount, currency, status, gateway, internal_order_id, meta,
       created_by, user_id, wallet_id, credited, processing_fee
     ) VALUES (
       :amount, :currency, 'pending', 'razorpay', :internal_order_id, :meta,
       :created_by, :user_id, :wallet_id, 0, :processing_fee
     )`,
    {
      amount: amountInr,
      currency,
      internal_order_id: internalOrderId,
      meta: JSON.stringify({ source, processing_fee: fee, total_payable: totalPayable }),
      created_by: userId,
      user_id: userId,
      wallet_id: wallet.id,
      processing_fee: fee,
    }
  );

  const rechargeId = insert.insertId;

  try {
    const order = await paymentGateway.createOrder({
      amountInr: totalPayable,
      currency,
      receipt: internalOrderId,
      notes: {
        recharge_id: String(rechargeId),
        user_id: String(userId),
        internal_order_id: internalOrderId,
        source,
      },
    });

    await query(
      `UPDATE recharges
       SET razorpay_order_id = :order_id,
           gateway_ref = :order_id,
           status = 'processing',
           meta = :meta
       WHERE id = :id`,
      {
        id: rechargeId,
        order_id: order.orderId,
        meta: JSON.stringify({
          source,
          processing_fee: fee,
          total_payable: totalPayable,
          razorpay_amount_paise: order.amount,
          currency: order.currency,
        }),
      }
    );

    return {
      success: true,
      rechargeId,
      internalOrderId,
      orderId: order.orderId,
      amount: order.amount,
      amountInr,
      processingFee: fee,
      totalPayable,
      currency: order.currency,
      keyId: order.keyId || paymentGateway.getPublicKeyId(),
    };
  } catch (err) {
    await query(`UPDATE recharges SET status = 'failed', meta = :meta WHERE id = :id`, {
      id: rechargeId,
      meta: JSON.stringify({ source, error: err.message }),
    });
    throw err;
  }
}

/** Manual bank transfer / UPI intent — does NOT credit wallet */
export async function createManualRechargeIntent({
  amount,
  userId,
  method = 'bank_transfer',
  source = 'manual_intent',
}) {
  const amountInr = validateRechargeAmount(amount);
  const fee = getProcessingFee(amountInr);
  const wallet = await getBusinessWallet();
  const internalOrderId = `mn_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

  const insert = await query(
    `INSERT INTO recharges (
       amount, currency, status, gateway, internal_order_id, payment_method,
       meta, created_by, user_id, wallet_id, credited, processing_fee
     ) VALUES (
       :amount, :currency, 'pending', :gateway, :internal_order_id, :payment_method,
       :meta, :created_by, :user_id, :wallet_id, 0, :processing_fee
     )`,
    {
      amount: amountInr,
      currency: config.wallet.currency || 'INR',
      gateway: method === 'upi' ? 'upi_manual' : 'bank_transfer',
      internal_order_id: internalOrderId,
      payment_method: method === 'upi' ? 'UPI (Manual)' : 'Bank Transfer',
      meta: JSON.stringify({
        source,
        note: 'Awaiting manual confirmation. Wallet will not be credited automatically.',
        processing_fee: fee,
      }),
      created_by: userId,
      user_id: userId,
      wallet_id: wallet.id,
      processing_fee: fee,
    }
  );

  return {
    success: true,
    rechargeId: insert.insertId,
    internalOrderId,
    amountInr,
    processingFee: fee,
    totalPayable: Number((amountInr + fee).toFixed(2)),
    status: 'pending',
    message:
      method === 'upi'
        ? 'UPI transfer request recorded. Wallet will be credited after admin confirmation.'
        : 'Bank transfer request recorded. Wallet will be credited after payment confirmation.',
  };
}

export async function verifyRechargePayment({
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
  userId,
}) {
  if (!paymentGateway.isConfigured()) {
    throw new AppError('Razorpay is not configured', 503, 'PAYMENT_NOT_CONFIGURED');
  }
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw new AppError('Missing payment verification fields', 400, 'MISSING_PAYMENT_FIELDS');
  }

  const valid = paymentGateway.verifyCheckoutSignature({
    orderId: razorpayOrderId,
    paymentId: razorpayPaymentId,
    signature: razorpaySignature,
  });
  if (!valid) {
    throw new AppError('Invalid payment signature', 400, 'INVALID_SIGNATURE');
  }

  const payment = await paymentGateway.fetchPayment(razorpayPaymentId);
  if (!payment || payment.order_id !== razorpayOrderId) {
    throw new AppError('Payment does not match order', 400, 'PAYMENT_ORDER_MISMATCH');
  }
  if (!['captured', 'authorized'].includes(payment.status)) {
    throw new AppError(`Payment not successful (status: ${payment.status})`, 400, 'PAYMENT_NOT_SUCCESS');
  }

  const result = await withTransaction(async (conn) => {
    const recharge = await findRechargeByOrderId(razorpayOrderId, conn);
    if (!recharge) throw new AppError('Recharge order not found', 404, 'RECHARGE_NOT_FOUND');

    const ownerId = recharge.user_id || recharge.created_by;
    if (userId && ownerId && Number(ownerId) !== Number(userId)) {
      throw new AppError('This recharge does not belong to your account', 403, 'FORBIDDEN');
    }

    const fee = Number(recharge.processing_fee || 0);
    const expectedPaise = Math.round((Number(recharge.amount) + fee) * 100);
    if (Number(payment.amount) !== expectedPaise) {
      // Fallback: older orders charged amount only
      const amountOnlyPaise = Math.round(Number(recharge.amount) * 100);
      if (Number(payment.amount) !== amountOnlyPaise) {
        throw new AppError('Payment amount mismatch', 400, 'AMOUNT_MISMATCH');
      }
    }
    const currency = (recharge.currency || config.wallet.currency || 'INR').toUpperCase();
    if (String(payment.currency || '').toUpperCase() !== currency) {
      throw new AppError('Payment currency mismatch', 400, 'CURRENCY_MISMATCH');
    }

    return creditRechargeIfNeeded({
      recharge,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature,
      paymentMethod: paymentMethodLabel(payment),
      createdBy: userId,
      conn,
    });
  });

  return {
    success: true,
    alreadyCredited: result.alreadyCredited,
    balance: result.balance,
    recharge: {
      id: result.recharge.id,
      amount: Number(result.recharge.amount),
      currency: result.recharge.currency || 'INR',
      status: result.recharge.status,
      razorpay_order_id: result.recharge.razorpay_order_id,
      razorpay_payment_id: result.recharge.razorpay_payment_id,
      payment_method: result.recharge.payment_method,
      completed_at: result.recharge.completed_at,
      created_at: result.recharge.created_at,
    },
  };
}

export async function markRechargeCancelled({ razorpayOrderId, userId, reason = 'checkout_dismissed' }) {
  if (!razorpayOrderId) return { success: true };
  const rows = await query(`SELECT * FROM recharges WHERE razorpay_order_id = :order_id LIMIT 1`, {
    order_id: razorpayOrderId,
  });
  const recharge = rows[0];
  if (!recharge) return { success: true };
  if (recharge.status === 'completed' || Number(recharge.credited) === 1) {
    return { success: true, status: 'completed' };
  }
  const ownerId = recharge.user_id || recharge.created_by;
  if (userId && ownerId && Number(ownerId) !== Number(userId)) {
    throw new AppError('This recharge does not belong to your account', 403, 'FORBIDDEN');
  }
  if (['pending', 'processing'].includes(recharge.status)) {
    let meta = {};
    try {
      meta = typeof recharge.meta === 'string' ? JSON.parse(recharge.meta || '{}') : recharge.meta || {};
    } catch {
      meta = {};
    }
    meta.cancel_reason = reason;
    await query(
      `UPDATE recharges
       SET status = 'cancelled', meta = :meta
       WHERE id = :id AND status IN ('pending', 'processing')`,
      { id: recharge.id, meta: JSON.stringify(meta) }
    );
  }
  return { success: true, status: 'cancelled' };
}

export async function handleRazorpayWebhook({ rawBody, signature, event }) {
  if (!paymentGateway.isConfigured()) {
    throw new AppError('Razorpay is not configured', 503, 'PAYMENT_NOT_CONFIGURED');
  }
  if (!config.razorpay.webhookSecret) {
    throw new AppError('RAZORPAY_WEBHOOK_SECRET is not configured', 503, 'WEBHOOK_NOT_CONFIGURED');
  }

  const valid = paymentGateway.verifyWebhookSignature({ rawBody, signature });
  if (!valid) {
    throw new AppError('Invalid webhook signature', 400, 'INVALID_WEBHOOK_SIGNATURE');
  }

  const eventName = event?.event || '';
  const payload = event?.payload || {};

  if (eventName === 'payment.captured' || eventName === 'order.paid') {
    const payment = payload.payment?.entity;
    const orderId = payment?.order_id || payload.order?.entity?.id || null;
    const paymentId = payment?.id || null;

    if (!orderId || !paymentId) {
      return { success: true, ignored: true, reason: 'missing_ids' };
    }

    if (payment && !['captured', 'authorized'].includes(payment.status) && eventName === 'payment.captured') {
      return { success: true, ignored: true, reason: 'not_captured' };
    }

    let paymentDetails = payment;
    try {
      paymentDetails = await paymentGateway.fetchPayment(paymentId);
    } catch {
      /* use webhook payload */
    }

    const result = await withTransaction(async (conn) => {
      const recharge = await findRechargeByOrderId(orderId, conn);
      if (!recharge) return { ignored: true, reason: 'unknown_order' };

      if (paymentDetails) {
        const fee = Number(recharge.processing_fee || 0);
        const expectedPaise = Math.round((Number(recharge.amount) + fee) * 100);
        const amountOnlyPaise = Math.round(Number(recharge.amount) * 100);
        if (
          Number(paymentDetails.amount) !== expectedPaise &&
          Number(paymentDetails.amount) !== amountOnlyPaise
        ) {
          throw new AppError('Webhook payment amount mismatch', 400, 'AMOUNT_MISMATCH');
        }
      }

      return creditRechargeIfNeeded({
        recharge,
        paymentId,
        signature: null,
        paymentMethod: paymentMethodLabel(paymentDetails || payment),
        createdBy: recharge.user_id || recharge.created_by,
        conn,
      });
    });

    return { success: true, ...result, event: eventName };
  }

  if (eventName === 'payment.failed') {
    const payment = payload.payment?.entity;
    const orderId = payment?.order_id;
    if (orderId) {
      const rows = await query(`SELECT id, meta FROM recharges WHERE razorpay_order_id = :order_id LIMIT 1`, {
        order_id: orderId,
      });
      if (rows[0]) {
        let meta = {};
        try {
          meta = typeof rows[0].meta === 'string' ? JSON.parse(rows[0].meta || '{}') : rows[0].meta || {};
        } catch {
          meta = {};
        }
        meta.failure = {
          error_code: payment?.error_code || null,
          error_description: payment?.error_description || null,
          at: new Date().toISOString(),
        };
        await query(
          `UPDATE recharges
           SET status = 'failed',
               razorpay_payment_id = COALESCE(razorpay_payment_id, :payment_id),
               payment_method = COALESCE(payment_method, :method),
               meta = :meta
           WHERE id = :id
             AND status IN ('pending', 'processing')
             AND credited = 0`,
          {
            id: rows[0].id,
            payment_id: payment?.id || null,
            method: paymentMethodLabel(payment),
            meta: JSON.stringify(meta),
          }
        );
      }
    }
    return { success: true, event: eventName, status: 'failed' };
  }

  return { success: true, ignored: true, event: eventName };
}

export { validateRechargeAmount, paymentMethodLabel };
