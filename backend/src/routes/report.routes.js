import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { query } from '../db/pool.js';

const router = Router();
router.use(authenticate);

router.get(
  '/messages',
  asyncHandler(async (req, res) => {
    const from = req.query.from || null;
    const to = req.query.to || null;
    const params = {};
    let where = '1=1';
    if (from) {
      where += ' AND DATE(created_at) >= :from';
      params.from = from;
    }
    if (to) {
      where += ' AND DATE(created_at) <= :to';
      params.to = to;
    }

    const summary = await query(
      `SELECT
         SUM(status IN ('sent','delivered','read')) AS sent,
         SUM(status = 'delivered') AS delivered,
         SUM(status = 'read') AS \`read\`,
         SUM(status = 'failed') AS failed,
         SUM(status IN ('pending','queued')) AS pending,
         COUNT(*) AS total,
         SUM(cost) AS total_cost
       FROM campaign_messages WHERE ${where}`,
      params
    );

    const daily = await query(
      `SELECT DATE(created_at) AS day,
              SUM(status IN ('sent','delivered','read')) AS sent,
              SUM(status = 'delivered') AS delivered,
              SUM(status = 'read') AS \`read\`,
              SUM(status = 'failed') AS failed
       FROM campaign_messages WHERE ${where}
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      params
    );

    res.json({
      success: true,
      data: {
        summary: {
          sent: Number(summary[0]?.sent || 0),
          delivered: Number(summary[0]?.delivered || 0),
          read: Number(summary[0]?.read || 0),
          failed: Number(summary[0]?.failed || 0),
          pending: Number(summary[0]?.pending || 0),
          total: Number(summary[0]?.total || 0),
          total_cost: Number(summary[0]?.total_cost || 0),
        },
        daily,
      },
    });
  })
);

router.get(
  '/campaigns',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, name, status, total_count, sent_count, delivered_count, read_count,
              failed_count, pending_count, total_cost, created_at, completed_at
       FROM campaigns
       ORDER BY id DESC
       LIMIT 200`
    );
    res.json({ success: true, data: rows });
  })
);

export default router;
