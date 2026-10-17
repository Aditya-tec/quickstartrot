import { siteUrl } from '@/lib/env';

// Copyable embeds for a README. The base URL is configuration (NEXT_PUBLIC_SITE_URL), never hard-coded.

export function badgeSnippets(slug: string, site: string): { markdown: string; html: string } {
  const img = `${site}/api/badge/${slug}`;
  const link = `${site}/tools/${slug}`;
  return {
    markdown: `[![Quickstart status](${img})](${link})`,
    html: `<a href="${link}"><img src="${img}" alt="Quickstart status"></a>`,
  };
}

export function BadgeSnippets({ slug }: { slug: string }) {
  const { markdown, html } = badgeSnippets(slug, siteUrl());
  return (
    <section aria-labelledby="badge-heading" className="mt-10">
      <h2 id="badge-heading" className="text-xl font-semibold tracking-tight">
        Add the badge to your README
      </h2>
      <p className="mt-1 text-sm text-muted">
        The badge shows passing, failing, verifying or unknown, and links back to this page.
      </p>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-3">
        <div>
          <h3 className="text-sm font-medium">Markdown</h3>
          <pre
            className="mt-1 overflow-x-auto rounded border border-border bg-surface-2 px-3 py-2 font-mono text-xs"
            tabIndex={0}
          >
            {markdown}
          </pre>
        </div>
        <div>
          <h3 className="text-sm font-medium">HTML</h3>
          <pre
            className="mt-1 overflow-x-auto rounded border border-border bg-surface-2 px-3 py-2 font-mono text-xs"
            tabIndex={0}
          >
            {html}
          </pre>
        </div>
      </div>
    </section>
  );
}
