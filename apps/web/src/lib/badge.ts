import type { PublicStatus } from '@qsr/core/public';

// The README badge (spec section 13): a self-contained shields-style SVG, "quickstart | passing". It is served
// to anyone for any slug, so: the slug is validated with a strict pattern, every piece of text is XML-escaped
// (and stripped of characters that are not valid XML), the colour must be a plain hex value, and the image
// contains no link, script, style import or other external reference.

export const BADGE_CACHE_CONTROL = 'public, s-maxage=600, stale-while-revalidate=86400';

/** Same shape as a target slug (kebab-case, at most 64 characters). */
export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

// Characters that may not appear in XML 1.0 text, plus invisible and bidi controls that make text lie.
// Ranges as code points (not escapes): the source must contain no invisible character.
const INVALID_XML_RANGES: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfffe, 0xffff],
];
const NOT_XML = new RegExp(
  `[${INVALID_XML_RANGES.map(([a, b]) => `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`).join('')}]`,
  'g',
);

export function xmlEscape(text: string): string {
  return text
    .replace(NOT_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export type BadgeStatus = PublicStatus | 'not_tracked';

export interface BadgeSpec {
  label: string;
  value: string;
  color: string;
}

const BADGE: Record<BadgeStatus, { value: string; color: string }> = {
  // dark enough for white text at 4.5:1 or better
  passing: { value: 'passing', color: '#1a7f37' },
  failing: { value: 'failing', color: '#cf222e' },
  verifying: { value: 'verifying', color: '#9a6700' },
  unknown: { value: 'unknown', color: '#6e7781' },
  needs_person: { value: 'needs a person', color: '#0969da' },
  not_tracked: { value: 'not tracked', color: '#57606a' },
};

export function badgeFor(status: BadgeStatus): BadgeSpec {
  const b = BADGE[status];
  return { label: 'quickstart', value: b.value, color: b.color };
}

const MAX_TEXT = 40;
const ELLIPSIS = String.fromCodePoint(0x2026);
const clip = (text: string): string => {
  const clean = text.replace(NOT_XML, '');
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}${ELLIPSIS}` : clean;
};

/** A rough Verdana 11px width: narrow, wide and ordinary characters. Good enough for a badge. */
function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if ("iljt.,:;!|' ".includes(ch)) w += 3.8;
    else if ('mwMW'.includes(ch)) w += 9.6;
    else if (ch >= 'A' && ch <= 'Z') w += 7.4;
    else w += 6.5;
  }
  return Math.ceil(w);
}

export function renderBadge(spec: BadgeSpec): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(spec.color))
    throw new Error('the badge colour must be a #rrggbb value');
  const label = clip(spec.label);
  const value = clip(spec.value);
  const lw = textWidth(label) + 14;
  const vw = textWidth(value) + 14;
  const w = lw + vw;
  const aria = xmlEscape(`${label}: ${value}`);
  const l = xmlEscape(label);
  const v = xmlEscape(value);
  const r = 3;
  const labelPath = `M${r} 0h${lw - r}v20H${r}a${r} ${r} 0 0 1-${r}-${r}V${r}a${r} ${r} 0 0 1 ${r}-${r}z`;
  const valuePath = `M${lw} 0h${vw - r}a${r} ${r} 0 0 1 ${r} ${r}v${20 - 2 * r}a${r} ${r} 0 0 1-${r} ${r}H${lw}z`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${aria}">`,
    `<title>${aria}</title>`,
    `<path d="${labelPath}" fill="#444d56"/>`,
    `<path d="${valuePath}" fill="${spec.color}"/>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">`,
    `<text x="${lw / 2}" y="14">${l}</text>`,
    `<text x="${lw + vw / 2}" y="14">${v}</text>`,
    `</g>`,
    `</svg>`,
  ].join('');
}
