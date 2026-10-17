import type { Metadata } from 'next';
import Link from 'next/link';
import { REPO_URL } from '@/components/site-footer';
import { contactEmail, siteUrl } from '@/lib/env';

export const metadata: Metadata = {
  title: 'QuickstartRotBot',
  description:
    'About the QuickstartRot crawler: its user agent, how often it visits, and how to opt out.',
  alternates: { canonical: '/bot' },
};

export default function BotPage() {
  const site = siteUrl();
  const email = contactEmail();
  const userAgent = `QuickstartRotBot/1.0 (+${site}/bot)`;
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">QuickstartRotBot</h1>
      <p className="mt-3 max-w-3xl text-[15px] leading-7">
        QuickstartRot checks whether developer quickstart guides still work. To do that, a crawler
        opens the documentation page of each quickstart we track and reads its code blocks. This
        page says how it behaves.
      </p>

      <h2 className="mt-10 text-xl font-semibold tracking-tight">User agent</h2>
      <p className="mt-2 text-[15px]">Requests from the crawler identify themselves like this:</p>
      <pre
        className="mt-2 max-w-full overflow-x-auto rounded border border-border bg-surface-2 px-3 py-2 font-mono text-xs"
        tabIndex={0}
      >
        {userAgent}
      </pre>

      <h2 className="mt-10 text-xl font-semibold tracking-tight">How often</h2>
      <ul className="mt-2 max-w-3xl list-disc space-y-2 pl-5 text-[15px] leading-7">
        <li>
          Each docs page is fetched <strong>at most once per cycle</strong>. A cycle runs every six
          hours, so a page is visited about four times a day.
        </li>
        <li>
          If a request fails on a network error, it is retried once after 10 seconds. Never more.
        </li>
        <li>
          The crawler opens only the docs page we track, like a browser would; it does not follow
          links or crawl a site.
        </li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold tracking-tight">robots.txt</h2>
      <p className="mt-2 max-w-3xl text-[15px] leading-7">
        The crawler reads <code className="font-mono text-sm">robots.txt</code> before every visit
        and obeys it for the user agent <code className="font-mono text-sm">QuickstartRotBot</code>.
        If a page is disallowed, it is not fetched, and the quickstart is disabled until a person
        reviews it.
      </p>
      <p className="mt-2 max-w-3xl text-[15px] leading-7">
        The crawler also never signs up for anything, never solves a CAPTCHA and never uses a real
        API key.
      </p>

      <h2 id="opt-out" className="mt-10 scroll-mt-20 text-xl font-semibold tracking-tight">
        Opt out
      </h2>
      <p className="mt-2 max-w-3xl text-[15px] leading-7">
        If you maintain a quickstart we track and you want it removed, open an issue with the
        opt-out form. We disable the tool and hide its history within 24 hours. You can also block{' '}
        <code className="font-mono text-sm">QuickstartRotBot</code> in your{' '}
        <code className="font-mono text-sm">robots.txt</code>.
      </p>
      <p className="mt-3">
        <a
          href={`${REPO_URL}/issues/new?template=opt-out.yml`}
          rel="noopener noreferrer"
          className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground hover:opacity-90"
        >
          Open the opt-out form on GitHub
        </a>
      </p>
      {email ? (
        <p className="mt-3 text-[15px]">
          Or write to{' '}
          <a href={`mailto:${email}`} className="underline underline-offset-2">
            {email}
          </a>
          .
        </p>
      ) : null}

      <p className="mt-10 max-w-3xl text-sm text-muted">
        More on how the tests work, and what we never do, is on the{' '}
        <Link href="/methodology" className="underline underline-offset-2 hover:text-foreground">
          methodology page
        </Link>
        .
      </p>
    </>
  );
}
