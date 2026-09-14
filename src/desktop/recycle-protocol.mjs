import { createHmac, timingSafeEqual } from 'node:crypto';

export const RECYCLE_SERVER = 'autocodex_recycle';
export function signRecycle(value, secret) {
  return createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex');
}
export function verifiedRecycle(meta, secret) {
  const value = meta?.autocodexRecycle, signature = meta?.autocodexSignature;
  if (!secret || !value || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return null;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(signRecycle(value, secret))) ? value : null;
}
