import { LEVEL_DESCRIPTION, levelLabel } from '@/lib/status-style';
import { cn } from '@/lib/utils';

/** "L3": how deep this quickstart is tested. L3 reaches the vendor's API; L2 and L1 prove less. */
export function LevelBadge({ level, className }: { level: number; className?: string }) {
  const label = levelLabel(level);
  const reachesVendor = level >= 3;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs font-medium tabular',
        reachesVendor ? 'border-accent/50 text-accent' : 'border-border-strong text-muted',
        className,
      )}
      title={LEVEL_DESCRIPTION[label]}
      aria-label={LEVEL_DESCRIPTION[label]}
    >
      {label}
    </span>
  );
}
