import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { sendTemplateMessage } from '../services/meta.service.js';
import { debitWallet, getMessageCost, getMessagePricing, getWallet, calcPlatformRevenue } from '../services/wallet.service.js';
import { notifyProjectEvent } from '../services/notification.service.js';
import { emitCampaignProgress } from '../realtime.js';
import { parseJson } from '../utils/helpers.js';
import { getAccountAccessToken } from '../services/numberConnection.service.js';

let connection;
let campaignQueue;
let worker;

function getConnection() {
  if (!connection) {
    if (config.redis.url) {
      connection = new IORedis(config.redis.url, {
        maxRetriesPerRequest: null,
      });
    } else {
      connection = new IORedis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password || undefined,
        maxRetriesPerRequest: null,
      });
    }
  }
  return connection;
}

export function getCampaignQueue() {
  if (!campaignQueue) {
    campaignQueue = new Queue('campaign-send', { connection: getConnection() });
  }
  return campaignQueue;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildTemplateComponents(template, variables, mapping) {
  const components = parseJson(template.components, []);
  const bodyComp = components.find((c) => c.type === 'BODY' || c.type === 'body');
  const paramCount = (bodyComp?.text?.match(/\{\{\d+\}\}/g) || []).length;
  if (!paramCount) return undefined;

  const parameters = [];
  for (let i = 1; i <= paramCount; i += 1) {
    const key = mapping?.[String(i)] || mapping?.[i] || String(i);
    let value = variables?.[key] ?? variables?.[String(i)] ?? variables?.[`{{${i}}}`];
    if (value == null && Array.isArray(variables)) value = variables[i - 1];
    parameters.push({ type: 'text', text: String(value ?? '') });
  }
  return [{ type: 'body', parameters }];
}

export async function enqueueCampaign(campaignId) {
  const queue = getCampaignQueue();
  await queue.add(
    'run-campaign',
    { campaignId },
    {
      jobId: `campaign-${campaignId}-${Date.now()}`,
      removeOnComplete: 100,
      removeOnFail: 200,
    }
  );
}

export async function enqueueCampaignMessages(campaignId, messageIds = null) {
  const queue = getCampaignQueue();
  let messages;
  if (messageIds?.length) {
    messages = await query(
      `SELECT id FROM campaign_messages WHERE campaign_id = :campaignId AND id IN (${messageIds
        .map((_, i) => `:id${i}`)
        .join(',')})`,
      Object.fromEntries([['campaignId', campaignId], ...messageIds.map((id, i) => [`id${i}`, id])])
    );
  } else {
    messages = await query(
      `SELECT id FROM campaign_messages
       WHERE campaign_id = :campaignId
         AND status IN ('pending','failed','queued')
         AND (wamid IS NULL OR wamid = '')`,
      { campaignId }
    );
  }

  for (const msg of messages) {
    const jobId = `cm-send-${msg.id}`;
    try {
      const existing = await queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (['waiting', 'delayed', 'active', 'paused'].includes(state)) continue;
        await existing.remove().catch(() => {});
      }
      await queue.add(
        'send-message',
        { campaignId, messageId: msg.id },
        {
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 500,
          removeOnFail: 500,
        }
      );
    } catch (err) {
      // Same message already queued — avoid duplicate Meta sends
      if (!String(err?.message || '').toLowerCase().includes('job')) {
        throw err;
      }
    }
  }
  return messages.length;
}

/** Remove delayed schedule job and waiting send jobs for a campaign (best-effort). */
export async function drainCampaignJobs(campaignId, { removeScheduled = true } = {}) {
  const queue = getCampaignQueue();
  if (removeScheduled) {
    try {
      const sched = await queue.getJob(`campaign-sched-${campaignId}`);
      if (sched) await sched.remove();
    } catch {
      /* ignore */
    }
  }
  try {
    const waiting = await queue.getJobs(['waiting', 'delayed', 'paused']);
    await Promise.all(
      waiting
        .filter((j) => Number(j.data?.campaignId) === Number(campaignId))
        .map((j) => j.remove().catch(() => {}))
    );
  } catch {
    /* ignore */
  }
}

