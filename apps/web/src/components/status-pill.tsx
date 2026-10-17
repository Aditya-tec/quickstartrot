import type { PublicStatus } from '@qsr/core/public';
import { STATUS_STYLE } from '@/lib/status-style';
import { cn } from '@/lib/utils';

/** A status as an icon, a word and a colour together. */
export function StatusPill({ status, className }: { status: PublicStatus; className?: string }) {
  const style = STATUS_STYLE[status];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium',
        style.className,
        className,
      )}
      title={style.explanation}
      data-status={status}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {style.label}
    </span>
  );
}
