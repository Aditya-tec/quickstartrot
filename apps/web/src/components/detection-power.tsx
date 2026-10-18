import { REPO_URL } from '@/components/site-footer';
import {
  badgeParagraph,
  DETECTION_LEVELS,
  l3ProductionSentence,
  levelStatements,
  type DetectionCell,
  type DetectionLevel,
  type DetectionSummary,
} from '@qsr/core/public';

// "How well the monitor sees a broken quickstart", for /methodology. Every figure is read from `data` (the file `qsr detection-summary`
// writes from docs/detection-power.json); nothing here is typed by hand, and detection-power.test.tsx renders it with changed data and
// fails if a number stays the same. Three rules the wording keeps: install-level and code-level mutants are never added together (npm
// and pip catch the first whatever our checks do), level 3 is a number of targets and never a rate, and a shadow target is labelled
// verifying and not counted.

const LABEL: Record<DetectionLevel, string> = {
  L1: 'L1',
  L2: 'L2',
  L3: 'L3',
  local: 'Executed locally (no vendor)',
};

const noun = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** 2026-10-18T04:35:46.556Z as "18 October 2026", in UTC so a server and a browser say the same. */
const longDate = (iso: string): string =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

const sum = (cells: readonly DetectionCell[], key: keyof DetectionCell): number =>
  cells.reduce((n, c) => n + c[key], 0);
const cellsOf = (by: Record<DetectionLevel, DetectionCell>): DetectionCell[] =>
  DETECTION_LEVELS.map((l) => by[l]);

function Rate({ level, cell }: { level: DetectionLevel; cell: DetectionCell }) {
  if (level === 'L3') return <>not quoted</>;
  if (cell.tested === 0) return <>n/a</>;
  return <>{Math.round((cell.detected / cell.tested) * 100)}%</>;
}

