# Launch checklist

The gate to pass the day before anything is posted. One command runs every check that can be automated and prints the evidence for each:

```
node --env-file=.env scripts/launch-check.mjs
```

It needs the repository built (`pnpm build`) and `ADMIN_TOKEN` and `API_BASE_URL` in `.env` for the admin checks (without them those checks are SKIP, and say so). `--only a,b` runs some of them, `--list` prints the ids, `--json` gives machine-readable output, `--max-ms` changes the limit for a first request to a page. The token is never printed.

The check sends nothing to a vendor, posts nothing, opens nothing on any other repository, and creates no data. Its only requests to our own services are GETs, plus one burst of `GET /health` to see the rate limit. Run it again after fixing anything; it is safe to repeat.

## How to read the result

- **PASS** the check holds, with the evidence on the same line.
- **FAIL** it does not. A FAIL blocks the launch: fix it and run again.
- **WARN** look at it; it does not block (a cache that had not warmed yet, an older CI run).
- **MANUAL** only a person can do it. The line says what to read.
- **SKIP** it could not run here (no Docker, no token, GitHub unreachable), with the reason. A SKIP is not a PASS: run it where it can.

## The gate

| Id                          | Check                                                     | How       | Passes when                                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site-reachable`            | The public pages answer                                   | Automated | Home, methodology, bot, incidents, submit, robots.txt and the sitemap answer 200.                                                                                                                                           |
| `unfurl-home`               | A link to the home page unfurls                           | Automated | `og:image` is an absolute https URL on the site, a 1200 by 630 png under 5 MB, with `twitter:card` summary_large_image and a title and description.                                                                         |
| `unfurl-methodology`        | A link to /methodology unfurls with its own card          | Automated | The same, and the image is `/api/og/methodology`, not the home page's.                                                                                                                                                      |
| `readme-matches-site`       | The counts and level wording in the README equal the site | Automated | `qsr readme --check` finds both generated blocks equal to the site's `/api/status` and to `docs/detection-power.json`. Fix with `pnpm qsr readme`, `pnpm format`, and commit.                                               |
| `detection-summary-current` | The file /methodology reads equals the document           | Automated | `qsr detection-summary --check` finds `apps/web/src/data/detection-power.json` equal to `docs/detection-power.json` and the target files.                                                                                   |
| `claims-current`            | The sheet of safe figures is current                      | Automated | `qsr claims --check` finds `docs/CLAIMS.md` equal to the site, the measurement, the target files, the pipeline constants and the admin API. Regenerate it with `pnpm qsr claims` and `pnpm format` before writing any post. |
| `status-matches-home`       | The status counts equal the home headline                 | Automated | `GET /api/status` and the "X of Y" on the home page give the same numbers.                                                                                                                                                  |
| `l3-count-matches`          | The L3 sentence is true                                   | Automated | The number of quickstarts the target files say reach L3 in production (the sentence in the README and on /methodology) equals the number the site tests at L3.                                                              |
| `cycle-valid`               | The latest finished cycle was valid and recent            | Automated | Valid, canaries behaved, started within two cycles plus an hour.                                                                                                                                                            |
| `no-unreviewed-public`      | No unreviewed incident is visible anywhere                | Automated | For each incident waiting for review, none of its signature, summary, fix or class appears on the tool page, its run pages, the image, the badge, the home page, the incidents page or the status counts.                   |
| `disclosures-48h`           | No vendor heads-up is inside its wait                     | Automated | No row of `docs/disclosure-log.md` (other than a withdrawn one) was sent less than the wait ago. With a token it also warns about a vendor-class incident waiting for review with no heads-up logged.                       |
| `ci-green`                  | CI is green for the head of main                          | Automated | The newest `ci.yml` run on main is a completed success for the commit at the head.                                                                                                                                          |
| `secrets-history`           | The gitleaks job of CI passed                             | Automated | The whole-history scan job succeeded for the head.                                                                                                                                                                          |
| `secrets-staged`            | The local secret gate works                               | Automated | `scripts/secrets-check.mjs` runs and finds nothing staged it refuses.                                                                                                                                                       |
| `actionlint`                | The workflows lint clean                                  | Automated | The pinned actionlint image CI uses finds nothing.                                                                                                                                                                          |
| `license`                   | The licence is chosen                                     | Automated | A `LICENSE` file exists and the README names it (MIT, a decision of the owner).                                                                                                                                             |
| `cold-start-pages`          | A first visit does not hang                               | Automated | The first request to each public page, badge, share image and the status counts answers 200 in under the limit.                                                                                                             |
| `cold-start-api`            | How long the sleeping API takes to wake                   | Automated | It answers. A slow first answer is a WARN: only /submit, the admin area and the revalidate hook use the API, and /submit wakes it when the page opens.                                                                      |
| `pages-independent-of-api`  | No public page waits for the API                          | Automated | The guard test finds no page, layout or public component reading the API address.                                                                                                                                           |
| `badges-cached`             | Badge endpoints are cached                                | Automated | A repeat request is answered from the CDN's cache (`x-vercel-cache` HIT or STALE, with an age). Vercel shows the client a bare `public`, so the origin's `s-maxage` is pinned by the badge route's test instead.            |
| `abuse-unknown-slugs`       | Made-up slugs cost nothing                                | Automated | Badges for slugs nobody tracks say "not tracked", images are 404, all fast.                                                                                                                                                 |
| `rate-limit-api`            | The API limits a burst from one address                   | Automated | A burst of `GET /health` is answered with 429 before the cap.                                                                                                                                                               |
| `vendor-issues-answered`    | No vendor question or opt-out waits                       | Automated | No open issue labelled vendor or opt-out has zero replies.                                                                                                                                                                  |
| `disclosure-log`            | The disclosure log is complete                            | Automated | Every row of `docs/disclosure-log.md` has a vendor, a valid date sent and a status; an empty log passes. The log is kept by hand: nothing in the repository sends a heads-up.                                               |
| `post-claims`               | Every number in the post is on the site                   | By hand   | Each figure in the launch post is on the home page or /methodology that day; any that is not is removed.                                                                                                                    |

## What a failure of each kind means

- A FAIL in `cycle-valid`, `no-unreviewed-public` or `ci-green` is never worked around: the launch waits.
- `license` fails if the `LICENSE` file, the README's License section or `package.json` stop agreeing (a test fails too).
- Anything that depends on the cache is checked again after a cycle finishes, because a finished cycle refreshes the data at once.

Related: [Disclosure policy](DISCLOSURE.md), [the walkthrough](WALKTHROUGH.md), [About our traffic](ABOUT-OUR-TRAFFIC.md).
