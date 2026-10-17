import type { Metadata } from 'next';

// Nothing under /admin is indexed or cached (the middleware also sets X-Robots-Tag and no-store).
export const metadata: Metadata = {
  title: 'Admin',
  robots: { index: false, follow: false, nocache: true },
};

export const dynamic = 'force-dynamic';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
