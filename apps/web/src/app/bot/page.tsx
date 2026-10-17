import type { Metadata } from 'next';
import { BotContent } from '@/components/bot-content';
import { contactEmail, siteUrl } from '@/lib/env';
import { FACTS } from '@/lib/facts';

export const metadata: Metadata = {
  title: 'QuickstartRotBot',
  description:
    'About the QuickstartRot crawler: its user agent, how often it visits, and how to opt out.',
  alternates: { canonical: '/bot' },
};

export default function BotPage() {
  return (
    <BotContent
      facts={FACTS}
      userAgent={`QuickstartRotBot/1.0 (+${siteUrl()}/bot)`}
      email={contactEmail()}
    />
  );
}
