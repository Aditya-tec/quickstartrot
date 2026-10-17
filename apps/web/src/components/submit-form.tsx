'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/form';

// The submit form. It posts to /api/submit. If the answer takes more than a few seconds the API is probably
// waking up (it sleeps on a free tier), so the form says so instead of looking stuck. Every outcome is shown.

type Phase =
  | { kind: 'idle' }
  | { kind: 'sending'; waking: boolean }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

const WAKING_AFTER_MS = 4000;

interface TurnstileApi {
  render: (
    el: HTMLElement,
    options: { sitekey: string; callback: (token: string) => void },
  ) => void;
}

export function SubmitForm({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [token, setToken] = useState('');
  const widget = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!turnstileSiteKey || !widget.current) return;
    const el = widget.current;
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => {
      const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      api?.render(el, { sitekey: turnstileSiteKey, callback: setToken });
    };
    document.head.appendChild(script);
    return () => script.remove();
  }, [turnstileSiteKey]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPhase({ kind: 'sending', waking: false });
    const timer = setTimeout(() => setPhase({ kind: 'sending', waking: true }), WAKING_AFTER_MS);
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          docsUrl: String(data.get('docsUrl') ?? ''),
          contact: String(data.get('contact') ?? ''),
          note: String(data.get('note') ?? ''),
          company: String(data.get('company') ?? ''),
          ...(token ? { turnstileToken: token } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
      } | null;
      if (res.ok && body?.ok === true) {
        form.reset();
        setPhase({ kind: 'done' });
      } else {
        setPhase({
          kind: 'error',
          message: body?.message ?? 'Something went wrong. Please try again in a few minutes.',
        });
      }
    } catch {
      setPhase({
        kind: 'error',
        message: 'The connection failed. Check your network and try again.',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  const sending = phase.kind === 'sending';
  return (
    <form onSubmit={onSubmit} className="grid max-w-xl gap-5" noValidate aria-busy={sending}>
      <div className="grid gap-1.5">
        <Label htmlFor="docsUrl">Docs URL of the quickstart</Label>
        <Input
          id="docsUrl"
          name="docsUrl"
          type="url"
          inputMode="url"
          autoComplete="off"
          required
          placeholder="https://docs.example.com/quickstart"
          aria-describedby="docsUrl-help"
          disabled={sending}
        />
        <p id="docsUrl-help" className="text-xs text-muted">
          The public page where the quickstart is written. https only; no IP addresses or private
          hosts.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="contact">Your contact (optional)</Label>
        <Input
          id="contact"
          name="contact"
          autoComplete="email"
          maxLength={200}
          placeholder="you@example.com or a GitHub handle"
          disabled={sending}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="note">Note (optional)</Label>
        <Textarea id="note" name="note" maxLength={1000} disabled={sending} />
      </div>

      {/* Honeypot: hidden from people and from assistive technology. Bots fill it. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="company">Company</label>
        <input id="company" name="company" tabIndex={-1} autoComplete="off" />
      </div>

      {turnstileSiteKey ? <div ref={widget} aria-label="Human check" /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={sending}>
          {sending ? 'Sending' : 'Submit quickstart'}
        </Button>
        <div aria-live="polite" className="text-sm">
          {phase.kind === 'sending' && phase.waking ? (
            <p data-testid="waking" className="text-muted">
              Waking the server, this can take up to a minute. Please keep this page open.
            </p>
          ) : null}
          {phase.kind === 'done' ? (
            <p data-testid="submit-done" className="text-pass">
              Thank you. The quickstart was received. A person will look at it; nothing is fetched
              automatically.
            </p>
          ) : null}
          {phase.kind === 'error' ? (
            <p role="alert" data-testid="submit-error" className="text-fail">
              {phase.message}
            </p>
          ) : null}
        </div>
      </div>
    </form>
  );
}
