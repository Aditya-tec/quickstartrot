# Disclosure email: private heads-up to a vendor

A template. It is not sent by any code in this repository, and nothing here knows an address: a person fills it in, checks every line against the run page, and sends it by hand to a contact the vendor publishes. Read [docs/DISCLOSURE.md](../DISCLOSURE.md) first. Replace each `{{placeholder}}`; delete this heading and the notes in brackets before sending.

---

**Subject:** A quickstart on {{docs_url}} fails on a clean machine: details inside, nothing public yet

Hello {{vendor}} team,

I run QuickstartRot, which re-runs developer quickstarts on a clean machine every few hours and reports whether they work. We have no affiliation with {{vendor}}, and this is a private heads-up: **nothing about this is public yet.**

Your {{tool_name}} quickstart, {{docs_url}}, started failing for us on {{first_failed_at}} (UTC) and has failed the same way in each valid test cycle since.

**What failed**

> {{failing_line}}

**How to see it**

- The run, with the steps and the output: {{run_link}}
- What we did: the install commands and the snippet from your page, exactly as written there, in a fresh container with no credentials. Nothing a model wrote was run.
- {{what_changed}} [for example: the docs page did not change; the package went from one version to another. Say only what the run page shows.]

**What we plan to do**

We will wait 48 hours from this message before anything is public. A person at our end will then look again. If the quickstart passes by then, the failure resolves and is never shown. If it still fails, we will publish a short, neutral note on the quickstart's page with the evidence above. We never publish for a network, registry or timeout failure, or one of ours.

**What you can do**

- You do not need to reply. A fix is the best outcome.
- If we are wrong, tell us how and we will look again. It might be wrong: a failure in our monitor is a bug in our monitor.
- If you would rather we did not test your quickstart at all, reply or use the opt-out form at https://github.com/Aditya-tec/quickstartrot/issues/new?template=opt-out.yml. If you do: Probing stops within 24 hours of an opt-out request. The quickstart's page stays up, labelled "no longer monitored at the vendor's request". Past results stay visible and are hidden only if the vendor asks for that. We send a written reply within 3 business days.

What our requests look like and how we decide what to publish: https://quickstartrot.vercel.app/bot and https://quickstartrot.vercel.app/methodology.

Thank you,
{{sender_name}}
QuickstartRot

---

[Before sending, check: the run page is the one you mean; the failing line is copied from it; the failure class is one of the four vendor classes in DISCLOSURE.md; the contact is one the vendor publishes; nothing here is a secret. Then record who, when and how in your disclosure log.]
