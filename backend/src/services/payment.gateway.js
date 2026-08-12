import crypto from 'crypto';
import Razorpay from 'razorpay';
import { config } from '../config.js';
import { AppError } from '../middleware/error.js';

/**
 * Payment gateway interface.
 * RazorpayPaymentGateway is used when RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET are set.
 */
export class PaymentGateway {
  async createOrder(_payload) {
    throw new Error('Not implemented');
  }

  verifyCheckoutSignature(_payload) {
    throw new Error('Not implemented');
  }

  verifyWebhookSignature(_payload) {
    throw new Error('Not implemented');
  }

  async fetchPayment(_paymentId) {
    throw new Error('Not implemented');
  }

  isConfigured() {
    return false;
  }

  getPublicKeyId() {
    return null;
  }
}

export class StubPaymentGateway extends PaymentGateway {
  isConfigured() {
    return false;
  }

  async createOrder() {
    throw new AppError(
      'Online payment is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET, or ask an admin to credit the wallet manually.',
      503,
      'PAYMENT_NOT_CONFIGURED'
    );
  }

  verifyCheckoutSignature() {
    return false;
  }

  verifyWebhookSignature() {
    return false;
  }
}

export class RazorpayPaymentGateway extends PaymentGateway {
  constructor({ keyId, keySecret, webhookSecret }) {
    super();
    this.keyId = keyId;
    this.keySecret = keySecret;
    this.webhookSecret = webhookSecret || '';
    this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }

  isConfigured() {
    return Boolean(this.keyId && this.keySecret);
  }

  getPublicKeyId() {
    return this.keyId;
  }

  /**
   * @param {{ amountInr: number, currency: string, receipt: string, notes?: object }} payload
   * amountInr is rupees (decimal). Razorpay expects paise.
   */
  async createOrder({ amountInr, currency = 'INR', receipt, notes = {} }) {
    const amountPaise = Math.round(Number(amountInr) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise < 100) {
      throw new AppError('Invalid payment amount', 400, 'INVALID_AMOUNT');
    }
    try {
      const order = await this.client.orders.create({
        amount: amountPaise,
        currency,
        receipt: String(receipt).slice(0, 40),
        notes,
        payment_capture: 1,
      });
      return {
        gateway: 'razorpay',
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt,
        status: order.status,
        keyId: this.keyId,
      };
    } catch (err) {
      const message = err?.error?.description || err?.message || 'Failed to create Razorpay order';
      throw new AppError(message, 502, 'RAZORPAY_ORDER_FAILED');
    }
  }

  verifyCheckoutSignature({ orderId, paymentId, signature }) {
    if (!orderId || !paymentId || !signature) return false;
    const expected = crypto
      .createHmac('sha256', this.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
    } catch {
      return false;
    }
  }

  verifyWebhookSignature({ rawBody, signature }) {
    if (!this.webhookSecret || !rawBody || !signature) return false;
    const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(body).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
    } catch {
      return false;
    }
  }

  async fetchPayment(paymentId) {
    try {
      return await this.client.payments.fetch(paymentId);
    } catch (err) {
      const message = err?.error?.description || err?.message || 'Failed to fetch Razorpay payment';
      throw new AppError(message, 502, 'RAZORPAY_FETCH_FAILED');
    }
  }
}

function createPaymentGateway() {
  const { keyId, keySecret, webhookSecret } = config.razorpay;
  if (keyId && keySecret) {
    return new RazorpayPaymentGateway({ keyId, keySecret, webhookSecret });
  }
  return new StubPaymentGateway();
}

export const paymentGateway = createPaymentGateway();