function leftOut(c: DetectionCell): string {
  const parts = [
    c.noSite > 0 ? `${c.noSite} with no site to change` : null,
    c.invalid > 0 ? `${c.invalid} refused by the grounding check` : null,
    c.harnessError > 0
      ? `${c.harnessError} harness ${noun(c.harnessError, 'error', 'errors')}`
      : null,
    c.notRun > 0 ? `${c.notRun} not run (no vendor requests)` : null,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? 'none' : parts.join(', ');
}

function KindTable({
  caption,
  note,
  by,
  levelTargets,
}: {
  caption: string;
  note: string;
  by: Record<DetectionLevel, DetectionCell>;
  levelTargets: DetectionSummary['levelTargets'];
}) {
  return (
    <div className="mt-6 max-w-4xl">
      <h3 className="text-lg font-semibold">{caption}</h3>
      <p className="mt-1 text-[15px] leading-7 text-muted">{note}</p>
      <div
        tabIndex={0}
        role="region"
        aria-label={`${caption}, scrollable`}
        className="mt-3 overflow-x-auto rounded-lg border border-border"
      >
        <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
          <thead className="bg-surface text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Level
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Targets at this level
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Planted and run
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Noticed
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Rate
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Left out of the count
              </th>
            </tr>
          </thead>
          <tbody>
            {DETECTION_LEVELS.map((level) => {
              const cell = by[level];
              return (
                <tr key={level} className="border-t border-border align-top">
                  <th scope="row" className="px-3 py-2 font-medium">
                    {LABEL[level]}
                  </th>
                  <td className="tabular px-3 py-2">{levelTargets[level]}</td>
                  <td className="tabular px-3 py-2">{cell.tested}</td>
                  <td className="tabular px-3 py-2">
                    {cell.tested === 0 ? 'none tested' : `${cell.detected} of ${cell.tested}`}
                  </td>
                  <td className="tabular px-3 py-2">
                    <Rate level={level} cell={cell} />
                  </td>
                  <td className="px-3 py-2 text-muted">{leftOut(cell)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DetectionPower({ data }: { data: DetectionSummary }) {
  const d = data;
  const noSite = sum(cellsOf(d.install), 'noSite') + sum(cellsOf(d.code), 'noSite');
  const statements = levelStatements(d);
  const nShadow = d.shadowTargets.length;

  return (
    <>
      <h2 id="detection" className="mt-12 scroll-mt-20 text-2xl font-semibold tracking-tight">
        How well the monitor sees a broken quickstart
      </h2>
      <p className="mt-3 max-w-3xl text-[15px] leading-7">
        A monitor that always said &ldquo;passing&rdquo; would look perfect, so we measured whether
        this one notices a quickstart that is broken. We planted small, deterministic breakages in
        the docs code of the quickstarts we track, ran each broken quickstart in the same sandbox,
        and recorded whether the monitor failed it.
      </p>
      <p className="mt-3 max-w-3xl rounded-lg border border-border bg-surface p-4 text-[15px] leading-7">
        {badgeParagraph(d)}
      </p>
      <p className="mt-3 max-w-3xl text-[15px] leading-7">{l3ProductionSentence(d)}</p>
      <p className="mt-3 max-w-3xl text-[15px] leading-7">
        Install-level and code-level results are reported apart and never added together: a typo in
        a package name is stopped by npm or pip whatever our checks do, and counting it would credit
        the monitor for the package manager. Each cell says how many planted breakages were run and
        how many were noticed; a rate is shown only where a level has enough targets behind it to
        quote one.
      </p>

      <KindTable
        caption="Install-level mutants"
        note="A package name with two letters added, or a version that does not exist."
        by={d.install}
        levelTargets={d.levelTargets}
      />
      <KindTable
        caption="Code-level mutants"
        note="A renamed import, a renamed method, a path that does not exist, a missing bracket, a misnamed option."
        by={d.code}
        levelTargets={d.levelTargets}
      />

      <h3 className="mt-8 text-lg font-semibold">What a pass at each level tells you</h3>
      <dl className="mt-3 grid max-w-3xl gap-3 text-[15px] leading-7">
        {DETECTION_LEVELS.map((level) => (
          <div key={level} className="rounded-lg border border-border bg-surface p-4">
            <dt className="font-medium">{LABEL[level]}</dt>
            <dd>{statements[level]}</dd>
          </div>
        ))}
      </dl>

      {nShadow > 0 && (
        <div className="mt-6 max-w-3xl">
          <h3 className="text-lg font-semibold">Level 3 on trial</h3>
          <p className="mt-2 text-[15px] leading-7">
            {nShadow} more {noun(nShadow, 'quickstart runs its', 'quickstarts run their')} Level 3
            step as a trial. Their result is recorded and not counted: each is labelled{' '}
            <strong>verifying</strong> here and shows Level 2 on its own page, until the evidence
            has been stable over many cycles and we decide to count it.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {d.shadowTargets.map((slug) => (
              <li
                key={slug}
                className="rounded border border-border-strong px-2 py-1 font-mono text-xs"
              >
                {slug} <span className="text-muted">verifying</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3 className="mt-8 text-lg font-semibold">What this does not show</h3>
      <ul className="mt-3 max-w-3xl list-disc space-y-2 pl-5 text-[15px] leading-7">
        <li>
          None of this measures how often real quickstarts break. It measures what the monitor can
          see.
        </li>
        <li>
          The breakages are invented by us, from a fixed list of kinds. A kind not on the list (a
          changed default, a behaviour change, an authentication flow that moved) is not measured.
        </li>
        <li>
          Measured on {longDate(d.generatedAt)} under harness version {d.harnessVersion}, one run on
          one machine. {d.targetsMeasured} of {d.targetsConsidered} targets had a control that
          passed twice and are in the figures.
        </li>
        <li>
          {noSite} mutants had no site to change (the plan had nothing for that kind of breakage to
          alter) and are in no rate. A rate over a handful of targets is an order of magnitude, not
          a precise percentage.
        </li>
      </ul>
      <p className="mt-3 max-w-3xl text-[15px] leading-7">
        The full document, with every survivor and the method:{' '}
        <a
          href={`${REPO_URL}/blob/main/docs/DETECTION-POWER.md`}
          className="underline underline-offset-2"
          rel="noopener noreferrer"
        >
          docs/DETECTION-POWER.md
        </a>
        ; the data:{' '}
        <a
          href={`${REPO_URL}/blob/main/docs/detection-power.json`}
          className="underline underline-offset-2"
          rel="noopener noreferrer"
        >
          docs/detection-power.json
        </a>
        .
      </p>
    </>
  );
}
