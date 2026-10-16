# @qsr/cli

The `qsr` command line (spec sections 12 and 15). From the repo root, `pnpm qsr <command>` builds what it needs and runs it.

## Commands

| Command                           | Phase | Status      |
| --------------------------------- | ----- | ----------- |
| `qsr crawl <slug>`                | P2    | implemented |
| `qsr compile <slug>`              | P3    | not yet     |
| `qsr run <slug>`                  | P4    | not yet     |
| `qsr plan` / `execute` / `report` | P7    | not yet     |

```sh
pnpm qsr crawl zod-node                  # human summary: title, hash, block counts, code block list
pnpm qsr crawl zod-node --json           # full Extraction as JSON on stdout (logs go to stderr)
pnpm qsr crawl resend-node --trace-dir ./traces
```

Exit codes: `0` ok, `1` crawl failed (`CRAWL_ERROR (<reason>)` on stderr), `2` usage or invalid target file.

## Library

`loadTarget(dir, slug)`, `loadAllTargets(dir, { canaries })` and `parseTargetFile(file)` read `targets/<slug>.yaml` (or `targets/_canary/`), validate with the `Target` schema from `@qsr/core`, and require the slug to equal the file name.
