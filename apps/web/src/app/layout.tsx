import type { Metadata, Viewport } from 'next';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import { siteUrl } from '@/lib/env';
import { HOME_META } from '@/lib/home-copy';
import './globals.css';

const TITLE = 'QuickstartRot';
const DESCRIPTION = HOME_META.description;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: HOME_META.title, template: `%s · ${TITLE}` },
  description: DESCRIPTION,
  applicationName: TITLE,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: TITLE,
    title: HOME_META.title,
    description: DESCRIPTION,
    images: [
      { url: '/api/og/home', width: 1200, height: 630, alt: 'QuickstartRot headline number' },
    ],
  },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#faf9f7',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:shadow"
        >
          Skip to content
        </a>
        <SiteHeader />
        <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
