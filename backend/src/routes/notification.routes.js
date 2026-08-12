import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import {
  countUnreadNotifications,
  listNotifications,
  markAllRead,
  markNotificationRead,
} from '../services/notification.service.js';

const router = Router();
router.use(authenticate);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await listNotifications({
      userId: req.user.id,
      page: Number(req.query.page || 1),
      limit: Number(req.query.limit || 30),
    });
    res.json({ success: true, data: rows });
  })
);

router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    const count = await countUnreadNotifications(req.user.id);
    res.json({ success: true, data: { count } });
  })
);

router.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    await markNotificationRead(req.params.id, req.user.id);
    res.json({ success: true, data: { message: 'Marked read' } });
  })
);

router.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await markAllRead(req.user.id);
    res.json({ success: true, data: { message: 'All marked read' } });
  })
);

export default router;
