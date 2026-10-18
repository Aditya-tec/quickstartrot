# Disclosure log

None have been sent.

This is the record of every private heads-up sent to a vendor about a failing quickstart (see [the disclosure policy](DISCLOSURE.md)). It is empty on purpose: nothing has been sent, and nothing in this repository sends anything. A person adds a row when they send a heads-up, by hand, and keeps it up to date. The launch check (`scripts/launch-check.mjs`) reads this file: it passes only if every row has a vendor, a valid date sent and a status, and it fails while any heads-up is still inside its wait.

When the first row is added, delete the line "None have been sent." above and write "Some have been sent." in its place (the check fails if the log says none were sent but has rows).

Columns:

- **Vendor** and **Tool (slug)**: who, and which quickstart.
- **Failure class**: one of the four vendor classes in the policy. A transient or infrastructure failure is never disclosed.
- **Sent to (channel)**: how it was sent (a support form, a documentation address), never the address itself.
- **Date sent (UTC)**: `YYYY-MM-DD`, or a full UTC time.
- **Status**: `sent`, `replied`, `fixed`, `disputed`, `no reply` or `withdrawn`.
- **Reply** and **Notes**: what they said, and anything worth keeping.

<!-- An example row, not an entry (a comment is ignored by the check):
| Acme | acme-node | API_DRIFT | support form | 2026-10-01 | sent | | |
-->

| Vendor | Tool (slug) | Failure class | Sent to (channel) | Date sent (UTC) | Status | Reply | Notes |
| ------ | ----------- | ------------- | ----------------- | --------------- | ------ | ----- | ----- |
