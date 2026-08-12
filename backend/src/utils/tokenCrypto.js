import crypto from 'crypto';
import { config } from '../config.js';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';

function getKey() {
  const material =
    config.meta.tokenEncryptionKey ||
    `${config.jwt.accessSecret}:${config.meta.appSecret || 'meta'}`;
  return crypto.createHash('sha256').update(material).digest();
}

export function encryptSecret(plain) {
  if (plain == null || plain === '') return '';
  const text = String(plain);
  if (text.startsWith(PREFIX)) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptSecret(value) {
  if (value == null || value === '') return '';
  const text = String(value);
  if (!text.startsWith(PREFIX)) return text;
  const parts = text.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted token format');
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
