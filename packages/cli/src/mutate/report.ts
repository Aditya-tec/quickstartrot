import { OPERATOR_IDS, OPERATOR_INFO, type OperatorId } from './operators.js';
import type { ControlRecord, MutantRecord } from './run.js';
import {
  compareRuns,
  misclassified,
  summarize,
  type Cell,
  type Comparison,
  type HarnessComparison,
  type Kind,
  type KindLevel,
  type Rate,
  type Summary,
} from './stats.js';

// The raw results file and the public document of `qsr mutate`. Both are written to be quoted: every figure comes from
// the records, and the limits are stated next to the numbers.

export interface DetectionResults {
  schemaVersion: 1;
  generatedAt: string;
  method: {
    seed: string;
    operators: OperatorId[];
    concurrency: number;
    sample: number | null;
    /** The check that was on for these runs; `none` is what production cycles do. */
    harnessChecks:
      'production (syntax, imports)' | 'production plus qsr-check-exports (experimental)';
    /** The version of the checks (P9d). Results from before versioning have none, which means 1. */
    harnessVersion?: number;
    compilerVersion: string;
    targetsRequested: number;
  };
  skipped: { slug: string; reason: string }[];
  controls: ControlRecord[];
  mutants: MutantRecord[];
  summary: Summary;
  /** Present when the export check was compared with the baseline. */
  comparison: Comparison | null;
  /** Mutants whose verdict comes from a later run of the target alone, because the network failed twice in the full run. */
  reruns?: { slug: string; operator: OperatorId; reason: string }[];
  /** Present when an earlier harness version's results were given (`--render --v1`): the same mutants, one by one. */
  harnessComparison: HarnessComparison | null;
}

export function buildResults(args: {
  generatedAt: string;
  method: DetectionResults['method'];
  skipped: DetectionResults['skipped'];
  controls: ControlRecord[];
  mutants: MutantRecord[];
  baseline?: { controls: ControlRecord[]; mutants: MutantRecord[] } | undefined;
}): DetectionResults {
  const merged = args.baseline ? mergeAfter(args.baseline, args) : args;
  return {
    schemaVersion: 1,
    generatedAt: args.generatedAt,
    method: args.method,
    skipped: args.skipped,
    controls: merged.controls,
    mutants: merged.mutants,
    summary: summarize(merged.controls, merged.mutants),
    comparison: args.baseline ? compareRuns(args.baseline, args) : null,
    harnessComparison: null,
  };
}

/** The run with the check on: the baseline's mutants, with the re-run survivors replaced by their new result. */
function mergeAfter(
  before: { controls: ControlRecord[]; mutants: MutantRecord[] },
  after: { controls: ControlRecord[]; mutants: MutantRecord[] },
): { controls: ControlRecord[]; mutants: MutantRecord[] } {
  const rerun = new Map(after.mutants.map((m) => [`${m.slug}:${m.operator}`, m]));
  return {
    controls: after.controls,
    mutants: before.mutants.map((m) => rerun.get(`${m.slug}:${m.operator}`) ?? m),
  };
}

const pct = (r: number | null): string => (r === null ? 'n/a' : `${(r * 100).toFixed(0)}%`);
const frac = (r: Rate): string =>
  r.tested === 0 ? 'no mutants tested' : `${r.detected} of ${r.tested}`;
const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;
const clip = (s: string | null, n = 110): string =>
  (s === null ? '' : s.length > n ? `${s.slice(0, n - 1)}...` : s)
    .replaceAll('|', '/')
    .replaceAll('\n', ' ');

