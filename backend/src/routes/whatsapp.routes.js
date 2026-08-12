import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/error.js';
import { query } from '../db/pool.js';
import {
  exchangeCodeForToken,
  fetchPhoneNumberDetails,
  fetchWabaDetails,
  fetchBusinessProfile,
  subscribeWabaWebhooks,
} from '../services/meta.service.js';
import { config } from '../config.js';
import { parseJson } from '../utils/helpers.js';
import {
  encryptAccessTokenForStorage,
  getAccountAccessToken,
  toPublicNumber,
} from '../services/numberConnection.service.js';
import { notifyProjectEvent } from '../services/notification.service.js';

const router = Router();

router.get(
  '/config',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: {
        appId: config.meta.appId,
        configId: config.meta.configId,
        graphVersion: config.meta.graphVersion,
        embeddedSignupEnabled: Boolean(config.meta.appId && config.meta.configId),
      },
    });
  })
);

router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, phone_number, phone_number_id, waba_id, business_name, quality_rating,
              messaging_limit, status, profile_picture_url, about_text, connected_at, disconnected_at, created_at, updated_at
       FROM whatsapp_accounts ORDER BY id DESC`
    );
    res.json({ success: true, data: rows });
  })
);

router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, phone_number, phone_number_id, waba_id, business_name, quality_rating,
              messaging_limit, status, profile_picture_url, about_text, connected_at, disconnected_at, meta_payload, created_at, updated_at
       FROM whatsapp_accounts WHERE id = :id LIMIT 1`,
      { id: req.params.id }
    );
    if (!rows.length) throw new AppError('WhatsApp account not found', 404);
    const row = rows[0];
    row.meta_payload = parseJson(row.meta_payload);
    res.json({ success: true, data: row });
  })
);

/**
 * Connect via Embedded Signup code exchange OR manual credentials for already-approved numbers.
 */
router.post(
  '/connect',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      code: z.string().optional(),
      accessToken: z.string().optional(),
      phoneNumberId: z.string().min(1),
      wabaId: z.string().min(1),
    });
    const body = schema.parse(req.body);

    let accessToken = body.accessToken || config.meta.systemUserToken;
    if (body.code) {
      const tokenData = await exchangeCodeForToken(body.code);
      accessToken = tokenData.access_token;
    }
    if (!accessToken) {
      throw new AppError('Access token or Embedded Signup code is required', 400);
    }

    const phone = await fetchPhoneNumberDetails(body.phoneNumberId, accessToken);
    let waba = null;
    try {
      waba = await fetchWabaDetails(body.wabaId, accessToken);
    } catch {
      waba = { id: body.wabaId, name: null };
    }

    let profile = null;
    try {
      profile = await fetchBusinessProfile(body.phoneNumberId, accessToken);
    } catch {
      profile = null;
    }

    try {
      await subscribeWabaWebhooks(body.wabaId, accessToken);
    } catch (err) {
      console.warn('Webhook subscribe warning:', err.message);
    }

    const existing = await query(
      'SELECT id FROM whatsapp_accounts WHERE phone_number_id = :phone_number_id LIMIT 1',
      { phone_number_id: body.phoneNumberId }
    );

    const payload = {
      phone_number: phone.display_phone_number || null,
      phone_number_id: body.phoneNumberId,
      waba_id: body.wabaId,
      business_name: phone.verified_name || waba?.name || null,
      quality_rating: phone.quality_rating || null,
      messaging_limit: phone.messaging_limit_tier || null,
      access_token: encryptAccessTokenForStorage(accessToken),
      status: 'connected',
      profile_picture_url: profile?.profile_picture_url || null,
      about_text: profile?.about || null,
      meta_payload: JSON.stringify({ phone, waba, profile }),
      connected_by: req.user.id,
    };

    let id;
    if (existing.length) {
      id = existing[0].id;
      await query(
        `UPDATE whatsapp_accounts SET
          phone_number = :phone_number,
          waba_id = :waba_id,
          business_name = :business_name,
          quality_rating = :quality_rating,
          messaging_limit = :messaging_limit,
          access_token = :access_token,
          status = 'connected',
          profile_picture_url = :profile_picture_url,
          about_text = :about_text,
          meta_payload = :meta_payload,
          connected_by = :connected_by,
          connected_at = NOW(),
          disconnected_at = NULL
         WHERE id = :id`,
        { ...payload, id }
      );
    } else {
      const result = await query(
        `INSERT INTO whatsapp_accounts
         (phone_number, phone_number_id, waba_id, business_name, quality_rating, messaging_limit,
          access_token, status, profile_picture_url, about_text, meta_payload, connected_by, connected_at)
         VALUES
         (:phone_number, :phone_number_id, :waba_id, :business_name, :quality_rating, :messaging_limit,
          :access_token, 'connected', :profile_picture_url, :about_text, :meta_payload, :connected_by, NOW())`,
        payload
      );
      id = result.insertId;
    }

    const rows = await query(
      `SELECT id, phone_number, phone_number_id, waba_id, business_name, quality_rating,
              messaging_limit, status, profile_picture_url, about_text, connected_at
       FROM whatsapp_accounts WHERE id = :id`,
      { id }
    );
    const number = toPublicNumber(rows[0]);
    await notifyProjectEvent({
      type: 'number_connected',
      title: 'WhatsApp number connected',
      body: `${number.phone_number || number.business_name || `#${id}`} is now connected.`,
      meta: { numberId: Number(id), phoneNumber: number.phone_number || null, connectedBy: req.user.id },
      actorUserId: req.user.id,
    });
    res.status(201).json({ success: true, data: number });
  })
);

