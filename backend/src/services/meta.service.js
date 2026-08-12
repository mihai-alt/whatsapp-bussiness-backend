import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { config } from '../config.js';
import { AppError } from '../middleware/error.js';

function graphBase() {
  return `https://graph.facebook.com/${config.meta.graphVersion}`;
}

function metaHttpError(err, fallbackMessage, fallbackCode) {
  const meta = err.response?.data?.error;
  const status = err.response?.status || 502;
  let message = meta?.message || err.message || fallbackMessage;
  if (config.meta.appSecret) {
    message = String(message).split(config.meta.appSecret).join('[redacted]');
  }
  const code = meta?.code ? `META_${meta.code}` : fallbackCode;
  return new AppError(message, status >= 400 && status < 600 ? status : 502, code, {
    state: 'failed',
  });
}

export function assertMetaAppConfigured() {
  const missing = [];
  if (!config.meta.appId) missing.push('META_APP_ID');
  if (!config.meta.appSecret) missing.push('META_APP_SECRET');
  if (!config.meta.configId) missing.push('META_CONFIG_ID');
  if (missing.length) {
    throw new AppError(
      `Meta Embedded Signup is not configured (${missing.join(', ')}).`,
      503,
      'META_NOT_CONFIGURED',
      { state: 'failed', details: { missing } }
    );
  }
}

export function getMetaClient(accessToken) {
  return axios.create({
    baseURL: graphBase(),
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 60000,
  });
}

/** Exchange Embedded Signup authorization code (~30s TTL) for a business token. */
export async function exchangeMetaAuthorization(code) {
  assertMetaAppConfigured();
  if (!code) {
    throw new AppError('Meta authorization code is required', 400, 'CODE_REQUIRED', {
      state: 'failed',
    });
  }
  try {
    const { data } = await axios.get(`${graphBase()}/oauth/access_token`, {
      params: {
        client_id: config.meta.appId,
        client_secret: config.meta.appSecret,
        code,
      },
    });
    if (!data?.access_token) {
      throw new AppError(
        'Meta did not return an access token for this authorization.',
        502,
        'TOKEN_MISSING',
        { state: 'failed' }
      );
    }
    return data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw metaHttpError(err, 'Unable to exchange Meta authorization code.', 'CODE_EXCHANGE_FAILED');
  }
}

export async function exchangeCodeForToken(code) {
  return exchangeMetaAuthorization(code);
}

export async function debugToken(inputToken) {
  assertMetaAppConfigured();
  try {
    const { data } = await axios.get(`${graphBase()}/debug_token`, {
      params: {
        input_token: inputToken,
        access_token: `${config.meta.appId}|${config.meta.appSecret}`,
      },
    });
    return data;
  } catch (err) {
    throw metaHttpError(err, 'Unable to validate Meta access token.', 'TOKEN_DEBUG_FAILED');
  }
}

export async function getPhoneNumberInformation(phoneNumberId, accessToken) {
  const client = getMetaClient(accessToken);
  try {
    const { data } = await client.get(`/${phoneNumberId}`, {
      params: {
        fields:
          'display_phone_number,verified_name,quality_rating,messaging_limit_tier,account_mode,is_official_business_account',
      },
    });
    return data;
  } catch (err) {
    throw metaHttpError(err, 'Phone number not found or inaccessible.', 'PHONE_NOT_FOUND');
  }
}

export async function fetchPhoneNumberDetails(phoneNumberId, accessToken) {
  return getPhoneNumberInformation(phoneNumberId, accessToken);
}

export async function getWabaInformation(wabaId, accessToken) {
  const client = getMetaClient(accessToken);
  try {
    const { data } = await client.get(`/${wabaId}`, {
      params: {
        fields: 'id,name,currency,account_review_status,message_template_namespace,owner_business_info',
      },
    });
    return data;
  } catch (err) {
    throw metaHttpError(err, 'WhatsApp Business Account not found or inaccessible.', 'WABA_NOT_FOUND');
  }
}

