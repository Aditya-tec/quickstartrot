# QuickstartRot

QuickstartRot runs developer quickstart guides on a clean machine every six hours and publishes which ones work. The site is
at <https://quickstartrot.vercel.app>. It reports what happened and does not rank or review products.

- How a quickstart is tested, and what a pass proves at each level: [Methodology](https://quickstartrot.vercel.app/methodology)
- The crawler, its user agent and how to opt out: [QuickstartRotBot](https://quickstartrot.vercel.app/bot)
- Building, testing and deploying: `AGENTS.md` (commands and conventions) and `DEPLOY.md` (Render and Vercel)

## Badge

Every tracked quickstart has a badge you can put in your own README. It shows `quickstart | passing`, `failing`, `verifying`,
`unknown` or `needs a person`, and links back to the tool page. "failing" appears only after a person confirmed the failure;
until then the badge says "verifying".

Markdown (replace `resend-node` with the slug of your tool, which is the last part of its page URL):

```markdown
[![Quickstart status](https://quickstartrot.vercel.app/api/badge/resend-node)](https://quickstartrot.vercel.app/tools/resend-node)
```

HTML:

```html
<a href="https://quickstartrot.vercel.app/tools/resend-node"
  ><img src="https://quickstartrot.vercel.app/api/badge/resend-node" alt="Quickstart status"
/></a>
```

The badge is a small self-contained SVG, cached for ten minutes. A slug that is not tracked shows `not tracked`.

## Development

```
pnpm install
pnpm build
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
```

The website runs without any credentials on seeded data: `QSR_DATA=fixtures pnpm --filter @qsr/web dev`
(see `apps/web/README.md`).
