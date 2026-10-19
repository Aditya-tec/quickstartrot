import Link from 'next/link';
import type { Headline as HeadlineData } from '@qsr/core/public';
import { formatDateTime } from '@/lib/format';
import { FACTS, type Facts } from '@/lib/facts';
import { homeCopy } from '@/lib/home-copy';
import { tierBreakdown } from '@/lib/headline';
import type { ToolSummary } from '@/lib/model';
import { cn } from '@/lib/utils';

// The home page headline. A single "X of Y" would overstate what was proven: an L2 pass shows the quickstart
// installs and builds, not that it reached the vendor. So the breakdown by level is part of the headline.

function Meter({
  passing,
  verifying,
  failing,
  total,
}: {
  passing: number;
  verifying: number;
  failing: number;
  total: number;
}) {
  const pct = (n: number): string => `${(n / total) * 100}%`;
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
      <div className="bg-pass" style={{ width: pct(passing) }} />
      <div className="bg-verify" style={{ width: pct(verifying) }} />
      <div className="bg-fail" style={{ width: pct(failing) }} />
    </div>
  );
}

export function Headline({
  headline,
  tested,
  asOf,
  facts = FACTS,
}: {
  headline: HeadlineData;
  tested: readonly ToolSummary[];
  asOf: string | null;
  facts?: Facts;
}) {
  const copy = homeCopy({
    passing: headline.passing,
    tested: headline.tested,
    testedAtL3: headline.testedAtL3,
    testedAtL2: headline.testedAtL2,
    testedAtL1: headline.testedAtL1,
    cycleHours: facts.cycleHours,
  });
  const tiers = tierBreakdown(tested);
  return (
    <section aria-labelledby="headline" className="-mt-8 mb-10">
      <div
        className="relative isolate ml-[calc(50%-50vw)] flex min-h-[34rem] w-screen items-center justify-center overflow-hidden px-8 py-20 text-center text-[#0f172a] md:min-h-[calc(100svh-6rem)]"
        style={{
          backgroundColor: 'var(--hero-fallback)',
          backgroundImage: 'url(/hero-poster.jpg)',
          backgroundPosition: 'center',
          backgroundSize: 'cover',
        }}
      >
        {/* Decorative loop, self-hosted (the CSP allows no other media host). Still frame for reduced motion. */}
        <video
          aria-hidden="true"
          className="hero-video absolute inset-0 -z-20 size-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster="/hero-poster.jpg"
        >
          <source src="/hero.mp4" type="video/mp4" />
        </video>
        {/* A pale veil behind the text keeps the navy readable over the busier parts of the picture. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.72),rgba(255,255,255,0.18)_75%)]"
        />
        <div className="mx-auto flex max-w-[1280px] flex-col items-center">
          <h1
            id="headline"
            className="fade-rise font-display text-balance text-5xl font-normal leading-[0.95] tracking-[-2.46px] sm:text-[80px]"
          >
            <em className="tabular font-normal not-italic">{copy.lead}</em>{' '}
            <span className="text-muted">{copy.rest}</span>
          </h1>
          <p className="fade-rise fade-rise-1 mx-auto mt-6 max-w-[670px] text-pretty text-lg leading-relaxed text-muted">
            {asOf ? (
              <>
                As of <time dateTime={asOf}>{formatDateTime(asOf)}</time>
                {'. '}
              </>
            ) : null}
            {copy.detail}
            {headline.failing > 0 || headline.verifying > 0 ? (
              <>
                {' '}
                <span className="tabular">{headline.failing}</span> confirmed failing,{' '}
                <span className="tabular">{headline.verifying}</span> being verified.
              </>
            ) : null}
          </p>
          <a href="#leaderboard" className="btn-pill btn-pill-lg fade-rise fade-rise-2 mt-12">
            See the leaderboard
          </a>
        </div>
      </div>

      {tiers.length > 0 ? (
        <div className="mx-auto mt-6 grid max-w-3xl gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-5">
          <h2 className="text-sm font-semibold">How far each quickstart was tested</h2>
          <ul className="grid gap-4">
            {tiers.map((t) => (
              <li key={t.tier} className="grid gap-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <p className="text-sm">
                    <span
                      className={cn(
                        'mr-2 font-mono text-xs font-medium',
                        t.tier === 'L3' ? 'text-accent' : 'text-muted',
                      )}
                    >
                      {t.tier}
                    </span>
                    <span className="tabular font-medium">
                      {t.passing} of {t.total}
                    </span>{' '}
                    passing
                    {t.verifying > 0 ? (
                      <span className="text-muted">, {t.verifying} being verified</span>
                    ) : null}
                  </p>
                </div>
                <Meter
                  passing={t.passing}
                  verifying={t.verifying}
                  failing={t.failing}
                  total={t.total}
                />
                <p className="text-xs text-muted">{t.proves}</p>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            A pass at L2 or L1 proves less than a pass at L3. See{' '}
            <Link
              href="/methodology#levels"
              className="underline underline-offset-2 hover:text-foreground"
            >
              what each level proves
            </Link>{' '}
            and{' '}
            <Link
              href="/methodology#detection"
              className="underline underline-offset-2 hover:text-foreground"
            >
              how well each level sees a broken quickstart
            </Link>
            .
          </p>
        </div>
      ) : null}
    </section>
  );
}
