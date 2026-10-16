import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HMAC_WINDOW_SECONDS, signRequest, verifyRequest } from './hmac.js';

// Spec section 11: X-QSR-Timestamp (unix seconds) and X-QSR-Signature: sha256=<hex> where the signature is
// HMAC_SHA256(INGEST_HMAC_SECRET, timestamp + "." + rawBody). Rejected if the timestamp is more than 300 s
// off, or the signature fails timingSafeEqual (which THROWS on unequal lengths: that must be a 401).

const SECRET = 'test-secret-value-0123456789';
const NOW = 1_792_000_000;
const body = Buffer.from('{"hello":"world"}');

const good = (over: { ts?: number; secret?: string; raw?: Buffer } = {}) =>
  signRequest(over.secret ?? SECRET, over.ts ?? NOW, over.raw ?? body);
const verify = (o: {
  ts?: string | undefined;
  sig?: string | undefined;
  raw?: Buffer;
  now?: number;
  secret?: string;
}) =>
  verifyRequest({
    secret: o.secret ?? SECRET,
    timestampHeader: 'ts' in o ? o.ts : String(NOW),
    signatureHeader: 'sig' in o ? o.sig : good(),
    rawBody: o.raw ?? body,
    nowSeconds: o.now ?? NOW,
  });

describe('signRequest', () => {
  it('is sha256=<hex> of HMAC_SHA256(secret, timestamp + "." + rawBody)', () => {
    const expected = createHmac('sha256', SECRET).update(`${NOW}.`).update(body).digest('hex');
    expect(signRequest(SECRET, NOW, body)).toBe(`sha256=${expected}`);
  });

  it('signs an empty body (a POST with no payload)', () => {
    expect(signRequest(SECRET, NOW, Buffer.alloc(0))).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('depends on the secret, the timestamp and every byte of the body', () => {
    const base = signRequest(SECRET, NOW, body);
    expect(signRequest('other', NOW, body)).not.toBe(base);
    expect(signRequest(SECRET, NOW + 1, body)).not.toBe(base);
    expect(signRequest(SECRET, NOW, Buffer.from('{"hello":"worle"}'))).not.toBe(base);
  });
});

describe('verifyRequest', () => {
  it('accepts a correct signature made now', () => {
    expect(verify({})).toEqual({ ok: true });
  });

  it('accepts a timestamp exactly at the edge of the window, either side', () => {
    expect(HMAC_WINDOW_SECONDS).toBe(300);
    expect(verify({ ts: String(NOW - 300), sig: good({ ts: NOW - 300 }) })).toEqual({ ok: true });
    expect(verify({ ts: String(NOW + 300), sig: good({ ts: NOW + 300 }) })).toEqual({ ok: true });
  });

  it('rejects missing headers: each one, and both', () => {
    expect(verify({ ts: undefined })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verify({ sig: undefined })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verify({ ts: undefined, sig: undefined })).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
    expect(verify({ ts: '', sig: good() })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verify({ sig: '' })).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('rejects a stale timestamp, even with a valid signature for it', () => {
    const old = NOW - 301;
    expect(verify({ ts: String(old), sig: good({ ts: old }) })).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
    expect(verify({ ts: '1', sig: good({ ts: 1 }) })).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('rejects a timestamp in the future, even with a valid signature for it', () => {
    const future = NOW + 301;
    expect(verify({ ts: String(future), sig: good({ ts: future }) })).toEqual({
      ok: false,
      reason: 'future_timestamp',
    });
  });

  it.each([
    'abc',
    '12.5',
    '-5',
    '1e9',
    ' 1792000000',
    '1792000000 ',
    '0x10',
    '99999999999999999999',
  ])('rejects a timestamp that is not plain unix seconds: %j', (ts) => {
    expect(verify({ ts })).toEqual({ ok: false, reason: 'bad_timestamp' });
  });

  it('rejects a tampered body', () => {
    expect(verify({ raw: Buffer.from('{"hello":"WORLD"}') })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verify({ raw: Buffer.concat([body, Buffer.from(' ')]) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects the wrong secret', () => {
    expect(verify({ secret: 'not-the-secret' })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a signature for another timestamp (replay under a fresh timestamp)', () => {
    expect(verify({ sig: good({ ts: NOW - 10 }) })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['one hex digit short', () => good().slice(0, -1)],
    ['one hex digit long', () => `${good()}0`],
    ['empty hex', () => 'sha256='],
    ['a very long signature', () => `sha256=${'a'.repeat(5000)}`],
    ['no prefix', () => good().slice('sha256='.length)],
    ['the wrong algorithm prefix', () => good().replace('sha256=', 'sha1=')],
    ['non-hex characters of the right length', () => `sha256=${'z'.repeat(64)}`],
    ['uppercase hex of the right length that does not match', () => `sha256=${'A'.repeat(64)}`],
  ])(
    'a wrong-length or malformed signature is a clean rejection, never a throw: %s',
    (_name, make) => {
      const result = verify({ sig: make() });
      expect(result.ok).toBe(false);
    },
  );

  it('wrong-length signatures are reported as bad_signature_format (timingSafeEqual would have thrown)', () => {
    expect(verify({ sig: good().slice(0, -2) })).toEqual({
      ok: false,
      reason: 'bad_signature_format',
    });
    expect(verify({ sig: 'sha256=' })).toEqual({ ok: false, reason: 'bad_signature_format' });
  });

  it('accepts uppercase hex when it is the right signature', () => {
    const upper = `sha256=${good().slice('sha256='.length).toUpperCase()}`;
    expect(verify({ sig: upper })).toEqual({ ok: true });
  });

  it('checks the window before the signature: a stale request is stale whatever its signature', () => {
    expect(verify({ ts: String(NOW - 1000), sig: 'sha256=bogus' })).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('works for an empty body', () => {
    const raw = Buffer.alloc(0);
    expect(verify({ raw, sig: good({ raw }) })).toEqual({ ok: true });
  });
});
