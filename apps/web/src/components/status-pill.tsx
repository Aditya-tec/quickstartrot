import { Ban } from 'lucide-react';
import { OPT_OUT, type PublicStatus } from '@qsr/core/public';
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

/** The label a vendor's page carries after it opted out: icon, words and colour together, like every status. */
export function OptedOutPill({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        STATUS_STYLE.unknown.className,
        className,
      )}
      data-status="opted_out"
    >
      <Ban className="size-3.5 shrink-0" aria-hidden="true" />
      {OPT_OUT.pageLabel}
    </span>
  );
}
