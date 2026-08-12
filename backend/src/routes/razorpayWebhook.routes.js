import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { handleRazorpayWebhook } from '../services/recharge.service.js';

const router = Router();

/**
 * Razorpay webhooks — no JWT.
 * Signature verified with RAZORPAY_WEBHOOK_SECRET against raw body.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const result = await handleRazorpayWebhook({
      rawBody: req.rawBody,
      signature,
      event: req.body,
    });
    res.json(result);
  })
);

export default router;
