import { createHmac, timingSafeEqual } from 'node:crypto';

// Spec section 11, "HMAC scheme for /internal/*". Shared by the API (verify) and the CLI (sign) so the two
// cannot drift. Headers: X-QSR-Timestamp (unix seconds) and X-QSR-Signature: sha256=<hex>, where the
// signature is HMAC_SHA256(INGEST_HMAC_SECRET, timestamp + "." + rawBody). 100% coverage is enforced.

export const HMAC_WINDOW_SECONDS = 300;
export const TIMESTAMP_HEADER = 'x-qsr-timestamp';
export const SIGNATURE_HEADER = 'x-qsr-signature';

const SIGNATURE_FORMAT = /^sha256=([0-9a-f]{64})$/i;
const TIMESTAMP_FORMAT = /^\d{1,12}$/;

/** `sha256=<hex>` for a request made at `timestamp` (unix seconds) with this exact body. */
export function signRequest(secret: string, timestamp: number, rawBody: Uint8Array): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

export type HmacFailure =
  | 'missing_headers'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'future_timestamp'
  | 'bad_signature_format'
  | 'bad_signature';

export type HmacResult = { ok: true } | { ok: false; reason: HmacFailure };

export interface VerifyInput {
  secret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: Uint8Array;
  nowSeconds: number;
  windowSeconds?: number;
}

/**
 * Pure and total: every input gives a result, none throws. The window is checked before the signature,
 * and the signature is compared with `timingSafeEqual` only after its length is known to match (that
 * function throws on unequal lengths, which would turn a malformed header into a 500).
 */
export function verifyRequest(input: VerifyInput): HmacResult {
  const { timestampHeader, signatureHeader } = input;
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: 'missing_headers' };
  if (!TIMESTAMP_FORMAT.test(timestampHeader)) return { ok: false, reason: 'bad_timestamp' };

  const timestamp = Number(timestampHeader);
  const window = input.windowSeconds ?? HMAC_WINDOW_SECONDS;
  if (timestamp < input.nowSeconds - window) return { ok: false, reason: 'stale_timestamp' };
  if (timestamp > input.nowSeconds + window) return { ok: false, reason: 'future_timestamp' };

  const match = SIGNATURE_FORMAT.exec(signatureHeader);
  if (!match) return { ok: false, reason: 'bad_signature_format' };

  const expected = Buffer.from(signRequest(input.secret, timestamp, input.rawBody).slice(7), 'hex');
  const given = Buffer.from(match[1] as string, 'hex');
  return timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
