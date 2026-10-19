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
          <img
            src="/logo.png"
            alt=""
            width={24}
            height={30}
            className="h-[30px] w-auto rounded-md [[data-theme=dark]_&]:bg-[#faf7ec] [[data-theme=dark]_&]:p-0.5"
          />
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
