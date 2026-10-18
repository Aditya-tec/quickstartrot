import Link from 'next/link';
import { REPO_URL } from '@/components/site-footer';
import { plural, timesWord, words, type Facts } from '@/lib/facts';

// The /bot page, from the facts the crawler really follows (PIPELINE in @qsr/core). See honesty.test.tsx.

/** "A", "A and B", "A, B and C". */
const listNames = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** 2026-10-18 as "18 October 2026", in UTC so a server and a browser say the same. */
const longDate = (iso: string): string =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

export interface BotTraffic {
  services: readonly { name: string }[];
  /** YYYY-MM-DD: when the terms of these services were read. */
  termsReviewedOn: string;
}

export function BotContent({
  facts: f,
  userAgent,
  email,
  traffic,
}: {
  facts: Facts;
  userAgent: string;
  email: string | null;
  traffic: BotTraffic;
}) {
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
          Each docs page is fetched <strong>a single time per cycle</strong>. A cycle runs every{' '}
          {words(f.cycleHours)} {plural(f.cycleHours, 'hour')}, so a page is visited about{' '}
          {words(f.cyclesPerDay)} times a day.
        </li>
        <li>
          If a request fails on a network error, it is retried {timesWord(f.crawlRetries)} after{' '}
          {f.crawlRetryDelaySeconds} seconds. Never more.
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

      <h2 id="traffic" className="mt-10 scroll-mt-20 text-xl font-semibold tracking-tight">
        About our traffic
      </h2>
      <p className="mt-2 max-w-3xl text-[15px] leading-7">
        For some quickstarts the check goes one step further than installing: it runs the
        documentation&apos;s own code, and that code makes a request to the service&apos;s API with
        an <strong>invalid, made-up credential</strong>. The service is expected to refuse it, and
        the refusal coming back is how we know the code reached the service. (For a service whose
        docs set no key, the request carries none at all, and is refused the same way.)
      </p>
      <ul className="mt-2 max-w-3xl list-disc space-y-2 pl-5 text-[15px] leading-7">
        <li>
          <strong>Which services:</strong> {listNames(traffic.services.map((s) => s.name))}. These
          names only say where the traffic goes; there is no affiliation with, or endorsement by,
          any of them.
        </li>
        <li>
          <strong>How often:</strong> at most {words(f.vendorRequestsPerCycle)}{' '}
          {plural(f.vendorRequestsPerCycle, 'request')} per cycle for each quickstart, so at most{' '}
          {words(f.vendorRequestsPerDay)} a day for each quickstart (a service for which we track
          more than one quickstart, say a Node one and a Python one, receives that for each of
          them). A failed request is not retried.
        </li>
        <li>
          <strong>From where:</strong> GitHub Actions runners, which share GitHub&apos;s address
          ranges. The request is made by the service&apos;s own client library, so it carries the
          library&apos;s user agent, not ours.
        </li>
        <li>
          <strong>What it never does:</strong> an invalid credential cannot create, send or charge
          anything, and we never hold a real one. We do not sign up for anything.
        </li>
        <li>
          <strong>To ask us to stop:</strong> use the opt-out form below
          {email ? (
            <>
              {' '}
              or write to{' '}
              <a href={`mailto:${email}`} className="underline underline-offset-2">
                {email}
              </a>
            </>
          ) : null}
          . We stop within {f.optOutHours} hours.
        </li>
      </ul>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-muted">
        On {longDate(traffic.termsReviewedOn)} we read the public terms of each of these services
        for anything about automated requests or requests with invalid credentials. That was a
        summary check by us, it is not legal advice, and it did not cover every policy a service
        links to. If we got something wrong, tell us and we will stop.
      </p>

      <h2 id="opt-out" className="mt-10 scroll-mt-20 text-xl font-semibold tracking-tight">
        Opt out
      </h2>
      <p className="mt-2 max-w-3xl text-[15px] leading-7">
        If you maintain a quickstart we track and you want it removed, open an issue with the
        opt-out form. We disable the tool and hide its history within {f.optOutHours} hours. You can
        also block <code className="font-mono text-sm">QuickstartRotBot</code> in your{' '}
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
