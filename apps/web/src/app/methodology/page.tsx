import type { Metadata } from 'next';
import { DetectionPower } from '@/components/detection-power';
import { MethodologyContent } from '@/components/methodology-content';
import { DETECTION } from '@/lib/detection';
import { FACTS } from '@/lib/facts';

const TITLE = 'Methodology';
const DESCRIPTION =
  'How QuickstartRot chooses and tests developer quickstarts: levels, how well the monitor sees a broken quickstart, the gates before a quickstart is called failing, canaries, human review and limitations.';
const IMAGE = '/api/og/methodology';

// A page-level openGraph replaces the layout's, so this page names its own card (drawn by /api/og/methodology from the same data).
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/methodology' },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: '/methodology',
    images: [
      {
        url: IMAGE,
        width: 1200,
        height: 630,
        alt: 'What the QuickstartRot monitor can and cannot see',
      },
    ],
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [IMAGE] },
};

export default function MethodologyPage() {
  return <MethodologyContent facts={FACTS} detection={<DetectionPower data={DETECTION} />} />;
}