export async function fetchWabaDetails(wabaId, accessToken) {
  return getWabaInformation(wabaId, accessToken);
}

export async function getPhoneNumbers(wabaId, accessToken) {
  const client = getMetaClient(accessToken);
  try {
    const { data } = await client.get(`/${wabaId}/phone_numbers`, {
      params: {
        fields:
          'id,display_phone_number,verified_name,quality_rating,messaging_limit_tier,account_mode',
      },
    });
    return data?.data || [];
  } catch (err) {
    throw metaHttpError(err, 'Unable to list phone numbers for this WABA.', 'WABA_PHONES_LOOKUP_FAILED');
  }
}

export async function verifyWabaPhoneRelationship(wabaId, phoneNumberId, accessToken) {
  const phones = await getPhoneNumbers(wabaId, accessToken);
  const match = phones.find((p) => String(p.id) === String(phoneNumberId));
  if (!match) {
    throw new AppError(
      'Phone number does not belong to the reported WhatsApp Business Account.',
      400,
      'PHONE_WABA_MISMATCH',
      { state: 'failed' }
    );
  }
  return match;
}

export async function getBusinessInformation(phoneNumberId, accessToken) {
  const client = getMetaClient(accessToken);
  try {
    const { data } = await client.get(`/${phoneNumberId}/whatsapp_business_profile`, {
      params: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' },
    });
    return data?.data?.[0] || data;
  } catch (err) {
    throw metaHttpError(err, 'Unable to retrieve WhatsApp business profile.', 'PROFILE_LOOKUP_FAILED');
  }
}

export async function fetchBusinessProfile(phoneNumberId, accessToken) {
  return getBusinessInformation(phoneNumberId, accessToken);
}

export async function updateBusinessProfile(phoneNumberId, accessToken, payload) {
  const client = getMetaClient(accessToken);
  const { data } = await client.post(`/${phoneNumberId}/whatsapp_business_profile`, payload);
  return data;
}

export async function uploadMedia(phoneNumberId, accessToken, filePath, mimeType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', fs.createReadStream(filePath), { contentType: mimeType });
  form.append('type', mimeType);
  const client = getMetaClient(accessToken);
  const { data } = await client.post(`/${phoneNumberId}/media`, form, {
    headers: form.getHeaders(),
  });
  return data;
}

export async function createMessageTemplate(wabaId, accessToken, template) {
  const client = getMetaClient(accessToken);
  const { data } = await client.post(`/${wabaId}/message_templates`, template);
  return data;
}

export async function listMessageTemplates(wabaId, accessToken, { limit = 100 } = {}) {
  const client = getMetaClient(accessToken);
  const { data } = await client.get(`/${wabaId}/message_templates`, {
    params: { limit, fields: 'name,status,language,category,components,rejected_reason,id' },
  });
  return data;
}

export async function deleteMessageTemplate(wabaId, accessToken, name) {
  const client = getMetaClient(accessToken);
  const { data } = await client.delete(`/${wabaId}/message_templates`, {
    params: { name },
  });
  return data;
}

export async function sendTemplateMessage({
  phoneNumberId,
  accessToken,
  to,
  templateName,
  language,
  components,
}) {
  const client = getMetaClient(accessToken);
  try {
    const { data } = await client.post(`/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        components: components || undefined,
      },
    });
    return data;
  } catch (err) {
    throw metaHttpError(err, 'Failed to send WhatsApp template message.', 'META_API_ERROR');
  }
}

export async function subscribeWabaWebhooks(wabaId, accessToken) {
  const client = getMetaClient(accessToken);
  try {
    const { data } = await client.post(`/${wabaId}/subscribed_apps`);
    return data;
  } catch (err) {
    throw metaHttpError(err, 'Unable to subscribe app to WABA webhooks.', 'WEBHOOK_SUBSCRIBE_FAILED');
  }
}

/** Local disconnect — Meta has no universal Embedded Signup unlink for all partner types. */
export async function disconnectMetaNumber() {
  return { localOnly: true };
}
