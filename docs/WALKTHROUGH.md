# One-minute walkthrough

A script for a short screen recording or a live demo. Text only: what to put on screen, in order, and what to say. It quotes no figure. At each beat, **read the number off the screen**, so what you say is what the site says that day.

Written for the person recording, who has the site open at <https://quickstartrot.vercel.app>.

## Before you record

- Refresh the page and check the headline is current. Run `pnpm qsr readme --check` and `node --env-file=.env scripts/launch-check.mjs` and fix anything that fails.
- Pick a quickstart that is passing and tested up to L3 for the tool page, if there is one; otherwise a passing L2 one. Open its latest run page in a second tab.
- Use a clean browser window at a normal zoom, light theme, no extensions showing.

## Do not show

- Anything under `/admin`, the admin login, or the review queue.
- A token, `.env`, the Render or Supabase dashboards, or a terminal with environment variables.
- A quickstart that is verifying. Its cause is not public until a person has confirmed it, and the walkthrough must not reveal it.
- A vendor's name next to a failure. The recording is about the method.

## The script

| Time      | On screen                                                                                       | Say                                                                                                                                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00-0:07 | `/` at the top: the headline sentence and the box "How far each quickstart was tested".         | "Every few hours we run developer quickstarts on a clean machine. This is how many work right now, and how far each one was tested." Read the headline number.                                                                                                           |
| 0:07-0:15 | `/` scrolled to the table. Filter by language, then point at a status pill and a history strip. | "One row per quickstart. Passing, or being verified. A failure is only called failing after a person has confirmed it."                                                                                                                                                  |
| 0:15-0:27 | `/tools/` the passing tool you chose: the level badge, the step timeline, the history strip.    | "Here is one quickstart. It installs, builds, and for this level the snippet reaches the vendor's API with a made-up key. Every step is timed."                                                                                                                          |
| 0:27-0:37 | `/runs/` the latest run of that tool: open a step's output, then the grounding report.          | "The model never writes code. Everything that ran is quoted from the docs, and this report shows where each line came from."                                                                                                                                             |
| 0:37-0:50 | `/methodology#detection`: the two tables, then the line about L3.                               | "We also tested the monitor by breaking quickstarts on purpose. Install breakage is caught by the package manager; for broken code, read the L2 row. L3 rests on a few quickstarts, so there is no rate." Read the L2 numbers and the number of quickstarts L3 rests on. |
| 0:50-0:56 | The Badge section of the README, or a badge image in a README.                                  | "Every quickstart has a badge you can put in your own README."                                                                                                                                                                                                           |
| 0:56-1:00 | `/submit`, then the repository page.                                                            | "Submit yours, or read the code. It is all public."                                                                                                                                                                                                                      |

## After

Do not post it anywhere from here: posting is a separate step, and the launch checklist has to pass first.
