import { eq, inArray } from 'drizzle-orm';
import { hashJson, type SyncResponse, type Target } from '@qsr/core';
import { tools, type Db } from '@qsr/db';
import { HttpError } from '../problem.js';

/** A tool a person switched off (an admin pause, a vendor opt-out): a sync never switches it back on. */
const isHeldOff = (reason: string | null): boolean => reason === 'admin' || reason === 'opt_out';

/**
 * POST /internal/targets/sync: upsert every target by slug, disable tools whose file was removed or whose
 * target says `enabled: false`. A tool an admin paused (`disabled_reason = 'admin'`) or a vendor opted out
 * (`'opt_out'`) is NEVER re-enabled by a sync. A tool that is switched off keeps all its runs, plans and incidents; it only stops
 * appearing in new cycles (createCycle lists enabled tools). When a tool is switched back on, the streaks and the
 * last failure signature of its old life are forgotten, so a failure weeks ago cannot combine with one today
 * into an incident. All or nothing: one transaction.
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
      skipped: [],
    };

    for (const target of targets) {
      const configHash = hashJson(target);
      const fields = {
        name: target.name,
        docsUrl: target.docsUrl,
        language: target.language,
        // A shadow-L3 target is compiled at its own level (so its plan has the L3 step) but SHOWN at 2 until it is promoted.
        level: target.l3?.mode === 'shadow' ? Math.min(target.level, 2) : target.level,
        config: target,
        configHash,
        // on probation while the target file says so; the public views release the tool at its second valid cycle
        probation: target.probation !== undefined,
      };
      const current = bySlug.get(target.slug);

      if (target.enabled === false) {
        if (!current) {
          result.skipped.push(target.slug);
        } else if (isHeldOff(current.disabledReason)) {
          if (current.configHash !== configHash)
            await tx.update(tools).set(fields).where(eq(tools.id, current.id));
          result.keptDisabled.push(target.slug);
        } else if (!current.enabled) {
          if (current.configHash !== configHash)
            await tx.update(tools).set(fields).where(eq(tools.id, current.id));
          result.unchanged.push(target.slug);
        } else {
          await tx
            .update(tools)
            .set({ ...fields, enabled: false, disabledReason: 'target_disabled' })
            .where(eq(tools.id, current.id));
          result.disabled.push(target.slug);
        }
        continue;
      }

      if (!current) {
        await tx.insert(tools).values({ slug: target.slug, ...fields });
        result.created.push(target.slug);
      } else if (isHeldOff(current.disabledReason)) {
        if (current.configHash !== configHash)
          await tx.update(tools).set(fields).where(eq(tools.id, current.id));
        result.keptDisabled.push(target.slug);
      } else if (current.configHash === configHash && current.enabled) {
        result.unchanged.push(target.slug);
      } else {
        await tx
          .update(tools)
          .set({
            ...fields,
            enabled: true,
            disabledReason: null,
            // coming back from being off: forget the streaks of the old life
            ...(current.enabled
              ? {}
              : {
                  consecutiveFailures: 0,
                  consecutivePasses: 0,
                  transientStreak: 0,
                  lastFailureSignature: null,
                  lastFailureClass: null,
                  lastFailureHarnessVersion: null,
                }),
          })
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
    result.disabled.sort();
    return result;
  });
}
