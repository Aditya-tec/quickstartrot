'use client';

import { useEffect, useState } from 'react';
import { IncidentReview, type PendingIncident } from '@/components/admin/incident-review';

// The list of incidents waiting for review. A confirm or false-positive refreshes the page (the action drops the
// public cache), and the server then no longer lists that incident. It stays on screen, with its confirmation
// message, until the page is reloaded; new incidents that arrive are added.
export function PendingList({ incidents }: { incidents: PendingIncident[] }) {
  const [shown, setShown] = useState(incidents);
  useEffect(() => {
    setShown((previous) => {
      const known = new Set(previous.map((i) => i.id));
      const added = incidents.filter((i) => !known.has(i.id));
      return added.length === 0 ? previous : [...previous, ...added];
    });
  }, [incidents]);
  if (shown.length === 0)
    return <p className="text-sm text-muted">Nothing is waiting for review.</p>;
  return (
    <>
      {shown.map((incident) => (
        <IncidentReview key={incident.id} incident={incident} />
      ))}
    </>
  );
}
