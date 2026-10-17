'use client';

import { Button } from '@/components/ui/button';

// Shown when a page cannot load its data (for example the database is unreachable). It says nothing about the
// cause: the error is logged on the server, and the message and digest are never rendered.
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">This page could not load</h1>
      <p role="alert" className="mt-3 max-w-xl text-[15px]">
        The data is temporarily unavailable. Try again in a moment.
      </p>
      <div className="mt-4">
        <Button onClick={() => reset()}>Try again</Button>
      </div>
    </>
  );
}