async function processSendMessage(job) {
  const { campaignId, messageId } = job.data;

  const campaigns = await query(
    `SELECT c.*, t.name AS template_name, t.language, t.category, t.components AS template_components,
            wa.phone_number_id, wa.access_token, wa.status AS account_status
     FROM campaigns c
     JOIN templates t ON t.id = c.template_id
     JOIN whatsapp_accounts wa ON wa.id = c.whatsapp_account_id
     WHERE c.id = :id LIMIT 1`,
    { id: campaignId }
  );
  if (!campaigns.length) return;
  const campaign = campaigns[0];

  if (['paused', 'cancelled'].includes(campaign.status)) {
    return;
  }

  const messages = await query(
    `SELECT * FROM campaign_messages WHERE id = :id AND campaign_id = :campaignId LIMIT 1`,
    { id: messageId, campaignId }
  );
  if (!messages.length) return;
  const message = messages[0];
  // Idempotency: never resend once Meta accepted (wamid) or terminal success states
  if (message.wamid || ['sent', 'delivered', 'read', 'cancelled'].includes(message.status)) {
    return;
  }
  if (!['pending', 'failed', 'queued'].includes(message.status)) return;

  if (campaign.account_status !== 'connected') {
    await markFailed(message.id, campaignId, 'ACCOUNT_DISCONNECTED', 'WhatsApp account disconnected');
    return;
  }

  const cost = Number(campaign.cost_per_message) || (await getMessageCost(campaign.category));
  const wallet = await getWallet();
  if (Number(wallet.balance) < cost) {
    await query(`UPDATE campaigns SET status = 'paused' WHERE id = :id`, { id: campaignId });
    await notifyProjectEvent({
      type: 'low_wallet',
      title: 'Campaign paused — low wallet balance',
      body: `Campaign #${campaignId} paused due to insufficient balance`,
      meta: { campaignId },
      relatedUserIds: campaign.created_by ? [campaign.created_by] : [],
    });
    emitCampaignProgress(campaignId, { status: 'paused', reason: 'low_wallet' });
    return;
  }

  // Claim the row atomically so concurrent workers cannot double-send
  const claimed = await query(
    `UPDATE campaign_messages SET status = 'queued'
     WHERE id = :id AND status IN ('pending','failed','queued') AND (wamid IS NULL OR wamid = '')`,
    { id: message.id }
  );
  if (!claimed.affectedRows) return;

  try {
    const pricing = await getMessagePricing(campaign.category);
    const platformRevenue = calcPlatformRevenue(cost, pricing.providerCost);
    await debitWallet({
      userId: campaign.created_by || null,
      amount: cost,
      description: `WhatsApp message charge (Campaign #${campaignId} / message #${message.id})`,
      createdBy: campaign.created_by || null,
      referenceType: 'campaign_message',
      referenceId: String(message.id),
      platformRevenue,
    });

    const mapping = parseJson(campaign.variable_mapping, {});
    const variables = parseJson(message.variables, {});
    const template = {
      components: parseJson(campaign.template_components, []),
    };
    const components = buildTemplateComponents(template, variables, mapping);

    const result = await sendTemplateMessage({
      phoneNumberId: campaign.phone_number_id,
      accessToken: getAccountAccessToken(campaign),
      to: message.phone,
      templateName: campaign.template_name,
      language: campaign.language,
      components,
    });

    const wamid = result?.messages?.[0]?.id || null;
    await query(
      `UPDATE campaign_messages SET status = 'sent', wamid = :wamid, cost = :cost, sent_at = NOW(),
       error_code = NULL, error_message = NULL WHERE id = :id`,
      { id: message.id, wamid, cost }
    );
    await query(
      `UPDATE campaigns SET sent_count = sent_count + 1,
        pending_count = GREATEST(pending_count - 1, 0),
        total_cost = total_cost + :cost
       WHERE id = :id`,
      { id: campaignId, cost }
    );
  } catch (err) {
    await markFailed(message.id, campaignId, err.code || 'SEND_ERROR', err.message);
  }

  await sleep(config.campaignSendDelayMs);
  await refreshCampaignStatus(campaignId);
}

