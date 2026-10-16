// Concurrency for `qsr plan` (spec sections 7 and 12): at most N jobs at once, and never two for the same
// domain at once, so a vendor's docs server sees one request from us at a time.

export function domainOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

interface Pending {
  domain: string;
  start: () => void;
}

/** `run(domain, job)` starts `job` when a slot is free and no job for `domain` is running. */
export function createLimiter(
  limit: number,
): <T>(domain: string, job: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('the limit must be at least 1');
  let active = 0;
  const busy = new Set<string>();
  const queue: Pending[] = [];

  const pump = (): void => {
    for (let i = 0; i < queue.length && active < limit;) {
      const next = queue[i] as Pending;
      if (busy.has(next.domain)) {
        i += 1;
        continue;
      }
      queue.splice(i, 1);
      active += 1;
      busy.add(next.domain);
      next.start();
    }
  };

  return <T>(domain: string, job: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push({
        domain,
        start: () => {
          job()
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              busy.delete(domain);
              pump();
            });
        },
      });
      pump();
    });
}
