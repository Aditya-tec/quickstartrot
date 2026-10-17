import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatDay,
  formatDuration,
  formatPercent,
  relativeTime,
  shortId,
  formatBytes,
} from './format';

// All times are UTC and formatted the same way on the server and in the browser, so there is no hydration
// mismatch and a screenshot is the same everywhere.

describe('formatDay', () => {
  it('is "Oct 12" in UTC', () => {
    expect(formatDay('2026-10-12T23:59:00Z')).toBe('Oct 12');
    expect(formatDay('2026-10-13T00:00:00+00:00')).toBe('Oct 13');
    expect(formatDay('2026-01-05 04:27:16.394+00')).toBe('Jan 5');
  });

  it('is an em dash for nothing', () => {
    expect(formatDay(null)).toBe('—');
    expect(formatDay('not a date')).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('is "Oct 12, 14:03 UTC"', () => {
    expect(formatDateTime('2026-10-12T14:03:59Z')).toBe('Oct 12, 14:03 UTC');
  });
});

describe('formatPercent', () => {
  it.each([
    [1, '100%'],
    [0, '0%'],
    [0.9667, '96.7%'],
    [0.5, '50%'],
    [0.9999, '99.9%'],
    [0.0004, '0%'],
  ])('%s -> %s', (value, text) => {
    expect(formatPercent(value)).toBe(text);
  });

  it('is an em dash when there is no rate yet', () => {
    expect(formatPercent(null)).toBe('—');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0 s'],
    [800, '0.8 s'],
    [4200, '4.2 s'],
    [59_949, '59.9 s'],
    [125_000, '2 min 5 s'],
    [3_600_000, '60 min 0 s'],
  ])('%s ms -> %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  it.each([
    ['2026-10-17T11:59:40Z', 'just now'],
    ['2026-10-17T11:30:00Z', '30 min ago'],
    ['2026-10-17T09:00:00Z', '3 h ago'],
    ['2026-10-15T12:00:00Z', '2 d ago'],
    ['2026-08-01T12:00:00Z', 'Aug 1'],
  ])('%s -> %s', (iso, text) => {
    expect(relativeTime(iso, now)).toBe(text);
  });

  it('is an em dash for nothing, and "just now" for a time slightly in the future (clock skew)', () => {
    expect(relativeTime(null, now)).toBe('—');
    expect(relativeTime('2026-10-17T12:00:30Z', now)).toBe('just now');
  });
});

describe('shortId', () => {
  it('is the first 8 characters', () => {
    expect(shortId('0f9d2c1e-aaaa-bbbb-cccc-0123456789ab')).toBe('0f9d2c1e');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
    [1.5 * 1024 * 1024 * 1024, '1.50 GB'],
  ])('%d -> %s', (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });
});
