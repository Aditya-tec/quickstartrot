import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_LOG_BYTES, decodeLog, splitLines, windowRange } from './log-decode';

// The log viewer fetches a gzip file from the public bucket in the browser and shows it as text. These are the
// pure parts: decoding (raw gzip, or already decoded when a CDN applied Content-Encoding) and windowing.

const toBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('decodeLog', () => {
  it('decodes raw gzip (what the bucket serves)', async () => {
    const text = '$ npm install\nadded 1 package\n';
    expect(await decodeLog(toBuffer(gzipSync(Buffer.from(text))))).toBe(text);
  });

  it('passes through bytes a CDN already decoded (Content-Encoding applied)', async () => {
    const text = '$ node index.js\nok\n';
    expect(await decodeLog(toBuffer(Buffer.from(text)))).toBe(text);
  });

  it('is not fooled by plain text that merely starts with similar bytes', async () => {
    expect(await decodeLog(toBuffer(Buffer.from([0x1f, 0x20, 0x41])))).toContain('A');
  });

  it('reports a corrupt gzip body instead of showing garbage', async () => {
    const bad = Buffer.concat([
      Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
      Buffer.from('not gzip at all'),
    ]);
    await expect(decodeLog(toBuffer(bad))).rejects.toThrow(/log/i);
  });

  it('keeps only the tail of an oversized log, and says so', async () => {
    const big = 'x'.repeat(MAX_LOG_BYTES + 1000);
    const out = await decodeLog(toBuffer(gzipSync(Buffer.from(big))));
    expect(out.length).toBeLessThan(big.length);
    expect(out).toMatch(/^\[earlier output omitted\]/);
  });

  it('does not interpret markup: it returns the characters as they are', async () => {
    const text = '<img src=x onerror=alert(1)>\n';
    expect(await decodeLog(toBuffer(gzipSync(Buffer.from(text))))).toBe(text);
  });
});

describe('splitLines', () => {
  it('splits on LF and CRLF and drops one trailing empty line', () => {
    expect(splitLines('a\r\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });
  it('keeps blank lines in the middle', () => {
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
  });
  it('returns no lines for empty text', () => {
    expect(splitLines('')).toEqual([]);
  });
});

describe('windowRange', () => {
  it('shows the first lines at the top, with overscan', () => {
    expect(
      windowRange({ scrollTop: 0, viewport: 100, lineHeight: 20, total: 1000, overscan: 3 }),
    ).toEqual({
      start: 0,
      end: 8,
    });
  });
  it('moves with the scroll position', () => {
    const r = windowRange({
      scrollTop: 2000,
      viewport: 100,
      lineHeight: 20,
      total: 1000,
      overscan: 2,
    });
    expect(r).toEqual({ start: 98, end: 107 });
  });
  it('never goes past the last line', () => {
    const r = windowRange({
      scrollTop: 99_000,
      viewport: 100,
      lineHeight: 20,
      total: 1000,
      overscan: 5,
    });
    expect(r.end).toBe(1000);
    expect(r.start).toBeLessThan(1000);
  });
  it('handles an empty log and a negative scroll', () => {
    expect(
      windowRange({ scrollTop: -50, viewport: 100, lineHeight: 20, total: 0, overscan: 3 }),
    ).toEqual({
      start: 0,
      end: 0,
    });
  });
});
