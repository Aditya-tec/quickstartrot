# Disclosure policy

How QuickstartRot tells a vendor that a quickstart of theirs fails, and what becomes public and when.

The short version: **the vendor hears first, privately; we wait; and nothing is public until a person has reviewed it.** A failure that is ours or the network's is never public.

## The rules

1. **Private heads-up first.** When a quickstart fails in a way that looks like the vendor's (see below), we send the vendor a private message with the evidence before anything about it is public. The message is the template in [docs/templates/disclosure-email.md](templates/disclosure-email.md), sent by a person to a contact the vendor publishes (a support or documentation address, or a private channel they offer). We do not open a public issue on a vendor's repository as the first step.
2. **Then we wait 48 hours.** The wait is `PIPELINE.disclosureWaitHours` in `packages/core/src/pipeline-facts.ts`, the same figure the methodology page quotes. It starts when the heads-up is sent, not when the failure started.
3. **Nothing is public meanwhile.** Until a person confirms an incident, the quickstart shows as "verifying" on the site, the badge and the share images, with no cause, no error line, no logs and no diff. That is enforced in the database views and again in the application, and the end-to-end suite fails if a cause leaks.
4. **Public only after human review.** After the wait, a person reads the evidence again, with whatever the vendor has told us, and decides. If the quickstart passes again, the incident resolves by itself and was never shown. If it is a false alarm, it is marked as one and was never shown. If it is a real, still-open failure, the person confirms it, edits the summary and the suggested fix, and only then does the cause become public.
5. **A launch post never names a vendor** whose failure has not been through these steps.

## What counts as the vendor's failure

Only a failure of one of these classes can ever be confirmed and shown: `DEPENDENCY_RESOLUTION`, `API_DRIFT`, `DOCS_SNIPPET_ERROR` and `RUNTIME_VERSION`. These are about the quickstart: a package that cannot be installed, an API the snippet uses that has changed, a snippet that is wrong as written, a runtime version it does not support.

## Never public for a transient or infrastructure failure

A failure caused by the network, a registry, a timeout, or by us is **never public for a transient or infrastructure failure**, whoever reviews it, and the vendor is not contacted about it:

| Class               | What it is                                                          |
| ------------------- | ------------------------------------------------------------------- |
| `NETWORK_TRANSIENT` | A connection, DNS or registry outage that a retry would likely fix. |
| `TIMEOUT`           | The step ran out of time.                                           |
| `CRAWL_ERROR`       | Our crawler could not read the docs page.                           |
| `COMPILER_ERROR`    | Our compiler could not make a valid plan from the page.             |
| `HARNESS_ERROR`     | Our own runner failed.                                              |

These are enforced in code, not only by care. A run of these failures in a row can open an internal incident (it is labelled a likely outage), but `confirmIncident` in `apps/api/src/services/admin-actions.ts` refuses to confirm any incident whose class is not one of the four vendor classes above, and the review screen shows the error. The only way out for such an incident is to resolve it or mark it a false positive. A test in `apps/api/test/admin.test.ts` pins it, and the public methodology page says so.

A canary that misbehaves makes the whole cycle invalid and ignored, so a broken runner cannot blame a vendor either.

## What the vendor can do

- **Reply, fix, or do nothing.** A fix within the wait is the best outcome: the quickstart passes again, the incident resolves, and nothing was ever shown.
- **Dispute it.** If the vendor disagrees, they tell us why and we look again. A false alarm is a bug in our monitor; we fix the classification and record it.
- **Ask us to stop.** Use the [Vendor: question or opt-out](../.github/ISSUE_TEMPLATE/opt-out.yml) form or write to the address on the bot page. Probing stops within 24 hours of an opt-out request, and the tool's history is hidden at the same time; the figure is `PIPELINE.optOutHours`. Whatever you write to us, we send a written reply within 3 business days (`PIPELINE.vendorReplyBusinessDays`).
- **Ask what we send.** [docs/ABOUT-OUR-TRAFFIC.md](ABOUT-OUR-TRAFFIC.md) says which services receive a request from some of our checks, and how often.

## What we do not do

- We do not contact a vendor about a failure we have not reproduced in valid cycles, or one a person has not looked at.
- We do not ask for anything in return, publish a deadline as a threat, or compare vendors.
- We do not publish a vendor's reply without their agreement.

## Records

A heads-up is sent by a person and recorded by that person, in [docs/disclosure-log.md](disclosure-log.md): who was contacted, when, how, and what they said. Nothing in this repository sends an email, opens an issue on another repository, or posts anywhere; the template is a file. The log is empty on purpose: none have been sent. The launch check reads it: it passes only if every entry has a date sent and a status, and it fails while any heads-up is still inside its wait. Disclosure tracking inside the admin page is not built; the log is what stands in for it.
