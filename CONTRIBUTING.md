# Contributing

QuickstartRot runs developer quickstarts on a clean machine and publishes which ones work. The most useful contribution is a quickstart we do not track yet. Fixes to the code are welcome too, and a report that a result is wrong is a contribution as well.

A person reads every issue and pull request.

## Add a quickstart

1. **Open an issue** with the [Add a quickstart](https://github.com/Aditya-tec/quickstartrot/issues/new?template=submit-quickstart.yml) form, giving the docs URL and the language. Or skip this and go straight to a pull request.
2. **Write the target file.** Copy a similar one in `targets/` (for example `targets/zod-node.yaml`) to `targets/<slug>.yaml`. The slug is the file name without `.yaml`. The fields:
   - `docsUrl`: the page of the quickstart, public, `https`.
   - `language`: `node` or `python`.
   - `level`: how far it can be tested, `2` (installs and the code builds) or `3` (the snippet runs and reaches the vendor's API with a made-up key). When in doubt use `2`; a maintainer raises it after a real run.
   - `runtime`: the image to run in. Copy it from a target of the same language.
   - `extract.root`: a CSS selector for the part of the page with the quickstart, so the menus and footers are not read.
   - `notes`: which page and which code blocks, and anything a tester should know.
3. **Start disabled.** Put `enabled: false` in the file. A new target is switched on only after a maintainer has reproduced a run in Docker and read the log; you do not need a model key or Docker for that.
4. **Check the file.** `pnpm install`, then `pnpm qsr validate --only <slug>` checks it against the schema. `--crawl` also tries a dry-run crawl of the page, but needs the crawler's contact address in the environment, so a maintainer can do that step for you.
5. **Open a pull request** with the one file. `targets/` is reviewed by a maintainer (see `.github/CODEOWNERS`).

### What we accept

A quickstart is accepted only if all of these hold, and they are the same ones [the methodology page](https://quickstartrot.vercel.app/methodology) states:

- the docs are public, and `robots.txt` allows crawling the page;
- the quickstart is built around code for Node.js or Python, with an install step and a snippet to copy;
- it can be tested without a sign-up (a sign-up is never automated);
- no terms of service forbid automated access (when they are unclear, we skip it);
- the product or project has real users.

### What we do not accept

- A quickstart that needs a real API key, a paid account, a CAPTCHA or an interactive login to run.
- A page whose terms or `robots.txt` ask automated tools to stay away.
- A target added to prove a point about a vendor. The aim is a representative sample, not a hunt for failures, and a tool is never dropped for passing.

## Report a wrong result

If a result on the site looks wrong (a pass that should fail, a failure that is ours), open an issue with the run page link and what you expected. That is a wrong result report, and we treat a false alarm as a bug in the monitor, not in your docs.

If you work on the product being tested, use the [Vendor: question or opt-out](https://github.com/Aditya-tec/quickstartrot/issues/new?template=opt-out.yml) form. It is also where you ask us to stop. How we tell a vendor about a failure is in [docs/DISCLOSURE.md](docs/DISCLOSURE.md); what our requests look like is in [docs/ABOUT-OUR-TRAFFIC.md](docs/ABOUT-OUR-TRAFFIC.md).

## Change the code

Read [AGENTS.md](AGENTS.md) first: it has the commands, the conventions and the rules that must never be broken. In short:

- Strict TypeScript and no `any`. Everything that crosses a boundary (an HTTP body, a YAML file, a model's output, a runner's result) is parsed with a Zod schema from `packages/core`.
- Tests first. Write the failing test, then the change. Run `pnpm typecheck && pnpm test && pnpm lint && pnpm format:check` before you push.
- Conventional commit messages (`fix(api): ...`, `feat(web): ...`) and one logical change per pull request.
- The trust rules hold for every change: the model never writes code (only code found verbatim in the docs runs), no secret ever appears in a log, an artifact or a prompt, the execute job has no secrets, and nothing is public as failing without a person's review. A change that weakens one is not accepted.

Do not put a secret, a token or a private address in an issue or a pull request. The secret scanner runs on every commit and on the whole history.
