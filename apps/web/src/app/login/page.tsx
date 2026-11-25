'use client';

import type { Refusal, SessionView } from '@aftercare/console/client';
import { Activity } from 'lucide-react';
import { useState } from 'react';
import { Button, Field, INPUT_CLASS, RefusalNote } from '../../components/ui.tsx';
import { sendJson } from '../../lib/api.ts';

export default function LoginPage() {
  const [principal, setPrincipal] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const signIn = async () => {
    setPending(true);
    const result = await sendJson<SessionView>('/api/session', { principal, password }, null);
    setPending(false);
    if (result.ok) {
      window.location.assign('/');
    } else {
      setRefusal(result.refusal);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-14">
      <div className="t-enter w-full max-w-100 rounded-panel border border-line-subtle bg-card px-8 pt-8 pb-7 shadow-card max-sm:px-6">
        <span
          aria-hidden
          className="grid size-11 place-items-center rounded-panel bg-ink text-white"
        >
          <Activity className="size-5" strokeWidth={2.4} />
        </span>
        <h1 className="mt-5 text-title font-semibold">登录</h1>
        <form
          className="mt-7 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn();
          }}
        >
          <Field label="账号">
            <input
              name="principal"
              autoComplete="username"
              className={INPUT_CLASS}
              value={principal}
              onChange={(event) => setPrincipal(event.target.value)}
            />
          </Field>
          <Field label="密码">
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              className={INPUT_CLASS}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Button
            tone="primary"
            type="submit"
            className="mt-2 w-full"
            pending={pending}
            disabled={principal === '' || password === ''}
          >
            登录
          </Button>
          <RefusalNote refusal={refusal} />
        </form>
      </div>
    </main>
  );
}
