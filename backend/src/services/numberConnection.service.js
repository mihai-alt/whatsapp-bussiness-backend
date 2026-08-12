import { query } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { encryptSecret, decryptSecret } from '../utils/tokenCrypto.js';
import { parseJson } from '../utils/helpers.js';
import {
  exchangeMetaAuthorization,
  getWabaInformation,
  getPhoneNumbers,
  getPhoneNumberInformation,
  verifyWabaPhoneRelationship,
  getBusinessInformation,
  subscribeWabaWebhooks,
  debugToken,
  disconnectMetaNumber,
} from './meta.service.js';

const SAFE_FIELDS = `id, phone_number, phone_number_id, waba_id, business_name, quality_rating,
  messaging_limit, status, profile_picture_url, about_text, connected_at, disconnected_at, created_at, updated_at`;

export function getAccountAccessToken(account) {
  if (!account?.access_token) return '';
  try {
    return decryptSecret(account.access_token);
  } catch (err) {
    console.error('Failed to decrypt WhatsApp access token:', err.message);
    throw new AppError(
      'Stored access token is invalid. Please reconnect the number.',
      400,
      'TOKEN_DECRYPT_FAILED',
      { state: 'failed' }
    );
  }
}

export function encryptAccessTokenForStorage(plainToken) {
  return encryptSecret(plainToken);
}

