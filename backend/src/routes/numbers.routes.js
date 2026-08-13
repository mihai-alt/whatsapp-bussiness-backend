import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/error.js';
import { config } from '../config.js';
import {
  connectFromEmbeddedSignup,
  disconnectNumber,
  getNumberById,
  listNumbersForUser,
  refreshNumber,
} from '../services/numberConnection.service.js';
import { writeAudit } from '../services/audit.service.js';

const router = Router();

const embeddedBodySchema = z
  .object({
    code: z.string().min(1).optional(),
    authorizationCode: z.string().min(1).optional(),
    authCode: z.string().min(1).optional(),
    phoneNumberId: z.string().min(1).optional().nullable(),
    phone_number_id: z.string().min(1).optional().nullable(),
    wabaId: z.string().min(1).optional().nullable(),
    waba_id: z.string().min(1).optional().nullable(),
    businessId: z.string().min(1).optional().nullable(),
    business_id: z.string().min(1).optional().nullable(),
    sessionInfo: z.union([z.string(), z.record(z.any())]).optional().nullable(),
    state: z.string().optional().nullable(),
    event: z.string().optional().nullable(),
  })
  .refine((b) => Boolean(b.code || b.authorizationCode || b.authCode), {
    message: 'Meta authorization code is required',
  });

router.get(
  '/config',
  authenticate,
  asyncHandler(async (req, res) => {
    const missing = [];
    if (!config.meta.appId) missing.push('META_APP_ID');
    if (!config.meta.appSecret) missing.push('META_APP_SECRET');
    if (!config.meta.configId) missing.push('META_CONFIG_ID');

    res.json({
      success: true,
      state: missing.length ? 'failed' : 'ready',
      data: {
        appId: config.meta.appId || '',
        configId: config.meta.configId || '',
        graphVersion: config.meta.graphVersion || 'v21.0',
        redirectUri: config.meta.redirectUri || '',
        embeddedSignupEnabled: missing.length === 0,
        canLaunchSignup: Boolean(config.meta.appId && config.meta.configId),
        missing,
        setupUrl: 'https://developers.facebook.com/apps/',
      },
    });
  })
);

router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const numbers = await listNumbersForUser(req.user);
    res.json({ success: true, data: numbers, numbers });
  })
);

router.post(
  '/meta/connect',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = embeddedBodySchema.parse(req.body);
    try {
      const number = await connectFromEmbeddedSignup({
        userId: req.user.id,
        rawBody: body,
      });
      await writeAudit({
        userId: req.user.id,
        action: 'whatsapp.number_connected',
        entityType: 'whatsapp_account',
        entityId: number?.id,
        meta: {
          phone_number: number?.phone_number || number?.display_phone_number,
          waba_id: number?.waba_id,
        },
        ip: req.ip,
      });
      res.status(201).json({
        success: true,
        message: 'WhatsApp Business number connected successfully.',
        state: 'success',
        number,
        data: number,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err.code === 'ER_DUP_ENTRY') {
        throw new AppError(
          'This WhatsApp Business number is already connected.',
          409,
          'DUPLICATE_NUMBER',
          { state: 'already_connected' }
        );
      }
      console.error('Meta connect failed:', err?.message || err);
      throw new AppError(
        'Unable to connect the WhatsApp Business number.',
        502,
        'CONNECT_FAILED',
        { state: 'failed' }
      );
    }
  })
);

router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const number = await getNumberById(req.params.id);
    res.json({ success: true, data: number, number });
  })
);

router.post(
  '/:id/refresh',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const number = await refreshNumber(req.params.id);
    res.json({
      success: true,
      message: 'Number details refreshed from Meta.',
      state: 'success',
      number,
      data: number,
    });
  })
);

router.post(
  '/:id/reconnect',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = embeddedBodySchema.parse(req.body);
    try {
      const number = await connectFromEmbeddedSignup({
        userId: req.user.id,
        rawBody: body,
        reconnectAccountId: req.params.id,
      });
      await writeAudit({
        userId: req.user.id,
        action: 'whatsapp.number_reconnected',
        entityType: 'whatsapp_account',
        entityId: number?.id || Number(req.params.id),
        meta: {
          phone_number: number?.phone_number || number?.display_phone_number,
          waba_id: number?.waba_id,
        },
        ip: req.ip,
      });
      res.json({
        success: true,
        message: 'WhatsApp Business number reconnected successfully.',
        state: 'success',
        number,
        data: number,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (err.code === 'ER_DUP_ENTRY') {
        throw new AppError(
          'This WhatsApp Business number is already connected.',
          409,
          'DUPLICATE_NUMBER',
          { state: 'already_connected' }
        );
      }
      console.error('Meta reconnect failed:', err?.message || err);
      throw new AppError(
        'Unable to reconnect the WhatsApp Business number.',
        502,
        'RECONNECT_FAILED',
        { state: 'failed' }
      );
    }
  })
);

router.delete(
  '/:id',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const result = await disconnectNumber(req.params.id, req.user.id);
    res.json({
      success: true,
      message: result.message,
      state: 'success',
      data: result,
    });
  })
);

router.post(
  '/:id/disconnect',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const result = await disconnectNumber(req.params.id, req.user.id);
    res.json({
      success: true,
      message: result.message,
      state: 'success',
      data: result,
    });
  })
);

export default router;
