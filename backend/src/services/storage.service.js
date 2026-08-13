import fs from 'fs';
import path from 'path';
import { createHash, createHmac } from 'crypto';
import { config } from '../config.js';

function s3Configured() {
  return Boolean(
    config.storage.bucket &&
      config.storage.accessKeyId &&
      config.storage.secretAccessKey &&
      config.storage.endpoint
  );
}

export function isObjectStorageConfigured() {
  return s3Configured();
}

/** Public URL for a stored relative key like `avatars/x.jpg`. */
export function publicUrlForKey(key) {
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return key;
  const clean = String(key).replace(/^\/+/, '');
  if (s3Configured() && config.storage.publicBaseUrl) {
    return `${config.storage.publicBaseUrl.replace(/\/+$/, '')}/${clean}`;
  }
  return `/uploads/${clean}`;
}

/**
 * Persist a local file. Returns { key, url }.
 * Uses S3-compatible storage (AWS/R2/MinIO) when configured; otherwise keeps local disk.
 */
export async function persistLocalFile(localPath, { key, contentType } = {}) {
  if (!localPath || !fs.existsSync(localPath)) {
    throw new Error('Local file missing for upload');
  }
  const finalKey = (key || path.basename(localPath)).replace(/^\/+/, '');

  if (!s3Configured()) {
    const dest = path.resolve(config.uploadDir, finalKey);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (path.resolve(localPath) !== dest) {
      fs.renameSync(localPath, dest);
    }
    return { key: finalKey, url: publicUrlForKey(finalKey), storage: 'local' };
  }

  const body = fs.readFileSync(localPath);
  await putObjectS3({
    key: finalKey,
    body,
    contentType: contentType || 'application/octet-stream',
  });

  // Prefer object storage as source of truth
  try {
    fs.unlinkSync(localPath);
  } catch {
    /* ignore */
  }

  return { key: finalKey, url: publicUrlForKey(finalKey), storage: 's3' };
}

async function putObjectS3({ key, body, contentType }) {
  const endpoint = config.storage.endpoint.replace(/\/+$/, '');
  const url = new URL(endpoint);
  const host = url.host;
  const region = config.storage.region || 'auto';
  const bucket = config.storage.bucket;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update(body).digest('hex');
  const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signingKey = getSignatureKey(
    config.storage.secretAccessKey,
    dateStamp,
    region,
    's3'
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.storage.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`${endpoint}${canonicalUri}`, {
    method: 'PUT',
    headers: {
      Host: host,
      'Content-Type': contentType,
      'X-Amz-Content-Sha256': payloadHash,
      'X-Amz-Date': amzDate,
      Authorization: authorization,
      'Content-Length': String(body.length),
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function getSignatureKey(secret, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}
