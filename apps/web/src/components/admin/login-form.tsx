'use client';

import { useActionState } from 'react';
import { loginAction, type ActionState } from '@/app/admin/actions';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/form';

const IDLE: ActionState = { status: 'idle' };

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, IDLE);
  return (
    <form action={action} className="grid max-w-sm gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="token">Admin token</Label>
        <Input
          id="token"
          name="token"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Checking' : 'Sign in'}
      </Button>
      {state.status === 'error' ? (
        <p role="alert" data-testid="login-error" className="text-sm text-fail">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
