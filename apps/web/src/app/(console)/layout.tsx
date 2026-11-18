'use client';

import { FlaskConical, LogOut } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '../../components/ui.tsx';
import { sendJson } from '../../lib/api.ts';
import { SessionGate, useCan, useSession } from '../../lib/session.tsx';

function Header() {
  const { session, displayName, modelMode, csrfToken } = useSession();
  const admin = useCan('administer_local');
  const signOut = async () => {
    await sendJson('/api/session', {}, csrfToken, 'DELETE');
    window.location.assign('/login');
  };
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <Link href="/" className="text-base font-semibold">
          {displayName}
        </Link>
        <nav className="flex gap-4 text-sm text-stone-700">
          <Link href="/">案例</Link>
          <Link href="/cases/new">提交事故</Link>
          {admin && <Link href="/admin">本地管理</Link>}
        </nav>
        <span className="ml-auto text-sm text-stone-600" data-testid="principal">
          {session.displayName}（{session.principal}）
        </span>
        <Button onClick={() => void signOut()}>
          <LogOut aria-hidden className="size-4" />
          退出
        </Button>
      </div>
      {modelMode === 'scripted_test' && (
        <p
          data-testid="test-mode-banner"
          className="flex items-center justify-center gap-2 bg-amber-200 px-6 py-1.5 text-sm font-medium text-amber-950"
        >
          <FlaskConical aria-hidden className="size-4" />
          测试模式：运行由脚本化测试替身驱动，不是模型的自主调查
        </p>
      )}
      {modelMode === 'unconfigured' && (
        <p className="bg-stone-200 px-6 py-1.5 text-center text-sm text-stone-800">
          未配置模型：可以查看案例，不能启动新的调查
        </p>
      )}
    </header>
  );
}

export default function ConsoleLayout({ children }: { readonly children: ReactNode }) {
  return (
    <SessionGate>
      <Header />
      <main className="mx-auto max-w-6xl space-y-4 px-6 py-6">{children}</main>
    </SessionGate>
  );
}
