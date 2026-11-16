// Standard Webhooks signature check for divdio Work deliveries. Only node:crypto, so tests load it without n8n.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Whether a delivery's webhook-signature header (space-separated v1,<base64>) signs "id.timestamp.body" with the secret. */
export function verifySignature(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer | string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): 'ok' | 'missing-headers' | 'stale-timestamp' | 'bad-signature' {
  const h = (name: string) => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(v) ? v.join(' ') : v;
  };
  const id = h('webhook-id');
  const ts = h('webhook-timestamp');
  const sig = h('webhook-signature');
  if (!id || !ts || !sig) return 'missing-headers';
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds) return 'stale-timestamp';
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody;
  const want = createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${id}.${ts}.`), body])).digest();
  for (const part of sig.split(' ')) {
    const [version, value] = part.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const got = Buffer.from(value, 'base64');
    if (got.length === want.length && timingSafeEqual(got, want)) return 'ok';
  }
  return 'bad-signature';
}