/** The table of a sample or a full run, for the terminal and the document. */
export function renderSampleTable(mutants: readonly MutantRecord[]): string {
  const lines = [
    row([
      'Target',
      'Level',
      'Operator',
      'Result',
      'Reached',
      'Failed step',
      'Class (expected)',
      'Rule',
    ]),
    row(['---', '---', '---', '---', '---', '---', '---', '---']),
  ];
  for (const m of mutants) {
    const result =
      m.status === 'detected'
        ? 'DETECTED'
        : m.status === 'survived'
          ? 'SURVIVED'
          : m.status === 'invalid'
            ? 'invalid'
            : m.status === 'not_applicable'
              ? 'n/a'
              : m.status === 'not_run'
                ? 'not run'
                : 'harness error';
    const expected = m.expected === null ? 'no expectation' : m.expected.join(' or ');
    lines.push(
      row([
        m.slug,
        `L${m.level}`,
        m.operator,
        result,
        m.reachedLevel === null ? '-' : `L${m.reachedLevel}`,
        m.failedStepId
          ? `${m.failedStepId}${m.failedStepKind ? ` (${m.failedStepKind})` : ''}`
          : '-',
        m.status === 'detected'
          ? `${m.failureClass ?? '?'} (${expected})${m.classMatches === false ? ' MISMATCH' : ''}`
          : `- (${expected})`,
        m.ruleId ?? '',
      ]),
    );
  }
  return lines.join('\n');
}

/** "12 of 40 (30%)" for a cell, with the targets behind it: the figure and its denominator travel together. */
const cellText = (c: Cell): string =>
  c.tested === 0
    ? 'none tested'
    : `${c.detected} of ${c.tested} (${pct(c.detection)}), ${c.targets} targets`;

const LEVEL_KEYS = ['L1', 'L2', 'L3'] as const;

function kindTable(
  title: string,
  operators: string,
  cells: KindLevel[Kind],
  levelTargets: Summary['levelTargets'],
): string[] {
  return [
    `### ${title}`,
    '',
    `Operators: ${operators}.`,
    '',
    row([
      'Level',
      'Targets at this level',
      'Tested',
      'Detected',
      'Rate',
      'Targets with a tested mutant',
      'Correct class',
      'No site',
      'Invalid',
      'Harness errors',
      'Not run (vendor calls off)',
    ]),
    row(['---', '---', '---', '---', '---', '---', '---', '---', '---', '---', '---']),
    ...LEVEL_KEYS.map((l) => {
      const c = cells[l];
      return row([
        l,
        levelTargets[l],
        c.tested,
        c.detected,
        pct(c.detection),
        c.targets,
        c.classified === 0 ? 'n/a' : `${c.classCorrect} of ${c.classified}`,
        c.notApplicable,
        c.invalid,
        c.harnessError,
        c.notRun,
      ]);
    }),
    '',
  ];
}

/** The same mutants under harness v1 and v2 (and v2 with the export check): code-level by level, then what changed one by one. */
function harnessSection(results: DetectionResults): string[] {
  const h = results.harnessComparison;
  if (!h && !results.comparison) return [];
  const out: string[] = [];
  out.push('## Harness versions, same mutants, same seed', '');
  const columns: { label: string; code: KindLevel['code']; install: KindLevel['install'] }[] = [];
  if (h) columns.push({ label: 'harness v1', code: h.before.code, install: h.before.install });
  if (h)
    columns.push({
      label: `harness v${results.method.harnessVersion ?? 2}`,
      code: h.after.code,
      install: h.after.install,
    });
  else
    columns.push({
      label: 'production checks',
      code: results.summary.byKind.code,
      install: results.summary.byKind.install,
    });
  if (results.comparison)
    columns.push({
      label: 'with the export check (experiment)',
      code: results.comparison.byKindAfter.code,
      install: results.comparison.byKindAfter.install,
    });
  out.push(
    'Code-level mutants by level (install-level mutants are shown below the table). Each cell: detected of tested, rate, targets with a tested mutant.',
    '',
    row(['Level', ...columns.map((c) => c.label)]),
    row(['---', ...columns.map(() => '---')]),
    ...LEVEL_KEYS.map((l) => row([l, ...columns.map((c) => cellText(c.code[l]))])),
    '',
    row(['Install-level', ...columns.map((c) => c.label)]),
    row(['---', ...columns.map(() => '---')]),
    ...LEVEL_KEYS.map((l) => row([l, ...columns.map((c) => cellText(c.install[l]))])),
    '',
  );
  if (h) {
    out.push(
      `Newly detected under the newer harness: ${h.newlyDetected.length}${h.newlyDetected.length ? ` (${h.newlyDetected.join(', ')})` : ''}.`,
      '',
      `Detected before and surviving now: ${h.newlyMissed.length}${h.newlyMissed.length ? ` (${h.newlyMissed.join(', ')})` : ''}. A mutant that survives a newer harness after being detected by the older one is a regression to be explained, not tuned away.`,
      '',
    );
  }
  return out;
}

