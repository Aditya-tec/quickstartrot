import type { Metadata } from 'next';
import { MethodologyContent } from '@/components/methodology-content';
import { FACTS } from '@/lib/facts';

export const metadata: Metadata = {
  title: 'Methodology',
  description:
    'How QuickstartRot chooses and tests developer quickstarts: levels, the gates before a quickstart is called failing, canaries, human review and limitations.',
  alternates: { canonical: '/methodology' },
};

export default function MethodologyPage() {
  return <MethodologyContent facts={FACTS} />;
}
