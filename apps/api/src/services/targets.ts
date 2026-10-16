import { eq, inArray } from 'drizzle-orm';
import { hashJson, type SyncResponse, type Target } from '@qsr/core';
import { tools, type Db } from '@qsr/db';
import { HttpError } from '../problem.js';

/**
 * POST /internal/targets/sync: upsert every target by slug, disable tools whose file was removed.
 * A tool an admin paused (`disabled_reason = 'admin'`, a vendor opt-out) is NEVER re-enabled by a sync.
 * All or nothing: one transaction.
 */
export async function syncTargets(db: Db, targets: readonly Target[]): Promise<SyncResponse> {
  const slugs = targets.map((t) => t.slug);
  if (new Set(slugs).size !== slugs.length)
    throw new HttpError(400, 'Bad Request', 'Two targets have the same slug.');

  return db.transaction(async (tx) => {
    const existing = await tx.select().from(tools);
    const bySlug = new Map(existing.map((t) => [t.slug, t]));
    const result: SyncResponse = {
      created: [],
      updated: [],
      unchanged: [],
      disabled: [],
      keptDisabled: [],
    };

    for (const target of targets) {
      const configHash = hashJson(target);
      const fields = {
        name: target.name,
        docsUrl: target.docsUrl,
        language: target.language,
        level: target.level,
        config: target,
        configHash,
      };
      const current = bySlug.get(target.slug);
      if (!current) {
        await tx.insert(tools).values({ slug: target.slug, ...fields });
        result.created.push(target.slug);
      } else if (current.disabledReason === 'admin') {
        if (current.configHash !== configHash)
          await tx.update(tools).set(fields).where(eq(tools.id, current.id));
        result.keptDisabled.push(target.slug);
      } else if (current.configHash === configHash && current.enabled) {
        result.unchanged.push(target.slug);
      } else {
        await tx
          .update(tools)
          .set({ ...fields, enabled: true, disabledReason: null })
          .where(eq(tools.id, current.id));
        result.updated.push(target.slug);
      }
    }

    const removed = existing.filter((t) => t.enabled && !slugs.includes(t.slug));
    if (removed.length > 0) {
      await tx
        .update(tools)
        .set({ enabled: false, disabledReason: 'file_removed' })
        .where(
          inArray(
            tools.id,
            removed.map((t) => t.id),
          ),
        );
      result.disabled.push(...removed.map((t) => t.slug).sort());
    }
    return result;
  });
}
