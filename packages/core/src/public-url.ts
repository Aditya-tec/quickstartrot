// Spec section 14, "Abuse of /submissions": URL validation (https only, no IPs or private hosts). A
// submission is never fetched automatically; a human turns it into a target PR. This check is defence in
// depth for everything that later reads the URL, so it is strict rather than clever.

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const MAX_LENGTH = 2048;
// ASCII controls, space and DEL. Whitespace inside a URL is never legitimate, and the URL parser silently
// strips tabs and newlines, which would let a hostile string pass as something it is not.
const FORBIDDEN_CHARS = /[\u0000- \u007f]/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home.arpa',
  '.corp',
  '.intranet',
];

/**
 * The WHATWG URL parser already turns every spelling of an IPv4 address (decimal `2130706433`, hex
 * `0x7f000001`, octal `0177.0.0.1`, shorthand `127.1`) into dotted decimal, so rejecting that shape
 * rejects all of them. IPv6 hosts keep their brackets.
 */
export function validateSubmissionUrl(input: string): UrlCheck {
  const raw = input.trim();
  if (raw === '') return { ok: false, reason: 'the URL is empty' };
  if (raw.length > MAX_LENGTH)
    return { ok: false, reason: `the URL is longer than ${MAX_LENGTH} characters` };
  if (FORBIDDEN_CHARS.test(raw))
    return { ok: false, reason: 'the URL contains spaces or control characters' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'the URL is not a valid absolute URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'only https URLs are accepted' };
  if (url.username !== '' || url.password !== '')
    return { ok: false, reason: 'URLs with credentials are not accepted' };
  if (url.port !== '') return { ok: false, reason: 'only the default https port is accepted' };

  const host = url.hostname.toLowerCase();
  if (host === '') return { ok: false, reason: 'the URL has no host name' };
  if (host.startsWith('[') || IPV4.test(host))
    return { ok: false, reason: 'IP addresses are not accepted: use the public host name' };
  if (host === 'localhost' || LOCAL_SUFFIXES.some((s) => host.endsWith(s)))
    return { ok: false, reason: 'local, private and internal host names are not accepted' };
  if (!host.includes('.'))
    return { ok: false, reason: 'the host name must be a public domain name (it has no dot)' };

  url.hash = '';
  return { ok: true, url: url.href };
}
