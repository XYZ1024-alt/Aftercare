'use client';

import type { Refusal, SessionView } from '@aftercare/console/client';
import { ShieldCheck } from 'lucide-react';
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
    <>
      <div aria-hidden className="h-15 bg-nav" />
      <main className="mx-auto w-full max-w-[420px] px-4 pt-16 pb-14 max-sm:pt-10">
        <div className="rounded-panel bg-sky-wash p-2.5">
          <div className="rounded-block bg-card px-7 pt-7 pb-6 shadow-card max-sm:px-5">
            <span className="grid size-11 place-items-center rounded-full bg-nav text-on-dark">
              <ShieldCheck aria-hidden className="size-5" />
            </span>
            <h1 className="mt-4 text-title font-medium">登录</h1>
            <p className="mt-1 text-sm text-muted">使用操作台账号登录。</p>
            <form
              className="mt-6 space-y-4"
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
                className="w-full"
                pending={pending}
                disabled={principal === '' || password === ''}
              >
                登录
              </Button>
              <RefusalNote refusal={refusal} />
            </form>
          </div>
        </div>
      </main>
    </>
  );
}