async function markFailed(messageId, campaignId, code, errorMessage) {
  await query(
    `UPDATE campaign_messages SET status = 'failed', error_code = :code, error_message = :msg, failed_at = NOW()
     WHERE id = :id`,
    { id: messageId, code: String(code).slice(0, 64), msg: errorMessage }
  );
  await query(
    `UPDATE campaigns SET failed_count = failed_count + 1, pending_count = GREATEST(pending_count - 1, 0)
     WHERE id = :id`,
    { id: campaignId }
  );
}

export async function refreshCampaignStatus(campaignId) {
  const stats = await query(
    `SELECT
       SUM(status IN ('pending','queued')) AS pending_count,
       SUM(status = 'sent') AS sent_count,
       SUM(status = 'delivered') AS delivered_count,
       SUM(status = 'read') AS read_count,
       SUM(status = 'failed') AS failed_count,
       COUNT(*) AS total_count
     FROM campaign_messages WHERE campaign_id = :id`,
    { id: campaignId }
  );
  const s = stats[0];
  const campaigns = await query('SELECT status, created_by, name FROM campaigns WHERE id = :id', {
    id: campaignId,
  });
  if (!campaigns.length) return;
  let status = campaigns[0].status;
  const createdBy = campaigns[0].created_by;
  const campaignName = campaigns[0].name || `#${campaignId}`;

  const pending = Number(s.pending_count || 0);
  const total = Number(s.total_count || 0);
  if (!['paused', 'cancelled'].includes(status)) {
    if (pending === 0 && total > 0) {
      status = 'completed';
      await query(
        `UPDATE campaigns SET status = 'completed', completed_at = NOW(),
          pending_count = :pending_count, sent_count = :sent_count, delivered_count = :delivered_count,
          read_count = :read_count, failed_count = :failed_count, total_count = :total_count
         WHERE id = :id`,
        {
          id: campaignId,
          pending_count: pending,
          sent_count: Number(s.sent_count || 0),
          delivered_count: Number(s.delivered_count || 0),
          read_count: Number(s.read_count || 0),
          failed_count: Number(s.failed_count || 0),
          total_count: total,
        }
      );
      await notifyProjectEvent({
        type: 'campaign_completed',
        title: `Campaign completed`,
        body: `"${campaignName}" finished — sent ${s.sent_count}, failed ${s.failed_count}.`,
        meta: { campaignId },
        relatedUserIds: createdBy ? [createdBy] : [],
      });
    } else {
      await query(
        `UPDATE campaigns SET
          pending_count = :pending_count, sent_count = :sent_count, delivered_count = :delivered_count,
          read_count = :read_count, failed_count = :failed_count, total_count = :total_count,
          status = IF(status IN ('queued','scheduled'), 'running', status)
         WHERE id = :id`,
        {
          id: campaignId,
          pending_count: pending,
          sent_count: Number(s.sent_count || 0),
          delivered_count: Number(s.delivered_count || 0),
          read_count: Number(s.read_count || 0),
          failed_count: Number(s.failed_count || 0),
          total_count: total,
        }
      );
      status = status === 'queued' || status === 'scheduled' ? 'running' : status;
    }
  }

  emitCampaignProgress(campaignId, {
    status,
    pending_count: Number(s.pending_count || 0),
    sent_count: Number(s.sent_count || 0),
    delivered_count: Number(s.delivered_count || 0),
    read_count: Number(s.read_count || 0),
    failed_count: Number(s.failed_count || 0),
    total_count: total,
  });
}

export function startCampaignWorker() {
  if (worker) return worker;
  worker = new Worker(
    'campaign-send',
    async (job) => {
      if (job.name === 'run-campaign') {
        const { campaignId } = job.data;
        await query(
          `UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = :id AND status IN ('queued','scheduled','running')`,
          { id: campaignId }
        );
        await enqueueCampaignMessages(campaignId);
        return;
      }
      if (job.name === 'send-message') {
        await processSendMessage(job);
      }
    },
    {
      connection: getConnection(),
      concurrency: config.campaignConcurrency,
    }
  );

  worker.on('failed', (job, err) => {
    console.error('Campaign job failed', job?.id, err.message);
  });

  return worker;
}
