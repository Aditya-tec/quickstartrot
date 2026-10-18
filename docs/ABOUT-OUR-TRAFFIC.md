# About our traffic

This is the plain-language note on the requests QuickstartRot sends to the services whose quickstarts it tests. The same text is on the public site (`/bot`, section "About our traffic"); the figures come from `TRAFFIC` and `PIPELINE` in `packages/core/src/pipeline-facts.ts`, and a test keeps the list of services equal to the real targets.

## What the request is

For some quickstarts the check goes one step further than installing: it runs the documentation's own code, and that code makes **one request to the service's API with an invalid, made-up credential** (the literal `qsr_dummy_key`). The service is expected to refuse it. The refusal coming back is how we know the code reached the service. (For a service whose docs set no key, the request carries none at all, and is refused the same way.) An invalid credential cannot create, send or charge anything, and we never hold a real one. We do not sign up for anything.

## Which services

Anthropic, Cerebras, OpenRouter, Resend and Slack (the quickstarts behind them are listed in `TRAFFIC.services`). These names only say where the traffic goes: there is no affiliation with, or endorsement by, any of them.

## How often

At most **one request per cycle** for each quickstart, and a cycle runs every six hours, so **at most four a day for each quickstart**. A service for which we track more than one quickstart (a Node one and a Python one, say) receives that for each of them. The probe never retries a failure at that step. Some of these quickstarts run the step in _shadow_ (recorded, not counted) while we check that the evidence is stable; shadow requests are counted in the figures above, they are not extra.

`qsr mutate`, the local mutation-testing tool, makes no such request unless it is run with `--allow-vendor-calls`; a manual probe dispatch runs one extra cycle and is the only other way the figure above can be exceeded.

## From where

GitHub Actions runners (shared GitHub address ranges). The request is made by the service's own client library, so it carries the library's user agent, not `QuickstartRotBot`'s.

## To ask us to stop

Use the opt-out form on the `/bot` page, or write to the address shown there. We stop within 24 hours.

## Terms

On 18 October 2026 we read the public terms of each of these services for anything about automated requests or requests with invalid credentials. That was a **summary check by us, it is not legal advice**, and it did not cover every policy a service links to (acceptable-use policies, developer policies and master agreements were not all public or read). Two services were left out because their terms were not clear enough to rely on: a mail API whose terms bar testing its authentication measures without written consent, and an email-marketing service whose acceptable-use text bans any automatic device. If we got something wrong, tell us and we will stop.
