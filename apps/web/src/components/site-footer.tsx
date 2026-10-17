import Link from 'next/link';

export const REPO_URL = 'https://github.com/Aditya-tec/quickstartrot';

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          QuickstartRot runs developer quickstarts on a fresh machine and publishes what happens. It
          does not rank or review products.
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-1">
          <Link href="/methodology" className="hover:text-foreground">
            Methodology
          </Link>
          <Link href="/bot" className="hover:text-foreground">
            About the crawler
          </Link>
          <a href={REPO_URL} className="hover:text-foreground">
            Source
          </a>
        </nav>
      </div>
    </footer>
  );
}
