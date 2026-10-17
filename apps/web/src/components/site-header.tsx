import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';

const NAV = [
  { href: '/', label: 'Leaderboard' },
  { href: '/incidents', label: 'Incidents' },
  { href: '/methodology', label: 'Methodology' },
  { href: '/submit', label: 'Submit' },
];

export function SiteHeader() {
  return (
    <header className="border-b border-border bg-surface/80">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
            <rect
              x="1.5"
              y="1.5"
              width="19"
              height="19"
              rx="5"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.8"
            />
            <path
              d="M6.2 11.4 9.6 14.6 15.8 7.8"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          QuickstartRot
        </Link>
        <nav
          aria-label="Main"
          className="order-last flex w-full flex-wrap gap-x-5 gap-y-1 text-sm sm:order-none sm:w-auto"
        >
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="text-muted hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>
        <ThemeToggle />
      </div>
    </header>
  );
}
