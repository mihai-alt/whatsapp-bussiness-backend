import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler, AppError } from '../middleware/error.js';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import {
  fetchBusinessProfile,
  updateBusinessProfile,
  uploadMedia,
} from '../services/meta.service.js';
import { getAccountAccessToken } from '../services/numberConnection.service.js';

const router = Router();
const uploadDir = path.resolve(config.uploadDir);
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 },
});

async function getAccount(id) {
  const rows = await query('SELECT * FROM whatsapp_accounts WHERE id = :id LIMIT 1', { id });
  if (!rows.length) throw new AppError('WhatsApp account not found', 404);
  if (rows[0].status !== 'connected') throw new AppError('WhatsApp account is disconnected', 400);
  const account = rows[0];
  account.access_token = getAccountAccessToken(account);
  return account;
}

router.get(
  '/:accountId',
  authenticate,
  asyncHandler(async (req, res) => {
    const account = await getAccount(req.params.accountId);
    let remote = null;
    try {
      remote = await fetchBusinessProfile(account.phone_number_id, account.access_token);
    } catch (err) {
      remote = { error: err.message };
    }
    res.json({
      success: true,
      data: {
        local: {
          id: account.id,
          phone_number: account.phone_number,
          business_name: account.business_name,
          profile_picture_url: account.profile_picture_url,
          about_text: account.about_text,
          quality_rating: account.quality_rating,
          messaging_limit: account.messaging_limit,
        },
        remote,
      },
    });
  })
);

router.patch(
  '/:accountId',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const schema = z.object({
      about: z.string().max(139).optional(),
      description: z.string().max(512).optional(),
      email: z.string().email().optional(),
      address: z.string().max(256).optional(),
      vertical: z.string().optional(),
      websites: z.array(z.string().url()).optional(),
    });
    const body = schema.parse(req.body);
    const account = await getAccount(req.params.accountId);

    const payload = { messaging_product: 'whatsapp', ...body };
    const result = await updateBusinessProfile(account.phone_number_id, account.access_token, payload);

    if (body.about !== undefined) {
      await query('UPDATE whatsapp_accounts SET about_text = :about WHERE id = :id', {
        about: body.about,
        id: account.id,
      });
    }

    res.json({ success: true, data: result });
  })
);

router.post(
  '/:accountId/picture',
  authenticate,
  requireRole('admin'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('Image file is required', 400);
    const account = await getAccount(req.params.accountId);
    const media = await uploadMedia(
      account.phone_number_id,
      account.access_token,
      req.file.path,
      req.file.mimetype
    );
    const result = await updateBusinessProfile(account.phone_number_id, account.access_token, {
      messaging_product: 'whatsapp',
      profile_picture_handle: media.id || media.h,
    });

    try {
      fs.unlinkSync(req.file.path);
    } catch {
      /* ignore */
    }

    res.json({ success: true, data: result });
  })
);

export default router;