export function renderDocument(results: DetectionResults, existing?: string): string {
  const s = results.summary;
  const out: string[] = [];
  const add = (...l: string[]): void => void out.push(...l);
  const ops = OPERATOR_IDS.filter((id) => OPERATOR_INFO[id].group === 'mutation');

  add(
    '# Detection power: what the monitor can and cannot see',
    '',
    `Generated ${results.generatedAt} by \`qsr mutate\`. Raw results: \`docs/detection-power.json\`. Seed \`${results.method.seed}\`, harness version ${results.method.harnessVersion ?? 1}, harness checks: ${results.method.harnessChecks}.`,
    '',
    'There is no single detection rate in this document, on purpose. Mutants that change the **install** command (a typo in a package name, a version that does not exist) are stopped by npm or pip whatever the harness checks do; mutants that change the **code** (a symbol, a method, a deep path, syntax, an option) are what the harness checks are for. Averaging the two would credit the monitor for what the package manager does anyway, so they are reported apart and by level.',
    '',
    '## What this is',
    '',
    'A quickstart monitor that always says "passing" would look perfect, so we also measured whether it notices a quickstart that is broken. We took each target\'s own cached docs extraction and its accepted plan, made one small, deterministic change to the docs code (a typo in a package name, a renamed import, a missing bracket, and so on), ran the changed quickstart in the same Docker sandbox the monitor uses, and recorded whether the monitor failed it and how it classified the failure. The mutated plan and the mutated docs lines are changed identically, so the real grounding validator still accepts them: the monitor is not tricked by an obviously forged plan, it is shown a plausible broken quickstart.',
    '',
    '## What this does NOT show',
    '',
    '- **It does not show how often real quickstarts break.** The mutants are invented by us. A high detection rate says the monitor would notice that kind of break; it says nothing about how many real ones exist.',
    '- It does not show that the monitor is right when it says "passing" for a quickstart we did not mutate. Each mutant is one planned kind of fault, in one place.',
    '- The operators are a list we chose. Faults outside it (a changed default, a behaviour change, an authentication flow that moved) are not measured. A rate here is a rate over this list.',
    '- Per-level rates have small denominators (see the counts); read them as orders of magnitude, not as precise percentages.',
    '- Each mutant ran once, on one machine, on the day shown above. Dependency versions resolved on that day.',
    '',
    '## Method',
    '',
    `- **Inputs:** the cached extraction and accepted plan of each target (the cached copy of the page the plan was compiled from; no new crawl, no model call). ${results.method.targetsRequested} targets were considered; ${s.controls.included} had a control that passed and are in the statistics; ${results.skipped.length + s.controls.excluded.length} skipped or excluded (listed below).`,
    '- **Controls first.** The unmutated plan is run once more (and once more if it fails). A target whose control does not pass twice is left out of every statistic.',
    '- **Mutants.** Operators are deterministic and seeded. Each applies the same textual change to the docs lines and to the plan step that quotes them, then the real grounding validator must accept the pair; if it does not, the mutant is discarded and counted as `invalid`. A plan with no site for an operator is `not applicable`.',
    "- **Levels.** A target is placed at the level its control reached: **L1** the quickstart only installs (the page showed no code to build), **L2** it installs and its code is parsed and its imports resolved, **L3** its snippet ran and reached the vendor's API (an authentication error with a dummy key counts as a pass).",
    '- **Detected** means the run failed. **Survived** means it passed. Correct classification is only judged where an operator has a fixed expectation, against our documented mapping.',
    '',
    '### Operators',
    '',
    row(['Operator', 'What changes', 'Expected class']),
    row(['---', '---', '---']),
    ...OPERATOR_IDS.map((id) =>
      row([
        `\`${id}\`${OPERATOR_INFO[id].group === 'experiment' ? ' (experiment)' : ''}`,
        OPERATOR_INFO[id].description,
        OPERATOR_INFO[id].expected?.join(' or ') ?? 'none: recorded',
      ]),
    ),
    '',
    '## Controls and exclusions',
    '',
    `${s.controls.included} of ${s.controls.total} controls passed. ${results.controls.filter((c) => c.retried).length} ${results.controls.filter((c) => c.retried).length === 1 ? 'control failed once and was' : 'controls failed once and were'} run again; ${results.controls.filter((c) => c.retried && c.included).length} passed the second time.`,
    '',
  );
  const left = [...results.skipped, ...s.controls.excluded];
  add(
    ...(left.length === 0
      ? ['No target was left out.']
      : [
          row(['Target', 'Why it is not in the statistics']),
          row(['---', '---']),
          ...left.map((e) => row([e.slug, clip(e.reason, 200)])),
        ]),
    '',
  );

  if (results.reruns && results.reruns.length > 0)
    add(
      '### Mutants run again after an environment failure',
      '',
      'The network (registry DNS) failed twice for these mutants in the full run, which is a harness error and no verdict. Each was run again alone with the same seed; the verdict below is from that run. Nothing else was re-run or chosen.',
      '',
      ...results.reruns.map((x) => `- ${x.slug} \`${x.operator}\`: ${x.reason}`),
      '',
    );

  add(
    '## Results',
    '',
    `Targets at each level (the level its control reached): L1 ${s.levelTargets.L1}, L2 ${s.levelTargets.L2}, L3 ${s.levelTargets.L3}. A cell below says how many mutants were tested, how many of those targets had at least one, and how many mutants were left out because the plan had no site for the operator (\`no site\`), the real validator refused the pair (\`invalid\`) or the harness itself failed.`,
    '',
    `**Limits that apply to every rate here:** L3 rests on ${s.levelTargets.L3} targets. ${s.noSite.code + s.noSite.install} mutants had no site to change (${s.noSite.code} code-level, ${s.noSite.install} install-level) and are in no rate. A rate over a handful of targets is an order of magnitude, not a percentage.`,
    '',
    ...kindTable(
      'Install-level mutants',
      'pkg_typo, version_pin',
      s.byKind.install,
      s.levelTargets,
    ),
    ...kindTable(
      'Code-level mutants',
      'renamed_symbol, renamed_method, deep_import, syntax_error, option_misnamed',
      s.byKind.code,
      s.levelTargets,
    ),
    ...harnessSection(results),
    '### By operator',
    '',
    row(['Operator', 'Detected', 'Rate', 'Correct class', 'Invalid', 'Not applicable']),
    row(['---', '---', '---', '---', '---', '---']),
    ...ops.map((id) => {
      const r = s.byOperator[id];
      return r
        ? row([
            `\`${id}\``,
            frac(r),
            pct(r.detection),
            r.classified === 0 ? 'n/a' : `${r.classCorrect} of ${r.classified}`,
            r.invalid,
            r.notApplicable,
          ])
        : '';
    }),
    '',
    '### By operator and level (detected of tested)',
    '',
    row(['Operator', 'L1', 'L2', 'L3']),
    row(['---', '---', '---', '---']),
    ...ops.map((id) =>
      row([
        `\`${id}\``,
        ...(['L1', 'L2', 'L3'] as const).map((l) => {
          const r = s.byOperatorLevel[id]?.[l];
          return r && r.tested > 0 ? `${r.detected}/${r.tested}` : '-';
        }),
      ]),
    ),
    '',
  );

  const wrong = misclassified(results.mutants);
  add('### Classification: expected against assigned', '');
  add(
    ...(wrong.length === 0
      ? ['Every detected mutant with a fixed expectation got an expected class.']
      : [
          row(['Target', 'Operator', 'Assigned', 'Expected', 'Rule', 'Evidence']),
          row(['---', '---', '---', '---', '---', '---']),
          ...wrong.map((m) =>
            row([
              m.slug,
              m.operator,
              m.failureClass ?? '?',
              m.expected?.join(' or ') ?? '',
              m.ruleId ?? '',
              clip(m.evidence),
            ]),
          ),
        ]),
    '',
  );

  const survivors = results.mutants.filter(
    (m) => m.group === 'mutation' && m.status === 'survived',
  );
  add(
    '## Survivors: mutants the monitor did not see',
    '',
    `${survivors.length} mutants passed. They fall into these patterns (most common first):`,
    '',
    row(['#', 'Operator', 'Level', 'Count', 'Why the monitor could not see it', 'Targets']),
    row(['---', '---', '---', '---', '---', '---']),
  );
  s.survivorPatterns.forEach((p, i) =>
    add(
      row([
        i + 1,
        `\`${p.operator}\``,
        `L${p.level}`,
        p.count,
        clip(p.reason, 400),
        p.targets.slice(0, 6).join(', ') +
          (p.targets.length > 6 ? `, +${p.targets.length - 6}` : ''),
      ]),
    ),
  );
  add(
    '',
    '### Every survivor',
    '',
    row(['Target', 'Level', 'Operator', 'Change']),
    row(['---', '---', '---', '---']),
    ...survivors.map((m) => row([m.slug, `L${m.level}`, `\`${m.operator}\``, clip(m.change, 140)])),
    '',
  );

  const inv = results.mutants.filter((m) => m.status === 'invalid');
  if (inv.length > 0)
    add(
      '### Invalid mutants',
      '',
      `${inv.length} mutants were discarded because the real validator refused the mutated pair:`,
      '',
      ...inv.slice(0, 20).map((m) => `- ${m.slug} \`${m.operator}\`: ${clip(m.note, 160)}`),
      '',
    );

  if (s.experiment) {
    const ex = results.mutants.filter((m) => m.group === 'experiment');
    add(
      '## Experiment (not an oracle): docs ahead of the package',
      '',
      'The previous major version of the package is installed while the snippet stays as the docs show it today. This is **not** a measure of detection power: there is no fixed expectation, the plan is run through an executor override (not a docs quotation), and whether a snippet written for the current major breaks on the previous one says more about the package than about the monitor. Reported here only to show what happens.',
      '',
      `${frac(s.experiment)} of the runs failed (${pct(s.experiment.detection)}); ${s.experiment.notApplicable} had no earlier major to install.`,
      '',
      row(['Target', 'Level', 'Change', 'Result', 'Class', 'Rule']),
      row(['---', '---', '---', '---', '---', '---']),
      ...ex
        .filter((m) => m.status !== 'not_applicable')
        .map((m) =>
          row([
            m.slug,
            `L${m.level}`,
            clip(m.change, 60),
            m.status,
            m.failureClass ?? '',
            m.ruleId ?? '',
          ]),
        ),
      '',
    );
  }

  if (results.comparison) {
    const c = results.comparison;
    add(
      '## With the export check (`qsr-check-exports`; in production it runs in shadow mode only)',
      '',
      `Same mutants, same seed; here the check FAILS the run, which production does not do. A target that opted out (\`harness.skipExportCheck\`) is not checked. **False positives on controls: ${c.falsePositives.length}.** ${c.falsePositives.map((f) => `${f.slug} (${clip(f.reason, 100)})`).join('; ')}`,
      '',
      row(['Code-level mutants', 'Without the check', 'With the check']),
      row(['---', '---', '---']),
      ...(['L1', 'L2', 'L3'] as const).map((l) =>
        row([l, cellText(c.byKindBefore.code[l]), cellText(c.byKindAfter.code[l])]),
      ),
      '',
      row(['By operator', 'Without the check', 'With the check']),
      row(['---', '---', '---']),
      ...ops.map((id) =>
        row([
          `\`${id}\``,
          `${frac(c.byOperatorBefore[id] as Rate)}`,
          `${frac(c.byOperatorAfter[id] as Rate)}`,
        ]),
      ),
      '',
      `Newly detected: ${c.newlyDetected.length} (${c.newlyDetected.slice(0, 12).join(', ')}${c.newlyDetected.length > 12 ? ', ...' : ''}).`,
      '',
    );
  }

  // Everything from the recommendation on is written by hand after reading the numbers, and survives a regeneration.
  const marker = '## Recommendation';
  const kept =
    existing && existing.includes(marker)
      ? existing.slice(existing.indexOf(marker))
      : `${marker}\n\n_To be written from the numbers above._\n`;
  return `${out.join('\n')}\n${kept}`;
}
