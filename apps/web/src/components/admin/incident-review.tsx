'use client';

import { useActionState } from 'react';
import { confirmAction, falsePositiveAction, type ActionState } from '@/app/admin/actions';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/form';

export interface PendingIncident {
  id: string;
  toolSlug: string;
  signature: string;
  failureClass: string;
  openedAt: string;
  summary: string | null;
  suggestedFix: string | null;
  docsChanged: boolean | null;
}

const IDLE: ActionState = { status: 'idle' };

function Message({ state }: { state: ActionState }) {
  if (state.status === 'idle') return null;
  return (
    <p
      role={state.status === 'error' ? 'alert' : 'status'}
      className={state.status === 'error' ? 'text-sm text-fail' : 'text-sm text-pass'}
      data-testid={state.status === 'error' ? 'action-error' : 'action-done'}
    >
      {state.message}
    </p>
  );
}

// One pending incident: the enrichment draft is editable, and two forms act on it. Confirming publishes the
// reviewed text; a false positive keeps it hidden. Neither is possible without a signed-in session.
export function IncidentReview({ incident }: { incident: PendingIncident }) {
  const [confirmState, confirm, confirming] = useActionState(confirmAction, IDLE);
  const [fpState, falsePositive, marking] = useActionState(falsePositiveAction, IDLE);
  const busy = confirming || marking;
  const done = confirmState.status === 'done' || fpState.status === 'done';
  const uid = incident.id.slice(0, 8);
  return (
    <article
      aria-labelledby={`pending-${uid}`}
      className="rounded-lg border border-border-strong bg-surface p-5"
      data-testid="pending-incident"
    >
      <h3 id={`pending-${uid}`} className="text-base font-semibold">
        {incident.toolSlug}
      </h3>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-3">
        <div>
          <dt className="inline">Class: </dt>
          <dd className="inline font-mono text-foreground">{incident.failureClass}</dd>
        </div>
        <div>
          <dt className="inline">Docs changed: </dt>
          <dd className="inline text-foreground">
            {incident.docsChanged === null ? 'not determined' : incident.docsChanged ? 'yes' : 'no'}
          </dd>
        </div>
        <div className="sm:col-span-3">
          <dt className="inline">Signature: </dt>
          <dd className="inline break-all font-mono text-foreground">{incident.signature}</dd>
        </div>
      </dl>

      <form action={confirm} className="mt-4 grid gap-3">
        <input type="hidden" name="id" value={incident.id} />
        <div className="grid gap-1.5">
          <Label htmlFor={`summary-${uid}`}>Summary (public once confirmed)</Label>
          <Textarea
            id={`summary-${uid}`}
            name="summary"
            defaultValue={incident.summary ?? ''}
            maxLength={4000}
            required
            disabled={busy || done}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`fix-${uid}`}>Suggested fix (public once confirmed)</Label>
          <Textarea
            id={`fix-${uid}`}
            name="suggestedFix"
            defaultValue={incident.suggestedFix ?? ''}
            maxLength={4000}
            disabled={busy || done}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy || done}>
            {confirming ? 'Confirming' : 'Confirm and publish'}
          </Button>
          <Message state={confirmState} />
        </div>
      </form>

      <form action={falsePositive} className="mt-5 grid gap-3 border-t border-border pt-4">
        <input type="hidden" name="id" value={incident.id} />
        <div className="grid gap-1.5">
          <Label htmlFor={`reason-${uid}`}>Reason, if this is a false positive</Label>
          <Input id={`reason-${uid}`} name="reason" maxLength={2000} disabled={busy || done} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="outline" disabled={busy || done}>
            {marking ? 'Saving' : 'Mark as false positive'}
          </Button>
          <Message state={fpState} />
        </div>
      </form>
    </article>
  );
}
