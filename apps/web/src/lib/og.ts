import type { DetectionSummary, PublicStatus } from '@qsr/core/public';
import { l2Findings } from './detection';
import { formatDay } from './format';
import type { OgData } from './service';
import { STATUS_STYLE } from './status-style';

// What an Open Graph image shows, as plain data: the image route only draws it. Kept apart from the drawing so
// the safety rule (a failing error line appears only for a confirmed incident) can be tested without rendering.

export interface OgCard {
  title: string;
  status: PublicStatus;
  statusLabel: string;
  /** "Quickstart failing since Oct 12", or null. */
  since: string | null;
  /** Only ever set for a confirmed incident. */
  errorLine: string | null;
}

const MAX_TITLE = 48;
const MAX_ERROR = 110;
const ELLIPSIS = String.fromCodePoint(0x2026);
// Controls, bidi overrides, zero-width characters: they do not belong in an image that quotes a failure.
const INVISIBLE = new RegExp(
  `[${String.fromCodePoint(0)}-${String.fromCodePoint(0x1f)}${String.fromCodePoint(0x7f)}-${String.fromCodePoint(0x9f)}${String.fromCodePoint(0x200b)}-${String.fromCodePoint(0x200f)}${String.fromCodePoint(0x202a)}-${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}${String.fromCodePoint(0xfeff)}]`,
  'g',
);

export function clipText(text: string, max: number): string {
  const clean = text.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}${ELLIPSIS}` : clean;
}

export function ogCard(data: OgData): OgCard {
  const failing = data.status === 'failing';
  return {
    title: clipText(data.name, MAX_TITLE),
    status: data.status,
    statusLabel: STATUS_STYLE[data.status].label,
    since:
      failing && data.failingSince
        ? `Quickstart failing since ${formatDay(data.failingSince)}`
        : null,
    errorLine: failing && data.errorLine ? clipText(data.errorLine, MAX_ERROR) : null,
  };
}

/** What the /methodology image shows: the level 2 code-level result the page quotes, from the same data. */
export interface MethodologyCard {
  lead: string;
  rest: string;
  footer: string;
}

/**
 * No percentage, no figure added across install-level and code-level mutants, and level 3 as a number of quickstarts with no rate:
 * the same three rules as the section of the page. Every figure is read from the data.
 */
export function methodologyCard(data: DetectionSummary): MethodologyCard {
  const f = l2Findings(data);
  const runtime = `${f.runtimeTested} renamed names, renamed methods or misnamed options`;
  return {
    lead: `${f.detected} of ${f.tested}`,
    rest:
      `planted code breakages noticed at Level 2. ` +
      (f.runtimeDetected === 0
        ? `It noticed none of the ${runtime}.`
        : `It noticed ${f.runtimeDetected} of the ${runtime}.`),
    footer: `Level 3 rests on ${data.l3Targets.length} ${data.l3Targets.length === 1 ? 'quickstart' : 'quickstarts'} and has no rate. How we test, and what a green badge does not prove.`,
  };
}

/** Colours for the image (Satori cannot read CSS variables): the same hues as the site, light on dark. */
export const OG_COLORS: Record<PublicStatus, string> = {
  passing: '#6fd69a',
  failing: '#ff948e',
  verifying: '#f3c868',
  unknown: '#b0bac3',
  needs_person: '#9bbaff',
};