router.post(
  '/:id/sync',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const rows = await query('SELECT * FROM whatsapp_accounts WHERE id = :id LIMIT 1', {
      id: req.params.id,
    });
    if (!rows.length) throw new AppError('WhatsApp account not found', 404);
    const account = rows[0];
    if (account.status !== 'connected') throw new AppError('Account is disconnected', 400);

    const accessToken = getAccountAccessToken(account);
    const phone = await fetchPhoneNumberDetails(account.phone_number_id, accessToken);
    let profile = null;
    try {
      profile = await fetchBusinessProfile(account.phone_number_id, accessToken);
    } catch {
      /* ignore */
    }

    await query(
      `UPDATE whatsapp_accounts SET
        phone_number = :phone_number,
        business_name = :business_name,
        quality_rating = :quality_rating,
        messaging_limit = :messaging_limit,
        profile_picture_url = :profile_picture_url,
        about_text = :about_text,
        meta_payload = :meta_payload
       WHERE id = :id`,
      {
        id: account.id,
        phone_number: phone.display_phone_number || account.phone_number,
        business_name: phone.verified_name || account.business_name,
        quality_rating: phone.quality_rating || null,
        messaging_limit: phone.messaging_limit_tier || null,
        profile_picture_url: profile?.profile_picture_url || account.profile_picture_url,
        about_text: profile?.about || account.about_text,
        meta_payload: JSON.stringify({ phone, profile }),
      }
    );

    const updated = await query(
      `SELECT id, phone_number, phone_number_id, waba_id, business_name, quality_rating,
              messaging_limit, status, profile_picture_url, about_text, connected_at
       FROM whatsapp_accounts WHERE id = :id`,
      { id: account.id }
    );
    res.json({ success: true, data: updated[0] });
  })
);

router.post(
  '/:id/disconnect',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const rows = await query(
      'SELECT id, phone_number, business_name FROM whatsapp_accounts WHERE id = :id LIMIT 1',
      { id: req.params.id }
    );
    if (!rows.length) throw new AppError('WhatsApp account not found', 404);
    await query(
      `UPDATE whatsapp_accounts SET status = 'disconnected', disconnected_at = NOW(), access_token = ''
       WHERE id = :id`,
      { id: req.params.id }
    );
    const label = rows[0].phone_number || rows[0].business_name || `#${req.params.id}`;
    await notifyProjectEvent({
      type: 'number_disconnected',
      title: 'WhatsApp number disconnected',
      body: `${label} was disconnected.`,
      meta: {
        numberId: Number(req.params.id),
        phoneNumber: rows[0].phone_number || null,
        disconnectedBy: req.user.id,
      },
      actorUserId: req.user.id,
    });
    res.json({ success: true, data: { message: 'Disconnected' } });
  })
);

export default router;
