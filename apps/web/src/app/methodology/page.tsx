import type { Metadata } from 'next';
import Link from 'next/link';
import { LevelBadge } from '@/components/level-badge';
import { REPO_URL } from '@/components/site-footer';

export const metadata: Metadata = {
  title: 'Methodology',
  description:
    'How QuickstartRot tests developer quickstarts: levels, the gates before a quickstart is called failing, canaries, human review and limitations.',
  alternates: { canonical: '/methodology' },
};

// Written from what the code does (packages/status, executor, classifier, compiler, crawler and the probe
// workflow), not from what we hope it does. When the pipeline changes, change this page in the same commit.

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mt-12 scroll-mt-20 text-2xl font-semibold tracking-tight">
      {children}
    </h2>
  );
}

const P = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-3 max-w-3xl text-[15px] leading-7">{children}</p>
);
const UL = ({ children }: { children: React.ReactNode }) => (
  <ul className="mt-3 max-w-3xl list-disc space-y-2 pl-5 text-[15px] leading-7">{children}</ul>
);

export default function MethodologyPage() {
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Methodology</h1>
      <P>
        QuickstartRot takes the quickstart from a vendor&rsquo;s documentation, runs it on a clean
        machine every six hours, and reports whether it works. This page says exactly what that
        means, what a pass proves, and what we do not claim. The code is public:{' '}
        <a href={REPO_URL} className="underline underline-offset-2" rel="noopener noreferrer">
          the repository
        </a>
        .
      </P>

      <H2 id="how">How a quickstart is tested</H2>
      <ol className="mt-3 max-w-3xl list-decimal space-y-2 pl-5 text-[15px] leading-7">
        <li>
          <strong>Crawl.</strong> A headless browser opens the docs page once per cycle, after
          checking <code className="font-mono text-sm">robots.txt</code>, and extracts the code
          blocks and the headings around them.
        </li>
        <li>
          <strong>Compile.</strong> A language model turns those blocks into a short ordered plan:
          install, write a file, set a dummy environment variable, run. The model{' '}
          <em>never writes code</em>. A deterministic grounding check rejects any plan that contains
          a command or file that does not appear verbatim in the docs. A plan that fails the check
          is retried once with the violations listed, and then discarded.
        </li>
        <li>
          <strong>Execute.</strong> The plan runs in a fresh container with no host environment, no
          secrets and no credentials. Dummy placeholder values stand in for API keys.
        </li>
        <li>
          <strong>Classify.</strong> A failure is matched by fixed rules against the exit code and
          output, so that a network blip, a registry outage or a problem on our side is not mistaken
          for a broken quickstart.
        </li>
        <li>
          <strong>Decide.</strong> A small state machine, with every transition covered by tests,
          decides what the result means (see below).
        </li>
      </ol>

      <H2 id="levels">Levels: what a pass proves</H2>
      <P>
        Not every quickstart can be tested equally far. Each one has a level, and a pass means
        different things at different levels. The home page counts them separately for that reason.
      </P>
      <dl className="mt-4 grid max-w-3xl gap-4">
        {[
          {
            level: 1,
            text: 'The install commands ran and exited successfully. Nothing was built or run. This is the weakest pass.',
          },
          {
            level: 2,
            text: 'The quickstart installs, and its code builds: imports resolve and the code compiles or type-checks. It was not run against the vendor, so it does not show that the vendor’s service accepts it.',
          },
          {
            level: 3,
            text: 'The snippet ran and reached the vendor’s API. With a dummy key the API answers with an authentication error, and that is counted as a pass: the code, the SDK and the network path all work, and only the credentials were missing.',
          },
          {
            level: 4,
            text: 'A full run with real credentials. Not used in this version: we never use real vendor API keys.',
          },
        ].map((l) => (
          <div key={l.level} className="rounded-lg border border-border bg-surface p-4">
            <dt className="flex items-center gap-2 font-medium">
              <LevelBadge level={l.level} /> Level {l.level}
            </dt>
            <dd className="mt-1 text-[15px] leading-7">{l.text}</dd>
          </div>
        ))}
      </dl>
      <P>
        A quickstart that stops at a step only a person can do, such as signing up or answering an
        interactive prompt, is marked &ldquo;needs a person&rdquo;. It is listed separately, is not
        a failure, and is not counted in the headline number.
      </P>

      <H2 id="before-failing">Before a quickstart is called failing</H2>
      <P>
        Calling a vendor&rsquo;s quickstart broken in public is a serious claim, so it needs several
        things to be true:
      </P>
      <UL>
        <li>
          <strong>Two failures in a row, in valid cycles.</strong> The first failure moves a
          quickstart to &ldquo;verifying&rdquo; and nothing more. A second failure with the same
          signature, in the next valid cycle, opens an incident.
        </li>
        <li>
          <strong>The failure has to be about the quickstart.</strong> Network errors and timeouts
          are retried once inside the cycle, after a minute, and only the last attempt counts. Four
          transient failures in a row open an incident that is labelled as a likely registry or
          vendor outage. Problems on our side (the crawler, the compiler, the runner) and anything
          that needs credentials never count as the vendor&rsquo;s failure; they go to our own
          review queue.
        </li>
        <li>
          <strong>A person reviews it.</strong> Until a person confirms the incident, the quickstart
          shows &ldquo;verifying&rdquo; and the page shows no cause, no error output and no logs.
          That is enforced in the database views and again in the application. If the reviewer finds
          a false alarm, the incident is closed and was never shown.
        </li>
        <li>
          <strong>It recovers on its own.</strong> One pass clears a first failure that was still
          being checked. A confirmed incident is resolved after two consecutive passes in valid
          cycles. A failure with the signature of an incident resolved in the last seven days
          reopens that incident.
        </li>
      </UL>

      <H2 id="canaries">Canaries</H2>
      <P>
        Every cycle also runs four canaries: small fake quickstarts whose correct outcome is known
        in advance (two that must pass, one that must fail because a function the docs call does not
        exist, and one that must fail because a package cannot be found). If any canary gives the
        wrong answer, the runner itself is not trustworthy that cycle. The whole cycle is marked
        invalid, none of its results change any status, and it is ignored. Canaries are never shown
        publicly.
      </P>

      <H2 id="staleness">Stale plans</H2>
      <P>
        If the language model is unavailable or rate-limited, a quickstart is run with the last plan
        that passed the grounding check instead of waiting. Such a run is marked as a stale plan on
        its page and in the history strip. It still tests the quickstart as it was last understood,
        but not any change to the docs since.
      </P>

      <H2 id="never">What we never do</H2>
      <UL>
        <li>Run code a model wrote. Only code found verbatim in the docs runs.</li>
        <li>Automate sign-ups, solve CAPTCHAs, or use real vendor API keys.</li>
        <li>
          Ignore <code className="font-mono text-sm">robots.txt</code>, or fetch a docs page more
          than once per cycle. See{' '}
          <Link href="/bot" className="underline underline-offset-2">
            the bot page
          </Link>
          .
        </li>
        <li>
          Put a secret in a log, an artifact or a model prompt. All captured output is redacted.
        </li>
        <li>Publish a failure before a person has reviewed it.</li>
        <li>
          Name a vendor in a launch post before telling them, with the evidence, and waiting 48
          hours.
        </li>
      </UL>

      <H2 id="limitations">Limitations</H2>
      <UL>
        <li>
          <strong>A pass is not a guarantee.</strong> It means the quickstart worked in our
          environment at that time, up to the stated level. It does not show that it works on your
          machine, with your version of Node.js or Python, or with a real key.
        </li>
        <li>
          <strong>Levels differ.</strong> A level 2 pass proves much less than a level 3 pass.
          Compare like with like.
        </li>
        <li>
          <strong>Plans are model-assisted.</strong> The grounding check stops invented code, but
          the model may pick the wrong blocks or miss a step. That shows up as a failure or a
          skipped step that we then review, never as a public claim without a person.
        </li>
        <li>
          <strong>Coverage is small and chosen by hand.</strong> Only Node.js and Python quickstarts
          that run in a terminal are covered. A quickstart that needs a browser, a mobile app or a
          dashboard is out of scope.
        </li>
        <li>
          <strong>Times are approximate.</strong> Scheduled runs can start late. The page shows when
          each run actually started, in UTC.
        </li>
        <li>
          <strong>The data is cached for up to five minutes</strong>, and the badge for up to ten.
        </li>
      </UL>

      <H2 id="corrections">Corrections and removal</H2>
      <P>
        If a result is wrong, open an issue in{' '}
        <a
          href={`${REPO_URL}/issues`}
          className="underline underline-offset-2"
          rel="noopener noreferrer"
        >
          the repository
        </a>
        . A vendor can ask to be removed with the{' '}
        <Link href="/bot#opt-out" className="underline underline-offset-2">
          opt-out form
        </Link>
        ; we disable the tool and hide its history within 24 hours.
      </P>
    </>
  );
}
