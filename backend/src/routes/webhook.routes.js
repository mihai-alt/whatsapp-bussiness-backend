import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { notifyProjectEvent } from '../services/notification.service.js';
import { refreshCampaignStatus } from '../queues/campaign.queue.js';
import { asyncHandler } from '../middleware/error.js';
import { getIO } from '../realtime.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === config.meta.webhookVerifyToken) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    res.sendStatus(200);
    try {
      await processWebhook(req.body);
    } catch (err) {
      console.error('Webhook processing error:', err.message);
    }
  })
);

async function processWebhook(body) {
  const entries = body?.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field === 'messages') {
        await handleMessageStatuses(change.value);
      }
      if (change.field === 'message_template_status_update') {
        await handleTemplateStatus(change.value);
      }
    }
  }
}

async function handleMessageStatuses(value) {
  const statuses = value?.statuses || [];
  for (const st of statuses) {
    const wamid = st.id;
    const status = st.status; // sent, delivered, read, failed
    const messages = await query(
      'SELECT id, campaign_id, status FROM campaign_messages WHERE wamid = :wamid LIMIT 1',
      { wamid }
    );
    if (!messages.length) continue;
    const msg = messages[0];

    if (status === 'delivered') {
      await query(
        `UPDATE campaign_messages SET status = 'delivered', delivered_at = FROM_UNIXTIME(:ts)
         WHERE id = :id AND status IN ('sent','delivered')`,
        { id: msg.id, ts: st.timestamp }
      );
      if (msg.status === 'sent') {
        await query(
          `UPDATE campaigns SET delivered_count = delivered_count + 1 WHERE id = :id`,
          { id: msg.campaign_id }
        );
      }
    } else if (status === 'read') {
      await query(
        `UPDATE campaign_messages SET status = 'read', read_at = FROM_UNIXTIME(:ts),
         delivered_at = COALESCE(delivered_at, FROM_UNIXTIME(:ts))
         WHERE id = :id`,
        { id: msg.id, ts: st.timestamp }
      );
      if (msg.status !== 'read') {
        await query(`UPDATE campaigns SET read_count = read_count + 1 WHERE id = :id`, {
          id: msg.campaign_id,
        });
        if (msg.status === 'sent') {
          await query(`UPDATE campaigns SET delivered_count = delivered_count + 1 WHERE id = :id`, {
            id: msg.campaign_id,
          });
        }
      }
    } else if (status === 'failed') {
      const err = st.errors?.[0];
      await query(
        `UPDATE campaign_messages SET status = 'failed', failed_at = FROM_UNIXTIME(:ts),
         error_code = :code, error_message = :msg WHERE id = :id`,
        {
          id: msg.id,
          ts: st.timestamp,
          code: String(err?.code || 'META_FAIL').slice(0, 64),
          msg: err?.title || err?.message || 'Failed',
        }
      );
      const campaignRows = await query(
        'SELECT created_by, name FROM campaigns WHERE id = :id LIMIT 1',
        { id: msg.campaign_id }
      );
      const creatorId = campaignRows[0]?.created_by;
      await notifyProjectEvent({
        type: 'failed_messages',
        title: 'Message delivery failed',
        body: err?.title || 'A WhatsApp message failed',
        meta: { campaignId: msg.campaign_id, messageId: msg.id },
        relatedUserIds: creatorId ? [creatorId] : [],
      });
    }

    await refreshCampaignStatus(msg.campaign_id);
    getIO()?.emit('message:status', {
      campaignId: msg.campaign_id,
      messageId: msg.id,
      status,
      wamid,
    });
  }
}

async function handleTemplateStatus(value) {
  const name = value?.message_template_name;
  const language = value?.message_template_language;
  const event = (value?.event || '').toUpperCase();
  if (!name) return;

  let status = 'PENDING';
  if (event.includes('APPROVE')) status = 'APPROVED';
  if (event.includes('REJECT')) status = 'REJECTED';
  if (event.includes('PAUSE')) status = 'PAUSED';
  if (event.includes('DISABLE')) status = 'DISABLED';

  await query(
    `UPDATE templates SET status = :status, rejection_reason = :reason
     WHERE name = :name AND (:language IS NULL OR language = :language)`,
    {
      status,
      reason: value?.reason || null,
      name,
      language: language || null,
    }
  );

  if (status === 'APPROVED' || status === 'REJECTED') {
    const templates = await query(
      `SELECT created_by FROM templates
       WHERE name = :name AND (:language IS NULL OR language = :language)
       LIMIT 1`,
      { name, language: language || null }
    );
    await notifyProjectEvent({
      type: status === 'APPROVED' ? 'template_approved' : 'template_rejected',
      title: `Template ${name} ${status.toLowerCase()}`,
      body: value?.reason || `Template ${name} is ${status}`,
      meta: { name, language, status },
      relatedUserIds: templates[0]?.created_by ? [templates[0].created_by] : [],
    });
  }
}

export default router;
