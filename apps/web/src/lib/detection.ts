import { DetectionSummary } from '@qsr/core/public';
import raw from '@/data/detection-power.json';

// The figures /methodology quotes about how well the monitor sees a broken quickstart. The file is written by
// `qsr detection-summary` from docs/detection-power.json and the target files, and a test in packages/cli fails when it is
// out of date. Parsed here, so a malformed file fails the build and not a page. The wording built from it (the badge paragraph, the
// per-level lines) lives in @qsr/core, so the README and the page quote the same sentences.
export const DETECTION: DetectionSummary = DetectionSummary.parse(raw);

export { l2Findings, type L2Findings } from '@qsr/core/public';
