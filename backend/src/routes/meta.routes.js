import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { config } from '../config.js';

const router = Router();

/**
 * Public (authenticated) Embedded Signup bootstrap config for the frontend.
 * Never returns App Secret or tokens.
 */
router.get(
  '/embedded-signup',
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
        connectEndpoint: '/api/numbers/meta/connect',
      },
    });
  })
);

export default router;
