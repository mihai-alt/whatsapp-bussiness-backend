import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { query } from '../db/pool.js';
import { getWallet } from '../services/wallet.service.js';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [accounts, wallet, today, recentCampaigns] = await Promise.all([
      query(
        `SELECT id, phone_number, phone_number_id, waba_id, business_name, quality_rating,
                messaging_limit, status, profile_picture_url
         FROM whatsapp_accounts WHERE status = 'connected' ORDER BY id DESC`
      ),
      getWallet(),
      query(
        `SELECT
           SUM(status IN ('sent','delivered','read')) AS sent,
           SUM(status = 'delivered') AS delivered,
           SUM(status = 'read') AS \`read\`,
           SUM(status = 'failed') AS failed,
           SUM(status IN ('pending','queued')) AS pending
         FROM campaign_messages
         WHERE created_at >= UTC_DATE()
           AND created_at < UTC_DATE() + INTERVAL 1 DAY`
      ),
      query(
        `SELECT id, name, status, total_count, sent_count, delivered_count, read_count, failed_count, pending_count, created_at
         FROM campaigns ORDER BY id DESC LIMIT 8`
      ),
    ]);

    res.json({
      success: true,
      data: {
        accounts,
        primaryAccount: accounts[0] || null,
        wallet,
        today: {
          sent: Number(today[0]?.sent || 0),
          delivered: Number(today[0]?.delivered || 0),
          read: Number(today[0]?.read || 0),
          failed: Number(today[0]?.failed || 0),
          pending: Number(today[0]?.pending || 0),
        },
        recentCampaigns,
      },
    });
  })
);

export default router;
