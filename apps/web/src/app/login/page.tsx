'use client';

import type { Refusal, SessionView } from '@aftercare/console/client';
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
    <main className="mx-auto mt-24 w-full max-w-sm rounded-lg border border-stone-200 bg-white p-6">
      <h1 className="mb-4 text-lg font-semibold">登录</h1>
      <form
        className="space-y-3"
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
          pending={pending}
          disabled={principal === '' || password === ''}
        >
          登录
        </Button>
        <RefusalNote refusal={refusal} />
      </form>
    </main>
  );
}
