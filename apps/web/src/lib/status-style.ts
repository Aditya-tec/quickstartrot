import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Hourglass,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import type { PublicStatus } from '@qsr/core/public';

// The look and the words of each public status. Status is always an icon AND a word AND a colour, never colour
// alone. Copy is neutral: vendors read this site.

export interface StatusStyle {
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the pill: text, background and border colour. */
  className: string;
  /** One sentence for a tooltip or a legend. */
  explanation: string;
}

export const STATUS_STYLE: Record<PublicStatus, StatusStyle> = {
  passing: {
    label: 'Passing',
    icon: CircleCheck,
    className: 'text-pass bg-pass-bg border-pass/30',
    explanation: 'The quickstart ran to its target level on a fresh machine in the latest cycle.',
  },
  failing: {
    label: 'Failing',
    icon: CircleX,
    className: 'text-fail bg-fail-bg border-fail/30',
    explanation: 'A person confirmed that the quickstart fails. The incident explains why.',
  },
  verifying: {
    label: 'Verifying',
    icon: Hourglass,
    className: 'text-verify bg-verify-bg border-verify/30',
    explanation:
      'A failure was seen and is being checked. Details are published only after a person reviews them.',
  },
  unknown: {
    label: 'Not yet tested',
    icon: CircleDashed,
    className: 'text-unknown bg-unknown-bg border-unknown/30',
    explanation: 'This quickstart has not completed a test run yet.',
  },
  needs_person: {
    label: 'Needs a person',
    icon: UserRound,
    className: 'text-person bg-person-bg border-person/30',
    explanation:
      'The quickstart stops at a step that needs a person, such as an interactive prompt or a sign-up.',
  },
};

export const LEVEL_DESCRIPTION: Record<string, string> = {
  L1: 'Level 1: the install commands run',
  L2: 'Level 2: installs, and the code builds and its imports resolve; it is not run against the vendor',
  L3: "Level 3: the snippet runs and reaches the vendor's API (an auth error with a dummy key counts as a pass)",
  L4: 'Level 4: a full run with real credentials',
};

export const levelLabel = (level: number): string => `L${Math.min(4, Math.max(1, level))}`;
