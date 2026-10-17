import { LoginForm } from '@/components/admin/login-form';

export default function AdminLoginPage() {
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Admin</h1>
      <p className="mt-2 max-w-xl text-sm text-muted">
        Sign in with the admin token to review incidents and the queue. The token is checked on the
        server and is never stored in the browser; you get a session that expires after eight hours.
      </p>
      <div className="mt-6">
        <LoginForm />
      </div>
    </>
  );
}
