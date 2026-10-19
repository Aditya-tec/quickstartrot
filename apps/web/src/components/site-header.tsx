import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';

const NAV = [
  { href: '/', label: 'Leaderboard' },
  { href: '/incidents', label: 'Incidents' },
  { href: '/methodology', label: 'Methodology' },
  { href: '/bot', label: 'Our bot' },
];

export function SiteHeader() {
  return (
    <header>
      <div className="mx-auto grid max-w-[1280px] grid-cols-[1fr_auto] items-center gap-x-6 gap-y-3 px-8 py-6 md:grid-cols-[1fr_auto_1fr]">
        <Link href="/" className="flex items-center gap-2.5 justify-self-start">
          <img
            src="/logo.png"
            alt=""
            width={24}
            height={30}
            className="h-[30px] w-auto rounded-md [[data-theme=dark]_&]:bg-[#faf7ec] [[data-theme=dark]_&]:p-0.5"
          />
          <span className="font-display text-[30px] leading-none tracking-tight">
            QuickstartRot
            <sup className="ml-0.5 align-super text-[0.4em]">&trade;</sup>
          </span>
        </Link>
        <nav
          aria-label="Main"
          className="order-last col-span-2 flex flex-wrap items-center justify-center gap-x-10 gap-y-1 text-sm font-medium md:order-none md:col-span-1"
        >
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="inline-flex h-10 items-center text-foreground/80 hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2 justify-self-end">
          <ThemeToggle />
          <Link href="/submit" className="btn-pill">
            Submit a quickstart
          </Link>
        </div>
      </div>
    </header>
  );
}
