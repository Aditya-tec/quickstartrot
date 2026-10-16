# @qsr/crawler

Turns one docs URL into a normalized, hashable `Extraction` (spec section 7). Pure library: no HTTP server, no database. Playwright and `fetch` are injected.

## Public API

```ts
import { extract, launchBrowser, CrawlError } from '@qsr/crawler';

const browser = await launchBrowser();
try {
  const extraction = await extract(target, { browser, traceDir: './traces' });
  console.log(extraction.contentHash, extraction.blocks.length);
} catch (err) {
  if (err instanceof CrawlError) console.error(err.reason, err.details); // recorded as CRAWL_ERROR
} finally {
  await browser.close();
}
```

`extract(target, opts)` follows the spec algorithm: robots.txt check (`robots-parser`, RFC 9309 semantics), a fresh context with user agent `QuickstartRotBot/1.0 (+<contact>)`, wait for `extract.root`, click `[role=tab]` labels matching `extract.tab`, expand `details > summary`, then walk the root in document order.

Code is read with `innerText`, so hidden copy-button labels are dropped and inactive tab panels are skipped. Blocks are normalized (CRLF, trailing whitespace, shell prompts, 3+ blank lines) and hashed:
`contentHash = sha256(JSON.stringify(blocks.map(b => [b.kind, b.lang, b.text])))`.

### Failures

`extract` throws `CrawlError` with a `reason`: `robots`, `http_status`, `navigation_timeout`, `network`, `missing_root`, `no_code_blocks`. Only `network` and `navigation_timeout` are retried, once, after 10 s. With `traceDir` set, a Playwright trace is saved on failure (`err.details.tracePath`).

### Behaviour beyond the spec (found on real docs sites)

- Language also comes from Sphinx `highlight-<lang>` classes, and is searched on wrappers up to 12 levels above the code, but only wrappers that contain a single code block (mkdocs-material line-number tables).
- Code made of per-line `<span class="line">` elements is rebuilt line by line, because highlighters leave blank lines as empty spans that `innerText` drops.
- A block whose first line starts with `$ ` is treated as a terminal session whatever its language tag (`text`, `pytest`, none): only `$ ` prompts are stripped, output lines stay.
- Set `extract.codeBlocks` to `div.highlight pre` for Sphinx sites, whose `<pre>` has no inner `<code>`.

### Known limits

Content that a page only reveals through scripted animation (for example the termynal terminal widgets on FastAPI and Typer) is hidden from the DOM until it plays, so it is not extracted.

## Testing

`pnpm test` needs Chromium: `pnpm --filter @qsr/crawler exec playwright install chromium`. Fixture pages live in `fixtures/docs-site/` and are served by `startFixtureServer` (also exported for the canary targets). Extraction snapshots in `src/__snapshots__` were reviewed by eye.
