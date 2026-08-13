import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { listAuditLogs } from '../services/audit.service.js';

const router = Router();
router.use(authenticate, requireRole('admin'));

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 50);
    const data = await listAuditLogs({ page, limit });
    res.json({ success: true, data });
  })
);

export default router;
