import Link from 'next/link';
import { LANGUAGES } from '@qsr/core/public';
import { DEFAULT_PARAMS, STATUS_FILTERS, homeHref, type HomeParams } from '@/lib/filters';
import { cn } from '@/lib/utils';

// Filters and sort are plain links: the page is rendered on the server, the URL carries the state, and a view
// can be shared. The current choice has aria-current.

const LANG_LABEL: Record<string, string> = { all: 'All', node: 'Node.js', python: 'Python' };
const STATUS_LABEL: Record<string, string> = {
  all: 'All',
  passing: 'Passing',
  failing: 'Failing',
  verifying: 'Verifying',
};
const LEVEL_LABEL: Record<string, string> = {
  all: 'All',
  L3: 'L3 (reaches the vendor)',
  L2: 'L2',
  L1: 'L1',
};
const SORT_LABEL: Record<HomeParams['sort'], string> = {
  status: 'Status',
  name: 'Name',
  pass_rate: '30-day pass rate',
  checked: 'Last checked',
};

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'inline-flex h-10 items-center rounded-full border px-4 text-sm font-medium',
        active
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-surface text-foreground hover:bg-surface-2',
      )}
    >
      {children}
    </Link>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span
        className="mr-1 text-xs font-medium uppercase tracking-wide text-muted"
        aria-hidden="true"
      >
        {label}
      </span>
      {children}
    </div>
  );
}

export function FiltersBar({ params }: { params: HomeParams }) {
  const set = (patch: Partial<HomeParams>): string => homeHref({ ...params, ...patch });
  const filtered = params.lang !== 'all' || params.status !== 'all' || params.level !== 'all';
  return (
    <nav aria-label="Filters and sort" className="mb-5 grid gap-3">
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <Group label="Language">
          {(['all', ...LANGUAGES] as const).map((l) => (
            <Chip key={l} href={set({ lang: l })} active={params.lang === l}>
              {LANG_LABEL[l]}
            </Chip>
          ))}
        </Group>
        <Group label="Status">
          {STATUS_FILTERS.map((s) => (
            <Chip key={s} href={set({ status: s })} active={params.status === s}>
              {STATUS_LABEL[s]}
            </Chip>
          ))}
        </Group>
        <Group label="Level">
          {(['all', 'L3', 'L2', 'L1'] as const).map((l) => (
            <Chip key={l} href={set({ level: l })} active={params.level === l}>
              {LEVEL_LABEL[l]}
            </Chip>
          ))}
        </Group>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Group label="Sort by">
          {(Object.keys(SORT_LABEL) as HomeParams['sort'][]).map((s) => {
            const active = params.sort === s;
            // choosing the active sort again flips its direction
            const dir = active ? (params.dir === 'asc' ? 'desc' : 'asc') : DEFAULT_PARAMS.dir;
            return (
              <Chip key={s} href={set({ sort: s, dir })} active={active}>
                {SORT_LABEL[s]}
                {active ? (
                  <span aria-hidden="true" className="ml-1">
                    {params.dir === 'asc' ? '↑' : '↓'}
                  </span>
                ) : null}
                {active ? (
                  <span className="sr-only">
                    {params.dir === 'asc' ? ', ascending' : ', descending'}
                  </span>
                ) : null}
              </Chip>
            );
          })}
        </Group>
        {filtered ? (
          <Link href="/" className="text-sm underline underline-offset-2 hover:text-foreground">
            Clear filters
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
