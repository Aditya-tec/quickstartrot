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
    <header>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-5 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <svg width="30" height="30" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
            <rect x="1.5" y="1.5" width="19" height="19" rx="6" fill="var(--gold)" />
            <path
              d="M6.2 11.4 9.6 14.6 15.8 7.8"
              fill="none"
              stroke="#1a1300"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="font-display text-2xl italic leading-none tracking-tight">
            QuickstartRot
          </span>
        </Link>
        <div className="flex flex-wrap items-center gap-1 sm:gap-2">
          <nav
            aria-label="Main"
            className="flex flex-wrap items-center gap-1 text-sm font-medium sm:gap-2"
          >
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="inline-flex h-9 items-center rounded-full px-3 text-muted sm:h-10 sm:px-4 hover:bg-surface hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
