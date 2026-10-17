import Link from 'next/link';
import type { Headline as HeadlineData } from '@qsr/core/public';
import { formatDateTime } from '@/lib/format';
import { headlineText, tierBreakdown } from '@/lib/headline';
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
}: {
  headline: HeadlineData;
  tested: readonly ToolSummary[];
  asOf: string | null;
}) {
  const text = headlineText(headline.passing, headline.tested);
  const tiers = tierBreakdown(tested);
  return (
    <section aria-labelledby="headline" className="mb-10">
      <h1
        id="headline"
        className="max-w-3xl text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-5xl"
      >
        <span className="tabular text-accent">{text.lead}</span> {text.rest}
      </h1>
      <p className="mt-3 text-sm text-muted">
        {asOf ? (
          <>
            As of <time dateTime={asOf}>{formatDateTime(asOf)}</time>
            {'. '}
          </>
        ) : null}
        Every quickstart is run on a fresh machine every six hours.
        {headline.failing > 0 || headline.verifying > 0 ? (
          <>
            {' '}
            <span className="tabular">{headline.failing}</span> confirmed failing,{' '}
            <span className="tabular">{headline.verifying}</span> being verified.
          </>
        ) : null}
      </p>

      {tiers.length > 0 ? (
        <div className="mt-6 grid max-w-3xl gap-3 rounded-lg border border-border bg-surface p-4 sm:p-5">
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
            </Link>
            .
          </p>
        </div>
      ) : null}
    </section>
  );
}