export function toPublicNumber(row) {
  if (!row) return null;
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    phoneNumberId: row.phone_number_id,
    wabaId: row.waba_id,
    businessName: row.business_name,
    qualityRating: row.quality_rating,
    messagingLimit: row.messaging_limit,
    connectionStatus: row.status,
    profilePictureUrl: row.profile_picture_url || null,
    aboutText: row.about_text || null,
    connectedAt: row.connected_at || null,
    disconnectedAt: row.disconnected_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    phone_number: row.phone_number,
    phone_number_id: row.phone_number_id,
    waba_id: row.waba_id,
    business_name: row.business_name,
    quality_rating: row.quality_rating,
    messaging_limit: row.messaging_limit,
    status: row.status,
    profile_picture_url: row.profile_picture_url || null,
    about_text: row.about_text || null,
    connected_at: row.connected_at || null,
    disconnected_at: row.disconnected_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function parseSessionInfo(sessionInfo) {
  if (sessionInfo == null || sessionInfo === '') return {};
  if (typeof sessionInfo === 'object') return sessionInfo;
  try {
    return JSON.parse(sessionInfo);
  } catch {
    throw new AppError('Invalid Meta sessionInfo payload.', 400, 'INVALID_SESSION_INFO', {
      state: 'failed',
    });
  }
}

/**
 * Official Embedded Signup provides:
 * - authResponse.code (FB.login)
 * - WA_EMBEDDED_SIGNUP message: data.phone_number_id, data.waba_id, data.business_id
 * IDs from the browser are hints only — always verified via Graph API.
 */
export function normalizeEmbeddedSignupBody(body = {}) {
  const session = parseSessionInfo(body.sessionInfo);
  const sessionData = session.data || session;

  const code = body.code || body.authorizationCode || body.authCode || null;
  const phoneNumberId =
    body.phoneNumberId ||
    body.phone_number_id ||
    sessionData.phone_number_id ||
    session.phone_number_id ||
    null;
  const wabaId =
    body.wabaId ||
    body.waba_id ||
    sessionData.waba_id ||
    session.waba_id ||
    (Array.isArray(sessionData.waba_ids) ? sessionData.waba_ids[0] : null) ||
    null;
  const businessId =
    body.businessId ||
    body.business_id ||
    sessionData.business_id ||
    session.business_id ||
    null;

  return {
    code: code ? String(code) : null,
    phoneNumberId: phoneNumberId ? String(phoneNumberId) : null,
    wabaId: wabaId ? String(wabaId) : null,
    businessId: businessId ? String(businessId) : null,
    state: body.state ? String(body.state) : null,
    event: (body.event || session.event) ? String(body.event || session.event) : null,
  };
}

async function resolvePhoneAndWaba({ accessToken, phoneNumberId, wabaId }) {
  let resolvedWabaId = wabaId ? String(wabaId) : '';
  let resolvedPhoneId = phoneNumberId ? String(phoneNumberId) : '';

  if (!resolvedWabaId) {
    throw new AppError(
      'WhatsApp Business Account ID was not returned by Meta Embedded Signup.',
      400,
      'WABA_MISSING',
      { state: 'failed' }
    );
  }

  await getWabaInformation(resolvedWabaId, accessToken);

  if (!resolvedPhoneId) {
    const phones = await getPhoneNumbers(resolvedWabaId, accessToken);
    if (!phones.length) {
      throw new AppError(
        'No phone number was found on this WhatsApp Business Account.',
        404,
        'PHONE_NOT_FOUND',
        { state: 'failed' }
      );
    }
    if (phones.length > 1) {
      throw new AppError(
        'Multiple phone numbers found on the WABA. Complete Embedded Signup with a specific number selected.',
        400,
        'PHONE_AMBIGUOUS',
        { state: 'failed' }
      );
    }
    resolvedPhoneId = String(phones[0].id);
  }

  await verifyWabaPhoneRelationship(resolvedWabaId, resolvedPhoneId, accessToken);
  return { phoneNumberId: resolvedPhoneId, wabaId: resolvedWabaId };
}

async function loadSafeAccount(id) {
  const rows = await query(`SELECT ${SAFE_FIELDS} FROM whatsapp_accounts WHERE id = :id LIMIT 1`, {
    id,
  });
  if (!rows.length) {
    throw new AppError('WhatsApp number not found', 404, 'NUMBER_NOT_FOUND', { state: 'failed' });
  }
  return toPublicNumber(rows[0]);
}

export async function listNumbersForUser() {
  const rows = await query(`SELECT ${SAFE_FIELDS} FROM whatsapp_accounts ORDER BY id DESC`);
  return rows.map(toPublicNumber);
}

export async function getNumberById(id) {
  const rows = await query(
    `SELECT ${SAFE_FIELDS}, meta_payload FROM whatsapp_accounts WHERE id = :id LIMIT 1`,
    { id }
  );
  if (!rows.length) {
    throw new AppError('WhatsApp number not found', 404, 'NUMBER_NOT_FOUND', { state: 'failed' });
  }
  const publicRow = toPublicNumber(rows[0]);
  const meta = parseJson(rows[0].meta_payload, {});
  publicRow.metaSummary = {
    businessId: meta.business_id || null,
    connectedVia: meta.connected_via || null,
  };
  return publicRow;
}

export async function connectFromEmbeddedSignup({ userId, rawBody, reconnectAccountId = null }) {
  const normalized = normalizeEmbeddedSignupBody(rawBody);

  if (!normalized.code) {
    throw new AppError(
      'Invalid Meta authorization data. An Embedded Signup authorization code is required.',
      400,
      'INVALID_AUTHORIZATION',
      { state: 'failed' }
    );
  }

  if (normalized.event && String(normalized.event).toUpperCase() === 'CANCEL') {
    throw new AppError('Meta onboarding was cancelled.', 400, 'USER_CANCELLED', {
      state: 'cancelled',
    });
  }

  const tokenData = await exchangeMetaAuthorization(normalized.code);
  const accessToken = tokenData.access_token;
  let tokenExpiresAt = null;
  if (tokenData.expires_in) {
    tokenExpiresAt = new Date(Date.now() + Number(tokenData.expires_in) * 1000);
  }

  try {
    const dbg = await debugToken(accessToken);
    if (dbg?.data && dbg.data.is_valid === false) {
      throw new AppError('Meta authorization/token is invalid.', 401, 'TOKEN_INVALID', {
        state: 'failed',
      });
    }
  } catch (err) {
    if (err instanceof AppError && err.code === 'TOKEN_INVALID') throw err;
    console.warn('Meta debug_token warning:', err.message);
  }

  const resolved = await resolvePhoneAndWaba({
    accessToken,
    phoneNumberId: normalized.phoneNumberId,
    wabaId: normalized.wabaId,
  });

  const existing = await query(
    'SELECT id, status FROM whatsapp_accounts WHERE phone_number_id = :phone_number_id LIMIT 1',
    { phone_number_id: resolved.phoneNumberId }
  );

  if (reconnectAccountId) {
    const target = await query(
      'SELECT id, phone_number_id FROM whatsapp_accounts WHERE id = :id LIMIT 1',
      { id: reconnectAccountId }
    );
    if (!target.length) {
      throw new AppError('WhatsApp number not found', 404, 'NUMBER_NOT_FOUND', { state: 'failed' });
    }
    if (
      existing.length &&
      Number(existing[0].id) !== Number(reconnectAccountId) &&
      existing[0].status === 'connected'
    ) {
      throw new AppError(
        'This WhatsApp Business number is already connected.',
        409,
        'DUPLICATE_NUMBER',
        { state: 'already_connected' }
      );
    }
  } else if (existing.length && existing[0].status === 'connected') {
    throw new AppError(
      'This WhatsApp Business number is already connected.',
      409,
      'DUPLICATE_NUMBER',
      { state: 'already_connected' }
    );
  }

  const phone = await getPhoneNumberInformation(resolved.phoneNumberId, accessToken);
  let waba = null;
  try {
    waba = await getWabaInformation(resolved.wabaId, accessToken);
  } catch {
    waba = { id: resolved.wabaId, name: null };
  }

  let profile = null;
  try {
    profile = await getBusinessInformation(resolved.phoneNumberId, accessToken);
  } catch (err) {
    console.warn('Business profile lookup warning:', err.message);
  }

  try {
    await subscribeWabaWebhooks(resolved.wabaId, accessToken);
  } catch (err) {
    console.warn('Webhook subscribe warning:', err.message);
  }

  const payload = {
    phone_number: phone.display_phone_number || null,
    phone_number_id: resolved.phoneNumberId,
    waba_id: resolved.wabaId,
    business_name: phone.verified_name || waba?.name || null,
    quality_rating: phone.quality_rating || null,
    messaging_limit: phone.messaging_limit_tier || null,
    access_token: encryptSecret(accessToken),
    token_expires_at: tokenExpiresAt,
    status: 'connected',
    profile_picture_url: profile?.profile_picture_url || null,
    about_text: profile?.about || null,
    meta_payload: JSON.stringify({
      phone,
      waba,
      profile,
      business_id: normalized.businessId || null,
      connected_via: 'meta_embedded_signup',
      client_state: normalized.state || null,
    }),
    connected_by: userId,
  };

  let id;
  if (reconnectAccountId) {
    id = Number(reconnectAccountId);
    await query(
      `UPDATE whatsapp_accounts SET
        phone_number = :phone_number,
        phone_number_id = :phone_number_id,
        waba_id = :waba_id,
        business_name = :business_name,
        quality_rating = :quality_rating,
        messaging_limit = :messaging_limit,
        access_token = :access_token,
        token_expires_at = :token_expires_at,
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
  } else if (existing.length) {
    id = existing[0].id;
    await query(
      `UPDATE whatsapp_accounts SET
        phone_number = :phone_number,
        waba_id = :waba_id,
        business_name = :business_name,
        quality_rating = :quality_rating,
        messaging_limit = :messaging_limit,
        access_token = :access_token,
        token_expires_at = :token_expires_at,
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
        access_token, token_expires_at, status, profile_picture_url, about_text, meta_payload, connected_by, connected_at)
       VALUES
       (:phone_number, :phone_number_id, :waba_id, :business_name, :quality_rating, :messaging_limit,
        :access_token, :token_expires_at, 'connected', :profile_picture_url, :about_text, :meta_payload, :connected_by, NOW())`,
      payload
    );
    id = result.insertId;
  }

  const account = await loadSafeAccount(id);
  try {
    const { notifyProjectEvent } = await import('./notification.service.js');
    const label = account.phone_number || account.business_name || `#${id}`;
    await notifyProjectEvent({
      type: reconnectAccountId ? 'number_reconnected' : 'number_connected',
      title: reconnectAccountId ? 'WhatsApp number reconnected' : 'WhatsApp number connected',
      body: `${label} is now connected.`,
      meta: {
        numberId: Number(id),
        phoneNumber: account.phone_number || null,
        connectedBy: userId,
      },
      actorUserId: userId,
    });
  } catch (err) {
    console.warn('Number connect notification failed:', err.message);
  }
  return account;
}

export async function disconnectNumber(id, actorUserId = null) {
  const rows = await query(
    'SELECT id, phone_number, business_name FROM whatsapp_accounts WHERE id = :id LIMIT 1',
    { id }
  );
  if (!rows.length) {
    throw new AppError('WhatsApp number not found', 404, 'NUMBER_NOT_FOUND', { state: 'failed' });
  }

  await disconnectMetaNumber();

  await query(
    `UPDATE whatsapp_accounts
     SET status = 'disconnected', disconnected_at = NOW(), access_token = '', token_expires_at = NULL
     WHERE id = :id`,
    { id }
  );

  try {
    const { notifyProjectEvent } = await import('./notification.service.js');
    const label = rows[0].phone_number || rows[0].business_name || `#${id}`;
    await notifyProjectEvent({
      type: 'number_disconnected',
      title: 'WhatsApp number disconnected',
      body: `${label} was disconnected.`,
      meta: { numberId: Number(id), phoneNumber: rows[0].phone_number || null, disconnectedBy: actorUserId },
      actorUserId: actorUserId,
    });
  } catch (err) {
    console.warn('Number disconnect notification failed:', err.message);
  }

  return {
    id: Number(id),
    connectionStatus: 'disconnected',
    message:
      'Disconnected. Messaging for this number is unavailable until you reconnect via Meta Embedded Signup.',
  };
}

export async function refreshNumber(id) {
  const rows = await query('SELECT * FROM whatsapp_accounts WHERE id = :id LIMIT 1', { id });
  if (!rows.length) {
    throw new AppError('WhatsApp number not found', 404, 'NUMBER_NOT_FOUND', { state: 'failed' });
  }
  const account = rows[0];
  if (account.status !== 'connected') {
    throw new AppError('Account is disconnected. Reconnect via Meta first.', 400, 'DISCONNECTED', {
      state: 'failed',
    });
  }

  const accessToken = getAccountAccessToken(account);
  if (!accessToken) {
    throw new AppError('No access token stored. Please reconnect via Meta.', 400, 'TOKEN_MISSING', {
      state: 'failed',
    });
  }

  const phone = await getPhoneNumberInformation(account.phone_number_id, accessToken);
  let profile = null;
  try {
    profile = await getBusinessInformation(account.phone_number_id, accessToken);
  } catch {
    /* optional */
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
      meta_payload: JSON.stringify({ phone, profile, refreshed_at: new Date().toISOString() }),
    }
  );

  return loadSafeAccount(account.id);
}
