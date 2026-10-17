import type { Metadata } from 'next';
import { SubmitForm } from '@/components/submit-form';
import { REPO_URL } from '@/components/site-footer';
import { turnstileSiteKey } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Submit a quickstart',
  description: 'Suggest a developer quickstart for QuickstartRot to track.',
  alternates: { canonical: '/submit' },
};

export default function SubmitPage() {
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Submit a quickstart</h1>
      <p className="mt-3 max-w-2xl text-[15px] leading-7">
        Tell us which quickstart to track. A person reads each submission and, if it fits, adds it.
        The URL is stored, never fetched automatically. At most five submissions a day from one
        address.
      </p>
      <p className="mt-2 max-w-2xl text-[15px] leading-7">
        You can also{' '}
        <a
          href={`${REPO_URL}/issues/new?template=submit-quickstart.yml`}
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          submit it as a GitHub issue
        </a>
        .
      </p>
      <div className="mt-8">
        <SubmitForm turnstileSiteKey={turnstileSiteKey()} />
      </div>
    </>
  );
}
