import { ImageResponse } from 'next/og';
import { OG_COLORS, type MethodologyCard, type OgCard } from './og';
import type { Headline } from '@qsr/core/public';
import { FACTS } from './facts';
import { homeCopy } from './home-copy';

// The drawing of the Open Graph images (1200x630). Satori renders text as glyphs, never as markup, so a name or an
// error line cannot inject anything. The font is the one bundled with next/og: no request to a font host.

const SIZE = { width: 1200, height: 630 } as const;
const BG = '#0d0e0f';
const FG = '#ecece9';
const MUTED = '#a4a49d';
const CACHE = 'public, s-maxage=600, stale-while-revalidate=86400';

function respond(element: React.ReactElement): ImageResponse {
  return new ImageResponse(element, { ...SIZE, headers: { 'cache-control': CACHE } });
}

export function toolImage(card: OgCard): ImageResponse {
  const color = OG_COLORS[card.status];
  return respond(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: BG,
        color: FG,
        padding: 72,
      }}
    >
      <div style={{ display: 'flex', fontSize: 30, color: MUTED }}>QuickstartRot</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', fontSize: 84, fontWeight: 700, lineHeight: 1.1 }}>
          {card.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 32 }}>
          <div
            style={{
              display: 'flex',
              border: `3px solid ${color}`,
              color,
              borderRadius: 999,
              padding: '6px 28px',
              fontSize: 40,
              fontWeight: 600,
            }}
          >
            {card.statusLabel}
          </div>
          {card.since ? (
            <div style={{ display: 'flex', fontSize: 36, color: MUTED, marginLeft: 28 }}>
              {card.since}
            </div>
          ) : null}
        </div>
        {card.errorLine ? (
          <div
            style={{
              display: 'flex',
              marginTop: 36,
              padding: '16px 24px',
              background: '#1b1e20',
              borderRadius: 12,
              fontSize: 30,
              color: '#ff948e',
              fontFamily: 'monospace',
            }}
          >
            {card.errorLine}
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', fontSize: 28, color: MUTED }}>
        Is the quickstart passing its checks?
      </div>
    </div>,
  );
}

export function methodologyImage(card: MethodologyCard): ImageResponse {
  return respond(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: BG,
        color: FG,
        padding: 72,
      }}
    >
      <div style={{ display: 'flex', fontSize: 30, color: MUTED }}>QuickstartRot · Methodology</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            fontSize: 150,
            fontWeight: 700,
            color: '#66cdc5',
            lineHeight: 1,
          }}
        >
          {card.lead}
        </div>
        <div
          style={{ display: 'flex', fontSize: 44, marginTop: 24, maxWidth: 1020, lineHeight: 1.25 }}
        >
          {card.rest}
        </div>
      </div>
      <div style={{ display: 'flex', fontSize: 26, color: MUTED, maxWidth: 1040, lineHeight: 1.3 }}>
        {card.footer}
      </div>
    </div>,
  );
}

export function homeImage(headline: Headline): ImageResponse {
  const text = homeCopy({
    passing: headline.passing,
    tested: headline.tested,
    testedAtL3: headline.testedAtL3,
    testedAtL2: headline.testedAtL2,
    testedAtL1: headline.testedAtL1,
    cycleHours: FACTS.cycleHours,
  });
  return respond(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: BG,
        color: FG,
        padding: 72,
      }}
    >
      <div style={{ display: 'flex', fontSize: 30, color: MUTED }}>QuickstartRot</div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            fontSize: 150,
            fontWeight: 700,
            color: '#66cdc5',
            lineHeight: 1,
          }}
        >
          {text.lead}
        </div>
        <div
          style={{ display: 'flex', fontSize: 48, marginTop: 24, maxWidth: 980, lineHeight: 1.25 }}
        >
          {text.rest}
        </div>
      </div>
      <div style={{ display: 'flex', fontSize: 28, color: MUTED }}>{text.detail}</div>
    </div>,
  );
}
